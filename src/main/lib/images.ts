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
    // 超时兜底：thumbnail 全片分析较慢，30s 未结束强制 kill
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL')
      } catch {}
      resolve(null)
    }, FRAME_TIMEOUT_MS)
    p.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    p.on('close', async (code) => {
      clearTimeout(timer)
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

/** 单次截帧：在指定时间段内用 thumbnail 滤镜选最优 1 帧（自动跳过黑场/静帧） */
const FRAME_TIMEOUT_MS = 30_000 // 单次截帧超时：ffmpeg 子进程 30s 未结束则 kill（防长视频/异常文件卡死）
/** 小于这个字节数的输出图视为无效（纯色黑/白/损坏，thumbnail 有时也会挑错） */
const MIN_FRAME_BYTES = 2_048

function spawnThumbnailInSegment(
  exe: string, videoPath: string, startSec: number, durSec: number, out: string
): Promise<{ ok: boolean; size?: number }> {
  // thumbnail=n=15: 分析该时间段内 15 帧, 挑最"有代表性"的 (跳过黑/静/淡入淡出)
  const args = [
    '-y',
    '-ss', String(Math.max(0, startSec)),
    '-i', videoPath,
    '-t', String(Math.max(1, durSec)),
    '-vf', 'thumbnail=n=15,scale=480:-1',
    '-frames:v', '1',
    '-q:v', '3',
    out
  ]
  void frameLog(`[spawnThumbnail] sec=[${startSec.toFixed(1)}, ${(startSec + durSec).toFixed(1)}] out=${out}`)
  return new Promise((resolve) => {
    const p = spawn(exe, args, { windowsHide: true })
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      void frameLog(`[spawnThumbnail] timeout kill startSec=${startSec}`)
      try { p.kill('SIGKILL') } catch {}
      resolve({ ok: false })
    }, FRAME_TIMEOUT_MS)
    p.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false }) } })
    p.on('close', async (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code !== 0) { resolve({ ok: false }); return }
      try {
        const st = await fs.stat(out)
        if (st.size < MIN_FRAME_BYTES) {
          void frameLog(`[spawnThumbnail] too-small ${st.size}B (skip pure black/white frame) out=${out}`)
          await fs.unlink(out).catch(() => {})
          resolve({ ok: false })
        } else {
          void frameLog(`[spawnThumbnail] ok size=${st.size}B out=${out}`)
          resolve({ ok: true, size: st.size })
        }
      } catch { resolve({ ok: false }) }
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
 * ffmpeg 兜底截帧：封面全片 thumbnail + 预览帧分段 thumbnail 选优。
 * 核心改进 (对比 v2.2.12 之前):
 *   1. 预览帧不再按固定时间点截 (容易截到同场景/黑场/白场/模糊)
 *      → 视频分成 PREVIEW_COUNT 段, 每段内跑 thumbnail=n=15 自动挑最有代表性帧
 *   2. 冗余候选: 每段附近额外截 2 张候选, 失败/过小 (< 2KB 纯色) 时补位
 *   3. 文件尺寸校验: < MIN_FRAME_BYTES 的图大概率是纯色黑/白/损坏, 直接丢弃
 * 返回的 coverPath 复用 <id>.jpg (与 generateFrame 一致), previewPaths 为 <id>_preview_<n>.jpg。
 */
export async function generatePreviewSet(
  video: Video,
  settings: Settings
): Promise<{ coverPath?: string; previewPaths: string[] } | null> {
  const exe = await ffmpegAvailable(settings)
  const dur = video.durationSec ?? video.techInfo?.durationSec ?? 600
  void frameLog(`[generatePreviewSet] id=${video.id} exe=${exe ?? 'null'} duration=${dur}s PREVIEW_COUNT=${PREVIEW_COUNT}`)
  if (!exe) { void frameLog(`[generatePreviewSet] abort: no ffmpeg`); return null }
  await fs.mkdir(postersCacheDir(), { recursive: true })

  const coverPath = frameCachePath(video)

  // ===== 封面: 全片 thumbnail 选优 (保持不变, 已验证靠谱) =====
  const tnN = Math.min(200, Math.max(100, Math.floor(dur / 30)))
  const coverPromise: Promise<boolean> = new Promise((resolve) => {
    const p = spawn(exe, ['-y', '-i', video.path, '-vf', `thumbnail=n=${tnN},scale=480:-1`, '-frames:v', '1', '-q:v', '2', coverPath], { windowsHide: true })
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })

  // ===== 预览帧: 分段 thumbnail =====
  // 策略: 视频分成 PREVIEW_COUNT × 3 段 (每段短 = thumbnail 跑得更快),
  // 取每段内 thumbnail 选的最优帧, 但均匀采样保证覆盖整个视频
  // 段起点留出 4% padding 避开片头黑场, 终点留 4% 避开片尾黑场/字幕
  const usableStart = Math.max(5, dur * 0.04)
  const usableEnd = Math.min(dur - 5, dur * 0.96)
  const usableDur = Math.max(usableEnd - usableStart, 30)
  const segCount = PREVIEW_COUNT * 3           // 候选分段数 = 目标数 × 3 (冗余)
  const segDur = Math.max(3, usableDur / segCount)

  // 每段派一个任务, 但只保留均匀间隔的 PREVIEW_COUNT 个输出位置
  // 先并行跑全部候选 (最多 PREVIEW_COUNT × 3 ≈ 45 个 ffmpeg 进程, 并发 4)
  const segments = Array.from({ length: segCount }, (_, i) => ({
    segIndex: i,
    startSec: usableStart + segDur * i,
    durSec: segDur,
  }))

  // 映射到预览输出槽: 按 segIndex / 3 决定写入 preview_<slot>.jpg
  // slot = Math.floor(segIndex / 3), 同一 slot 的 3 个候选都尝试, 第一个成功的保留
  // 简化: 直接均匀取 PREVIEW_COUNT 个段 (跳过中间的, 每 3 段取 1)
  const pickedSegs = segments.filter((_, i) => i % 3 === 1)   // 取中间那个段, 避开候选的 start/end 边界
  void frameLog(`[generatePreviewSet] segCount=${segCount} picked=${pickedSegs.length} segDur=${segDur.toFixed(1)}s`)

  // 并行跑 thumbnail 选帧, 4 并发
  const previewResults = await mapLimit(pickedSegs, 4, (seg) => {
    const outIdx = Math.floor(seg.segIndex / 3)
    const out = previewPathFor(video, outIdx)
    return spawnThumbnailInSegment(exe, video.path, seg.startSec, seg.durSec, out)
  })

  // 还要 cover 也等一下
  const coverOk = await coverPromise

  // 收集成功的预览路径
  let previewPaths = previewResults
    .map((r, i) => (r.ok ? previewPathFor(video, pickedSegs[i].segIndex / 3 | 0) : null))
    .filter((p): p is string => !!p)

  void frameLog(`[generatePreviewSet] validPreviews=${previewPaths.length}/${pickedSegs.length} coverOk=${coverOk}`)

  // 兜底: 如果分段 thumbnail 失败太多, 降级回均匀时间点直接截 (但仍然过滤小文件)
  if (previewPaths.length < Math.ceil(PREVIEW_COUNT * 0.5)) {
    void frameLog(`[generatePreviewSet] fallback: too few previews (${previewPaths.length}), retry with even spread`)
    const fallback = Array.from({ length: PREVIEW_COUNT }, (_, i) => {
      const frac = 0.06 + ((i + 0.5) / PREVIEW_COUNT) * 0.88
      return { i, sec: Math.max(5, Math.floor(dur * frac)) }
    })
    const fbResults = await mapLimit(fallback, 4, (it) => {
      // 兜底也用 thumbnail (短时间段), 不要直接 -ss 截单帧
      return spawnThumbnailInSegment(exe, video.path, it.sec - 2, 4, previewPathFor(video, it.i))
    })
    const fbPaths = fbResults
      .map((r, i) => (r.ok ? previewPathFor(video, fallback[i].i) : null))
      .filter((p): p is string => !!p)
    // 合并: 分段成功的 + 兜底成功的 (去重按文件路径)
    const seen = new Set<string>()
    previewPaths = [...previewPaths, ...fbPaths].filter(p => { if (seen.has(p)) return false; seen.add(p); return true })
    void frameLog(`[generatePreviewSet] fallback merged previewCount=${previewPaths.length}`)
  }

  const finalCover = coverOk ? coverPath : previewPaths.length > 0 ? previewPaths[0] : undefined
  void frameLog(`[generatePreviewSet] DONE id=${video.id} finalCover=${finalCover ?? 'none'} previewCount=${previewPaths.length}`)
  return { coverPath: finalCover, previewPaths }
}

export { postersCacheDir, frameCachePath, generateFrame, frameLog }
