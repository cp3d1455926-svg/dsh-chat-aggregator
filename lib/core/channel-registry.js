// Channel registry — manages adapter type registration and instantiation
import { WechatAdapter } from '../adapters/wechat-adapter.js'
import { DingtalkAdapter } from '../adapters/dingtalk-adapter.js'
import { TelegramAdapter } from '../adapters/telegram-adapter.js'
import { DiscordAdapter } from '../adapters/discord-adapter.js'
import { SlackAdapter } from '../adapters/slack-adapter.js'
import { CustomAdapter } from '../adapters/custom-adapter.js'

/** 内置适配器类型映射 */
const BUILTIN_ADAPTERS = {
  wechat: WechatAdapter,
  dingtalk: DingtalkAdapter,
  telegram: TelegramAdapter,
  discord: DiscordAdapter,
  slack: SlackAdapter,
  custom: CustomAdapter,
}

export class ChannelRegistry {
  /** @type {Map<string, typeof import('../core/channel-adapter.js').ChannelAdapter>} */
  #types = new Map()
  /** @type {Map<string, import('../core/channel-adapter.js').ChannelAdapter>} */
  #instances = new Map()
  #log

  constructor({ log } = {}) {
    this.#log = log ?? (() => {})
    // 注册内置适配器
    for (const [type, Adapter] of Object.entries(BUILTIN_ADAPTERS)) {
      this.#types.set(type, Adapter)
    }
  }

  /**
   * 注册自定义适配器类型
   * @param {string} type - 类型标识
   * @param {typeof import('../core/channel-adapter.js').ChannelAdapter} AdapterClass
   */
  register(type, AdapterClass) {
    if (this.#types.has(type)) {
      this.#log('⚠️ 适配器类型已存在，将覆盖: ' + type)
    }
    this.#types.set(type, AdapterClass)
  }

  /**
   * 创建适配器实例
   * @param {string} type - 渠道类型
   * @param {Object} opts - 适配器构造参数
   * @returns {import('../core/channel-adapter.js').ChannelAdapter | null}
   */
  create(type, opts) {
    const AdapterClass = this.#types.get(type)
    if (!AdapterClass) return null
    const instance = new AdapterClass({ ...opts, type })
    this.#instances.set(opts.id, instance)
    return instance
  }

  /**
   * 获取已创建的适配器实例
   * @param {string} id
   * @returns {import('../core/channel-adapter.js').ChannelAdapter | undefined}
   */
  get(id) {
    return this.#instances.get(id)
  }

  /** @returns {import('../core/channel-adapter.js').ChannelAdapter[]} */
  getAll() {
    return [...this.#instances.values()]
  }

  /** @returns {string[]} 已注册的类型列表 */
  get registeredTypes() {
    return [...this.#types.keys()]
  }
}
