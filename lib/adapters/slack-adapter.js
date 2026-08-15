// Slack adapter — uses Slack Bolt or Web API for messaging
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * Slack 适配器
 *
 * 通过 Slack Web API + Socket Mode 接入：
 *   - WebSocket 实时接收消息
 *   - chat.postMessage 发送消息
 *   - 支持 Block Kit 富文本
 *
 * 配置项 (config):
 *   botToken   — Slack Bot Token (xoxb-...)
 *   appToken   — Slack App Token (xapp-...)（Socket Mode）
 *   signingSecret — 签名密钥（HTTP Mode）
 */
export class SlackAdapter extends ChannelAdapter {
  #app = null
  #abort = null

  constructor(opts) {
    super({ ...opts, type: 'slack' })
  }

  get capabilities() {
    return {
      text: true,
      images: true,
      files: true,
      audio: false,
      video: false,
      markdown: true,
      edit: true,
      react: true,
      maxMessageLength: 40000,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true
    this.#abort = new AbortController()

    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    const botToken = this.config.botToken ?? process.env.SLACK_BOT_TOKEN
    const appToken = this.config.appToken ?? process.env.SLACK_APP_TOKEN

    if (!botToken) throw new Error('Slack botToken 必须配置')

    if (appToken) {
      // Socket Mode
      await this.#startSocketMode(botToken, appToken, onMessage)
    } else {
      // HTTP Mode（需要 webhook）
      this.log('⚠️ Slack HTTP 模式需要 webhook 配置')
      throw new Error('Slack 需要 appToken（Socket Mode）或 signingSecret（HTTP Mode）')
    }
  }

  stop() {
    this._running = false
    this.#abort?.abort()
    this.#app?.stop?.()
  }

  async sendText(chatId, text, opts) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.botToken ?? process.env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify({
        channel: chatId,
        text,
        ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
      }),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`Slack 发送失败: ${data.error}`)
  }

  async sendMedia(chatId, media, opts) {
    // Slack 通过 files.upload 发送文件
    const fs = await import('node:fs')
    const path = await import('node:path')

    if (media.filePath) {
      const fileBuffer = fs.default.readFileSync(media.filePath)
      const form = new FormData()
      form.append('channels', chatId)
      form.append('file', new Blob([fileBuffer]), path.default.basename(media.filePath))
      if (media.caption) form.append('initial_comment', media.caption)

      const res = await fetch('https://slack.com/api/files.upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.botToken ?? process.env.SLACK_BOT_TOKEN}`,
        },
        body: form,
      })
      const data = await res.json()
      if (!data.ok) throw new Error(`Slack 文件上传失败: ${data.error}`)
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async #startSocketMode(botToken, appToken, onMessage) {
    const { App } = await this.#loadSlackBolt()

    this.#app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    })

    // 注册消息事件
    this.#app.message(async ({ message, say }) => {
      if (message.bot_id) return

      const isGroup = message.channel_type === 'channel'
      const text = message.text ?? ''
      const media = []

      // 解析文件附件
      if (message.files) {
        for (const file of message.files) {
          const type = file.mimetype?.startsWith('image/') ? 'image'
            : file.mimetype?.startsWith('video/') ? 'video'
            : file.mimetype?.startsWith('audio/') ? 'audio'
            : 'file'
          media.push({
            type,
            url: file.url_private,
            fileName: file.name,
            fileSize: file.size,
          })
        }
      }

      // @mention 检测
      const botUserId = this.#app.botUser?.id
      const isMentioned = text.includes(`<@${botUserId}>`)

      // @mention 门控
      if (isGroup && this.config.requireMention && !isMentioned) return

      if (!text && media.length === 0) return

      onMessage?.({
        channelId: this.id,
        channelType: 'slack',
        senderId: message.user,
        senderName: message.user, // Slack 需要额外 API 调用获取用户名
        text: text.replace(/<@!?\w+>/g, '').trim(),
        chatId: message.channel,
        chatName: message.channel,
        isGroup,
        isMentioned,
        media,
        timestamp: message.ts ? parseFloat(message.ts) * 1000 : Date.now(),
        raw: message,
      })
    })

    await this.#app.start()
    this.log('✅ Slack Socket Mode 已连接')
  }

  async #loadSlackBolt() {
    try {
      return await import('@slack/bolt')
    } catch {
      throw new Error('请安装 @slack/bolt: npm install @slack/bolt')
    }
  }
}
