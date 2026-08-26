/**
 * ffmpeg/ffprobe 运行环境检测与磁盘整理。
 *
 * 版本策略（v1.1.0）：
 *  - 安装包捆绑 UPX 版 ffmpeg（resources/ffmpeg/bin，62MB）作离线兜底；
 *  - 但**系统已装 ffmpeg 的电脑应完全复用系统版**，并**删除捆绑版**释放 62MB 磁盘；
 *  - 查找优先级（运行时）：设置 ffmpegPath > 系统 PATH/常见目录 > 捆绑版。
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Settings } from '../../shared/types'

/** 捆绑版 ffmpeg 目录（安装器/extraResources 位置） */
export function bundledFfmpegDir(): string {
  // process.resourcesPath 在 Electron 运行时始终存在；纯 node 测试环境可能 undefined，防御兜底
  const base = process.resourcesPath || process.cwd()
  return path.join(base, 'ffmpeg')
}

export function bundledFfmpegPath(): string {
  return path.join(bundledFfmpegDir(), 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
}

export function bundledFfprobePath(): string {
  return path.join(bundledFfmpegDir(), 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
}

/** 探测 exe 是否可运行（spawn -version） */
function probeExecutable(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(exe, ['-version'], { windowsHide: true })
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
}

/** 判断一个绝对路径的 ffmpeg.exe 是否真实可用 */
async function isUsable(exe: string): Promise<boolean> {
  try {
    await fs.access(exe)
  } catch {
    return false
  }
  return probeExecutable(exe)
}

/** 常见系统安装位置（PATH 之外的常用目录） */
const COMMON_DIRS = [
  'C:\\ffmpeg\\bin',
  'C:\\ffmpeg\\bin64',
  'C:\\Program Files\\ffmpeg\\bin',
  'C:\\Program Files (x86)\\ffmpeg\\bin'
]

/**
 * 检测当前 ffmpeg 来源。
 * 优先级：settings.ffmpegPath（custom）> 系统 PATH（system）> 常见目录（system）> 捆绑版（bundled）> missing
 * 检测到系统版时，尝试删除捆绑版释放磁盘（删除失败不阻塞，返回 note）。
 */
export async function detectFfmpeg(
  settings: Settings
): Promise<{
  source: 'custom' | 'system' | 'bundled' | 'missing'
  path?: string
  bundledRemoved?: boolean
  note?: string
}> {
  // 1) 手动指定
  const custom = settings.ffmpegPath?.trim()
  if (custom) {
    if (await isUsable(custom)) {
      await tryRemoveBundled()
      return { source: 'custom', path: custom, bundledRemoved: true }
    }
    // 指定的路径不可用 → 继续向下探测
  }

  // 2) 系统 PATH
  const inPath = await probeExecutable('ffmpeg')
  if (inPath) {
    await tryRemoveBundled()
    return { source: 'system', path: 'ffmpeg（PATH）', bundledRemoved: true }
  }

  // 3) 常见安装目录
  for (const dir of COMMON_DIRS) {
    const cand = path.join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    if (await isUsable(cand)) {
      await tryRemoveBundled()
      return { source: 'system', path: cand, bundledRemoved: true }
    }
  }

  // 4) 捆绑版兜底
  if (await isUsable(bundledFfmpegPath())) {
    return { source: 'bundled', path: bundledFfmpegPath() }
  }

  // 5) 缺失
  return {
    source: 'missing',
    note:
      '未检测到 ffmpeg：视频封面截帧与分辨率探测将不可用。' +
      '可到设置中手动指定 ffmpeg.exe 路径，或安装 ffmpeg（下载 gyan.dev 的 essentials 版解压即可）。'
  }
}

/** 尝试删除捆绑版 ffmpeg（62MB），删除失败静默忽略（如 Program Files 无写权限） */
async function tryRemoveBundled(): Promise<boolean> {
  const dir = bundledFfmpegDir()
  try {
    await fs.access(dir)
    await fs.rm(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 运行时可执行路径解析：custom > PATH > bundled（供 images/ffprobe 使用） */
export async function resolveFfmpegExe(settings: Settings): Promise<string | null> {
  const custom = settings.ffmpegPath?.trim()
  if (custom && (await isUsable(custom))) return custom
  if (await probeExecutable('ffmpeg')) return 'ffmpeg'
  if (await isUsable(bundledFfmpegPath())) return bundledFfmpegPath()
  return null
}

/** 运行时可执行路径解析：优先 ffmpeg 同目录 ffprobe，其次系统，其次捆绑 */
export async function resolveFfprobeExe(settings: Settings): Promise<string | null> {
  const custom = settings.ffmpegPath?.trim()
  if (custom) {
    const cand = path.join(
      path.dirname(custom),
      process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    )
    if (await isUsable(cand)) return cand
  }
  if (await probeExecutable('ffprobe')) return 'ffprobe'
  if (await isUsable(bundledFfprobePath())) return bundledFfprobePath()
  return null
}
