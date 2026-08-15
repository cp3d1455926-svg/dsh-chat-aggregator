// Custom adapter — extensible adapter for user-defined platforms
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * 自定义适配器
 *
 * 用于接入用户自定义的即时通讯平台：
 *   - 通过 HTTP webhook 接收消息
 *   - 通过 HTTP API 发送消息
 *   - 支持自定义消息格式转换
 *
 * 配置项 (config):
 *   webhookUrl     — 接收消息的 webhook URL（POST）
 *   sendApiUrl     — 发送消息的 API URL
 *   sendMethod     — 发送方法（默认 POST）
 *   sendHeaders    — 发送请求头（Object）
 *   messageFormat  — 消息格式转换函数（可选）
 *   mediaEnabled   — 是否支持媒体
 */
export class CustomAdapter extends ChannelAdapter {
  #webhookServer = null
  #abort = null

  constructor(opts) {
    super({ ...opts, type: 'custom' })
  }

  get capabilities() {
    return {
      text: true,
      images: this.config.mediaEnabled ?? false,
      files: this.config.mediaEnabled ?? false,
      audio: false,
      video: false,
      markdown: false,
      edit: false,
      react: false,
      maxMessageLength: this.config.maxMessageLength ?? 4096,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true
    this.#abort = new AbortController()

    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    const webhookUrl = this.config.webhookUrl
    if (!webhookUrl) {
      throw new Error('自定义渠道需要配置 webhookUrl')
    }

    // 如果配置了 webhook 端口，启动本地 HTTP 服务器
    const webhookPort = this.config.webhookPort
    if (webhookPort) {
      await this.#startWebhookServer(webhookPort, onMessage)
    }

    this.log(`✅ 自定义渠道已启动: ${webhookUrl}`)
  }

  stop() {
    this._running = false
    this.#abort?.abort()
    if (this.#webhookServer) {
      this.#webhookServer.close()
    }
  }

  async sendText(chatId, text, opts) {
    const sendApiUrl = this.config.sendApiUrl
    if (!sendApiUrl) throw new Error('自定义渠道需要配置 sendApiUrl')

    const method = this.config.sendMethod ?? 'POST'
    const headers = {
      'Content-Type': 'application/json',
      ...(this.config.sendHeaders ?? {}),
    }

    const body = JSON.stringify({
      chat_id: chatId,
      text,
      ...(opts ?? {}),
    })

    const res = await fetch(sendApiUrl, { method, headers, body })
    if (!res.ok) throw new Error(`自定义渠道发送失败: HTTP ${res.status}`)
  }

  async sendMedia(chatId, media, opts) {
    // 自定义渠道的媒体发送（用户可覆盖）
    if (media.filePath) {
      await this.sendText(chatId, `📎 [文件](${media.filePath})`)
    } else if (media.url) {
      await this.sendText(chatId, `📎 [文件](${media.url})`)
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async #startWebhookServer(port, onMessage) {
    const http = await import('node:http')

    this.#webhookServer = http.default.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }

      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          const data = JSON.parse(body)
          this.#handleWebhookMessage(data, onMessage)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          this.log(`❌ Webhook 解析失败: ${e.message}`)
          res.writeHead(400)
          res.end(JSON.stringify({ ok: false, error: e.message }))
        }
      })
    })

    this.#webhookServer.listen(port, () => {
      this.log(`🌐 Webhook 服务器监听: http://127.0.0.1:${port}`)
    })
  }

  #handleWebhookMessage(data, onMessage) {
    // 通用 webhook 消息格式转换
    // 期望格式:
    // {
    //   sender_id: string,
    //   sender_name: string,
    //   text: string,
    //   chat_id: string,
    //   chat_name?: string,
    //   is_group?: boolean,
    //   media?: Array<{ type, url }>,
    //   timestamp?: number
    // }

    const msg = this.config.messageFormat
      ? this.config.messageFormat(data)
      : data

    onMessage?.({
      channelId: this.id,
      channelType: 'custom',
      senderId: msg.sender_id ?? 'unknown',
      senderName: msg.sender_name ?? msg.sender_id ?? 'unknown',
      text: msg.text ?? '',
      chatId: msg.chat_id ?? msg.sender_id ?? 'unknown',
      chatName: msg.chat_name ?? msg.chat_id ?? 'unknown',
      isGroup: msg.is_group ?? false,
      isMentioned: true,
      media: msg.media ?? [],
      timestamp: msg.timestamp ?? Date.now(),
      raw: data,
    })
  }
}
