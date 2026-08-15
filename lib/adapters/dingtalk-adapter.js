// DingTalk adapter — uses DingTalk Stream SDK for real-time messaging
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * 钉钉适配器
 *
 * 通过 DingTalk Stream Mode 接入钉钉：
 *   - WebSocket 长连接接收消息（dingtalk-stream SDK）
 *   - session_webhook 回复消息
 *   - 支持 AI Card 流式更新
 *
 * 配置项 (config):
 *   clientId     — 钉钉应用 AppKey
 *   clientSecret — 钉钉应用 AppSecret
 *   robotCode    — 机器人 code（默认同 clientId）
 *   cardTemplateId — AI Card 模板 ID（启用流式回复）
 */
export class DingtalkAdapter extends ChannelAdapter {
  #streamClient = null
  #httpClient = null
  #sessionWebhooks = new Map() // chatId → { url, expiredAt }
  #abort = null

  constructor(opts) {
    super({ ...opts, type: 'dingtalk' })
  }

  get capabilities() {
    return {
      text: true,
      images: true,
      files: true,
      audio: true,
      video: true,
      markdown: true,
      edit: !!this.config.cardTemplateId,
      react: false,
      maxMessageLength: 20000,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true
    this.#abort = new AbortController()

    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    const clientId = this.config.clientId ?? process.env.DINGTALK_CLIENT_ID
    const clientSecret = this.config.clientSecret ?? process.env.DINGTALK_CLIENT_SECRET

    if (!clientId || !clientSecret) {
      throw new Error('钉钉 clientId 和 clientSecret 必须配置')
    }

    // 动态加载 dingtalk-stream SDK
    const ds = await this.#loadDingtalkStream()

    const credential = new ds.Credential(clientId, clientSecret)
    this.#streamClient = new ds.DingTalkStreamClient(credential)

    // 注册消息回调
    const handler = this.#createHandler(onMessage)
    this.#streamClient.registerCallbackHandler(ds.ChatbotMessage.TOPIC, handler)

    // 启动 WebSocket 连接
    this.log('🔌 钉钉 Stream 连接中...')
    this.#streamClient.start()
    this.log('✅ 钉钉 Stream 已连接')
  }

  stop() {
    this._running = false
    this.#abort?.abort()
    if (this.#streamClient?.close) {
      try { this.#streamClient.close() } catch {}
    }
  }

  async sendText(chatId, text, opts) {
    const webhook = this.#sessionWebhooks.get(chatId)
    if (!webhook) throw new Error(`没有 ${chatId} 的 session webhook`)

    const body = {
      msgtype: 'markdown',
      markdown: { title: '回复', text },
    }

    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) throw new Error(`钉钉发送失败: HTTP ${res.status}`)
  }

  async sendMedia(chatId, media, opts) {
    // 钉钉通过 session webhook 发送 markdown，媒体需要通过 Card SDK 或文件 API
    // 简化实现：将媒体作为 markdown 链接发送
    if (media.filePath) {
      await this.sendText(chatId, `📎 [文件](${media.filePath})`)
    } else if (media.url) {
      await this.sendText(chatId, `📎 [文件](${media.url})`)
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  #createHandler(onMessage) {
    const loop = this.#abort?.signal ? null : null

    return {
      process: async (callbackMessage) => {
        try {
          const msg = callbackMessage.data
          if (!msg) return

          const chatId = msg.conversationId ?? ''
          const senderId = msg.senderStaffId ?? msg.senderId ?? ''
          const senderName = msg.senderNick ?? senderId
          const text = msg.text?.content?.trim() ?? ''

          // 缓存 session webhook
          if (msg.sessionWebhook) {
            this.#sessionWebhooks.set(chatId, {
              url: msg.sessionWebhook,
              expiredAt: Date.now() + 3600_000,
            })
          }

          // @mention 检测
          const isMentioned = msg.isInAtList === true

          if (!text) return

          onMessage?.({
            channelId: this.id,
            channelType: 'dingtalk',
            senderId,
            senderName,
            text,
            chatId,
            chatName: msg.conversationTitle ?? chatId,
            isGroup: msg.conversationType === '2',
            isMentioned,
            media: [],
            timestamp: msg.createAt ?? Date.now(),
            raw: msg,
          })
        } catch (e) {
          this.log(`❌ 钉钉消息处理异常: ${e.message}`)
        }

        // 返回 ACK
        return { status: 200 }
      },
    }
  }

  async #loadDingtalkStream() {
    try {
      return await import('dingtalk-stream')
    } catch {
      throw new Error('请安装 dingtalk-stream: npm install dingtalk-stream')
    }
  }
}
