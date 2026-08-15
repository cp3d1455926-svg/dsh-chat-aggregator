// QQ Official Bot adapter — uses QQ Bot Open Platform API
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * QQ 机器人适配器
 *
 * 通过 QQ 开放平台接入：
 *   - WebSocket 接收消息（沙箱环境）
 *   - REST API 发送消息
 *   - 支持文本、图片、markdown、ark 消息
 *
 * 配置项 (config):
 *   appId       — QQ 机器人 App ID
 *   appSecret   — QQ 机器人 App Secret
 *   token       — QQ 机器人 Token（沙箱环境）
 *   sandbox     — 是否沙箱模式（默认 true）
 *   intents     — Gateway Intents（默认 PUBLIC_GUILD_MESSAGES + AT_MESSAGE）
 */
export class QQAdapter extends ChannelAdapter {
  #appId = null
  #appSecret = null
  #token = null
  #sandbox = true
  #ws = null
  #heartbeat = null
  #sequence = 0
  #sessionId = null
  #abort = null
  #onMessage = null

  constructor(opts) {
    super({ ...opts, type: 'qq' })
  }

  get capabilities() {
    return {
      text: true,
      images: true,
      files: false,
      audio: false,
      video: false,
      markdown: true,
      edit: false,
      react: false,
      maxMessageLength: 2000,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true
    this.#onMessage = onMessage
    this.#abort = new AbortController()

    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    this.#appId = this.config.appId ?? process.env.QQ_APP_ID
    this.#appSecret = this.config.appSecret ?? process.env.QQ_APP_SECRET
    this.#token = this.config.token ?? process.env.QQ_TOKEN
    this.#sandbox = this.config.sandbox !== false

    if (!this.#appId || !this.#token) {
      throw new Error('QQ appId 和 token 必须配置')
    }

    // 连接 WebSocket Gateway
    await this.#connectGateway()
  }

  stop() {
    this._running = false
    this.#abort?.abort()
    if (this.#ws) {
      try { this.#ws.close() } catch {}
    }
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat)
    }
  }

  async sendText(chatId, text, opts) {
    const apiBase = this.#sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com'

    const res = await fetch(`${apiBase}/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.#appId}.${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: text }),
    })
    const data = await res.json()
    if (data.code && data.code !== 0) {
      throw new Error(`QQ 发送失败: ${data.message ?? JSON.stringify(data)}`)
    }
  }

  async sendMedia(chatId, media, opts) {
    const apiBase = this.#sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com'

    if (media.filePath) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const fileBuffer = fs.default.readFileSync(media.filePath)
      const fileName = path.default.basename(media.filePath)
      const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName)

      const form = new FormData()
      form.append('file', new Blob([fileBuffer]), fileName)

      if (isImage) {
        form.append('img_file', new Blob([fileBuffer]), fileName)
        const res = await fetch(`${apiBase}/channels/${chatId}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${this.#appId}.${this.#token}`,
          },
          body: form,
        })
        const data = await res.json()
        if (data.code && data.code !== 0) {
          throw new Error(`QQ 图片发送失败: ${data.message}`)
        }
      } else {
        await this.sendText(chatId, `📎 [${fileName}]`)
      }
    }
  }

  async sendMarkdown(chatId, markdown) {
    const apiBase = this.#sandbox
      ? 'https://sandbox.api.sgroup.qq.com'
      : 'https://api.sgroup.qq.com'

    const res = await fetch(`${apiBase}/channels/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.#appId}.${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        msg_type: 2, // markdown
        markdown: { content: markdown },
      }),
    })
    const data = await res.json()
    if (data.code && data.code !== 0) {
      throw new Error(`QQ Markdown 发送失败: ${data.message}`)
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async #connectGateway() {
    // 获取 WebSocket URL
    const gatewayRes = await fetch(
      this.#sandbox
        ? 'https://sandbox.api.sgroup.qq.com/gateway'
        : 'https://api.sgroup.qq.com/gateway',
      {
        headers: {
          'Authorization': `Bot ${this.#appId}.${this.#token}`,
        },
      }
    )
    const gatewayData = await gatewayRes.json()
    if (!gatewayData.url) {
      throw new Error(`QQ Gateway 获取失败: ${JSON.stringify(gatewayData)}`)
    }

    const wsUrl = gatewayData.url + '?v=10&encoding=json'
    this.log(`🔌 QQ WebSocket 连接: ${this.#sandbox ? '沙箱' : '正式'}`)

    this.#ws = new WebSocket(wsUrl)

    this.#ws.onopen = () => {
      this.log('✅ QQ WebSocket 已连接')
    }

    this.#ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data))
        this.#handleFrame(frame)
      } catch {}
    }

    this.#ws.onclose = () => {
      this.log('QQ WebSocket 已断开')
      if (this._running && !this.#abort.signal.aborted) {
        // 重连
        setTimeout(() => {
          if (this._running) this.#connectGateway()
        }, 5000)
      }
    }

    this.#ws.onerror = (err) => {
      this.log(`❌ QQ WebSocket 错误: ${err.message ?? 'unknown'}`)
    }
  }

  #handleFrame(frame) {
    // op 10: Hello，需要发送 identify
    if (frame.op === 10) {
      const heartbeatInterval = frame.d?.heartbeat_interval ?? 41250
      this.#startHeartbeat(heartbeatInterval)
      this.#sendIdentify()
      return
    }

    // op 11: Heartbeat ACK
    if (frame.op === 11) return

    // op 0: Dispatch 事件
    if (frame.op === 0) {
      this.#sequence = frame.s ?? this.#sequence
      this.#dispatchEvent(frame.t, frame.d)
      return
    }

    // op 9: Invalid Session，需要重新 identify
    if (frame.op === 9) {
      this.#sessionId = null
      setTimeout(() => this.#sendIdentify(), 2000)
      return
    }

    // op 7: Resume
    if (frame.op === 7) {
      this.#sendResume()
      return
    }
  }

  #dispatchEvent(eventName, data) {
    switch (eventName) {
      case 'READY':
        this.#sessionId = data.session_id
        this.log(`✅ QQ 已就绪: ${data.user?.username ?? 'unknown'}`)
        break

      case 'MESSAGE_CREATE':
      case 'AT_MESSAGE_CREATE':
        this.#handleMessage(data)
        break
    }
  }

  #handleMessage(msg) {
    const text = msg.content ?? ''

    // QQ 消息格式中 @mention 会以 <@user_id> 形式出现
    const cleanedText = text.replace(/<@!?\d+>/g, '').trim()

    if (!cleanedText) return

    const chatId = msg.channel_id ?? ''
    const guildId = msg.guild_id ?? ''
    const senderId = msg.author?.id ?? ''
    const senderName = msg.author?.username ?? senderId

    // QQ 频道消息都是群聊
    const isGroup = true

    // @mention 检测（AT_MESSAGE_CREATE 本身就是被 @了才触发）
    const isMentioned = true

    // 用户白名单
    if (!this.isAllowed(senderId)) return

    this.#onMessage?.({
      channelId: this.id,
      channelType: 'qq',
      senderId,
      senderName,
      text: cleanedText,
      chatId,
      chatName: msg.guild_id ?? chatId,
      isGroup,
      isMentioned,
      media: [],
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      raw: msg,
    })
  }

  #startHeartbeat(interval) {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = setInterval(() => {
      if (this.#ws?.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ op: 1, d: this.#sequence }))
      }
    }, interval)
  }

  #sendIdentify() {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return

    // QQ Gateway intents
    const GUILD_MESSAGES = 1 << 0    // 群聊消息
    const PUBLIC_GUILD_MESSAGES = 1 << 0 // 公域消息
    const AT_MESSAGE = 1 << 30        // @消息

    const intents = this.config.intents ?? (GUILD_MESSAGES | AT_MESSAGE)

    this.#ws.send(JSON.stringify({
      op: 2,
      d: {
        token: `Bot ${this.#appId}.${this.#token}`,
        intents,
        shard: [0, 1],
        properties: {
          os: 'linux',
          browser: 'dsh-chat-aggregator',
          device: 'dsh',
        },
      },
    }))
  }

  #sendResume() {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
    this.#ws.send(JSON.stringify({
      op: 6,
      d: {
        token: `Bot ${this.#appId}.${this.#token}`,
        session_id: this.#sessionId,
        seq: this.#sequence,
      },
    }))
  }
}
