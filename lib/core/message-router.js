// Message router — routes inbound messages to DSH sessions and collects replies
import { randomUUID } from 'node:crypto'
import { MessageDeduplicator } from './dedup.js'
import { parseMediaDirectives, resolveMediaTarget } from '../media/media-handler.js'

const REPLY_TIMEOUT_MS = 300_000 // 5 minutes
const DSH_READY_MAX_ATTEMPTS = 12
const DSH_READY_RETRY_MS = 5000

export class MessageRouter {
  #transport
  #mediaMgr
  #dedup
  #defaultCwd
  #defaultAgentPreset
  #dshBaseUrl
  #log

  /** @type {Map<string, string>} channelId → sessionId */
  #sessionMap = new Map()
  /** @type {Map<string, { sessionId, texts, done, timeout }>} active awaits */
  #awaiting = new Map()
  /** @type {AbortController} */
  #abort = new AbortController()

  constructor({ transport, mediaMgr, dedupWindowMs, defaultCwd, defaultAgentPreset, dshBaseUrl, log }) {
    this.#transport = transport
    this.#mediaMgr = mediaMgr
    this.#dedup = new MessageDeduplicator(dedupWindowMs)
    this.#defaultCwd = defaultCwd
    this.#defaultAgentPreset = defaultAgentPreset
    this.#dshBaseUrl = dshBaseUrl
    this.#log = log
  }

  get signal() {
    return this.#abort.signal
  }

  abort() {
    this.#abort.abort()
  }

  /**
   * 确保指定渠道有可用的 DSH 会话
   * @param {string} [cwd]
   * @param {string} [agentPreset]
   * @returns {Promise<string>} sessionId
   */
  async ensureSession(cwd, agentPreset) {
    const workCwd = cwd ?? this.#defaultCwd
    const preset = agentPreset ?? this.#defaultAgentPreset
    try {
      await this.#waitForDshReady()
      // 尝试复用已有会话
      const list = await this.#transport.call('session.list', {})
      if (list.items?.length > 0) {
        const sessionId = list.items[0].sessionId
        this.#log('📌 复用 DSH 会话: ' + sessionId)
        return sessionId
      }
      // 创建新会话
      const created = await this.#transport.call('session.create', {
        cwd: workCwd,
        agentPreset: preset,
      })
      this.#log('🆕 创建 DSH 会话: ' + created.sessionId)
      return created.sessionId
    } catch (e) {
      throw new Error('DSH 会话初始化失败: ' + e.message)
    }
  }

  /**
   * 路由消息到 DSH 并收集回复
   * @param {string} channelId
   * @param {Object} channelCfg
   * @param {import('./channel-adapter.js').InboundMessage} msg
   */
  async route(channelId, channelCfg, msg) {
    // 去重
    const dedupKey = `${msg.channelId}:${msg.senderId}:${msg.chatId}:${msg.text?.slice(0, 100)}:${msg.timestamp}`
    if (this.#dedup.seen(dedupKey)) {
      this.#log('⏭️ 重复消息跳过: ' + channelId)
      return
    }

    // 获取或创建会话
    let sessionId = this.#sessionMap.get(channelId)
    if (!sessionId) {
      sessionId = await this.#ensureChannelSession(channelId, channelCfg)
    }

    // 构建 prompt 文本
    let promptText = ''
    if (msg.media?.length > 0) {
      for (const m of msg.media) {
        if (m.type === 'image' && m.url) {
          promptText += `[用户发送了图片: ${m.url}]\n`
        } else if (m.type === 'file' && m.url) {
          promptText += `[用户发送了文件: ${m.url}]\n`
        }
      }
    }
    promptText += msg.text || ''

    if (!promptText.trim()) return

    this.#log(`📩 [${channelId}] ${msg.senderName}: ${promptText.slice(0, 120)}`)

    // 发送到 DSH 并等待回复
    const reply = await this.#askDsh(sessionId, promptText)

    // 解析媒体指令
    const { text: cleanText, directives } = parseMediaDirectives(reply)

    // 查找渠道适配器（用于发送回复）
    const adapter = this.#findAdapter(channelId)
    if (!adapter) {
      this.#log('❌ 找不到渠道适配器: ' + channelId)
      return
    }

    // 发送媒体（如果有）
    let mediaSent = 0
    if (directives.length > 0) {
      for (const d of directives) {
        try {
          const filePath = await resolveMediaTarget(d.target, channelCfg.cwd ?? process.cwd())
          await adapter.sendMedia(msg.chatId, {
            filePath,
            caption: mediaSent === 0 ? cleanText : undefined,
          })
          mediaSent++
          this.#log(`✅ 已发送媒体到 ${channelId}: ${filePath}`)
        } catch (e) {
          this.#log(`❌ 媒体发送失败 [${channelId}]: ${e.message}`)
          try {
            await adapter.sendText(msg.chatId, `⚠️ 文件发送失败: ${e.message}`)
          } catch {}
        }
      }
    }

    // 发送剩余文本
    if (mediaSent === 0 && cleanText) {
      try {
        await adapter.sendText(msg.chatId, cleanText)
        this.#log(`📤 回复 [${channelId}]: ${cleanText.slice(0, 150)}`)
      } catch (e) {
        this.#log(`❌ 回复发送失败 [${channelId}]: ${e.message}`)
      }
    } else if (mediaSent > 0 && cleanText && cleanText !== (reply ?? '').trim()) {
      // 媒体已发送，但还有剩余文本
      try {
        await adapter.sendText(msg.chatId, cleanText)
      } catch {}
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  async #ensureChannelSession(channelId, channelCfg) {
    const sessionId = await this.#transport.call('session.create', {
      cwd: channelCfg.cwd ?? this.#defaultCwd,
      agentPreset: channelCfg.agentPreset ?? this.#defaultAgentPreset,
    })
    this.#sessionMap.set(channelId, sessionId.sessionId ?? sessionId)
    this.#log(`📌 渠道 ${channelId} 绑定会话: ${this.#sessionMap.get(channelId)}`)
    return this.#sessionMap.get(channelId)
  }

  async #askDsh(sessionId, text) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#awaiting.delete(sessionId)
        resolve('(超时无回复)')
      }, REPLY_TIMEOUT_MS)

      this.#awaiting.set(sessionId, {
        sessionId,
        texts: [],
        done: (reply) => {
          clearTimeout(timeout)
          this.#awaiting.delete(sessionId)
          resolve(reply)
        },
        timeout,
      })

      this.#transport.call('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).catch((e) => {
        clearTimeout(timeout)
        this.#awaiting.delete(sessionId)
        resolve('(DSH 调用失败: ' + e.message + ')')
      })
    })
  }

  /**
   * 处理 DSH 事件流帧（用于收集流式回复）
   * @param {Object} frame
   */
  handleMuxFrame(frame) {
    if (frame.type !== 'server-request' || frame.method !== 'session/event') return
    const payload = frame.payload
    if (!payload) return

    const awaitEntry = this.#awaiting.get(payload.sessionId)
    if (!awaitEntry) return

    const event = payload.event
    if (!event) return

    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? []
      for (const b of blocks) {
        if (b?.type === 'text' && b.text) {
          awaitEntry.texts.push(b.text)
        }
      }
    } else if (event.type === 'turn/end') {
      awaitEntry.done(awaitEntry.texts.join('\n').trim() || '(无文本回复)')
    }
  }

  #findAdapter(channelId) {
    // 由外部注入，这里用简单引用
    return this._adapterFinder?.(channelId)
  }

  /** 注入适配器查找函数 */
  setAdapterFinder(fn) {
    this._adapterFinder = fn
  }

  async #waitForDshReady() {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#transport.call('session.list', {})
        return
      } catch (e) {
        if (this.#abort.signal.aborted) throw e
        if (attempt >= DSH_READY_MAX_ATTEMPTS) throw e
        this.#log(`⏳ DSH 未就绪 (${e.message})，${DSH_READY_RETRY_MS / 1000}s 后重试 (${attempt}/${DSH_READY_MAX_ATTEMPTS})`)
        await new Promise((r) => setTimeout(r, DSH_READY_RETRY_MS))
      }
    }
  }
}
