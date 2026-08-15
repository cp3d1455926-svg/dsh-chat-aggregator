// WeChat adapter — uses Tencent iLink Bot (openclaw-weixin) for messaging
import { ChannelAdapter } from '../core/channel-adapter.js'

/**
 * WeChat 适配器
 *
 * 通过 Tencent iLink Bot 协议接入微信：
 *   - getUpdates 长轮询接收消息
 *   - sendMessageWeixin 发送文本/媒体
 *   - downloadMediaFromItem 接收媒体
 *
 * 配置项:
 *   accountId  — 微信账号 ID（从 ~/.openclaw/openclaw-weixin/accounts.json 读取）
 *   autoStart  — 是否自动启动轮询
 */
export class WechatAdapter extends ChannelAdapter {
  #account = null
  #pollTask = null
  #abort = null
  #onMessage = null
  #sessionId = null

  constructor(opts) {
    super({ ...opts, type: 'wechat' })
  }

  get capabilities() {
    return {
      text: true,
      images: true,
      files: true,
      audio: false,
      video: true,
      markdown: false,
      edit: false,
      react: false,
      maxMessageLength: 20000,
    }
  }

  async start({ sessionId, onMessage, signal }) {
    this.#sessionId = sessionId
    this.#onMessage = onMessage
    this.#abort = new AbortController()
    this._running = true

    // 合并外部 signal
    if (signal) {
      signal.addEventListener('abort', () => this.#abort.abort(), { once: true })
    }

    // 加载微信账号
    this.#account = await this.#loadAccount()
    if (!this.#account) {
      throw new Error('没有已登录的微信账号，请先运行: npx dsh-plugin-wechat login')
    }

    this.log(`✅ 微信账号已加载: ${this.#account.id}`)

    // 启动消息轮询
    this.#pollTask = this.#pollLoop()
  }

  stop() {
    this._running = false
    this.#abort?.abort()
  }

  async sendText(chatId, text, opts) {
    const { sendMessageWeixin } = await this.#loadVendor('send')
    await sendMessageWeixin({
      to: chatId,
      text,
      opts: {
        contextToken: opts?.contextToken,
        baseUrl: this.#account.baseUrl,
        token: this.#account.token,
        timeoutMs: 60_000,
      },
    })
  }

  async sendMedia(chatId, media, opts) {
    const { sendWeixinMediaFile } = await this.#loadVendor('send-media')
    const cdnBaseUrl = this.#account.cdnBaseUrl
    await sendWeixinMediaFile({
      filePath: media.filePath,
      to: chatId,
      text: media.caption,
      opts: {
        contextToken: opts?.contextToken,
        baseUrl: this.#account.baseUrl,
        token: this.#account.token,
        timeoutMs: 120_000,
      },
      cdnBaseUrl,
    })
  }

  // ─── Internal ─────────────────────────────────────────────────────────

  async #pollLoop() {
    const { getUpdates } = await this.#loadVendor('api')
    const { MessageType } = await this.#loadVendor('types')
    const { restoreContextTokens, setContextToken, getContextToken } = await this.#loadVendor('inbound')
    const { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } = await this.#loadVendor('sync-buf')

    restoreContextTokens(this.#account.id)
    let getUpdatesBuf = loadGetUpdatesBuf(getSyncBufFilePath(this.#account.id)) ?? ''

    while (this._running && !this.#abort.signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: this.#account.baseUrl,
          token: this.#account.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: 35_000,
          abortSignal: this.#abort.signal,
        })

        if (resp.ret != null && resp.ret !== 0) {
          this.log(`⚠️ getUpdates ret=${resp.ret} ${resp.errmsg ?? ''}`)
          await this.#sleep(5000)
          continue
        }

        if (resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf
          saveGetUpdatesBuf(getSyncBufFilePath(this.#account.id), resp.get_updates_buf)
        }

        for (const full of resp.msgs ?? []) {
          if (full.type === MessageType.BOT) continue
          this.#handleInbound(full, getContextToken, setContextToken)
        }
      } catch (e) {
        if (this.#abort.signal.aborted) break
        this.log(`⚠️ getUpdates 异常: ${e.message}`)
        await this.#sleep(5000)
      }
    }
  }

  async #handleInbound(full, getContextToken, setContextToken) {
    const from = full.from_user_id ?? ''
    if (!from) return

    const token = full.context_token
    if (token) setContextToken(this.#account.id, from, token)

    // 解析文本
    const texts = []
    for (const item of full.item_list ?? []) {
      if (item?.type === 1 && item.text_item?.text != null) {
        texts.push(String(item.text_item.text))
      }
    }
    const text = texts.join('\n').trim()

    // 解析媒体（简化版，实际应调用 vendor downloadMediaFromItem）
    const media = []
    for (const item of full.item_list ?? []) {
      if (item?.type === 2 && item.image_item?.media) {
        media.push({ type: 'image', url: item.image_item.media.full_url })
      } else if (item?.type === 4 && item.file_item?.media) {
        media.push({ type: 'file', url: item.file_item.media.full_url })
      }
    }

    if (!text && media.length === 0) return

    this.#onMessage?.({
      channelId: this.id,
      channelType: 'wechat',
      senderId: from,
      senderName: full.from_user_name ?? from,
      text,
      chatId: from,
      chatName: full.from_user_name ?? from,
      isGroup: false,
      isMentioned: true,
      media,
      timestamp: full.timestamp ?? Date.now(),
      raw: full,
    })
  }

  async #loadAccount() {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const os = await import('node:os')

      const stateDir = path.join(os.default.homedir(), '.openclaw', 'openclaw-weixin')
      const indexFile = path.join(stateDir, 'accounts.json')

      let accountIds = []
      try {
        const parsed = JSON.parse(fs.default.readFileSync(indexFile, 'utf8'))
        if (Array.isArray(parsed)) accountIds = parsed.filter((x) => typeof x === 'string')
      } catch {}

      // 也扫描目录
      if (accountIds.length === 0) {
        const dir = path.join(stateDir, 'accounts')
        if (fs.default.existsSync(dir)) {
          for (const f of fs.default.readdirSync(dir)) {
            if (f.endsWith('.json') && !f.endsWith('.sync.json') && !f.endsWith('.context-tokens.json')) {
              accountIds.push(f.slice(0, -5))
            }
          }
        }
      }

      if (accountIds.length === 0) return null

      const accountId = accountIds[0]
      const accountFile = path.join(stateDir, 'accounts', `${accountId}.json`)
      const accountData = JSON.parse(fs.default.readFileSync(accountFile, 'utf8'))

      return {
        id: accountId,
        token: accountData.token,
        baseUrl: accountData.base_url ?? 'https://ilink.bot.tencent.com',
        cdnBaseUrl: accountData.cdn_base_url,
      }
    } catch {
      return null
    }
  }

  async #loadVendor(module) {
    // 动态加载 vendor 模块（需要先安装 @ccchase/dsh-plugin-wechat 或独立 vendor）
    const vendors = {
      api: '../vendor/weixin/dist/src/api/api.js',
      types: '../vendor/weixin/dist/src/api/types.js',
      send: '../vendor/weixin/dist/src/messaging/send.js',
      'send-media': '../vendor/weixin/dist/src/messaging/send-media.js',
      inbound: '../vendor/weixin/dist/src/messaging/inbound.js',
      'sync-buf': '../vendor/weixin/dist/src/storage/sync-buf.js',
    }
    return import(vendors[module])
  }

  #sleep(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
}
