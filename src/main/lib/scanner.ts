import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Library, ScanProgress, Settings, Video } from '../../shared/types'
import { findVideoByPath, upsertVideo, updateVideo, listLibraries } from './repo'
import { resolvePoster, postersCacheDir, generatePreviewSet } from './images'
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

export async function* walk(dir: string, minSizeBytes = 0): AsyncGenerator<string> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full, minSizeBytes)
    } else if (entry.isFile()) {
      const ext = path.extname(full).toLowerCase()
      if (VIDEO_EXTS.has(ext)) {
        // 大小过滤：跳过小于 minSizeBytes 的文件（过滤短视频/广告样片；0 = 不过滤）
        if (minSizeBytes > 0) {
          // stat 失败时保守保留（不跳过，避免网络盘/权限异常时误过滤）
          const st = await fs.stat(full).catch(() => null)
          if (st && st.size < minSizeBytes) continue
        }
        yield full
      }
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
  // 扫描最小文件大小过滤：0 = 不限；小于阈值的视频（短视频/广告等）不进媒体库。
  // 只影响本次扫描**新建**的条目；已入库的视频不受影响（避免误删既有数据）。
  const minSizeBytes = Math.max(0, Math.floor(settings.scanMinSizeMB ?? 0)) * 1024 * 1024
  const allFiles: string[] = []
  for await (const f of walk(library.folderPath, minSizeBytes)) allFiles.push(f)
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
  // 兜底策略：无论 imagePriority 是否包含 ffmpeg，只要视频最终没有封面（数据源抓不到）就截帧显示
  const concurrency = Math.max(1, Math.min(8, Math.floor(settings.scanConcurrency) || 4))

  let doneCount = 0
  let nextIdx = 0
  async function enrichWorker(): Promise<void> {
    while (nextIdx < created.length) {
      const i = nextIdx++
      const v = created[i]
      onProgress?.({ libraryId: library.id, total, done: total + doneCount, current: v.title })
      try {
        // 无海报 → 尝试 resolvePoster（含 ffmpeg 生成）；仍无则直接 ffmpeg 截帧兜底
        if (!created[i].posterPath || created[i].posterSource === 'placeholder') {
          const r = await resolvePoster(created[i], lib, settings, { allowFfmpeg: true })
          if (r.source !== 'placeholder') {
            const updated = await updateVideo(created[i].id, {
              posterSource: r.source,
              posterPath: r.posterPath,
              posterPathFfmpeg: r.source === 'ffmpeg' ? r.posterPath : created[i].posterPathFfmpeg
            })
            if (updated) created[i] = updated
          } else {
            // 优先级链最终仍是占位 → 强制 ffmpeg 截帧兜底（保证有真实画面）
            const set = await generatePreviewSet(created[i], settings)
            if (set?.coverPath) {
              const updated = await updateVideo(created[i].id, {
                posterSource: 'ffmpeg',
                posterPath: set.coverPath,
                posterPathFfmpeg: set.coverPath,
                previewPaths: set.previewPaths
              })
              if (updated) created[i] = updated
            }
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
