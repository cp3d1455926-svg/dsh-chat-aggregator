// Discord adapter — uses Discord.js for messaging via bot token
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * Discord 适配器
 *
 * 通过 Discord.js 接入 Discord：
 *   - WebSocket 实时接收消息
 *   - 支持文本、嵌入、文件、按钮
 *   - 支持消息编辑（流式更新）
 *
 * 配置项 (config):
 *   botToken — Discord Bot Token
 *   intents  — Gateway Intents（默认 GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT）
 */
export class DiscordAdapter extends ChannelAdapter {
  #client = null
  #abort = null

  constructor(opts) {
    super({ ...opts, type: 'discord' })
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
      maxMessageLength: 2000,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this._running = true
    this.#abort = new AbortController()

    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    const botToken = this.config.botToken ?? process.env.DISCORD_BOT_TOKEN
    if (!botToken) throw new Error('Discord botToken 必须配置')

    // 动态加载 discord.js
    const { Client, GatewayIntentBits } = await this.#loadDiscordJs()

    this.#client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    })

    // 注册消息事件
    this.#client.on('messageCreate', (msg) => {
      if (msg.author.bot) return
      this.#handleMessage(msg, onMessage)
    })

    // 登录
    await this.#client.login(botToken)
    this.log(`✅ Discord bot 已登录: ${this.#client.user?.tag}`)
  }

  stop() {
    this._running = false
    this.#abort?.abort()
    this.#client?.destroy()
  }

  async sendText(chatId, text, opts) {
    const channel = await this.#client.channels.fetch(chatId)
    if (!channel?.isTextBased()) throw new Error(`${chatId} 不是文本频道`)

    // Discord 消息长度限制
    const chunks = this.#splitMessage(text, this.capabilities.maxMessageLength)
    for (const chunk of chunks) {
      await channel.send({
        content: chunk,
        ...(opts?.replyToMessageId ? { reply: { messageReference: opts.replyToMessageId } } : {}),
      })
    }
  }

  async sendMedia(chatId, media, opts) {
    const channel = await this.#client.channels.fetch(chatId)
    if (!channel?.isTextBased()) throw new Error(`${chatId} 不是文本频道`)

    const fs = await import('node:fs')
    const attachment = media.filePath
      ? new (await this.#loadDiscordJs()).AttachmentBuilder(media.filePath)
      : null

    await channel.send({
      content: media.caption ?? '',
      files: attachment ? [attachment] : [],
    })
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  #handleMessage(msg, onMessage) {
    const isGroup = msg.guild !== null
    const isMentioned = msg.mentions.has(this.#client.user)

    // @mention 门控
    if (isGroup && this.config.requireMention && !isMentioned) return

    const media = []
    for (const attachment of msg.attachments.values()) {
      const type = attachment.contentType?.startsWith('image/') ? 'image'
        : attachment.contentType?.startsWith('video/') ? 'video'
        : attachment.contentType?.startsWith('audio/') ? 'audio'
        : 'file'
      media.push({ type, url: attachment.url, fileName: attachment.name, fileSize: attachment.size })
    }

    // 移除 mention 文本
    let text = msg.content
    if (isMentioned) {
      text = text.replace(/<@!?\d+>/g, '').trim()
    }

    if (!text && media.length === 0) return

    onMessage?.({
      channelId: this.id,
      channelType: 'discord',
      senderId: msg.author.id,
      senderName: msg.member?.displayName ?? msg.author.username,
      text,
      chatId: msg.channelId,
      chatName: isGroup ? msg.guild?.name ?? msg.channelId : msg.author.username,
      isGroup,
      isMentioned,
      media,
      timestamp: msg.createdTimestamp,
      raw: msg,
    })
  }

  #splitMessage(text, maxLen) {
    if (text.length <= maxLen) return [text]
    const chunks = []
    let remaining = text
    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining)
        break
      }
      let splitAt = remaining.lastIndexOf('\n', maxLen)
      if (splitAt <= 0) splitAt = maxLen
      chunks.push(remaining.slice(0, splitAt))
      remaining = remaining.slice(splitAt).trimStart()
    }
    return chunks
  }

  async #loadDiscordJs() {
    try {
      return await import('discord.js')
    } catch {
      throw new Error('请安装 discord.js: npm install discord.js')
    }
  }
}
