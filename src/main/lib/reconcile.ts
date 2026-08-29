import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  DisplayEntry,
  IntroDoc,
  Library,
  ReconcileResult,
  Settings,
  UnlistedFile,
  Video
} from '../../shared/types'
import { parseIntroMd } from './parser'
import { parseIntroExcel } from './excel'
import { applyVideoChanges, findVideoByPath, listVideos, type VideoChange } from './repo'
import { resolvePoster } from './images'
import { walk, VIDEO_EXTS, idForPath } from './scanner'
import { isDomestic } from '../../shared/code'

async function readIntroDoc(library: Library): Promise<IntroDoc | null> {
  // Excel 片单优先（用户已切换到 Excel 格式）
  if (library.introExcelPath) {
    const doc = await parseIntroExcel(library.introExcelPath)
    if (doc) return doc
    // Excel 解析失败时回退 md
  }
  if (!library.introMdPath) return null
  try {
    const content = await fs.readFile(library.introMdPath, 'utf-8')
    return parseIntroMd(content)
  } catch {
    return null
  }
}

interface FileEntry {
  path: string
  /** 文件名（去扩展名、小写），用于番号匹配 */
  key: string
  /** 外文件夹名（小写），优先级更高的匹配源（比文件名更干净） */
  folderName: string
}

function collectFiles(files: string[]): FileEntry[] {
  return files.map((p) => {
    const base = path.basename(p)
    const ext = path.extname(p)
    const nameNoExt = base.slice(0, base.length - ext.length).toLowerCase()
    const folder = path.basename(path.dirname(p)).toLowerCase()
    return { path: p, key: nameNoExt, folderName: folder }
  })
}

/**
 * 番号归一化：转大写、去空格与点（保留连字符，连字符是番号结构的一部分）。
 * SONE-566 / sone-566 / sone.566 归一化后一致。
 */
export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[\s.]+/g, '')
}

/**
 * 判断文件名 key 是否命中番号 code：
 * - 归一化后包含；
 * - 前缀边界：code 前不能紧跟字母数字（防 `1SONE-560` 之类）；
 * - 后缀边界：code 后若紧跟数字则不算（防 `SONE-56` 误命中 `SONE-560`）；
 *   但允许紧跟字母/连字符等版本标记（`SONE-566-uc`、`SONE-566UC` 都算同片）。
 */
export function keyMatches(key: string, code: string): boolean {
  const k = normalizeCode(key)
  const c = normalizeCode(code)
  const i = k.indexOf(c)
  if (i < 0) return false
  const before = i > 0 ? k[i - 1] : ''
  if (before && /[A-Z0-9]/.test(before)) return false
  const after = k[i + c.length]
  if (after && /[0-9]/.test(after)) return false
  return true
}

/**
 * 找出所有匹配该番号的文件（同一番号的多版本文件都算同片，全部标记 used，
 * 避免被误报为「未收录」）。返回按主次排序的文件路径列表。
 * 匹配优先级：外文件夹名 > 文件名（外文件夹名更干净，命中更权威）。
 */
function findFilesForCode(code: string, files: FileEntry[], used: Set<string>): string[] {
  const hits: FileEntry[] = []
  for (const f of files) {
    if (used.has(f.path)) continue
    if (keyMatches(f.folderName, code) || keyMatches(f.key, code)) {
      used.add(f.path)
      hits.push(f)
    }
  }
  const c = normalizeCode(code)
  hits.sort((a, b) => {
    // 外文件夹名完全等于番号 > 文件名完全等于番号 > 其他
    const aFolder = normalizeCode(a.folderName) === c ? 0 : 1
    const bFolder = normalizeCode(b.folderName) === c ? 0 : 1
    if (aFolder !== bFolder) return aFolder - bFolder
    const aKey = normalizeCode(a.key) === c ? 0 : 1
    const bKey = normalizeCode(b.key) === c ? 0 : 1
    return aKey - bKey || a.key.localeCompare(b.key)
  })
  return hits.map((h) => h.path)
}

async function ensureVideo(
  filePath: string,
  library: Library,
  settings: Settings,
  meta: { code: string; description: string; tags: string[]; score?: number },
  changes: VideoChange[]
): Promise<Video> {
  const folderName = path.basename(path.dirname(filePath))
  const domestic = isDomestic(folderName, path.basename(filePath))
  const existing = await findVideoByPath(filePath)
  if (existing) {
    // md 为权威来源：简介/标签/评分以 md 为准（仅在变化时记录一次 update，不逐条写盘）
    if (
      existing.description !== meta.description ||
      JSON.stringify(existing.tags) !== JSON.stringify(meta.tags) ||
      existing.rating !== meta.score ||
      !!existing.domestic !== domestic
    ) {
      const updated: Video = {
        ...existing,
        description: meta.description,
        tags: [...meta.tags],
        descriptionSource: 'manual',
        rating: meta.score ?? existing.rating,
        domestic
      }
      changes.push({ type: 'update', video: updated })
      return updated
    }
    return existing
  }
  const stat = await fs.stat(filePath).catch(() => null)
  const video: Video = {
    id: idForPath(filePath),
    libraryId: library.id,
    path: filePath,
    fileName: path.basename(filePath),
    folderName: path.basename(path.dirname(filePath)),
    domestic,
    title: meta.code,
    description: meta.description,
    descriptionSource: 'manual',
    tags: [...meta.tags],
    rating: meta.score,
    addedAt: Date.now(),
    fileSize: stat?.size
  }
  if (!video.posterPath) {
    const r = await resolvePoster(video, library, settings, { allowFfmpeg: false })
    video.posterSource = r.source
    video.posterPath = r.posterPath
  }
  changes.push({ type: 'upsert', video })
  return video
}

/**
 * 按简介 md 对账某个媒体库的视频文件夹。
 * - md 条目匹配到文件 → matched（含海报/播放信息）
 * - md 有但文件缺失 → missing（提示下载或删除简介）
 * - 文件夹有但 md 未收录 → unlisted（提示更新 md）
 */
export async function reconcileLibrary(
  library: Library,
  settings: Settings,
  onProgress?: (p: { libraryId: string; total: number; done: number; current?: string }) => void
): Promise<ReconcileResult> {
  const doc = await readIntroDoc(library)

  // 与 scanLibrary 一致：按设置过滤小文件（短视频/广告样片）
  const minSizeBytes = Math.max(0, Math.floor(settings.scanMinSizeMB ?? 0)) * 1024 * 1024
  const allFiles: string[] = []
  for await (const f of walk(library.folderPath, minSizeBytes)) allFiles.push(f)
  const fileEntries = collectFiles(allFiles)
  const used = new Set<string>()

  const entries: DisplayEntry[] = []
  const changes: VideoChange[] = []
  let mdCount = 0
  let matched = 0
  let missing = 0

  // 已删除标记：用户主动删除过（文件挪回收站 + data.json 记录被删）的番号集合。
  // md 里有条目但文件缺失时，若该番号在 data.json 中已无任何记录，说明用户主动删除过，
  // 跳过该条目不标 missing（否则删除后对账又会把它标成"缺失"挂回来）。
  let activeCodeSet: Set<string> | null = null
  const getActiveCodeSet = async (): Promise<Set<string>> => {
    if (activeCodeSet) return activeCodeSet
    const s = new Set<string>()
    try {
      const all = await listVideos({})
      for (const v of all) {
        if (v.javdbDetail?.code) s.add(v.javdbDetail.code.toUpperCase())
        else if (v.title) s.add(String(v.title).toUpperCase())
        else if (v.fileName) s.add(path.basename(v.fileName, path.extname(v.fileName)).toUpperCase())
      }
    } catch {
      /* 拿不到记录列表时保守处理：不跳过（维持原 missing 行为） */
    }
    activeCodeSet = s
    return s
  }

  if (doc) {
    const total = doc.totalCount + allFiles.length
    for (const cat of doc.categories) {
      for (const item of cat.items) {
        mdCount++
        onProgress?.({
          libraryId: library.id,
          total,
          done: mdCount,
          current: item.code
        })
        const files = findFilesForCode(item.code, fileEntries, used)
        if (files.length > 0) {
          const video = await ensureVideo(files[0], library, settings, item, changes)
          entries.push({
            kind: 'matched',
            category: cat.name,
            order: cat.order,
            code: item.code,
            title: item.code,
            description: item.description,
            tags: item.tags,
            tagCategories: item.tagCategories,
            score: item.score,
            video
          })
          matched++
        } else {
          // 文件缺失：若该番号在 data.json 中已无任何记录（用户主动删除过视频 + 记录），
          // 跳过该条目不标 missing，避免"删了又挂回来"。
          const activeCodes = await getActiveCodeSet()
          const upperCode = String(item.code).toUpperCase()
          if (activeCodes.size > 0 && !activeCodes.has(upperCode)) {
            continue
          }
          entries.push({
            kind: 'missing',
            category: cat.name,
            order: cat.order,
            code: item.code,
            title: item.code,
            description: item.description,
            tags: item.tags,
            tagCategories: item.tagCategories,
            score: item.score
          })
          missing++
        }
      }
    }
  } else {
    // 未配置 md：全部文件作为「未分类」直接展示
    for (const f of allFiles) {
      const video = await ensureVideo(
        f,
        library,
        settings,
        { code: path.basename(f), description: '', tags: [] },
        changes
      )
      entries.push({
        kind: 'matched',
        category: '未分类',
        order: 0,
        code: path.basename(f),
        title: path.basename(f, path.extname(f)),
        description: '',
        tags: [],
        video
      })
      matched++
    }
  }

  const ignoredSet = new Set(settings.ignoredUnlistedPaths ?? [])

  // 所有未 used 的文件都生成「未收录」条目，保证忽略后仍可在主列表/「未收录」分类找到
  const unlistedAll: UnlistedFile[] = allFiles
    .filter((f) => !used.has(f))
    .map((f) => ({ fileName: path.basename(f), path: f }))

  // 对账弹窗/统计里过滤已忽略项，避免重复打扰
  const unlisted: UnlistedFile[] = unlistedAll.filter((u) => !ignoredSet.has(u.path))

  // 把未收录文件也展示出来（否则导入后列表/首页找不到），统一放到「未收录」分类
  const UNLISTED_ORDER = 9999
  for (const u of unlistedAll) {
    const existing = await findVideoByPath(u.path)
    const video =
      existing ??
      (await ensureVideo(
        u.path,
        library,
        settings,
        { code: u.fileName, description: '', tags: [] },
        changes
      ))
    const titleNoExt = path.basename(u.fileName, path.extname(u.fileName))
    entries.push({
      kind: 'matched',
      category: '未收录',
      order: UNLISTED_ORDER,
      code: titleNoExt,
      title: titleNoExt,
      description: '',
      tags: [],
      video
    })
  }

  entries.sort((a, b) => a.order - b.order || a.code.localeCompare(b.code, 'zh'))

  // 一次性批量落盘（避免逐条全量写 JSON）
  await applyVideoChanges(changes)

  onProgress?.({ libraryId: library.id, total: mdCount + allFiles.length, done: mdCount + allFiles.length })
  return {
    libraryId: library.id,
    entries,
    unlisted,
    stats: { mdCount, matched, missing, unlisted: unlisted.length },
    generatedAt: Date.now()
  }
}

export { VIDEO_EXTS }
