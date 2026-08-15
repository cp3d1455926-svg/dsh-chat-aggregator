// Media manager — handles inbound media saving and outbound media resolution
import fs from 'node:fs/promises'
import path from 'node:path'

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'text/plain': '.txt',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
}

const FALLBACK_EXT = { image: '.img', video: '.mp4', audio: '.audio', file: '.bin' }

export class MediaManager {
  #enabled
  #inboxDir
  #maxBytes
  #log

  constructor({ enabled = true, inboxDir, maxBytes = 50 * 1024 * 1024, log }) {
    this.#enabled = enabled
    this.#inboxDir = inboxDir ?? path.join(process.cwd(), '.chat-aggregator-inbox')
    this.#maxBytes = maxBytes
    this.#log = log ?? (() => {})
  }

  get enabled() { return this.#enabled }
  get inboxDir() { return this.#inboxDir }

  /**
   * 保存接收到的媒体文件
   * @param {Buffer} buf
   * @param {string} mimeType
   * @param {'image'|'video'|'audio'|'file'} kind
   * @param {string} [fileName]
   * @returns {Promise<string>} 保存路径
   */
  async saveInbound(buf, mimeType, kind, fileName) {
    if (!this.#enabled) throw new Error('media receiving is disabled')
    if (buf.length > this.#maxBytes) {
      throw new Error(`media too large: ${buf.length} bytes > ${this.#maxBytes} bytes`)
    }

    await fs.mkdir(this.#inboxDir, { recursive: true })

    let name = this.#sanitizeFileName(fileName)
    if (!name) {
      const ext = this.#extFromMime(mimeType, kind)
      name = `media-${Date.now()}${ext}`
    }

    const target = path.join(this.#inboxDir, name)
    const finalPath = await this.#uniquePath(target)
    await fs.writeFile(finalPath, buf)
    this.#log(`📎 接收媒体已保存: ${finalPath}`)
    return finalPath
  }

  #extFromMime(mime, kind) {
    const m = String(mime ?? '').toLowerCase()
    if (EXT_BY_MIME[m]) return EXT_BY_MIME[m]
    return FALLBACK_EXT[kind] ?? '.bin'
  }

  #sanitizeFileName(name) {
    if (!name) return undefined
    const base = path.win32.basename(String(name).replace(/[/\\]+/g, '/')).trim()
    const cleaned = base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
    return cleaned || undefined
  }

  async #uniquePath(target) {
    try {
      await fs.access(target)
      const ext = path.extname(target)
      const base = path.basename(target, ext)
      return path.join(path.dirname(target), `${Date.now()}-${base}${ext}`)
    } catch {
      return target
    }
  }
}
