// Simple time-windowed message deduplicator

export class MessageDeduplicator {
  /** @type {Map<string, number>} key → first-seen timestamp */
  #seen = new Map()
  #windowMs
  #cleanupInterval

  constructor(windowMs = 30_000) {
    this.#windowMs = windowMs
    // 定期清理过期条目
    this.#cleanupInterval = setInterval(() => this.#cleanup(), windowMs * 2)
  }

  /**
   * 检查消息是否重复
   * @param {string} key
   * @returns {true} if duplicate, records first seen
   */
  seen(key) {
    const now = Date.now()
    const prev = this.#seen.get(key)
    if (prev !== undefined && now - prev < this.#windowMs) {
      return true
    }
    this.#seen.set(key, now)
    return false
  }

  #cleanup() {
    const cutoff = Date.now() - this.#windowMs * 2
    for (const [key, ts] of this.#seen) {
      if (ts < cutoff) this.#seen.delete(key)
    }
  }

  destroy() {
    clearInterval(this.#cleanupInterval)
  }
}
