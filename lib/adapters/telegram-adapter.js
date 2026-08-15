// Telegram adapter — uses Telegram Bot API via long polling or webhook
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * Telegram 适配器
 *
 * 通过 Telegram Bot API 接入：
 *   - getUpdates 长轮询接收消息
 *   - sendMessage / sendPhoto / sendDocument 发送消息
 *   - 支持 Markdown 格式、流式编辑
 *
 * 配置项 (config):
 *   botToken  — Telegram Bot Token（从 @BotFather 获取）
 *   baseUrl   — API 基础 URL（可选，默认 https://api.telegram.org）
 */
export class TelegramAdapter extends ChannelAdapter {
  #botToken = null
  #baseUrl = null
  #pollTask = null
  #offset = 0

  constructor(opts) {
    super({ ...opts, type: 'telegram' })
  }

  get capabilities() {
    return {
      text: true,
      images: true,
      files: true,
      audio: true,
      video: true,
      markdown: true,
      edit: true,
      react: true,
      maxMessageLength: 4096,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true

    this.#botToken = this.config.botToken ?? process.env.TELEGRAM_BOT_TOKEN
    this.#baseUrl = this.config.baseUrl ?? 'https://api.telegram.org'

    if (!this.#botToken) {
      throw new Error('Telegram botToken 必须配置')
    }

    // 验证 token
    const me = await this.#apiCall('getMe')
    this.log(`✅ Telegram bot: @${me.username}`)

    // 启动轮询
    this.#pollLoop(onMessage, signal)
  }

  stop() {
    this._running = false
  }

  async sendText(chatId, text, opts) {
    await this.#apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      ...(opts?.replyToMessageId ? { reply_to_message_id: opts.replyToMessageId } : {}),
    })
  }

  async sendMedia(chatId, media, opts) {
    if (media.filePath) {
      // 本地文件 → 使用 sendPhoto / sendDocument
      const fs = await import('node:fs')
      const path = await import('node:path')
      const ext = path.default.extname(media.filePath).toLowerCase()
      const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)

      const form = new FormData()
      form.append('chat_id', chatId)
      if (media.caption) form.append('caption', media.caption)

      const fileBuffer = fs.default.readFileSync(media.filePath)
      const blob = new Blob([fileBuffer])
      const fileName = path.default.basename(media.filePath)

      if (isImage) {
        form.append('photo', blob, fileName)
        await this.#apiCallRaw('sendPhoto', form)
      } else {
        form.append('document', blob, fileName)
        await this.#apiCallRaw('sendDocument', form)
      }
    } else if (media.url) {
      // 远程 URL
      const isImageUrl = /^https?:\/\/.*\.(jpg|jpeg|png|gif|webp)/i.test(media.url)
      if (isImageUrl) {
        await this.#apiCall('sendPhoto', {
          chat_id: chatId,
          photo: media.url,
          caption: media.caption,
        })
      } else {
        await this.#apiCall('sendDocument', {
          chat_id: chatId,
          document: media.url,
          caption: media.caption,
        })
      }
    }
  }

  /**
   * 编辑已发送的消息（用于流式更新）
   */
  async editText(chatId, messageId, text) {
    await this.#apiCall('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
    })
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async #pollLoop(onMessage, signal) {
    while (this._running && !signal?.aborted) {
      try {
        const updates = await this.#apiCall('getUpdates', {
          offset: this.#offset,
          timeout: 30,
          allowed_updates: ['message'],
        })

        for (const update of updates ?? []) {
          this.#offset = update.update_id + 1
          const msg = update.message
          if (!msg || msg.from?.is_bot) continue

          const text = msg.text ?? msg.caption ?? ''
          const media = []

          if (msg.photo) {
            const largest = msg.photo[msg.photo.length - 1]
            media.push({ type: 'image', url: largest.file_id })
          }
          if (msg.document) {
            media.push({ type: 'file', url: msg.document.file_id })
          }
          if (msg.voice) {
            media.push({ type: 'audio', url: msg.voice.file_id })
          }
          if (msg.video) {
            media.push({ type: 'video', url: msg.video.file_id })
          }

          // @mention 检测
          const isMentioned = this.#checkTelegramMention(msg)

          if (!text && media.length === 0) continue

          onMessage?.({
            channelId: this.id,
            channelType: 'telegram',
            senderId: String(msg.from.id),
            senderName: msg.from.first_name ?? msg.from.username ?? String(msg.from.id),
            text,
            chatId: String(msg.chat.id),
            chatName: msg.chat.title ?? msg.chat.first_name ?? String(msg.chat.id),
            isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
            isMentioned,
            media,
            timestamp: msg.date * 1000,
            raw: msg,
          })
        }
      } catch (e) {
        if (signal?.aborted) break
        this.log(`⚠️ Telegram poll 异常: ${e.message}`)
        await this.#sleep(5000)
      }
    }
  }

  #checkTelegramMention(msg) {
    if (!this.config.requireMention) return true
    const text = msg.text ?? ''
    // 检查 @bot username
    if (msg.entities) {
      for (const entity of msg.entities) {
        if (entity.type === 'mention') {
          const mention = text.slice(entity.offset, entity.offset + entity.length)
          // 匹配 @botusername 格式
          return true // 简化：有任何 mention 就算触发
        }
      }
    }
    return false
  }

  async #apiCall(method, params) {
    const res = await fetch(`${this.#baseUrl}/bot${this.#botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`Telegram API ${method} 失败: ${data.description}`)
    return data.result
  }

  async #apiCallRaw(method, formData) {
    const res = await fetch(`${this.#baseUrl}/bot${this.#botToken}/${method}`, {
      method: 'POST',
      body: formData,
    })
    const data = await res.json()
    if (!data.ok) throw new Error(`Telegram API ${method} 失败: ${data.description}`)
    return data.result
  }

  #sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
}
