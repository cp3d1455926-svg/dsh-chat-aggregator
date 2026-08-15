// Base channel adapter interface
// 所有平台适配器必须实现此接口

/**
 * @typedef {Object} InboundMessage
 * @property {string} channelId    - 来源渠道 ID
 * @property {string} channelType  - 来源渠道类型
 * @property {string} senderId     - 发送者 ID
 * @property {string} senderName   - 发送者显示名
 * @property {string} text         - 文本内容
 * @property {string} chatId       - 群组/会话 ID
 * @property {string} chatName     - 群组/会话名称
 * @property {boolean} isGroup     - 是否群聊
 * @property {boolean} isMentioned - 是否被 @mention
 * @property {InboundMedia[]} [media] - 附件列表
 * @property {string} [replyToId]  - 回复的消息 ID
 * @property {number} timestamp    - 消息时间戳
 * @property {Object} [raw]        - 原始平台消息对象
 */

/**
 * @typedef {Object} InboundMedia
 * @property {'image'|'video'|'audio'|'file'} type
 * @property {string} [url]       - 远程 URL
 * @property {Buffer} [data]      - 二进制数据
 * @property {string} [mimeType]  - MIME 类型
 * @property {string} [fileName]  - 文件名
 * @property {number} [fileSize]  - 文件大小
 */

/**
 * @typedef {Object} ChannelCapabilities
 * @property {boolean} text       - 支持文本消息
 * @property {boolean} images     - 支持图片
 * @property {boolean} files      - 支持文件
 * @property {boolean} audio      - 支持语音
 * @property {boolean} video      - 支持视频
 * @property {boolean} markdown   - 支持 Markdown 格式
 * @property {boolean} edit       - 支持编辑已发消息（流式更新）
 * @property {boolean} react      - 支持表情回复
 * @property {number} maxMessageLength - 最大消息长度
 */

/**
 * ChannelAdapter — 平台适配器基类
 *
 * 每个平台适配器继承此类并实现:
 *   - start({ sessionId, onMessage, signal })
 *   - stop()
 *   - sendText(chatId, text, opts?)
 *   - sendMedia(chatId, media, opts?)
 *   - capabilities
 */
export class ChannelAdapter {
  /** @type {string} 渠道实例 ID */
  id
  /** @type {string} 渠道类型标识 */
  type
  /** @type {string} 显示名称 */
  label
  /** @type {Object} 渠道配置 */
  config
  /** @type {Function} 日志函数 */
  log
  /** @type {import('../media/media-manager.js').MediaManager} */
  mediaMgr
  /** @type {boolean} */
  _running = false

  /**
   * @param {Object} opts
   * @param {string} opts.id
   * @param {string} opts.type
   * @param {string} opts.label
   * @param {Object} opts.config
   * @param {Function} opts.log
   * @param {import('../media/media-manager.js').MediaManager} opts.mediaMgr
   */
  constructor({ id, type, label, config, log, mediaMgr }) {
    this.id = id
    this.type = type
    this.label = label ?? id
    this.config = config ?? {}
    this.log = log ?? (() => {})
    this.mediaMgr = mediaMgr
  }

  /**
   * 启动渠道连接，开始监听消息
   * @param {Object} opts
   * @param {string} opts.sessionId - DSH 会话 ID
   * @param {function(InboundMessage): void} opts.onMessage - 收到消息时的回调
   * @param {AbortSignal} opts.signal - 停止信号
   */
  async start({ sessionId, onMessage, signal }) {
    throw new Error(`${this.type}.start() not implemented`)
  }

  /** 停止渠道连接 */
  stop() {
    this._running = false
  }

  /**
   * 发送文本消息
   * @param {string} chatId
   * @param {string} text
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  async sendText(chatId, text, opts) {
    throw new Error(`${this.type}.sendText() not implemented`)
  }

  /**
   * 发送媒体消息
   * @param {string} chatId
   * @param {{ filePath?: string, url?: string, mimeType?: string, caption?: string }} media
   * @param {Object} [opts]
   * @returns {Promise<void>}
   */
  async sendMedia(chatId, media, opts) {
    throw new Error(`${this.type}.sendMedia() not implemented`)
  }

  /** @returns {ChannelCapabilities} */
  get capabilities() {
    return {
      text: true,
      images: false,
      files: false,
      audio: false,
      video: false,
      markdown: false,
      edit: false,
      react: false,
      maxMessageLength: 4096,
    }
  }

  /**
   * 检查用户是否被允许使用此渠道
   * @param {string} userId
   * @returns {boolean}
   */
  isAllowed(userId) {
    const allowed = this.config.allowedUsers ?? ['*']
    if (allowed.includes('*')) return true
    return allowed.includes(userId)
  }

  /**
   * 检查消息是否包含 mention
   * @param {string} text
   * @returns {boolean}
   */
  checkMention(text) {
    if (!this.config.requireMention) return true
    const patterns = this.config.mentionPatterns ?? []
    if (patterns.length === 0) return true // 无模式则默认触发
    return patterns.some((p) => {
      try { return new RegExp(p, 'i').test(text) } catch { return false }
    })
  }
}
