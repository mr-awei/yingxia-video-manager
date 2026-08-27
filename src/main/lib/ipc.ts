import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { IPC } from '../../shared/ipc'
import * as repo from './repo'
import { scanLibrary, walk } from './scanner'
import path from 'node:path'
import { readFileSync, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { reconcileLibrary } from './reconcile'
import { openVideo } from './player'
import { resolvePoster, generatePreviewSet, frameLog } from './images'
import { postersCacheDir } from './images'
import { cacheRemoteImage } from './javdb'
import { fetchJavdbPosterForVideo, fetchJavdbDetail } from './javdb'
import { extractBaseCode } from '../../shared/code'
import { fetchJavBusDetail } from './javbus'
import { testProxyConnectivity } from './proxy'
import { detectFfmpeg } from './ffmpegEnv'
import { applyRuntimeSettings } from './runtime'
import { findAndParseTorrents } from './torrent'
import { probeVideo } from './ffprobe'
import { previewRenames, applyRenames } from './rename'
import { watchLibraryMd, unwatchLibraryMd, syncMdWatchers } from './mdWatcher'
import { DEFAULT_IMAGE_PRIORITY, type JavdbDetail, type Library, type ScanProgress, type Settings, type Video, type ImageSource } from '../../shared/types'
import { type UpdateCheckResult, type UpdateAssetInfo } from '../../shared/api-types'

/**
 * 多源详情聚合：JavDB（最准，已有 Cookie）→ JavBus（自动绕过年龄验证）。
 * 任一源成功即返回（本地化图片后由调用方写库）；全部失败返回 null。
 */
interface MovieDetailResult {
  detail: JavdbDetail | null
  /** 命中来源（success 时） */
  source?: 'javdb' | 'javbus'
  /** 全部失败时的原因描述 */
  error?: string
}

/**
 * 把详情里的 cover 转成可写 posterPath 的本地路径。
 * javdb.ts / javbus.ts 返回的 detail.cover 已是**本地缓存路径**（内部已下载到磁盘），
 * 直接复用即可；若个别源返回 http(s) URL 则用 cacheRemoteImage 下载。
 * 返回 null 表示无可用封面（不覆盖原 posterPath）。
 */
async function resolveDetailCover(
  detail: JavdbDetail,
  videoId: string,
  settings: Settings
): Promise<string | null> {
  if (!detail.cover) return null
  const isLocal = /^[A-Za-z]:[\\/]|^file:\/\//.test(detail.cover)
  if (isLocal) {
    try {
      await fs.access(detail.cover)
      return detail.cover
    } catch {
      return null
    }
  }
  // http(s) URL → 下载本地
  return cacheRemoteImage(
    detail.cover,
    videoId,
    settings,
    detail.source === 'javbus' ? 'https://www.seedmm.bond' : 'https://javdb.com'
  ).catch(() => null)
}

/**
 * 把数据源详情回填到 Video 顶层字段（无 md 视频用得上）。
 * - actors：演员名单
 * - year / rating：缺失时从详情补全
 * - tags：合并数据源 genres（去重）
 * - title：仅当视频未受简介管理（无 descriptionSource）且当前标题就是文件名时，用数据源标题覆盖
 */
function backfillFromDetail(v: Video, detail: JavdbDetail): Partial<Video> {
  const patch: Partial<Video> = {}
  const actors = detail.actresses && detail.actresses.length ? detail.actresses : detail.actors
  if (actors && actors.length) patch.actors = actors
  if (!v.year && detail.date) {
    const y = Number(String(detail.date).slice(0, 4))
    if (!Number.isNaN(y)) patch.year = y
  }
  if (v.rating == null && detail.rating) {
    const r = parseFloat(String(detail.rating).replace(/[^0-9.]/g, ''))
    if (!Number.isNaN(r)) patch.rating = r
  }
  const mergedTags = Array.from(new Set([...(v.tags ?? []), ...(detail.genres ?? [])]))
  if (mergedTags.length) patch.tags = mergedTags
  const nameWithoutExt = v.fileName ? v.fileName.replace(/\.[^.]+$/, '') : ''
  if (!v.descriptionSource && v.title && nameWithoutExt && v.title === nameWithoutExt) {
    patch.title = detail.title
  }
  return patch
}

/** 语义化比较版本号：支持 x.y.z 与带 -beta/-rc 的 semver；a>b 返回 1，a<b 返回 -1，相等返回 0 */
function cmpVer(a: string, b: string): number {
  const parse = (v: string) => {
    const cleaned = String(v).replace(/^v/i, '')
    const [core, pre] = cleaned.split('-', 2)
    const parts = core.split('.').map((x) => parseInt(x, 10) || 0)
    return { parts, pre }
  }
  const pa = parse(a)
  const pb = parse(b)
  const n = Math.max(pa.parts.length, pb.parts.length)
  for (let i = 0; i < n; i++) {
    const x = pa.parts[i] ?? 0
    const y = pb.parts[i] ?? 0
    if (x !== y) return x - y
  }
  // 核心版本相同：有 pre-release 的版本视为更小（1.0.0-beta < 1.0.0）
  if (pa.pre && !pb.pre) return -1
  if (!pa.pre && pb.pre) return 1
  if (pa.pre && pb.pre) return pa.pre.localeCompare(pb.pre)
  return 0
}

function normalizeAsset(raw: unknown): UpdateAssetInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  const name = String(a.name || '')
  const size = Number(a.size || 0)
  const url = String(a.browser_download_url || a.direct_asset_url || a.url || '')
  if (!name || !url) return null
  return { name, size, downloadUrl: url, contentType: String(a.content_type || a.contentType || '') }
}

/** 从 release assets 中匹配 Windows x64 安装包与对应校验文件 */
function matchWindowsAsset(assets: unknown[]): { installer?: UpdateAssetInfo; checksum?: UpdateAssetInfo } {
  const list = assets.map(normalizeAsset).filter((x): x is UpdateAssetInfo => x !== null)
  const isInstaller = (a: UpdateAssetInfo) => {
    const lower = a.name.toLowerCase()
    if (!lower.endsWith('.exe') && !lower.includes('setup')) return false
    if (lower.includes('.blockmap') || lower.includes('.sha256') || lower.includes('.sha512') || lower.includes('.asc') || lower.includes('.sig')) return false
    return true
  }
  const candidates = list.filter(isInstaller)
  const score = (a: UpdateAssetInfo) => {
    const lower = a.name.toLowerCase()
    let s = 0
    if (lower.includes('x64') || lower.includes('64') || lower.includes('amd64')) s += 3
    if (lower.includes('win') || lower.includes('windows')) s += 2
    if (lower.includes('setup')) s += 1
    return s
  }
  candidates.sort((a, b) => score(b) - score(a))
  const installer = candidates[0]
  const checksum = installer
    ? list.find((a) => {
        const lower = a.name.toLowerCase()
        const base = installer.name.toLowerCase().replace(/\.exe$/, '')
        return (lower.includes('.sha256') || lower.includes('.blockmap') || lower.includes('.sha512')) && lower.includes(base)
      })
    : undefined
  return { installer, checksum }
}

function extractMinimumVersion(notes: string): string | undefined {
  const patterns = [/minVersion\s*[:：]\s*([\d.]+)/i, /minimum\s*version\s*[:：]\s*([\d.]+)/i, /最低版本\s*[:：]\s*([\d.]+)/i]
  for (const p of patterns) {
    const m = notes.match(p)
    if (m) return m[1]
  }
  return undefined
}

function detectUrgency(notes: string, minimumVersion?: string, currentVersion?: string): 'normal' | 'recommended' | 'critical' | 'mandatory' {
  if (minimumVersion && currentVersion && cmpVer(minimumVersion, currentVersion) > 0) return 'mandatory'
  const cn = notes
  const lower = notes.toLowerCase()
  if (/强制更新|mandatory|必须升级|critical|严重漏洞|安全修复/.test(cn + lower)) return 'mandatory'
  if (/breaking|不兼容|破坏性变更|数据迁移|数据库升级|重构/.test(cn + lower)) return 'critical'
  if (/recommended|建议升级|推荐更新|重要修复|performance|性能优化/.test(cn + lower)) return 'recommended'
  return 'normal'
}

async function fetchMovieDetail(code: string, settings: Settings): Promise<MovieDetailResult> {
  const mode = settings.dataSource ?? 'auto'
  const errors: string[] = []
  const onError = (m: string) => errors.push(m)
  // 手动指定源：只走该源（调试 JavBus/JavDB 用）
  if (mode === 'javdb') {
    try {
      const javdb = await fetchJavdbDetail(code, settings, onError)
      if (javdb) return { detail: javdb, source: 'javdb' }
    } catch (e) {
      errors.push(`JavDB 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'JavDB 未返回结果' }
  }
  if (mode === 'javbus') {
    try {
      const javbus = await fetchJavBusDetail(code, settings, onError)
      if (javbus) return { detail: javbus, source: 'javbus' }
    } catch (e) {
      errors.push(`JavBus 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'JavBus 未返回结果' }
  }
  // auto：JavDB → JavBus 降级
  try {
    const javdb = await fetchJavdbDetail(code, settings, onError)
    if (javdb) return { detail: javdb, source: 'javdb' }
  } catch (e) {
    errors.push(`JavDB 异常：${(e as Error)?.message || e}`)
  }
  try {
    const javbus = await fetchJavBusDetail(code, settings, onError)
    if (javbus) return { detail: javbus, source: 'javbus' }
  } catch (e) {
    errors.push(`JavBus 异常：${(e as Error)?.message || e}`)
  }
  return { detail: null, error: errors.length ? errors.join('；') : '两个数据源均未返回结果' }
}

interface SmartFetchState {
  /** JavDB 已被连续失败禁用（本轮不再尝试） */
  javdbDisabled: boolean
  javdbFails: number
  javbusFails: number
  /** 全部停止 */
  stop: boolean
}

const JAVDB_CONSECUTIVE_LIMIT = 3
const JAVBUS_CONSECUTIVE_LIMIT = 3

/**
 * 批量智能抓取：JavDB 连续失败 N 部 → 自动禁用 JavDB（本轮只走 JavBus，不再浪费请求）；
 * JavDB 禁用后 JavBus 也连续失败 N 部 → 停止整个批量（继续没有意义）。
 */
async function fetchDetailSmart(
  code: string,
  settings: Settings,
  state: SmartFetchState
): Promise<MovieDetailResult> {
  const mode = settings.dataSource ?? 'auto'
  const errors: string[] = []
  const onError = (m: string) => errors.push(m)
  if (mode === 'javdb') {
    try {
      const javdb = await fetchJavdbDetail(code, settings, onError)
      if (javdb) return { detail: javdb, source: 'javdb' }
    } catch (e) {
      errors.push(`JavDB 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'JavDB 未返回结果' }
  }
  if (mode === 'javbus') {
    try {
      const javbus = await fetchJavBusDetail(code, settings, onError)
      if (javbus) return { detail: javbus, source: 'javbus' }
    } catch (e) {
      errors.push(`JavBus 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'JavBus 未返回结果' }
  }
  if (!state.javdbDisabled) {
    try {
      const javdb = await fetchJavdbDetail(code, settings, onError)
      if (javdb) {
        state.javdbFails = 0
        return { detail: javdb, source: 'javdb' }
      }
    } catch (e) {
      errors.push(`JavDB 异常：${(e as Error)?.message || e}`)
    }
    state.javdbFails++
    if (state.javdbFails >= JAVDB_CONSECUTIVE_LIMIT) {
      state.javdbDisabled = true
      console.log(`[batch] JavDB 连续失败 ${state.javdbFails} 部，本轮自动切换 JavBus`)
    }
  }
  try {
    const javbus = await fetchJavBusDetail(code, settings, onError)
    if (javbus) {
      state.javbusFails = 0
      return { detail: javbus, source: 'javbus' }
    }
  } catch (e) {
    errors.push(`JavBus 异常：${(e as Error)?.message || e}`)
  }
  if (state.javdbDisabled) {
    state.javbusFails++
    if (state.javbusFails >= JAVBUS_CONSECUTIVE_LIMIT) {
      state.stop = true
      errors.push(`JavBus 连续失败 ${state.javbusFails} 部，已自动停止`)
    }
  }
  return { detail: null, error: errors.length ? errors.join('；') : '未知原因' }
}

function emitProgress(p: ScanProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.scanProgress, p)
  }
}

function defaultLibrary(): Library {
  return {
    id: '',
    name: '',
    folderPath: '',
    imagePriority: [...DEFAULT_IMAGE_PRIORITY],
    createdAt: 0
  }
}

/**
 * 执行一次更新检查（GitHub / Gitee），基于多维度特征判定是否有可用新版本：
 * - 版本号 semver 比较（支持 -beta/-rc）
 * - release asset 匹配：确认存在 Windows x64 Setup 安装包
 * - 发布时间、pre-release / draft 标记
 * - release notes 里的 urgency 标记（强制/重要/推荐）与最低版本要求
 * 并把结果持久化到设置：
 * - 若有可用更新：写入 pendingUpdate（版本、链接、紧急程度、资源信息）
 * - 草稿版本：不会标记为 hasUpdate，但会在结果里说明
 * - 无更新 / 出错：清空 pendingUpdate（避免陈旧提示）
 * - 始终更新 lastUpdateCheck 时间戳，供自动更新频率调度判定
 * 返回完整结果供 UI 即时展示。
 */
export async function runUpdateCheck(): Promise<UpdateCheckResult> {
  const s = await repo.getSettings()
  const source = s.updateSource ?? 'github'
  const current = app.getVersion()
  const repoPath = 'awei10/yingxia-video-manager'

  const baseResult: UpdateCheckResult = {
    source,
    currentVersion: current,
    latestVersion: '',
    hasUpdate: false,
    releaseUrl: '',
    confidence: 'none'
  }

  try {
    const r = await fetch(
      source === 'gitee'
        ? `https://gitee.com/api/v5/repos/${repoPath}/releases/latest`
        : `https://api.github.com/repos/${repoPath}/releases/latest`,
      {
        headers: {
          'User-Agent': 'yingxia',
          ...(source === 'github' ? { Accept: 'application/vnd.github+json' } : {})
        }
      }
    )
    if (!r.ok) throw new Error(`${source === 'gitee' ? 'Gitee' : 'GitHub'} API ${r.status}`)

    const j = (await r.json()) as {
      tag_name?: string
      name?: string
      html_url?: string
      body?: string
      published_at?: string
      prerelease?: boolean
      draft?: boolean
      assets?: unknown[]
    }

    const tagName = String(j.tag_name ?? '')
    const releaseName = String(j.name ?? '')
    const latest = (tagName || releaseName).replace(/^v/i, '')
    const url =
      j.html_url ??
      (source === 'gitee'
        ? `https://gitee.com/${repoPath}/releases`
        : `https://github.com/${repoPath}/releases`)
    const notes = typeof j.body === 'string' ? j.body : ''
    const publishedAt = typeof j.published_at === 'string' ? j.published_at : undefined
    const isPrerelease = !!j.prerelease
    const isDraft = !!j.draft

    const minimumVersion = extractMinimumVersion(notes)
    const urgency = detectUrgency(notes, minimumVersion, current)

    const assets = Array.isArray(j.assets) ? j.assets : []
    const { installer, checksum } = matchWindowsAsset(assets)
    const assetMatched = !!installer

    const versionNewer = latest ? cmpVer(latest, current) > 0 : false
    // 草稿不应向用户推送；pre-release 仍视为有更新，但会标记
    const hasUpdate = versionNewer && !isDraft
    const confidence = hasUpdate ? (assetMatched ? 'full' : 'partial') : latest ? 'none' : 'none'

    const result: UpdateCheckResult = {
      ...baseResult,
      latestVersion: latest,
      hasUpdate,
      releaseUrl: url,
      notes: notes.slice(0, 1000) || undefined,
      publishedAt,
      isPrerelease,
      isDraft,
      assetMatched,
      asset: installer,
      checksumAsset: checksum,
      urgency,
      minimumVersion,
      confidence,
      error: !latest ? '无法解析版本号' : undefined
    }

    try {
      await repo.saveSettings({
        lastUpdateCheck: Date.now(),
        pendingUpdate: result.hasUpdate && result.releaseUrl
          ? {
              version: result.latestVersion,
              url: result.releaseUrl,
              urgency: result.urgency,
              publishedAt: result.publishedAt,
              assetName: result.asset?.name,
              assetSize: result.asset?.size
            }
          : null
      })
    } catch {
      /* 持久化失败不影响本次返回 */
    }

    return result
  } catch (e) {
    const err = (e as Error)?.message ?? '检查更新失败'
    try {
      await repo.saveSettings({ lastUpdateCheck: Date.now(), pendingUpdate: null })
    } catch {
      /* 持久化失败不影响本次返回 */
    }
    return { ...baseResult, error: err }
  }
}

export function registerIpc(): void {
  // 同步 MD watcher（启动/库变化时）
  void syncMdWatchers(repo.listLibraries)

  // ---------- 媒体库 ----------
  ipcMain.handle(IPC.libraryList, () => repo.listLibraries())
  ipcMain.handle(IPC.libraryAdd, async (_e, input: Omit<Library, 'id' | 'createdAt'>) => {
    const lib = await repo.addLibrary(input)
    watchLibraryMd(lib)
    return lib
  })
  ipcMain.handle(IPC.libraryRemove, async (_e, id: string) => {
    unwatchLibraryMd(id)
    await repo.removeLibrary(id)
  })
  ipcMain.handle(IPC.libraryUpdate, async (_e, id: string, patch: Partial<Library>) => {
    const lib = await repo.updateLibrary(id, patch)
    if (lib) watchLibraryMd(lib)
    return lib
  })

  // ---------- 对账（MD 驱动 + 文件夹对账） ----------
  ipcMain.handle(IPC.libraryReconcile, async (_e, libraryId: string) => {
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) throw new Error('媒体库不存在')
    const settings = await repo.getSettings()
    return reconcileLibrary(lib, settings, emitProgress)
  })

  // ---------- 视频 ----------
  ipcMain.handle(IPC.videoList, (_e, filter: any) => repo.listVideos(filter ?? {}))
  ipcMain.handle(IPC.videoGet, (_e, id: string) => repo.getVideo(id))
  ipcMain.handle(IPC.videoUpdate, (_e, id: string, patch: any) => repo.updateVideo(id, patch))
  ipcMain.handle(IPC.videoScan, async (_e, libraryId: string) => {
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) throw new Error('媒体库不存在')
    const settings = await repo.getSettings()
    return scanLibrary(lib, settings, emitProgress)
  })
  ipcMain.handle(IPC.videoOpen, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const settings = await repo.getSettings()
    return openVideo(v, settings)
  })
  ipcMain.handle(IPC.videoRegeneratePoster, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const lib = (await repo.listLibraries()).find((l) => l.id === v.libraryId) ?? defaultLibrary()
    const settings = await repo.getSettings()
    const r = await resolvePoster(v, lib, settings, { allowFfmpeg: true })
    return repo.updateVideo(id, { posterSource: r.source, posterPath: r.posterPath })
  })

  // ---------- javdb 封面抓取 ----------
  ipcMain.handle(IPC.videoFetchJavdbPoster, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const settings = await repo.getSettings()
    const localPath = await fetchJavdbPosterForVideo(v, settings)
    if (!localPath) return null
    return repo.updateVideo(id, { posterSource: 'javdb', posterPath: localPath })
  })

  // ---------- javdb 详情抓取 ----------
  ipcMain.handle(IPC.videoFetchJavdbDetail, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const settings = await repo.getSettings()
    // 搜索源：title → folderName → fileName
    const code = (v.title || v.folderName || v.fileName || '').trim()
    if (!code) return null
    const mr = await fetchMovieDetail(code, settings)
    if (!mr.detail) return { ok: false as const, error: mr.error || '未获取到数据' }
    await repo.updateVideo(id, { javdbDetail: mr.detail, ...backfillFromDetail(v, mr.detail) })
    // **列表/详情封面同步**：详情抓取成功且有真实封面，但视频当前是 ffmpeg 截帧 / 占位 / 无封面时，
    // 用 detail.cover 覆盖（否则列表页还是错误的视频帧）
    const coverLocal = await resolveDetailCover(mr.detail, id, settings)
    if (coverLocal) {
      await repo.updateVideo(id, { posterSource: mr.detail.source ?? 'javdb', posterPath: coverLocal })
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) {
          w.webContents.send(IPC.javdbFetched, { videoId: id, posterPath: coverLocal, posterSource: mr.detail.source ?? 'javdb' })
        }
      }
    }
    return { ok: true as const, detail: mr.detail, source: mr.source ?? ('javdb' as const) }
  })

  ipcMain.handle(IPC.libraryFetchJavdbAll, async (_e, libraryId: string, force = false) => {
    console.log('[ipc] libraryFetchJavdbAll libraryId=', libraryId, 'force=', force)
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) throw new Error('媒体库不存在')
    const settings = await repo.getSettings()
    const videos = await repo.listVideos({ libraryId })
    if (videos.length === 0) {
      emitProgress({ libraryId, total: 0, done: 0 })
      return 0
    }
    // 抓取并发数 / 间隔（限速、降风控），Settings 中可配
    const baseConcurrency = Math.max(1, Math.min(8, Math.floor(settings.fetchConcurrency) || 2))
    const baseInterval = Math.max(0, Math.floor(settings.fetchIntervalMs) || 600)
    // 强制重抓模式：每部都重搜，量极大；并发降到 1、间隔 2 秒，避免触发 JavDB 反爬 (HTTP 403)。
    // 普通补齐保持用户配置的并发/间隔。
    const concurrency = force ? 1 : baseConcurrency
    const interval = force ? 3000 : baseInterval
    let done = 0
    let ok = 0
    let failed = 0
    const bySource: { javdb: number; javbus: number } = { javdb: 0, javbus: 0 }
    const failures: Array<{ title: string; reason: string }> = []
    const smartState: SmartFetchState = { javdbDisabled: false, javdbFails: 0, javbusFails: 0, stop: false }
    // 系列去重：同 base code 只抓一次，其余分集复用（HUNTA-468CD1/CD2 → 抓一次）
    const seriesCache = new Map<string, JavdbDetail>()
    let idx = 0
    const worker = async () => {
      while (idx < videos.length && !smartState.stop) {
        const v = videos[idx++]
        emitProgress({ libraryId, total: videos.length, done, current: v.title })

        // 0) 国产片（纯中文文件夹）：不抓 JavDB/JavBus 元数据，仅用 ffmpeg 截帧（封面 + 15 预览）
        if (v.domestic) {
          const needFrame = !v.posterPath || v.posterSource === 'placeholder' || !v.previewPaths?.length
          if (needFrame) {
            const set = await generatePreviewSet(v, settings).catch(() => null)
            if (set && (set.coverPath || set.previewPaths.length)) {
              const patch: Partial<Video> = {}
              if (set.coverPath) {
                patch.posterSource = 'ffmpeg'
                patch.posterPath = set.coverPath
              }
              if (set.previewPaths.length) patch.previewPaths = set.previewPaths
              await repo.updateVideo(v.id, patch)
              if (set.coverPath) {
                for (const w of BrowserWindow.getAllWindows()) {
                  if (!w.isDestroyed()) {
                    w.webContents.send(IPC.javdbFetched, { videoId: v.id, posterPath: set.coverPath })
                  }
                }
              }
              ok++
            }
          }
          done++
          emitProgress({ libraryId, total: videos.length, done, current: v.title })
          continue
        }

        // 1) 封面：仅缺封面/占位图才抓。force 不重抓海报——海报是图片、URL 基本不变，
        //    本地缓存命中即可；重抓只会浪费 JavDB/JavBus 请求额度并加剧 403。
        if (!v.posterPath || v.posterSource === 'placeholder') {
          // JavDB 抓封面 → 失败则 ffmpeg 批量截帧兜底（1 封面 + 15 预览图，保证真实画面 + 横屏预览墙素材）
          const javdbPoster = await fetchJavdbPosterForVideo(v, settings)
          let localPath: string | null = javdbPoster
          let source: ImageSource = 'javdb'
          let previews: string[] | undefined
          if (!localPath) {
            const set = await generatePreviewSet(v, settings).catch(() => null)
            if (set?.coverPath) {
              localPath = set.coverPath
              source = 'ffmpeg'
            }
            if (set?.previewPaths?.length) previews = set.previewPaths
          }
          if (localPath) {
            const patch: Partial<Video> = { posterSource: source, posterPath: localPath }
            if (previews && previews.length) patch.previewPaths = previews
            await repo.updateVideo(v.id, patch)
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) {
                w.webContents.send(IPC.javdbFetched, { videoId: v.id, posterPath: localPath })
              }
            }
            ok++
          }
          await new Promise((r) => setTimeout(r, interval))
        }

        // 2) 缺详情或详情陈旧（含远程 URL） → 抓详情
        const d = v.javdbDetail
        // parseVer !== 2：旧解析器写入的数据（演员可能混入男演员），需要重抓覆盖；
        // parseVer === 2：新版解析器已重抓成功，跳过以节省 JavDB 请求额度（避免触发 403）。
        const detailStale =
          !d ||
          d.parseVer !== 2 ||
          (d.cover ? /^https?:\/\//.test(d.cover) : false) ||
          (d.samples ? d.samples.some((s) => /^https?:\/\//.test(s)) : false)
        const fetchCode = v.title || v.folderName || v.fileName || ''
        const base = extractBaseCode(fetchCode)
        // 同系列已在本次抓取过 → 直接复用，不重复请求
        const seriesHit = base && base !== fetchCode.toUpperCase() ? seriesCache.get(base) : undefined
        if (seriesHit) {
          await repo.updateVideo(v.id, { javdbDetail: seriesHit, ...backfillFromDetail(v, seriesHit) })
          ok++
          const src = seriesHit.source ?? 'javdb'
          bySource[src] = (bySource[src] ?? 0) + 1
        } else if (force || detailStale) {
          // 智能抓取：JavDB 连续失败自动切 JavBus；JavBus 也连续失败自动停止
          const mr = await fetchDetailSmart(fetchCode, settings, smartState)
          if (mr.detail) {
            if (base) seriesCache.set(base, mr.detail)
            await repo.updateVideo(v.id, { javdbDetail: mr.detail, ...backfillFromDetail(v, mr.detail) })
            // **关键**：如果之前的封面是 ffmpeg 兜底（无 JavDB 海报时），但 detail.cover 有真实海报
            // （JavBus 来源常见），用 detail.cover 下载本地海报覆盖错误的截帧，保证列表/详情一致
            if (
              mr.detail.cover &&
              (v.posterSource === 'ffmpeg' || v.posterSource === 'placeholder' || !v.posterPath)
            ) {
              const coverLocal = await resolveDetailCover(mr.detail, v.id, settings)
              if (coverLocal) {
                await repo.updateVideo(v.id, { posterSource: mr.detail.source ?? 'javbus', posterPath: coverLocal })
                for (const w of BrowserWindow.getAllWindows()) {
                  if (!w.isDestroyed()) {
                    w.webContents.send(IPC.javdbFetched, { videoId: v.id, posterPath: coverLocal, posterSource: mr.detail.source ?? 'javbus' })
                  }
                }
              }
            }
            ok++
            const src = mr.detail.source ?? 'javdb'
            bySource[src] = (bySource[src] ?? 0) + 1
          } else {
            failed++
            failures.push({ title: v.title, reason: mr.error || '未知原因' })
          }
          await new Promise((r) => setTimeout(r, interval))
        }
        if (smartState.stop) break
        done++
        emitProgress({ libraryId, total: videos.length, done, current: v.title })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, videos.length) }, () => worker()))
    emitProgress({ libraryId, total: videos.length, done: videos.length })
    return {
      ok,
      failed,
      bySource,
      failures,
      stopped: smartState.stop,
      remaining: smartState.stop ? Math.max(0, videos.length - idx) : 0
    }
  })

  // ---------- 设置 ----------
  ipcMain.handle(IPC.settingsGet, () => repo.getSettings())
  ipcMain.handle(IPC.settingsSet, async (_e, patch: any) => {
    const saved = await repo.saveSettings(patch)
    // 运行时设置即时生效：开机自启 / 最小化到托盘
    const s = await repo.getSettings()
    applyRuntimeSettings(s)
    return saved
  })
  // ---------- 卸载应用（危险操作） ----------
  ipcMain.handle(IPC.appUninstall, async () => {
    try {
      // NSIS 卸载程序与主程序同目录：Uninstall <productName>.exe
      const dir = path.dirname(process.execPath)
      const candidates = ['Uninstall 影匣.exe', 'Uninstall.exe']
      for (const name of candidates) {
        const p = path.join(dir, name)
        try {
          await fs.access(p)
          // 静默卸载（NSIS /S 参数），卸载程序自己会关闭应用
          const child = spawn(p, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true })
          child.unref()
          return { ok: true }
        } catch {
          /* 继续找下一个 */
        }
      }
      return { ok: false, error: '未找到卸载程序（开发模式无卸载入口）' }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || '卸载失败' }
    }
  })
  ipcMain.handle(IPC.dialogSelectFolder, async () => {
    const res = await dialog.showOpenDialog({
      title: '第 1 步 · 选择视频文件夹',
      buttonLabel: '选择此文件夹',
      message: '影匣会扫描该文件夹及子文件夹里的全部视频文件，生成你的海报墙。',
      properties: ['openDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.dialogSelectFile, async () => {
    const res = await dialog.showOpenDialog({
      title: '第 2 步 · 选择简介 md 文件（可跳过）',
      buttonLabel: '选择此文件',
      message: '这个 md 文件里是每部影片的中文简介、标签、评分和分类。没有的话可以先跳过，之后用内置向导生成。',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.openPath, async (_e, p: string) => {
    try {
      await shell.openPath(p)
    } catch {
      // 忽略打开失败
    }
  })

  // ---------- 内置规范文档（新建 md 文件向导）：读取打包资源中的规范全文 ----------
  ipcMain.handle(IPC.specGet, () => {
    const candidates = [
      path.join(process.resourcesPath, '通用评分与简介规范.md'),
      path.join(app.getAppPath(), 'src/main/assets/通用评分与简介规范.md'),
      path.join(app.getAppPath(), '..', 'src/main/assets/通用评分与简介规范.md')
    ]
    for (const c of candidates) {
      try {
        const content = readFileSync(c, 'utf-8')
        return { content, path: c }
      } catch {
        // 尝试下一个候选路径
      }
    }
    return { content: '', path: '' }
  })

  // ---------- 批量导出番号清单（新建 md 文件向导第一步） ----------
  ipcMain.handle(IPC.libraryExportCodes, async (_e, libraryId: string) => {
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) return { ok: false, count: 0, codes: [], error: '媒体库不存在' }
    // 扫描文件夹，收集所有视频文件的「番号」（文件名去扩展名，去重 + 排序）
    const files: string[] = []
    for await (const f of walk(lib.folderPath)) files.push(f)
    const seen = new Set<string>()
    const codes: string[] = []
    for (const f of files) {
      const base = path.basename(f)
      const ext = path.extname(f)
      const name = base.slice(0, base.length - ext.length)
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      codes.push(name)
    }
    codes.sort((a, b) => a.localeCompare(b, 'zh'))
    const res = await dialog.showSaveDialog({
      title: '导出番号清单',
      defaultPath: `${lib.name}-番号清单.txt`,
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, count: codes.length, codes, error: '已取消' }
    await fs.writeFile(res.filePath, codes.join('，') + '\n', 'utf-8')
    // 同时复制到剪贴板，方便直接粘贴给 AI
    try {
      clipboard.writeText(codes.join('，'))
    } catch {
      // 复制失败不影响文件导出
    }
    return { ok: true, path: res.filePath, count: codes.length, codes }
  })

  // ---------- 仅扫描媒体库番号清单（不弹保存对话框、不写文件，供向导打开时自动加载） ----------
  ipcMain.handle(IPC.libraryGetCodes, async (_e, libraryId: string) => {
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) return { count: 0, codes: [] }
    const files: string[] = []
    for await (const f of walk(lib.folderPath)) files.push(f)
    const seen = new Set<string>()
    const codes: string[] = []
    for (const f of files) {
      const base = path.basename(f)
      const ext = path.extname(f)
      const name = base.slice(0, base.length - ext.length)
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      codes.push(name)
    }
    codes.sort((a, b) => a.localeCompare(b, 'zh'))
    return { count: codes.length, codes }
  })

  // ---------- 分享：扫描 .torrent → 磁链 → 复制 ----------
  ipcMain.handle(IPC.videoShareTorrents, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const dir = path.dirname(v.path)
    const items = await findAndParseTorrents(dir)
    const itemsRsp = items.map((t) => ({ name: t.name, size: t.size, infoHash: t.infoHash, magnet: t.magnet }))
    if (itemsRsp.length === 0) return { dir, copied: false, items: [] }
    clipboard.writeText(itemsRsp[0].magnet)
    return { dir, copied: true, items: itemsRsp }
  })

  // ---------- ffprobe 技术参数 ----------
  ipcMain.handle(IPC.videoProbe, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const settings = await repo.getSettings()
    const info = await probeVideo(v.path, settings)
    if (!info) return null
    return repo.updateVideo(id, { techInfo: info })
  })

  // ---------- 应用信息 ----------
  ipcMain.handle(IPC.appInfo, () => {
    // 读取 CHANGELOG.md 顶部（最近一版），优先 packaged 资源，回退 dev 项目根
    let changelog = ''
    const candidates = [
      path.join(process.resourcesPath, 'CHANGELOG.md'),
      path.join(app.getAppPath(), 'CHANGELOG.md'),
      path.join(app.getAppPath(), '..', 'CHANGELOG.md')
    ]
    for (const c of candidates) {
      try {
        const raw = readFileSync(c, 'utf-8')
        // 保留第一个版本段落：截到「第二个一级标题」之前（仅有单个版本时全保留）
        const first = raw.indexOf('\n## ')
        if (first >= 0) {
          const second = raw.indexOf('\n## ', first + 1)
          changelog = raw.slice(0, second > 0 ? second : raw.length).trim()
        } else {
          changelog = raw.trim()
        }
        break
      } catch {
        // 尝试下一个候选路径
      }
    }
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node ?? '',
      chrome: process.versions.chrome ?? '',
      dataDir: app.getPath('userData'),
      changelog
    }
  })
  // ---------- 打开外部链接 ----------
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    try {
      await shell.openExternal(url)
    } catch {
      // 忽略打开失败
    }
  })

  // 复制文本到剪贴板（sandbox preload 无法访问 clipboard 模块，必须在主进程做）
  ipcMain.handle(IPC.copyText, async (_e, text: string) => {
    try {
      clipboard.writeText(text)
    } catch {
      // 忽略复制失败
    }
  })

  ipcMain.handle(IPC.shellRevealInFolder, async (_e, p: string) => {
    try {
      shell.showItemInFolder(p)
    } catch {
      // 忽略
    }
  })

  // ---------- 批量改名（清理文件名广告） ----------
  ipcMain.handle(IPC.libraryPreviewRenames, async (_e, libraryId: string) => {
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) throw new Error('媒体库不存在')
    const settings = await repo.getSettings()
    const ignoredSet = new Set(settings.ignoredUnlistedPaths ?? [])
    return previewRenames(
      lib.folderPath,
      async (p) => (await repo.findVideoByPath(p)) !== null,
      (p) => ignoredSet.has(p)
    )
  })

  ipcMain.handle(
    IPC.libraryApplyRenames,
    async (_e, libraryId: string, items: Array<{ path: string; newName: string }>) => {
      const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
      if (!lib) throw new Error('媒体库不存在')
      const result = await applyRenames(items)
      // 改名成功的文件若已有 video 记录（同路径变更），清理旧记录，下次对账重建
      for (const item of items) {
        const v = await repo.findVideoByPath(item.path)
        if (v) await repo.removeVideo(v.id)
      }
      return result
    }
  )

  // ---------- 代理测试连接 ----------
  ipcMain.handle(IPC.proxyTest, async (_e, settings: any) => {
    return testProxyConnectivity(settings ?? {})
  })

  // ---------- 清理海报缓存目录 ----------
  ipcMain.handle(IPC.cacheClear, async () => {
    try {
      const dir = postersCacheDir()
      const entries = await fs.readdir(dir, { withFileTypes: true })
      let removed = 0
      for (const e of entries) {
        if (e.isFile()) {
          await fs.unlink(path.join(dir, e.name))
          removed++
        }
      }
      return { ok: true, removed }
    } catch {
      return { ok: true, removed: 0 }
    }
  })

  // ---------- ffmpeg 运行环境检测（系统优先，检测到系统版自动删除捆绑版释放磁盘） ----------
  ipcMain.handle(IPC.ffmpegStatus, async () => {
    const settings = await repo.getSettings()
    return detectFfmpeg(settings)
  })

  // ---------- 隐私锁：设置 / 校验 / 退出 ----------
  ipcMain.handle(IPC.lockSet, async (_e, password: string) => {
    // password 为空 → 清除锁
    if (!password) {
      await repo.saveSettings({ lockHash: undefined, lockSalt: undefined })
      return
    }
    const salt = randomBytes(16).toString('hex')
    const hash = createHash('sha256').update(salt + password).digest('hex')
    await repo.saveSettings({ lockHash: hash, lockSalt: salt })
  })

  ipcMain.handle(IPC.lockVerify, async (_e, password: string) => {
    const s = await repo.getSettings()
    if (!s.lockHash || !s.lockSalt) return false
    const hash = createHash('sha256').update(s.lockSalt + password).digest('hex')
    return hash === s.lockHash
  })

  ipcMain.handle(IPC.appQuit, () => {
    app.quit()
  })

  // ---------- 检查更新（GitHub / Gitee） ----------
  ipcMain.handle(IPC.updateCheck, (): Promise<UpdateCheckResult> => runUpdateCheck())

  // ---------- ffmpeg 批量截帧：1 封面 + 15 预览图 ----------
  ipcMain.handle(IPC.videoGeneratePreviews, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    await frameLog(`[videoGeneratePreviews] start id=${id} domestic=${v.domestic ?? false} path=${v.path}`)
    const settings = await repo.getSettings()
    const set = await generatePreviewSet(v, settings)
    if (!set || (!set.coverPath && set.previewPaths.length === 0)) {
      await frameLog(`[videoGeneratePreviews] no images id=${id}`)
      return null
    }
    const patch: Partial<Video> = {}
    if (set.coverPath) {
      patch.posterSource = 'ffmpeg'
      patch.posterPath = set.coverPath
    }
    if (set.previewPaths.length) patch.previewPaths = set.previewPaths
    await frameLog(`[videoGeneratePreviews] update id=${id} cover=${set.coverPath ?? 'none'} previews=${set.previewPaths.length}`)
    return repo.updateVideo(id, patch)
  })
}
