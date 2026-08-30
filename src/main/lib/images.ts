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
  const baseArgs = [
    '-y',
    '-i', video.path,
    '-vf', `thumbnail=n=${n},scale=480:-1`,
    '-frames:v', '1',
    '-q:v', '2',
    out
  ]
  return new Promise<string | null>((resolve) => {
    const p = spawn(exe, baseArgs, { windowsHide: true })
    // 超时兜底：thumbnail 全片分析较慢，30s 未结束强制 kill
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL') } catch {}
      resolve(null)
    }, FRAME_TIMEOUT_MS)
    p.on('error', () => { clearTimeout(timer); resolve(null) })
    p.on('close', async (code) => {
      clearTimeout(timer)
      if (code === 0) {
        try { await fs.access(out); resolve(out) } catch { resolve(null) }
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

// v2.3.11：统一子进程超时封装。
// 关键点 1：**必须消费 stdout/stderr**——损坏文件会让 ffmpeg 疯狂刷错误输出，管道缓冲区写满后
//   子进程阻塞在 write 上永远退不出来（原封面截帧没消费 stderr，这是"补齐卡死不动"的直接原因之一）。
// 关键点 2：**必须有超时**——原封面截帧（thumbnail 滤镜要解码全片）既没超时也没消费 stderr，
//   遇到损坏的 wmv 能挂几小时，整个 generatePreviewSet 不返回 → 批量补齐 worker 永久卡住。
const COVER_TIMEOUT_MS = 60_000 // 封面：thumbnail 滤镜需解码全片，给足 60s
const FRAME_TIMEOUT_MS = 30_000 // 单帧截帧

function spawnWithTimeout(
  exe: string,
  args: string[],
  timeoutMs: number,
  label: string
): Promise<{ ok: boolean; code: number | null; err: string }> {
  return new Promise((resolve) => {
    let done = false
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean, code: number | null, err = ''): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ ok, code, err })
    }
    let p: import('node:child_process').ChildProcessWithoutNullStreams
    try {
      p = spawn(exe, args, { windowsHide: true })
    } catch (e) {
      finish(false, null, (e as Error)?.message || 'spawn failed')
      return
    }
    timer = setTimeout(() => {
      void frameLog(`[${label}] timeout kill（${timeoutMs}ms）exe=${exe}`)
      try {
        p.kill('SIGKILL')
      } catch {}
      finish(false, null, `timeout ${timeoutMs}ms`)
    }, timeoutMs)
    // 消费输出：防止管道缓冲区写满把子进程卡死
    p.stdout?.on('data', () => {})
    p.stderr?.on('data', (c) => {
      if (stderr.length < 4000) stderr += String(c)
    })
    p.on('error', (e) => finish(false, null, e.message))
    p.on('close', (code) => finish(code === 0, code, stderr.slice(-400).replace(/\s+/g, ' ')))
  })
}

/** 单次截帧：在指定秒数处截取一帧（带超时 + 消费 stderr） */

async function spawnFrameAt(exe: string, videoPath: string, sec: number, out: string, settings: Settings): Promise<boolean> {
  void settings // 预留：未来 ffmpeg 参数（如 preset / 质量）可从 settings 读取
  const args = ['-y', '-ss', String(sec), '-i', videoPath, '-frames:v', '1', '-q:v', '3', out]
  void frameLog(`[spawnFrameAt] exe=${exe} sec=${sec} args=${JSON.stringify(args)}`)
  const r = await spawnWithTimeout(exe, args, FRAME_TIMEOUT_MS, 'spawnFrameAt')
  if (!r.ok) {
    void frameLog(`[spawnFrameAt] failed code=${r.code} err=${r.err}`)
    return false
  }
  try {
    await fs.access(out)
    void frameLog(`[spawnFrameAt] ok out=${out}`)
    return true
  } catch {
    void frameLog(`[spawnFrameAt] missing output file out=${out}`)
    return false
  }
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
): Promise<{ coverPath?: string; previewPaths: string[]; timedOut?: boolean } | null> {
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
  // v2.3.11：封面先跑（thumbnail 滤镜解码全片，最能暴露损坏文件），带超时 + 消费 stderr
  const coverRes = await spawnWithTimeout(
    exe,
    ['-y', '-i', video.path, '-vf', `thumbnail=n=${n},scale=480:-1`, '-frames:v', '1', '-q:v', '2', coverPath],
    COVER_TIMEOUT_MS,
    'coverThumbnail'
  )
  void frameLog(
    `[coverThumbnail] ${coverRes.ok ? 'ok' : 'failed'} id=${video.id} code=${coverRes.code} err=${coverRes.err}`
  )
  // 封面截帧**超时**（不是普通失败）= 文件损坏/结构异常的强信号，
  // 不再对其发起十余个预览帧 ffmpeg（原逻辑会继续跑，损坏文件下每个都吃满 30s 超时）
  if (!coverRes.ok && coverRes.err.startsWith('timeout')) {
    void frameLog(`[generatePreviewSet] 封面截帧超时，判定文件异常，跳过预览帧 id=${video.id}`)
    return { coverPath: undefined, previewPaths: [], timedOut: true }
  }
  const coverOk = coverRes.ok
  const previewsOk = await mapLimit(previewItems, 4, (it) =>
    spawnFrameAt(exe, video.path, it.sec, previewPathFor(video, it.i), settings)
  )
  const previewPaths = previewsOk
    .map((ok, i) => (ok ? previewPathFor(video, i) : null))
    .filter((p): p is string => p !== null)
  const finalCover = coverOk ? coverPath : previewPaths.length > 0 ? previewPaths[0] : undefined
  void frameLog(`[generatePreviewSet] result id=${video.id} coverOk=${coverOk} previewCount=${previewPaths.length} finalCover=${finalCover ?? 'none'}`)
  return { coverPath: finalCover, previewPaths, timedOut: false }
}

export { postersCacheDir, frameCachePath, generateFrame, frameLog }
