import { randomUUID } from 'node:crypto'
import { getDB, mutate, saveDB } from './store'
import type { Library, Settings, Video, VideoFilter } from '../../shared/types'
import { DEFAULT_IMAGE_PRIORITY } from '../../shared/types'

// ---------- 设置 ----------
export async function getSettings(): Promise<Settings> {
  const db = await getDB()
  return db.settings
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  return mutate((db) => {
    db.settings = { ...db.settings, ...patch }
    return db.settings
  })
}

// ---------- 媒体库 ----------
export async function listLibraries(): Promise<Library[]> {
  const db = await getDB()
  return [...db.libraries].sort((a, b) => a.createdAt - b.createdAt)
}

export async function addLibrary(input: Omit<Library, 'id' | 'createdAt'>): Promise<Library> {
  return mutate((db) => {
    const lib: Library = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now()
    }
    db.libraries.push(lib)
    return lib
  })
}

export async function updateLibrary(id: string, patch: Partial<Library>): Promise<Library | null> {
  return mutate((db) => {
    const lib = db.libraries.find((l) => l.id === id)
    if (!lib) return null
    Object.assign(lib, patch)
    return lib
  })
}

export async function removeLibrary(id: string): Promise<void> {
  await mutate((db) => {
    db.libraries = db.libraries.filter((l) => l.id !== id)
    db.videos = db.videos.filter((v) => v.libraryId !== id)
  })
}

// ---------- 视频 ----------
export async function getVideo(id: string): Promise<Video | null> {
  const db = await getDB()
  return db.videos.find((v) => v.id === id) ?? null
}

export async function upsertVideo(video: Video): Promise<Video> {
  return mutate((db) => {
    const idx = db.videos.findIndex((v) => v.id === video.id)
    if (idx >= 0) db.videos[idx] = video
    else db.videos.push(video)
    return video
  })
}

export async function updateVideo(id: string, patch: Partial<Video>): Promise<Video | null> {
  return mutate((db) => {
    const v = db.videos.find((x) => x.id === id)
    if (!v) return null
    Object.assign(v, patch)
    return v
  })
}

export async function removeVideo(id: string): Promise<void> {
  await mutate((db) => {
    db.videos = db.videos.filter((v) => v.id !== id)
  })
}

/** 按路径查重，避免重复扫描 */
export async function findVideoByPath(p: string): Promise<Video | null> {
  const db = await getDB()
  return db.videos.find((v) => v.path === p) ?? null
}

// ---------- 批量写盘（对账/扫描时避免逐条 saveDB 全量写 JSON） ----------

export type VideoChange =
  | { type: 'upsert'; video: Video }
  | { type: 'update'; video: Video }
  | { type: 'remove'; id: string }

/** 把一批视频变更一次性应用到内存 DB 并落盘（只写一次） */
export async function applyVideoChanges(changes: VideoChange[]): Promise<void> {
  if (changes.length === 0) return
  const db = await getDB()
  // v2.3.10：用 Map 建 id→下标索引（原逐条 findIndex 是 O(n²)——4494 条变更 × 6253 条记录
  // ≈ 2800 万次字符串比较，大库对账落盘明显卡顿）。remove 数量通常极少，先 filter 再建索引。
  const removeIds: string[] = []
  for (const c of changes) if (c.type === 'remove') removeIds.push(c.id)
  if (removeIds.length > 0) {
    const rm = new Set(removeIds)
    db.videos = db.videos.filter((v) => !rm.has(v.id))
  }
  const index = new Map<string, number>()
  for (let i = 0; i < db.videos.length; i++) {
    const id = db.videos[i].id
    if (!index.has(id)) index.set(id, i)
  }
  for (const c of changes) {
    if (c.type === 'remove') continue
    const idx = index.get(c.video.id)
    if (idx !== undefined) db.videos[idx] = c.video
    else {
      index.set(c.video.id, db.videos.length)
      db.videos.push(c.video)
    }
  }
  await saveDB()
}

export function applyFilter(videos: Video[], filter: VideoFilter): Video[] {
  let list = [...videos]
  if (filter.libraryId) list = list.filter((v) => v.libraryId === filter.libraryId)
  if (filter.tag) list = list.filter((v) => v.tags.includes(filter.tag!))
  if (filter.search) {
    const q = filter.search.trim().toLowerCase()
    if (q) list = list.filter((v) => v.title.toLowerCase().includes(q) || v.fileName.toLowerCase().includes(q) || (v.description ?? '').toLowerCase().includes(q))
  }
  const sort = filter.sort ?? 'added'
  const dir = filter.desc ? -1 : 1
  list.sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, 'zh') * dir
    if (sort === 'year') return ((a.year ?? 0) - (b.year ?? 0)) * dir
    if (sort === 'lastPlayed') return ((a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0)) * dir
    if (sort === 'random') return Math.random() - 0.5
    return ((a.addedAt ?? 0) - (b.addedAt ?? 0)) * dir
  })
  return list
}

export async function listVideos(filter: VideoFilter): Promise<Video[]> {
  const db = await getDB()
  return applyFilter(db.videos, filter)
}

export async function allTags(): Promise<string[]> {
  const db = await getDB()
  const set = new Set<string>()
  for (const v of db.videos) for (const t of v.tags) set.add(t)
  return [...set].sort()
}

export { DEFAULT_IMAGE_PRIORITY }
