import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * 极简 bencode 解码：返回原生 JS 对象。
 * - number -> 整数
 * - Buffer -> 字节串（保留为 Buffer）
 * - Array -> 数组
 * - Object -> 字典（key 用 Buffer.toString('binary') 当键名）
 * 仅用于解析 .torrent 磁链生成场景，不支持 list/dict 嵌套的复杂边界（足够覆盖标准 BT 文件）。
 */
function decodeBencode(buf: Buffer): any {
  let p = 0
  const read = (): any => {
    if (p >= buf.length) throw new Error('unexpected eof')
    const c = buf[p]
    if (c === 0x69 /* 'i' */) {
      p++
      const end = buf.indexOf(0x65 /* 'e' */, p)
      if (end < 0) throw new Error('unterminated integer')
      const n = parseInt(buf.slice(p, end).toString('ascii'), 10)
      if (!Number.isFinite(n)) throw new Error('invalid integer')
      p = end + 1
      return n
    }
    if (c >= 0x30 /* '0' */ && c <= 0x39 /* '9' */) {
      const colon = buf.indexOf(0x3a /* ':' */, p)
      if (colon < 0) throw new Error('missing length colon')
      const len = parseInt(buf.slice(p, colon).toString('ascii'), 10)
      p = colon + 1
      const s = buf.slice(p, p + len)
      p += len
      return s
    }
    if (c === 0x6c /* 'l' */) {
      p++
      const list: any[] = []
      while (buf[p] !== 0x65) list.push(read())
      p++
      return list
    }
    if (c === 0x64 /* 'd' */) {
      p++
      const dict: Record<string, any> = {}
      while (buf[p] !== 0x65) {
        const k = read() as Buffer
        const v = read()
        dict[k.toString('binary')] = v
      }
      p++
      return dict
    }
    throw new Error(`invalid bencode at ${p}: 0x${c.toString(16)}`)
  }
  const root = read()
  if (p !== buf.length) throw new Error('trailing data after bencode value')
  return root
}

/** bencode 编码（标准 BT 兼容：dict key 按字节序排序） */
function encodeBencode(obj: any): Buffer {
  if (typeof obj === 'number') {
    return Buffer.from(`i${obj}e`, 'ascii')
  }
  if (Buffer.isBuffer(obj)) {
    return Buffer.concat([Buffer.from(`${obj.length}:`, 'ascii'), obj])
  }
  if (Array.isArray(obj)) {
    return Buffer.concat([Buffer.from('l', 'ascii'), ...obj.map(encodeBencode), Buffer.from('e', 'ascii')])
  }
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort((a, b) => {
      const ba = Buffer.from(a, 'binary')
      const bb = Buffer.from(b, 'binary')
      return ba.compare(bb)
    })
    const parts: Buffer[] = [Buffer.from('d', 'ascii')]
    for (const k of keys) {
      parts.push(encodeBencode(Buffer.from(k, 'binary')))
      parts.push(encodeBencode(obj[k]))
    }
    parts.push(Buffer.from('e', 'ascii'))
    return Buffer.concat(parts)
  }
  throw new Error('invalid bencode value')
}

export interface TorrentInfo {
  /** 文件名（绝对路径） */
  file: string
  /** 种子内的视频名（info.name） */
  name: string
  /** 总字节数（单文件 = info.length / 多文件 = sum） */
  size: number
  /** 40 字符十六进制 SHA1 */
  infoHash: string
  /** magnet:?xt=urn:btih:<hash>&dn=<name> */
  magnet: string
  /** 文件列表（多文件模式） */
  files: { path: string; size: number }[]
}

/** 解析单个 .torrent 文件，返回磁链信息 */
export async function parseTorrentFile(filePath: string): Promise<TorrentInfo> {
  const buf = await fs.readFile(filePath)
  const parsed = decodeBencode(buf)
  const info = parsed?.info
  if (!info) throw new Error('missing info dict')
  // 重新编码 info dict（按字节序排序 key，与原始 .torrent 字节序一致）→ SHA1
  const infoBuf = encodeBencode(info)
  const infoHash = createHash('sha1').update(infoBuf).digest('hex')
  const name = Buffer.isBuffer(info.name) ? info.name.toString('utf-8') : String(info.name ?? '')
  const dn = encodeURIComponent(name || path.basename(filePath, '.torrent'))
  const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${dn}`

  let size = 0
  let files: { path: string; size: number }[] = []
  if (typeof info.length === 'number') {
    // 单文件模式
    size = info.length
    files = [{ path: name, size }]
  } else if (Array.isArray(info.files)) {
    // 多文件模式
    for (const f of info.files) {
      const parts = Array.isArray(f.path) ? f.path.map((p: Buffer) => p.toString('utf-8')) : []
      files.push({ path: parts.join('/'), size: f.length || 0 })
      size += f.length || 0
    }
  }
  return { file: filePath, name, size, infoHash, magnet, files }
}

/** 扫描指定目录下所有 .torrent 文件并解析 */
export async function findAndParseTorrents(dir: string): Promise<TorrentInfo[]> {
  let files: string[] = []
  try {
    const entries = await fs.readdir(dir)
    files = entries.filter((f) => f.toLowerCase().endsWith('.torrent'))
  } catch {
    return []
  }
  const out: TorrentInfo[] = []
  for (const f of files) {
    try {
      out.push(await parseTorrentFile(path.join(dir, f)))
    } catch (e) {
      // 单个 .torrent 解析失败不影响其他
      console.warn(`[torrent] parse failed: ${f}`, (e as Error).message)
    }
  }
  return out
}
