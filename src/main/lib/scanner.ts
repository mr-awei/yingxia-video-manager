import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Library, ScanProgress, Settings, Video } from '../../shared/types'
import { findVideoByPath, upsertVideo, updateVideo, listLibraries } from './repo'
import { resolvePoster, postersCacheDir } from './images'
import { isDomestic } from '../../shared/code'

export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v',
  '.mpg', '.mpeg', '.rm', '.rmvb', '.ts', '.m2ts', '.3gp', '.ogv'
])

export function idForPath(p: string): string {
  return createHash('sha1').update(p).digest('hex')
}

function cleanTitle(name: string): string {
  const noExt = name.replace(/\.[^./\\]+$/, '')
  let s = noExt
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
  s = s.replace(
    /\b(720p|1080p|2160p|4k|8k|hr|hd|fhd|uhd|web-?dl|blu-?ray|bdrip|dvdrip|hdtv|webrip|x264|x265|hevc|h\.?264|h\.?265|avc|10bit|8bit|yuv420p|ac3|aac|dts|truehd|atmos|chinese|english|双语|中英|双字|内封|外挂|合集|完整版|国语|粤语|普通话)\b/gi,
    ' '
  )
  return s.replace(/\s{2,}/g, ' ').trim()
}

export async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      const ext = path.extname(full).toLowerCase()
      if (VIDEO_EXTS.has(ext)) yield full
    }
  }
}


/**
 * 扫描媒体库文件夹，建立视频条目，再按策略富集元数据/海报。
 * onProgress 用于向渲染进程推送进度。
 */
export async function scanLibrary(
  library: Library,
  settings: Settings,
  onProgress?: (p: ScanProgress) => void
): Promise<Video[]> {
  const allFiles: string[] = []
  for await (const f of walk(library.folderPath)) allFiles.push(f)
  const total = allFiles.length
  let done = 0

  const created: Video[] = []
  for (const filePath of allFiles) {
    done++
    onProgress?.({ libraryId: library.id, total, done, current: path.basename(filePath) })
    const existing = await findVideoByPath(filePath)
    if (existing) {
      created.push(existing)
      continue
    }
    const stat = await fs.stat(filePath).catch(() => null)
    const folderName = path.basename(path.dirname(filePath))
    const video: Video = {
      id: idForPath(filePath),
      libraryId: library.id,
      path: filePath,
      fileName: path.basename(filePath),
      folderName,
      domestic: isDomestic(folderName, path.basename(filePath)),
      title: cleanTitle(path.basename(filePath)),
      tags: [],
      addedAt: Date.now(),
      fileSize: stat?.size
    }
    // 快速解析：手动/同名图/占位（不触发网络与截帧）
    const quick = await resolvePoster(video, library, settings, { allowFfmpeg: false })
    video.posterSource = quick.source
    video.posterPath = quick.posterPath
    const saved = await upsertVideo(video)
    created.push(saved)
  }

  // 富集阶段：ffmpeg 截帧兜底（并发 = settings.scanConcurrency，默认 4）
  const libraries = await listLibraries()
  const lib = libraries.find((l) => l.id === library.id) ?? library
  const needFfmpeg = lib.imagePriority.includes('ffmpeg')
  const concurrency = Math.max(1, Math.min(8, Math.floor(settings.scanConcurrency) || 4))

  let doneCount = 0
  let nextIdx = 0
  async function enrichWorker(): Promise<void> {
    while (nextIdx < created.length) {
      const i = nextIdx++
      const v = created[i]
      onProgress?.({ libraryId: library.id, total, done: total + doneCount, current: v.title })
      try {
        // 若仍无海报且策略允许，尝试 ffmpeg 截帧
        if (needFfmpeg && (!created[i].posterPath || created[i].posterSource === 'placeholder')) {
          const r = await resolvePoster(created[i], lib, settings, { allowFfmpeg: true })
          if (r.source !== 'placeholder') {
            const updated = await updateVideo(created[i].id, { posterSource: r.source, posterPath: r.posterPath })
            if (updated) created[i] = updated
          }
        }
      } catch {
        // 富集失败不影响主流程
      }
      doneCount++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, created.length) }, () => enrichWorker()))

  await postersCacheDir() // 确保缓存目录存在（无副作用）
  onProgress?.({ libraryId: library.id, total, done: total + created.length })
  return created
}
