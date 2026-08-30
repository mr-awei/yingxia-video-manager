import { app } from 'electron'
import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_SETTINGS, type Library, type Settings, type Video } from '../../shared/types'

export interface DBShape {
  libraries: Library[]
  videos: Video[]
  settings: Settings
}

const DEFAULT_DB: DBShape = {
  libraries: [],
  videos: [],
  settings: { ...DEFAULT_SETTINGS }
}

let cache: DBShape | null = null
let dbPath = ''

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
  if (cache) return cache
  dbPath = resolveDbPath()
  try {
    const raw = await fs.readFile(dbPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<DBShape>
    cache = {
      libraries: parsed.libraries ?? [],
      videos: parsed.videos ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) }
    }
  } catch {
    // 文件不存在或解析失败 -> 用默认值
    cache = structuredClone(DEFAULT_DB)
  }
  return cache
}

async function writeNow(): Promise<void> {
  const data = cache ?? (await ensureLoaded())
  if (!dbPath) dbPath = resolveDbPath()
  const dir = path.dirname(dbPath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(dbPath, JSON.stringify(data, null, 2), 'utf-8')
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
      writeFileSync(dbPath, JSON.stringify(cache, null, 2), 'utf-8')
    } catch (e) {
      console.error('[store] 退出前落盘失败:', (e as Error)?.message || e)
    }
  }
})
