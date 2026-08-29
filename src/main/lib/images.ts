import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { Library, Settings, Video, ImageSource } from '../../shared/types'
import { resolveFfmpegExe } from './ffmpegEnv'

/** 截帧诊断日志：写到 userData/logs/ffmpeg-frame.log，便于排查“点了截帧但不出图” */
function frameLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'ffmpeg-frame.log')
}
async function frameLog(msg: string): Promise<void> {
  try {
    const p = frameLogPath()
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.appendFile(p, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8')
  } catch {
    /* 日志失败不阻塞业务 */
  }
}

const POSTER_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']
/** 视频文件夹里常见的通用封面文件名（无需与视频同名） */
const GENERIC_POSTER_NAMES = [
  'poster',
  'cover',
  'folder',
  'front',
  'fanart',
  'thumb',
  'cover-art'
]

function postersCacheDir(): string {
  return path.join(app.getPath('userData'), 'posters')
}

/** 查找视频所在目录下的封面图（同名 / 外文件夹同名 / 通用名） */
export async function findSidecar(videoPath: string): Promise<string | null> {
  const dir = path.dirname(videoPath)
  const base = path.basename(videoPath, path.extname(videoPath))
  const folder = path.basename(dir)
  // 候选名：视频同名、外文件夹同名、通用封面名
  const candidates: string[] = [base, folder, ...GENERIC_POSTER_NAMES]
  for (const name of candidates) {
    for (const ext of POSTER_EXTS) {
      const candidate = path.join(dir, name + ext)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        // 继续尝试
      }
    }
  }
  return null
}

function frameCachePath(video: Video): string {
  return path.join(postersCacheDir(), `${video.id}.jpg`)
}

/** 解析 ffmpeg 可执行文件路径是否可用（优先级：设置 > 系统 PATH/常见目录 > 捆绑版兜底） */
async function ffmpegAvailable(settings: Settings): Promise<string | null> {
  return resolveFfmpegExe(settings)
}

async function generateFrame(video: Video, settings: Settings): Promise<string | null> {
  const exe = await ffmpegAvailable(settings)
  if (!exe) return null
  const out = frameCachePath(video)
  await fs.mkdir(postersCacheDir(), { recursive: true })
  // ffmpeg `thumbnail` 滤镜：分析 N 帧后自动选最具代表性的一帧（避免黑场/静帧/淡入淡出）。
  // 官方推荐做法：https://ffmpeg.org/ffmpeg-filters.html#thumbnail-1
  // n=100 覆盖常见短片；超长片（>2h）按比例放大 n 但封顶 200 避免太慢
  const dur = video.durationSec ?? 0
  const n = Math.min(200, Math.max(100, Math.floor(dur / 30)))
  return new Promise<string | null>((resolve) => {
    const p = spawn(
      exe,
      [
        '-y',
        '-i', video.path,
        '-vf', `thumbnail=n=${n},scale=480:-1`,
        '-frames:v', '1',
        '-q:v', '2',
        out
      ],
      { windowsHide: true }
    )
    p.on('error', () => resolve(null))
    p.on('close', async (code) => {
      if (code === 0) {
        try {
          await fs.access(out)
          resolve(out)
        } catch {
          resolve(null)
        }
      } else resolve(null)
    })
  })
}

export interface ResolvedPoster {
  source: ImageSource
  posterPath?: string
}

/**
 * 按媒体库 imagePriority 顺序解析海报来源。
 * allowFfmpeg=false 时跳过生成（扫描阶段用，避免阻塞）。
 */
export async function resolvePoster(
  video: Video,
  library: Library,
  settings: Settings,
  opts: { allowFfmpeg: boolean }
): Promise<ResolvedPoster> {
  for (const source of library.imagePriority) {
    switch (source) {
      case 'manual':
        if (video.posterSource === 'manual' && video.posterPath) {
          try {
            await fs.access(video.posterPath)
            return { source: 'manual', posterPath: video.posterPath }
          } catch {
            /* 文件丢失，继续 */
          }
        }
        break
      case 'sidecar': {
        const p = await findSidecar(video.path)
        if (p) return { source: 'sidecar', posterPath: p }
        break
      }
      case 'javdb':
      case 'javbus':
      case 'javlibrary':
        // 只复用已抓取的数据源缓存；抓取动作由「从数据源获取封面 / 批量补全」显式触发
        if (
          (video.posterSource === 'javdb' || video.posterSource === 'javbus' || video.posterSource === 'javlibrary') &&
          video.posterPath
        ) {
          try {
            await fs.access(video.posterPath)
            return { source: video.posterSource, posterPath: video.posterPath }
          } catch {
            /* 缓存丢失，继续 */
          }
        }
        break
      case 'ffmpeg': {
        // 已有截帧缓存则复用
        if (video.posterSource === 'ffmpeg' && video.posterPath) {
          try {
            await fs.access(video.posterPath)
            return { source: 'ffmpeg', posterPath: video.posterPath }
          } catch {
            /* 缓存丢失 */
          }
        }
        if (opts.allowFfmpeg) {
          const p = await generateFrame(video, settings)
          if (p) return { source: 'ffmpeg', posterPath: p }
        }
        break
      }
      case 'placeholder':
        return { source: 'placeholder' }
    }
  }
  return { source: 'placeholder' }
}

/** 横屏预览图数量（随机截帧） */
export const PREVIEW_COUNT = 15

function previewPathFor(video: Video, i: number): string {
  return path.join(postersCacheDir(), `${video.id}_preview_${i}.jpg`)
}

/** 单次截帧：在指定秒数处截取一帧 */
function spawnFrameAt(exe: string, videoPath: string, sec: number, out: string): Promise<boolean> {
  const args = ['-y', '-ss', String(sec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', out]
  void frameLog(`[spawnFrameAt] exe=${exe} sec=${sec} out=${out} args=${JSON.stringify(args)}`)
  return new Promise<boolean>((resolve) => {
    const p = spawn(exe, args, { windowsHide: true })
    let done = false
    let stderr = ''
    p.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    p.on('error', (err) => {
      if (!done) {
        done = true
        void frameLog(`[spawnFrameAt] error exe=${exe} err=${err.message}`)
        resolve(false)
      }
    })
    p.on('close', async (code) => {
      if (done) return
      done = true
      const errTail = stderr.slice(-400).replace(/\s+/g, ' ')
      if (code === 0) {
        try {
          await fs.access(out)
          void frameLog(`[spawnFrameAt] ok out=${out}`)
          resolve(true)
        } catch {
          void frameLog(`[spawnFrameAt] missing output file out=${out}`)
          resolve(false)
        }
      } else {
        void frameLog(`[spawnFrameAt] failed code=${code} err=${errTail}`)
        resolve(false)
      }
    })
  })
}

/** 限制并发的 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let idx = 0
  const worker = async () => {
    while (idx < items.length) {
      const cur = idx++
      results[cur] = await fn(items[cur])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/**
 * ffmpeg 兜底截帧：随机时间点截 1 张封面 + PREVIEW_COUNT 张预览图。
 * 用于实在获取不到封面/截图时（无 JavDB 海报、无侧车图），保证每部视频都有真实画面。
 * 返回的 coverPath 复用 <id>.jpg（与 generateFrame 一致），previewPaths 为 <id>_preview_<n>.jpg。
 */
export async function generatePreviewSet(
  video: Video,
  settings: Settings
): Promise<{ coverPath?: string; previewPaths: string[] } | null> {
  const exe = await ffmpegAvailable(settings)
  void frameLog(`[generatePreviewSet] id=${video.id} exe=${exe ?? 'null'} path=${video.path} durationSec=${video.durationSec ?? video.techInfo?.durationSec ?? 'unset'}`)
  if (!exe) {
    void frameLog(`[generatePreviewSet] abort: no ffmpeg`)
    return null
  }
  await fs.mkdir(postersCacheDir(), { recursive: true })
  const dur = video.durationSec ?? video.techInfo?.durationSec ?? 600
  const coverPath = frameCachePath(video)
  // 封面：用 thumbnail 滤镜（官方推荐，自动选最具代表性帧）避免黑场/静帧
  const n = Math.min(200, Math.max(100, Math.floor(dur / 30)))
  const previewItems = Array.from({ length: PREVIEW_COUNT }, (_, i) => {
    const frac = 0.06 + ((i + 0.5) / PREVIEW_COUNT) * 0.88
    return { i, sec: Math.max(5, Math.floor(dur * frac)) }
  })
  // 并行：封面用 thumbnail 滤镜；预览图按时间点散布
  const [coverOk, previewsOk] = await Promise.all([
    new Promise<boolean>((resolve) => {
      const p = spawn(
        exe,
        [
          '-y',
          '-i', video.path,
          '-vf', `thumbnail=n=${n},scale=480:-1`,
          '-frames:v', '1',
          '-q:v', '2',
          coverPath
        ],
        { windowsHide: true }
      )
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0))
    }),
    mapLimit(previewItems, 4, (it) => spawnFrameAt(exe, video.path, it.sec, previewPathFor(video, it.i)))
  ])
  const previewPaths = previewsOk
    .map((ok, i) => (ok ? previewPathFor(video, i) : null))
    .filter((p): p is string => p !== null)
  const finalCover = coverOk ? coverPath : previewPaths.length > 0 ? previewPaths[0] : undefined
  void frameLog(`[generatePreviewSet] result id=${video.id} coverOk=${coverOk} previewCount=${previewPaths.length} finalCover=${finalCover ?? 'none'}`)
  return { coverPath: finalCover, previewPaths }
}

export { postersCacheDir, frameCachePath, generateFrame, frameLog }
