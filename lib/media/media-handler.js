// Media directive parsing and resolution
// Agent 回复中的 MEDIA: 指令解析 + 文件路径/URL 解析

import path from 'node:path'
import fs from 'node:fs/promises'

const MEDIA_DIRECTIVE_RE = /(^|\n)MEDIA:([^\n]*)(?:\n|$)/gm

/**
 * 解析回复文本中的 MEDIA: 指令
 * 指令必须独占一行（行首 MEDIA: 到行尾），否则视为普通文本
 * @param {string} text
 * @returns {{ text: string, directives: Array<{ target: string }> }}
 */
export function parseMediaDirectives(text) {
  const directives = []
  const cleaned = String(text ?? '').replace(MEDIA_DIRECTIVE_RE, (_, lead, target) => {
    const t = String(target).trim()
    if (t) directives.push({ target: t })
    return lead
  })
  return {
    text: cleaned.replace(/\n{3,}/g, '\n\n').trim(),
    directives,
  }
}

/**
 * 将 MEDIA: 目标解析为本地文件路径
 * @param {string} target - 路径或 URL
 * @param {string} cwd - 工作目录
 * @returns {Promise<string>} 本地文件路径
 */
export async function resolveMediaTarget(target, cwd) {
  const raw = String(target ?? '').trim()
  if (!raw) throw new Error('media target is empty')

  // HTTP/HTTPS URL → 下载
  if (/^https?:\/\//i.test(raw)) {
    return downloadToTemp(raw, cwd)
  }

  // file:// URL
  if (raw.startsWith('file://')) {
    const p = raw.slice(7)
    if (!path.isAbsolute(p)) throw new Error('media target is not absolute: ' + raw)
    return p
  }

  // 绝对路径
  if (path.isAbsolute(raw)) return raw

  // 相对路径 → 基于 cwd
  return path.resolve(cwd, raw)
}

/**
 * 下载远程文件到临时目录
 * @param {string} url
 * @param {string} cwd
 * @returns {Promise<string>} 本地路径
 */
async function downloadToTemp(url, cwd) {
  const tempDir = path.join(cwd, '.chat-aggregator-outbox')
  await fs.mkdir(tempDir, { recursive: true })

  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)

  const ext = guessExtFromUrl(url, res.headers.get('content-type'))
  const fileName = `media-${Date.now()}${ext}`
  const filePath = path.join(tempDir, fileName)

  const buf = Buffer.from(await res.arrayBuffer())
  await fs.writeFile(filePath, buf)
  return filePath
}

function guessExtFromUrl(url, contentType) {
  if (contentType) {
    const mimeMap = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'application/pdf': '.pdf',
    }
    const ext = mimeMap[contentType.split(';')[0].trim()]
    if (ext) return ext
  }
  try {
    const pathname = new URL(url).pathname
    const ext = path.extname(pathname)
    if (ext && ext.length < 10) return ext
  } catch {}
  return '.bin'
}
