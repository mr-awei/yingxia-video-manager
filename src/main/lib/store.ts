import { app } from 'electron'
import { promises as fs, mkdirSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Library, type Settings, type Video } from '../../shared/types'
import type { JavdbDetail } from '../../shared/types'

export interface DBShape {
  libraries: Library[]
  videos: Video[]
  settings: Settings
  /** 数据结构迁移的最后版本号，用于启动时只跑新增迁移；缺失视为 v0（v2.2.12 及以前）*/
  schemaVersion?: number
}

const DEFAULT_DB: DBShape = {
  libraries: [],
  videos: [],
  settings: { ...DEFAULT_SETTINGS }
}

/** v2.2.13 schemaVersion：标签分层（tagCategories / backupTags）已完成迁移 */
export const SCHEMA_VERSION = 2026083001

let cache: DBShape | null = null
let dbPath = ''
// v2.3.9 外部修改检测：data.json 可能被外部工具/另一实例改写（如数据修复脚本、手动编辑），
// 内存缓存若永不重载，会用陈旧数据覆盖磁盘（丢数据）或把陈旧 entries 写进 reconcile-cache
// （列表看不到新写入的时长/元数据，"点详情再返回才刷新"）。每次取 DB 前比对新 mtime，
// 发现外部修改即丢弃内存重载。lastSelfWrite 记录自己写盘的 mtime，避免把自己的写当外部修改。
let lastSelfWriteMs = 0
let lastLoadMs = 0
const STAT_THROTTLE_MS = 1000
let lastStatMs = 0

// v2.2.10-fix5：写盘 debounce——连续写入合并为一次落盘（300ms 窗口），
// 避免连点收藏/改名等单条操作每次都全量序列化 4.7MB data.json（几百 ms 卡顿）。
// 批量场景（批量补齐 fix4 已合并）同样受益。进程退出前 flushSave 保证不丢数据。
const SAVE_DEBOUNCE_MS = 300
let saveTimer: NodeJS.Timeout | null = null
let pendingWrite: Promise<void> | null = null

function resolveDbPath(): string {
  const userData = app.getPath('userData')
  return path.join(userData, 'data.json')
}

async function ensureLoaded(): Promise<DBShape> {
  if (!dbPath) dbPath = resolveDbPath()
  // 外部修改检测（1s 节流）：磁盘 mtime 既不是自己写的也不是上次加载的 → 内存已陈旧，丢弃重载
  if (cache) {
    const now = Date.now()
    if (now - lastStatMs > STAT_THROTTLE_MS) {
      lastStatMs = now
      try {
        const st = await fs.stat(dbPath)
        if (st.mtimeMs !== lastSelfWriteMs && st.mtimeMs !== lastLoadMs) {
          console.log('[store] 检测到 data.json 被外部修改，重载内存缓存')
          cache = null
        }
      } catch {
        /* 文件暂时不可访问（被占用等）：保守沿用内存 */
      }
    }
    if (cache) return cache
  }
  try {
    const raw = await fs.readFile(dbPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DBShape> & { schemaVersion?: number }
    const current: DBShape = {
      schemaVersion: parsed.schemaVersion,
      libraries: parsed.libraries ?? [],
      videos: parsed.videos ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
    }
    migrateInPlace(current)
    cache = current
    const st = await fs.stat(dbPath).catch(() => null)
    lastLoadMs = st?.mtimeMs ?? 0
    lastSelfWriteMs = 0
  } catch {
    // 文件不存在或解析失败 -> 用默认值（新 schema）
    cache = structuredClone(DEFAULT_DB)
    cache.schemaVersion = SCHEMA_VERSION
    lastLoadMs = 0
    lastSelfWriteMs = 0
  }
  return cache
}

/** v2.2.13 标签分层迁移（一次性）：
 *  - 保证每个 Video 至少 tags=[], tagCategories 字段存在或为 undefined（正确类型）
 *  - 若视频同时有「文档来源」(descriptionSource==='manual' 或 reconciliation 写过 tags) + javdbDetail.genres：
 *    原来 mergedTags 已经把 genres 合并进 tags，迁移把「genres 里不是文档平铺 tags 子集的部分」移到 backupTags，
 *    避免数据源标签与文档标签混在一起（等价于把 backfillFromDetail 的旧合并行为 undo 一部分）。
 *  - schemaVersion < SCHEMA_VERSION 才执行，之后不重复跑。
 */
function migrateInPlace(db: DBShape): void {
  const from = db.schemaVersion ?? 0
  if (from >= SCHEMA_VERSION) return
  let moved = 0
  for (const v of db.videos) {
    // tags 必须存在（旧数据 JSON 可能缺）
    if (!Array.isArray(v.tags)) (v as Video & { tags?: unknown }).tags = []
    const doc = v as Video & { tagCategories?: Record<string, string[]>; backupTags?: string[]; javdbDetail?: JavdbDetail }
    const docTagSet = new Set<string>()
    if (doc.tagCategories) for (const list of Object.values(doc.tagCategories)) for (const t of list) docTagSet.add(t)
    for (const t of v.tags) docTagSet.add(t)
    const genres = doc.javdbDetail?.genres ?? []
    if (genres.length > 0 && (v.descriptionSource === 'manual' || v.tags.length > 0 || doc.tagCategories)) {
      // 有文档权威标签：把 genres 中「不属于文档标签集合」的项移到 backupTags，去除旧合并的冗余
      const movedTags: string[] = []
      for (const g of genres) if (!docTagSet.has(g)) movedTags.push(g)
      if (movedTags.length) {
        // 不覆盖已经存在的用户/数据迁移写过的 backupTags，合并去重
        const old = Array.isArray(doc.backupTags) ? doc.backupTags : []
        const merged = Array.from(new Set([...old, ...movedTags]))
        doc.backupTags = merged
        // 从 tags 里去掉这些非文档项（undo 旧版 backfill 的合并行为）
        if (v.tags.some((t) => movedTags.includes(t))) {
          v.tags = v.tags.filter((t) => !movedTags.includes(t))
        }
        moved++
      }
    } else if (genres.length > 0 && !v.tags.length && !doc.tagCategories && !doc.backupTags?.length) {
      // 无文档：原来 tags 可能被旧版合并填进了 genres，或者一直是空；把 genres 放 backupTags 做主标签
      doc.backupTags = Array.from(new Set(genres))
    }
  }
  db.schemaVersion = SCHEMA_VERSION
  console.log(`[store] schema migrate v${from} -> v${SCHEMA_VERSION}：迁移了 ${moved} 条视频的数据源标签至 backupTags`)
}

async function writeNow(): Promise<void> {
  const data = cache ?? (await ensureLoaded())
  if (!dbPath) dbPath = resolveDbPath()
  const dir = path.dirname(dbPath)
  await fs.mkdir(dir, { recursive: true })
  // v2.2.13 原子写盘：先写临时文件再 rename 覆盖，避免写盘中途崩溃/断电导致
  // data.json 截断损坏（4.7MB 全量序列化窗口内风险）。rename 是同目录原子操作。
  const tmp = `${dbPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await fs.rename(tmp, dbPath)
  // 记录自己写盘后的 mtime：外部修改检测以此为基准区分"自己写的"和"别人改的"
  const st = await fs.stat(dbPath).catch(() => null)
  lastSelfWriteMs = st?.mtimeMs ?? Date.now()
  lastLoadMs = lastSelfWriteMs
}

/** 触发一次防抖写盘；返回本次合并批次的完成 Promise（同一 debounce 窗口内的多次写入合并为一次） */
export function scheduleSave(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer)
  if (!pendingWrite) {
    pendingWrite = new Promise<void>((resolve) => {
      saveTimer = setTimeout(() => {
        saveTimer = null
        void writeNow()
          .catch((e) => console.error('[store] 落盘失败:', (e as Error)?.message || e))
          .finally(() => {
            pendingWrite = null
            resolve()
          })
      }, SAVE_DEBOUNCE_MS)
    })
  }
  return pendingWrite
}

/** 立即落盘（进程退出前调用，保证 debounce 窗口内的写入不丢） */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pendingWrite) {
    await pendingWrite.catch(() => {})
    // 可能有新的写入发生在 await 之后，再兜底一次
  }
  try {
    await writeNow()
  } catch (e) {
    console.error('[store] 落盘失败:', (e as Error)?.message || e)
  }
}

export async function getDB(): Promise<DBShape> {
  return ensureLoaded()
}

export async function saveDB(): Promise<void> {
  await scheduleSave()
}

/** 工具：在修改后自动落盘（防抖合并，立即返回不阻塞调用方） */
export async function mutate<T>(fn: (db: DBShape) => T): Promise<T> {
  const db = await ensureLoaded()
  const result = fn(db)
  scheduleSave()
  return result
}

// 进程退出前同步兜底落盘（debounce 未触发/进行中也能保住最新数据）
app.on('before-quit', () => {
  if (cache && dbPath) {
    try {
      mkdirSync(path.dirname(dbPath), { recursive: true })
      const tmp = `${dbPath}.tmp`
      writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
      try {
        // renameSync 在 Windows 上目标存在时会抛 EEXIST/EPERM，先删旧再 rename
        if (existsSync(dbPath)) unlinkSync(dbPath)
        renameSync(tmp, dbPath)
      } catch {
        // 跨设备或权限失败：退化为直接写（尽力而为，不因清理失败丢数据）
        writeFileSync(dbPath, JSON.stringify(cache, null, 2), 'utf-8')
      }
    } catch (e) {
      console.error('[store] 退出前落盘失败:', (e as Error)?.message || e)
    }
  }
})
