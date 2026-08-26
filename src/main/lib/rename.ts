import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 清理视频文件名里的"广告污染"：提取番号 + 保留版本标记。
 * 例：
 *   489155.com@PRED-828-C.mp4  → PRED-828-C.mp4
 *   【字幕组】SONE-566-uc.mp4   → SONE-566-uc.mp4
 *   www.xxx.com_IPZZ-586.mp4   → IPZZ-586.mp4
 * 返回 null 表示无需改名（没提取到番号 / 原名已干净）。
 */
export function cleanVideoFileName(fileName: string): string | null {
  const ext = path.extname(fileName)
  const name = fileName.slice(0, fileName.length - ext.length)
  // 番号必须大写字母开头（不带 i 标志，避免把 com_xxx 之类域名残留误当番号）。
  // 用负向断言而非 \b：域名+下划线+番号（com_IPZZ-586）的 `_` 是 word 字符，\b 会失效
  const re = /(?<![A-Za-z0-9])[A-Z]{2,}[-_][A-Z0-9]+/
  const m = re.exec(name)
  if (!m) return null
  const code = m[0]
  const end = m.index + code.length
  // 番号后的部分（版本标记如 -uc / -C / 1080p 等），去掉前导分隔符；
  // 空格/点规范化为横线，多个横线压缩
  const suffix = name
    .slice(end)
    .replace(/^[\s._\-～~·]+/, '')
    .replace(/[\s.]+/g, '-')
    .replace(/-+/g, '-')
    .trim()
  // 若后缀本身是广告词（常见域名/平台残留），直接丢弃
  const AD_RE = /^(com|org|net|www|官网|完整版|高清|HD|1080p|2160p|4k|8k)(-|$)/i
  const cleanSuffix = AD_RE.test(suffix) ? '' : suffix
  const clean = cleanSuffix ? `${code}-${cleanSuffix}` : code
  const result = clean + ext
  return result === fileName ? null : result
}

/** 预览：扫描文件夹中可安全改名的文件（只处理无 video 记录的文件，避免破坏已收录视频） */
export async function previewRenames(
  folderPath: string,
  isIndexed: (p: string) => Promise<boolean>
): Promise<Array<{ path: string; oldName: string; newName: string }>> {
  const files: string[] = []
  for await (const f of walkFiles(folderPath)) files.push(f)
  const items: Array<{ path: string; oldName: string; newName: string }> = []
  const seen = new Set<string>()
  for (const f of files) {
    const oldName = path.basename(f)
    const newName = cleanVideoFileName(oldName)
    if (!newName) continue
    const dir = path.dirname(f)
    const newPath = path.join(dir, newName)
    if (newPath === f) continue
    // 跳过已收录（有 video 记录）的文件
    if (await isIndexed(f)) continue
    // 冲突：目标名已存在
    if (seen.has(newName) || (await fileExists(newPath))) continue
    seen.add(newName)
    items.push({ path: f, oldName, newName })
  }
  return items
}

/** 执行改名（逐个，失败跳过） */
export async function applyRenames(
  items: Array<{ path: string; newName: string }>
): Promise<{ ok: number; failed: Array<{ path: string; reason: string }> }> {
  let ok = 0
  const failed: Array<{ path: string; reason: string }> = []
  for (const item of items) {
    const newPath = path.join(path.dirname(item.path), item.newName)
    try {
      if (newPath === item.path) continue
      if (await fileExists(newPath)) throw new Error('目标文件已存在')
      await fs.rename(item.path, newPath)
      ok++
    } catch (e) {
      failed.push({ path: item.path, reason: (e as Error).message })
    }
  }
  return { ok, failed }
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      yield* walkFiles(full)
    } else if (ent.isFile()) {
      yield full
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
