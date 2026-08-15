// @dsh-community/dsh-chat-aggregator — Multi-platform chat aggregator for DeepSeek Harness
// 统一接入微信、钉钉、Telegram、Discord、Slack 等即时通讯平台到一个 DSH agent 会话
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ChannelRegistry } from './core/channel-registry.js'
import { MessageRouter } from './core/message-router.js'
import { MediaManager } from './media/media-manager.js'

export const name = 'chat-aggregator'
export const inject = ['apiProxy']

// ─── Configuration Schema ───────────────────────────────────────────────────

const ChannelConfig = z.object({
  /** 渠道唯一标识 */
  id: z.string(),
  /** 渠道类型 */
  type: z.enum(['wechat', 'dingtalk', 'telegram', 'discord', 'slack', 'custom']),
  /** 是否启用 */
  enabled: z.boolean().default(true),
  /** 渠道显示名称 */
  label: z.string().optional(),
  /** 渠道特定配置（各适配器自行定义） */
  config: z.record(z.any()).default({}),
  /** 是否需要 @mention 才响应（群聊场景） */
  requireMention: z.boolean().default(false),
  /** mention 触发模式（正则） */
  mentionPatterns: z.array(z.string()).default([]),
  /** 允许的用户 ID 列表（'*' = 任何人） */
  allowedUsers: z.array(z.string()).default(['*']),
  /** 默认会话工作目录 */
  cwd: z.string().optional(),
  /** 该渠道使用的 agent preset */
  agentPreset: z.string().default('standard'),
})

export const Config = z.object({
  /** 是否随插件启动自动运行所有已启用渠道 */
  autoStart: z.boolean().default(true),
  /** 媒体收发总开关 */
  mediaEnabled: z.boolean().default(true),
  /** 媒体接收保存目录 */
  mediaInboxDir: z.string().optional(),
  /** 单条接收媒体大小上限（字节） */
  maxMediaBytes: z.number().int().positive().default(50 * 1024 * 1024),
  /** 消息去重窗口（毫秒） */
  dedupWindowMs: z.number().int().positive().default(30_000),
  /** DSH API 基础 URL */
  dshBaseUrl: z.string().default('http://127.0.0.1:3080'),
  /** 默认会话工作目录 */
  defaultCwd: z.string().optional(),
  /** 默认 agent preset */
  defaultAgentPreset: z.string().default('standard'),
  /** 已配置的渠道列表 */
  channels: z.array(ChannelConfig).default([]),
  /** 自定义适配器注册表（路径 → 模块说明） */
  customAdapters: z.record(z.string()).default({}),
})

// ─── Transport Layer ────────────────────────────────────────────────────────
// 将 ctx.apiProxy 包装为通用 transport，供所有适配器共用

function makeTransport(api) {
  return {
    async call(method, payload) {
      const [domain, fn] = method.split('.')
      const ALIAS = {
        session: 'sessions',
        subagent: 'subagents',
        agentPreset: 'agentPresets',
        download: 'downloads',
      }
      const prop = ALIAS[domain] ?? domain
      const resp = await api[prop][fn]({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload,
      })
      if (!resp?.result?.ok) {
        const e = resp?.result?.error ?? {}
        throw new Error(
          method + ' failed: ' + (e.code ?? '') + ' ' + (e.message ?? JSON.stringify(resp?.result))
        )
      }
      return resp.result.value
    },

    async frames(onFrame, signal) {
      const queue = await api.events.mux(
        { type: 'client-request', rpcId: randomUUID(), method: 'events.mux', payload: {} },
        signal
      )
      const iter = queue?.iterate ? queue.iterate(signal, () => {}) : queue
      for await (const narrow of iter) {
        if (signal.aborted) break
        const payload = narrow?.payload
        onFrame({
          type: 'server-request',
          rpcId: narrow?.rpcId,
          method: payload?.type,
          payload,
        })
      }
    },
  }
}

// ─── Plugin Entry ───────────────────────────────────────────────────────────

export function apply(ctx, config) {
  if (!config.autoStart || config.channels.length === 0) return

  let registry
  let router
  let mediaMgr

  ctx.effect(() => {
    const log = (...args) => {
      const line = args.join(' ')
      try { ctx.logger?.info?.(line) } catch {}
      console.log('[chat-aggregator] ' + line)
    }

    const transport = makeTransport(ctx.apiProxy)

    // 初始化媒体管理器
    mediaMgr = new MediaManager({
      enabled: config.mediaEnabled,
      inboxDir: config.mediaInboxDir,
      maxBytes: config.maxMediaBytes,
      log,
    })

    // 初始化渠道注册表
    registry = new ChannelRegistry({ log })

    // 初始化消息路由器
    router = new MessageRouter({
      transport,
      mediaMgr,
      dedupWindowMs: config.dedupWindowMs,
      defaultCwd: config.defaultCwd,
      defaultAgentPreset: config.defaultAgentPreset,
      dshBaseUrl: config.dshBaseUrl,
      log,
    })

    // 注册并启动各渠道
    const startedChannels = []
    for (const ch of config.channels) {
      if (!ch.enabled) {
        log('⏭️  渠道已禁用: ' + ch.id + ' (' + ch.type + ')')
        continue
      }
      try {
        const adapter = registry.create(ch.type, {
          id: ch.id,
          label: ch.label ?? ch.id,
          config: ch.config,
          requireMention: ch.requireMention,
          mentionPatterns: ch.mentionPatterns,
          allowedUsers: ch.allowedUsers,
          mediaMgr,
          log,
        })
        if (!adapter) {
          log('❌ 未知渠道类型: ' + ch.type + ' (渠道 ' + ch.id + ')')
          continue
        }
        startedChannels.push({ id: ch.id, adapter, config: ch })
      } catch (e) {
        log('❌ 渠道 ' + ch.id + ' 初始化失败: ' + e.message)
      }
    }

    // 并发启动所有渠道
    const startupPromises = startedChannels.map(async ({ id, adapter, config: chCfg }) => {
      try {
        const sessionId = await router.ensureSession(chCfg.cwd, chCfg.agentPreset)
        await adapter.start({
          sessionId,
          onMessage: (msg) => router.route(id, chCfg, msg),
          signal: router.signal,
        })
        log('✅ 渠道已启动: ' + id + ' → 会话 ' + sessionId)
      } catch (e) {
        log('❌ 渠道 ' + id + ' 启动失败: ' + e.message)
      }
    })

    Promise.all(startupPromises).then(() => {
      log('🚀 聊天聚合器已就绪，共 ' + startedChannels.length + ' 个渠道')
    })

    return () => {
      log('🛑 正在关闭聊天聚合器...')
      router?.abort()
      for (const { adapter } of startedChannels) {
        try { adapter.stop?.() } catch {}
      }
    }
  }, 'chat-aggregator')
}
