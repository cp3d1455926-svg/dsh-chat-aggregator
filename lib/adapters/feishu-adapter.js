// Feishu (飞书/Lark) adapter — uses Feishu Open API for messaging
import { ChannelAdapter } from '../core/channel-adapter.js'
import crypto from 'node:crypto'

/**
 * 飞书适配器
 *
 * 通过飞书开放平台接入：
 *   - Webhook 接收消息事件（Event Subscription）
 *   - REST API 发送消息（im/v1/messages）
 *   - 支持文本、富文本、图片、文件
 *
 * 配置项 (config):
 *   appId          — 飞书应用 App ID
 *   appSecret      — 飞书应用 App Secret
 *   verificationToken — 事件订阅验证 Token
 *   encryptKey     — 事件订阅加密 Key（可选）
 *   webhookPath    — Webhook 接收路径（默认 /feishu）
 *   webhookPort    — 本地 HTTP 服务器端口（默认 9321）
 */
export class FeishuAdapter extends ChannelAdapter {
  #appId = null
  #appSecret = null
  #tenantToken = null
  #tokenExpiry = 0
  #webhookServer = null
  #abort = null

  constructor(opts) {
    super({ ...opts, type: 'feishu' })
  }

  get capabilities() {
    return {
      text: true,
      images: true,
      files: true,
      audio: false,
      video: false,
      markdown: false, // 飞书用富文本 post 格式
      edit: false,
      react: true, // 表情回复
      maxMessageLength: 4096,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true
    this.#abort = new AbortController()

    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    this.#appId = this.config.appId ?? process.env.FEISHU_APP_ID
    this.#appSecret = this.config.appSecret ?? process.env.FEISHU_APP_SECRET

    if (!this.#appId || !this.#appSecret) {
      throw new Error('飞书 appId 和 appSecret 必须配置')
    }

    // 获取 tenant_access_token
    await this.#refreshToken()
    this.log(`✅ 飞书 Token 已获取`)

    // 启动 Webhook 服务器
    const port = this.config.webhookPort ?? 9321
    const path = this.config.webhookPath ?? '/feishu'
    await this.#startWebhookServer(port, path, onMessage)
    this.log(`✅ 飞书 Webhook 服务器监听: http://127.0.0.1:${port}${path}`)
  }

  stop() {
    this._running = false
    this.#abort?.abort()
    this.#webhookServer?.close()
  }

  async sendText(chatId, text, opts) {
    const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`
    const body = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await this.#getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.code !== 0) throw new Error(`飞书发送失败: ${data.msg}`)
  }

  async sendRichText(chatId, title, contentLines, opts) {
    // 飞书富文本消息（post 格式）
    const content = {
      zh_cn: {
        title,
        content: contentLines.map((line) =>
          line.map((seg) => {
            if (seg.tag === 'a') return { tag: 'a', text: seg.text, href: seg.href }
            if (seg.tag === 'at') return { tag: 'at', user_id: seg.userId }
            return { tag: 'text', text: seg.text }
          })
        ),
      },
    }

    const url = `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`
    const body = {
      receive_id: chatId,
      msg_type: 'post',
      content: JSON.stringify(content),
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${await this.#getToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (data.code !== 0) throw new Error(`飞书富文本发送失败: ${data.msg}`)
  }

  async sendMedia(chatId, media, opts) {
    // 先上传文件获取 file_key，再发送
    if (media.filePath) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const fileBuffer = fs.default.readFileSync(media.filePath)
      const fileName = path.default.basename(media.filePath)
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName)

      // 上传到飞书
      const form = new FormData()
      form.append('file_type', isImage ? 'image' : 'stream')
      form.append('file_name', fileName)
      form.append('file', new Blob([fileBuffer]), fileName)

      const uploadRes = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${await this.#getToken()}` },
        body: form,
      })
      const uploadData = await uploadRes.json()
      if (uploadData.code !== 0) throw new Error(`飞书文件上传失败: ${uploadData.msg}`)

      const fileKey = uploadData.data.file_key

      if (isImage) {
        // 发送图片消息
        const imgBody = {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: fileKey }),
        }
        const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${await this.#getToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(imgBody),
        })
        const data = await res.json()
        if (data.code !== 0) throw new Error(`飞书图片发送失败: ${data.msg}`)
      } else {
        // 发送文件消息
        const fileBody = {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        }
        const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${await this.#getToken()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(fileBody),
        })
        const data = await res.json()
        if (data.code !== 0) throw new Error(`飞书文件发送失败: ${data.msg}`)
      }
    }
  }

  async addReaction(chatId, messageId, emojiType) {
    // 添加表情回复
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${await this.#getToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      }
    )
    const data = await res.json()
    if (data.code !== 0) this.log(`⚠️ 表情回复失败: ${data.msg}`)
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async #startWebhookServer(port, path, onMessage) {
    const http = await import('node:http')

    this.#webhookServer = http.default.createServer(async (req, res) => {
      // 健康检查
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }

      // 飞书 URL 验证（首次配置时）
      if (req.method === 'POST' && req.url === path) {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', async () => {
          try {
            const data = JSON.parse(body)

            // URL 验证挑战
            if (data.type === 'url_verification' && data.challenge) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ challenge: data.challenge }))
              return
            }

            // v2.0 事件格式
            if (data.schema === '2.0') {
              await this.#handleEventV2(data, onMessage)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }

            // v1.0 事件格式
            if (data.event) {
              await this.#handleEventV1(data, onMessage)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true }))
              return
            }

            res.writeHead(200)
            res.end('{}')
          } catch (e) {
            this.log(`❌ 飞书 Webhook 处理异常: ${e.message}`)
            res.writeHead(200)
            res.end('{}')
          }
        })
        return
      }

      res.writeHead(404)
      res.end()
    })

    this.#webhookServer.listen(port, () => {
      this.log(`🌐 飞书 Webhook 服务器启动: port ${port}, path ${path}`)
    })
  }

  async #handleEventV2(data, onMessage) {
    // v2.0 事件：header + event
    const header = data.header ?? {}
    const event = data.event ?? {}

    // 只处理 im.message.receive_v1 事件
    if (header.event_type !== 'im.message.receive_v1') return

    const message = event.message ?? {}
    const sender = event.sender ?? {}

    // 只处理文本消息
    if (message.message_type !== 'text') return

    let text = ''
    try {
      const content = JSON.parse(message.content ?? '{}')
      text = content.text ?? ''
    } catch {}

    if (!text) return

    // @mention 过滤
    const chatId = message.chat_id ?? ''
    const senderId = sender.sender_id?.open_id ?? ''
    const senderName = sender.sender_id?.open_id ?? 'unknown'

    // 提取 mention 信息
    const mentions = message.mentions ?? []
    const isMentioned = mentions.length > 0

    // 飞书群聊需要 @mention
    const chatType = message.chat_type ?? 'p2p'
    if (chatType === 'group' && this.config.requireMention && !isMentioned) return

    // 用户白名单检查
    if (!this.isAllowed(senderId)) return

    onMessage?.({
      channelId: this.id,
      channelType: 'feishu',
      senderId,
      senderName: senderName,
      text,
      chatId,
      chatName: message.chat_id ?? chatId,
      isGroup: chatType === 'group',
      isMentioned,
      media: [],
      timestamp: parseInt(message.create_time ?? Date.now(), 10),
      raw: data,
    })
  }

  async #handleEventV1(data, onMessage) {
    // v1.0 事件格式
    const event = data.event ?? {}
    const msgType = event.msg_type ?? ''

    if (msgType !== 'text') return

    let text = ''
    try {
      const content = JSON.parse(event.text ?? '{}')
      text = content.text ?? ''
    } catch {
      text = event.text ?? ''
    }

    if (!text) return

    const chatId = event.open_chat_id ?? ''
    const senderId = event.open_id ?? ''

    onMessage?.({
      channelId: this.id,
      channelType: 'feishu',
      senderId,
      senderName: event.user_id ?? senderId,
      text,
      chatId,
      chatName: chatId,
      isGroup: !!event.open_chat_id,
      isMentioned: true,
      media: [],
      timestamp: Date.now(),
      raw: data,
    })
  }

  async #refreshToken() {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.#appId,
        app_secret: this.#appSecret,
      }),
    })
    const data = await res.json()
    if (data.code !== 0) throw new Error(`飞书 Token 获取失败: ${data.msg}`)
    this.#tenantToken = data.tenant_access_token
    this.#tokenExpiry = Date.now() + (data.expire - 60) * 1000 // 提前 60s 刷新
  }

  async #getToken() {
    if (Date.now() >= this.#tokenExpiry) {
      await this.#refreshToken()
    }
    return this.#tenantToken
  }
}
