import { app } from 'electron'
import { promises as fs } from 'node:fs'
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

export async function getDB(): Promise<DBShape> {
  return ensureLoaded()
}

export async function saveDB(): Promise<void> {
  const data = await ensureLoaded()
  if (!dbPath) dbPath = resolveDbPath()
  const dir = path.dirname(dbPath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(dbPath, JSON.stringify(data, null, 2), 'utf-8')
}

/** 工具：在修改后自动落盘 */
export async function mutate<T>(fn: (db: DBShape) => T): Promise<T> {
  const db = await ensureLoaded()
  const result = fn(db)
  await saveDB()
  return result
}
