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
import { extractBaseCode, extractCode } from '../../shared/code'
import { fetchJavBusDetail } from './javbus'
import { fetchJavLibraryDetail } from './javlibrary'
import { fetchJavinfoDetail, hasJavinfoKey } from './javinfo'
import { fetchJavapiDetail, hasJavapiConfig } from './javapi'
import { testProxyConnectivity } from './proxy'
import { detectFfmpeg } from './ffmpegEnv'
import { applyRuntimeSettings } from './runtime'
import { findAndParseTorrents } from './torrent'
import { probeVideo, probeImage } from './ffprobe'
import { previewRenames, applyRenames } from './rename'
import { watchLibraryMd, unwatchLibraryMd, syncMdWatchers } from './mdWatcher'
import { DEFAULT_IMAGE_PRIORITY, type JavdbDetail, type Library, type ScanProgress, type Settings, type Video, type ImageSource, type UpdateSource } from '../../shared/types'
import { type UpdateCheckResult, type UpdateAssetInfo } from '../../shared/api-types'

/**
 * 多源详情聚合：JavDB（最准，已有 Cookie）→ JavBus（自动绕过年龄验证）。
 * 任一源成功即返回（本地化图片后由调用方写库）；全部失败返回 null。
 */
interface MovieDetailResult {
  detail: JavdbDetail | null
  /** 命中来源（success 时） */
  source?: 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'
  /** 全部失败时的原因描述 */
  error?: string
}

/**
 * 把详情里的 cover 转成可写 posterPath 的本地路径。
 * javdb.ts / javbus.ts 返回的 detail.cover 已是**本地缓存路径**（内部已下载到磁盘），
 * 直接复用即可；若个别源返回 http(s) URL 则用 cacheRemoteImage 下载。
 * 返回 null 表示无可用封面（不覆盖原 posterPath）。
 */
/**
 * 封面替换前的图片有效性验证：ffprobe 能读出分辨率且不小于阈值。
 * javapi/javdb 下载的封面可能是损坏/截断/空内容的坏图（文件存在但 ffprobe 读不出尺寸），
 * 直接替换会覆盖现有 ffmpeg 截帧导致黑屏，必须验证通过才允许替换。
 */
async function isCoverUsable(filePath: string, settings: Settings): Promise<boolean> {
  const dim = await probeImage(filePath, settings)
  if (!dim) return false
  // 正常 JAV 封面至少几百像素；<100px 视为坏图/占位
  return dim.width >= 100 && dim.height >= 100
}

/**
 * 把详情里的 cover 转成可写 posterPath 的本地路径。
 * javdb.ts / javbus.ts 返回的 detail.cover 已是**本地缓存路径**（内部已下载到磁盘），
 * 直接复用即可；若个别源返回 http(s) URL 则用 cacheRemoteImage 下载。
 * **替换前必须通过 isCoverUsable 验证（分辨率正常），验证失败返回 null（不覆盖原 posterPath）。**
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
      if (!(await isCoverUsable(detail.cover, settings))) {
        // 损坏的本地封面：删除坏文件（避免后续复用），不替换
        await fs.unlink(detail.cover).catch(() => {})
        return null
      }
      return detail.cover
    } catch {
      return null
    }
  }
  // http(s) URL → 下载本地。key 用 `cover-<CODE>` 而非 videoId：
  // 避免与 ffmpeg 截帧封面 <videoId>.jpg 同名冲突（下载坏图会覆盖掉可用截帧）。
  const coverKey = detail.code ? `cover-${detail.code.toUpperCase()}` : videoId
  const local = await cacheRemoteImage(
    detail.cover,
    coverKey,
    settings,
    detail.source === 'javbus' ? 'https://www.seedmm.bond' : detail.source === 'javinfo' ? 'https://api.javinfo.dev' : 'https://javdb.com'
  ).catch(() => null)
  if (!local) return null
  // 下载后验证分辨率：损坏/全黑/截断的图不替换（避免用坏图覆盖现有 ffmpeg 截帧）
  if (!(await isCoverUsable(local, settings))) {
    await fs.unlink(local).catch(() => {})
    return null
  }
  return local
}

/**
 * 删除该视频的 ffmpeg 截帧预览图（<videoId>_preview_<n>.jpg）。
 * 封面文件 <videoId>.jpg 会被真实封面下载覆盖复用，不删；只清截帧预览图，
 * 避免「真实封面 + 截帧预览」同时在磁盘/记录里残留。
 */
async function removeFfmpegPreviewFiles(videoId: string): Promise<void> {
  try {
    const dir = postersCacheDir()
    const entries = await fs.readdir(dir)
    const prefix = `${videoId}_preview_`
    for (const f of entries) {
      const lower = f.toLowerCase()
      if (lower.startsWith(prefix) && lower.endsWith('.jpg')) {
        await fs.unlink(path.join(dir, f)).catch(() => {})
      }
    }
  } catch {
    /* 缓存目录不存在 */
  }
}

/** 从详情里取本地化的真实预览图（截图已缓存到本地，跳过远程 URL） */
function localSamples(detail: JavdbDetail | null | undefined): string[] {
  return (detail?.samples ?? []).filter((s) => !!s && !/^https?:\/\//.test(s))
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

/**
 * 清理某个视频的关联缓存文件（封面 / ffmpeg 截图 / javdb/javbus 下载的信息图）。
 * 命名规则（均在 postersCacheDir 下）：
 * - 视频专属：`<videoId>.jpg` + `<videoId>_preview_N.jpg`（封面 + ffmpeg 预览）
 * - 按番号共享：`javdb-cover-<CODE>.jpg` / `javdb-sample-<CODE>-N.jpg`、
 *   `javbus-cover-<CODE>.jpg` / `javbus-sample-<CODE>-N.jpg`
 * 共享文件删除前检查：若其他视频仍引用同一文件（同系列多分集共用元数据），则保留。
 * 返回删除的文件数。
 */
async function cleanVideoCacheFiles(video: Video): Promise<{ removed: number; kept: number }> {
  try {
    const cacheDir = postersCacheDir()
    let entries: string[]
    try {
      entries = await fs.readdir(cacheDir)
    } catch {
      return { removed: 0, kept: 0 } // 缓存目录不存在
    }

    // 该视频引用的缓存文件（优先精确收集）
    const referencedByVideo = new Set<string>()
    if (video.posterPath) referencedByVideo.add(path.normalize(video.posterPath))
    for (const p of video.previewPaths ?? []) referencedByVideo.add(path.normalize(p))

    // 番号（用于 javdb/javbus 共享缓存匹配）
    const detailCode = video.javdbDetail?.code ?? video.title ?? ''
    const code = extractCode(detailCode).toUpperCase()
    const prefixes = new Set<string>()
    prefixes.add(`${video.id}`)
    if (code) {
      prefixes.add(`javdb-cover-${code}`)
      prefixes.add(`javdb-sample-${code}`)
      prefixes.add(`javbus-cover-${code}`)
      prefixes.add(`javbus-sample-${code}`)
      prefixes.add(`javlibrary-cover-${code}`)
      prefixes.add(`javlibrary-sample-${code}`)
    }

    // 其他视频仍在引用的缓存文件（同系列多分集共享）——不可删
    const stillReferenced = new Set<string>()
    try {
      const others = await repo.listVideos({})
      for (const o of others) {
        if (o.id === video.id) continue
        if (o.posterPath) stillReferenced.add(path.normalize(o.posterPath))
        for (const p of o.previewPaths ?? []) stillReferenced.add(path.normalize(p))
      }
    } catch {
      /* 拿不到引用列表时保守处理：不删共享文件，只删视频专属文件 */
    }

    let removed = 0
    let kept = 0
    for (const f of entries) {
      const lower = f.toLowerCase()
      const matched = [...prefixes].some((p) => lower.startsWith(p.toLowerCase()))
      if (!matched) continue
      const abs = path.join(cacheDir, f)
      // 视频专属文件（videoId 前缀）且被本视频引用过 → 直接删
      // 共享文件（javdb/javbus）→ 仅当无其他视频引用才删
      if (stillReferenced.has(path.normalize(abs))) {
        kept++
        continue
      }
      try {
        await fs.unlink(abs)
        removed++
      } catch {
        kept++
      }
    }
    return { removed, kept }
  } catch {
    return { removed: 0, kept: 0 }
  }
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
  // 手动指定源：只走该源（调试 Javapi/Javinfo/JavBus/JavDB/JavLibrary 用）
  if (mode === 'javapi') {
    try {
      const javapi = await fetchJavapiDetail(code, settings, onError)
      if (javapi) return { detail: javapi, source: 'javapi' }
    } catch (e) {
      errors.push(`Javapi 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'Javapi 未返回结果' }
  }
  if (mode === 'javinfo') {
    try {
      const javinfo = await fetchJavinfoDetail(code, settings, onError)
      if (javinfo) return { detail: javinfo, source: 'javinfo' }
    } catch (e) {
      errors.push(`Javinfo 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'Javinfo 未返回结果' }
  }
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
  if (mode === 'javlibrary') {
    try {
      const javlibrary = await fetchJavLibraryDetail(code, settings, onError)
      if (javlibrary) return { detail: javlibrary, source: 'javlibrary' }
    } catch (e) {
      errors.push(`JavLibrary 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'JavLibrary 未返回结果' }
  }
  // auto：Javapi（本地免费，优先）→ Javinfo（免风控）→ JavDB → JavBus → JavLibrary 降级
  if (hasJavapiConfig(settings)) {
    try {
      const javapi = await fetchJavapiDetail(code, settings, onError)
      if (javapi) return { detail: javapi, source: 'javapi' }
    } catch (e) {
      errors.push(`Javapi 异常：${(e as Error)?.message || e}`)
    }
  } else {
    errors.push('未配置本地 Javapi，跳过')
  }
  if (hasJavinfoKey(settings)) {
    try {
      const javinfo = await fetchJavinfoDetail(code, settings, onError)
      if (javinfo) return { detail: javinfo, source: 'javinfo' }
    } catch (e) {
      errors.push(`Javinfo 异常：${(e as Error)?.message || e}`)
    }
  } else {
    errors.push('未配置 Javinfo key，跳过')
  }
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
  try {
    const javlibrary = await fetchJavLibraryDetail(code, settings, onError)
    if (javlibrary) return { detail: javlibrary, source: 'javlibrary' }
  } catch (e) {
    errors.push(`JavLibrary 异常：${(e as Error)?.message || e}`)
  }
  return { detail: null, error: errors.length ? errors.join('；') : '多个数据源均未返回结果' }
}

interface SmartFetchState {
  /** Javapi 已被连续失败禁用（本轮不再尝试，本地服务可能没起） */
  javapiDisabled: boolean
  javapiFails: number
  /** Javinfo 已被连续失败禁用（本轮不再尝试，保留免费额度） */
  javinfoDisabled: boolean
  javinfoFails: number
  /** JavDB 已被连续失败禁用（本轮不再尝试） */
  javdbDisabled: boolean
  javdbFails: number
  javbusFails: number
  /** 全部停止 */
  stop: boolean
}

const JAVAPI_CONSECUTIVE_LIMIT = 3
const JAVINFO_CONSECUTIVE_LIMIT = 3
const JAVDB_CONSECUTIVE_LIMIT = 3
const JAVBUS_CONSECUTIVE_LIMIT = 3

/**
 * 批量智能抓取：Javapi（本地免费）→ Javinfo（免风控）→ JavDB → JavBus → JavLibrary 降级。
 * 任一源连续**网络失败** N 部 → 本轮自动禁用该源（不再浪费请求）；
 * 注意：「搜索无结果 / 无法识别番号」属正常结果（该番号数据源确实没有），**不计数、不触发停止**——
 * 只有真正的网络/会话异常（请求失败、超时、年龄验证失败等）才累计失败次数，
 * 避免「IP 没被封、只是数据源没这个番号」时批量被误停；JavBus 作为最后兜底，连续网络失败即停止整批（防空转）。
 */
async function fetchDetailSmart(
  code: string,
  settings: Settings,
  state: SmartFetchState
): Promise<MovieDetailResult> {
  const mode = settings.dataSource ?? 'auto'
  const errors: string[] = []
  const onError = (m: string) => errors.push(m)
  if (mode === 'javapi') {
    try {
      const javapi = await fetchJavapiDetail(code, settings, onError)
      if (javapi) return { detail: javapi, source: 'javapi' }
    } catch (e) {
      errors.push(`Javapi 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'Javapi 未返回结果' }
  }
  if (mode === 'javinfo') {
    try {
      const javinfo = await fetchJavinfoDetail(code, settings, onError)
      if (javinfo) return { detail: javinfo, source: 'javinfo' }
    } catch (e) {
      errors.push(`Javinfo 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errors.length ? errors.join('；') : 'Javinfo 未返回结果' }
  }
  if (mode === 'javdb') {
    const errs: string[] = []
    try {
      const javdb = await fetchJavdbDetail(code, settings, (m) => errs.push(m))
      if (javdb) return { detail: javdb, source: 'javdb' }
    } catch (e) {
      errs.push(`JavDB 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errs.length ? errs.join('；') : 'JavDB 未返回结果' }
  }
  if (mode === 'javbus') {
    const errs: string[] = []
    try {
      const javbus = await fetchJavBusDetail(code, settings, (m) => errs.push(m))
      if (javbus) return { detail: javbus, source: 'javbus' }
    } catch (e) {
      errs.push(`JavBus 异常：${(e as Error)?.message || e}`)
    }
    return { detail: null, error: errs.length ? errs.join('；') : 'JavBus 未返回结果' }
  }
  // ---- auto：Javapi（未配置则跳过）→ Javinfo（未配置则跳过）→ JavDB（仅网络失败计数）→ JavBus → JavLibrary ----
  if (hasJavapiConfig(settings) && !state.javapiDisabled) {
    try {
      const javapi = await fetchJavapiDetail(code, settings, onError)
      if (javapi) {
        state.javapiFails = 0
        return { detail: javapi, source: 'javapi' }
      }
    } catch (e) {
      errors.push(`Javapi 异常：${(e as Error)?.message || e}`)
    }
    state.javapiFails++
    if (state.javapiFails >= JAVAPI_CONSECUTIVE_LIMIT) {
      state.javapiDisabled = true
      console.log(`[batch] Javapi 连续失败 ${state.javapiFails} 部，本轮自动切换 Javinfo`)
    }
  } else if (!hasJavapiConfig(settings)) {
    errors.push('未配置本地 Javapi，跳过')
  }
  if (hasJavinfoKey(settings) && !state.javinfoDisabled) {
    try {
      const javinfo = await fetchJavinfoDetail(code, settings, onError)
      if (javinfo) {
        state.javinfoFails = 0
        return { detail: javinfo, source: 'javinfo' }
      }
    } catch (e) {
      errors.push(`Javinfo 异常：${(e as Error)?.message || e}`)
    }
    state.javinfoFails++
    if (state.javinfoFails >= JAVINFO_CONSECUTIVE_LIMIT) {
      state.javinfoDisabled = true
      console.log(`[batch] Javinfo 连续失败 ${state.javinfoFails} 部，本轮自动切换 JavDB`)
    }
  } else if (!hasJavinfoKey(settings)) {
    errors.push('未配置 Javinfo key，跳过')
  }
  const javdbErrs: string[] = []
  if (!state.javdbDisabled) {
    try {
      const javdb = await fetchJavdbDetail(code, settings, (m) => javdbErrs.push(m))
      if (javdb) {
        state.javdbFails = 0
        return { detail: javdb, source: 'javdb' }
      }
    } catch (e) {
      javdbErrs.push(`JavDB 异常：${(e as Error)?.message || e}`)
    }
    // 仅网络失败计数；「无结果」不计数
    if (javdbErrs.length > 0) {
      state.javdbFails++
      if (state.javdbFails >= JAVDB_CONSECUTIVE_LIMIT) {
        state.javdbDisabled = true
        console.log(`[batch] JavDB 连续网络失败 ${state.javdbFails} 部，本轮自动切换 JavBus`)
      }
    }
  }
  const javbusErrs: string[] = []
  try {
    const javbus = await fetchJavBusDetail(code, settings, (m) => javbusErrs.push(m))
    if (javbus) {
      state.javbusFails = 0
      return { detail: javbus, source: 'javbus' }
    }
  } catch (e) {
    javbusErrs.push(`JavBus 异常：${(e as Error)?.message || e}`)
  }
  // 停止条件：JavBus 是最后兜底源，其连续**网络失败**说明整条抓取链已不可用。
  // 无条件计数（不管 javdbDisabled）+ 仅网络错误计数（无结果不计），
  // 既避免 JavDB 未连续失败时 JavBus 一直失败也不停止（无限空转），
  // 又避免「JavBus 只是没这个番号」被误停。
  if (javbusErrs.length > 0) {
    state.javbusFails++
    if (state.javbusFails >= JAVBUS_CONSECUTIVE_LIMIT) {
      state.stop = true
      javbusErrs.push(`JavBus 连续网络失败 ${state.javbusFails} 部，已自动停止`)
    }

  }
  // javlibrary 最后兜底（不计数；JavLibrary 数据与 javdb/javbus 重叠度高，作为补充源）
  try {
    const javlibrary = await fetchJavLibraryDetail(code, settings)
    if (javlibrary) return { detail: javlibrary, source: 'javlibrary' }
  } catch {
    /* 静默 */
  }
  const allErrs = [...javdbErrs, ...javbusErrs]
  return { detail: null, error: allErrs.length ? allErrs.join('；') : '未知原因' }
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
 * 容错：首选源（updateSource）请求失败时自动回退到另一源重试；
 * 返回的 source 为实际成功的源，fallback=true 表示发生过回退。
 * 返回完整结果供 UI 即时展示。
 */
export async function runUpdateCheck(): Promise<UpdateCheckResult> {
  const s = await repo.getSettings()
  const preferred = s.updateSource ?? 'gitee'
  const current = app.getVersion()
  const repoPath = 'mr-awei/yingxia-video-manager'

  const baseResult: UpdateCheckResult = {
    source: preferred,
    currentVersion: current,
    latestVersion: '',
    hasUpdate: false,
    releaseUrl: '',
    confidence: 'none'
  }

  // 按首选源优先，失败后回退到另一源（GitHub 在大陆网络可能不稳定）
  const order: UpdateSource[] = preferred === 'gitee' ? ['gitee', 'github'] : ['github', 'gitee']
  const errors: string[] = []
  let usedFallback = false

  for (const source of order) {
    try {
      const r = await fetch(
        source === 'gitee'
          ? `https://gitee.com/api/v5/repos/${repoPath}/releases/latest`
          : `https://api.github.com/repos/${repoPath}/releases/latest`,
        {
          headers: {
            'User-Agent': 'yingxia',
            ...(source === 'github' ? { Accept: 'application/vnd.github+json' } : {})
          },
          // 大陆网络下 GitHub API TCP/TLS 能通但 HTTP 层不响应，
          // 无超时则 undici 默认 fetch 会一直挂死导致 UI 永远转圈。
          signal: AbortSignal.timeout(20000)
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
        source,
        fallback: usedFallback,
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
      const cause = (e as { cause?: { code?: string; message?: string } })?.cause
      const err =
        (cause && (cause.code || cause.message)
          ? `${cause.code ?? '网络错误'}${cause.message ? ` ${cause.message}` : ''}`
          : (e as Error)?.message) || '请求失败'
      errors.push(`${source === 'gitee' ? 'Gitee' : 'GitHub'}：${err}`)
      usedFallback = true
      // 继续尝试另一源
    }
  }

  // 两个源都失败
  try {
    await repo.saveSettings({ lastUpdateCheck: Date.now(), pendingUpdate: null })
  } catch {
    /* 持久化失败不影响本次返回 */
  }
  return { ...baseResult, fallback: true, error: errors.join('；') }
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
    // 替换前验证图片有效性：下载损坏/截断的坏图不替换（避免黑屏）
    if (!(await isCoverUsable(localPath, settings))) {
      await fs.unlink(localPath).catch(() => {})
      return null
    }
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
    // 用 detail.cover 覆盖（否则列表页还是错误的视频帧）；同时删除旧的 ffmpeg 截帧预览图，
    // 预览图换成真实截图（本地），避免「真实封面 + 截帧」同时残留
    const coverLocal = await resolveDetailCover(mr.detail, id, settings)
    const patch: Partial<Video> = {}
    if (coverLocal) {
      patch.posterSource = mr.detail.source ?? 'javdb'
      patch.posterPath = coverLocal
      patch.previewPaths = localSamples(mr.detail)
      await removeFfmpegPreviewFiles(id)
    }
    await repo.updateVideo(id, patch)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send(IPC.javdbFetched, {
          videoId: id,
          posterPath: coverLocal,
          posterSource: mr.detail.source ?? 'javdb',
          previewPaths: coverLocal ? localSamples(mr.detail) : undefined
        })
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
    // 抓取并发数 / 间隔（限速、降风控），Settings 中可配。
    // 修复：`Math.floor(x) || 默认值` 在 x=0 时会被默认值顶掉（0 无法生效）——
    // 用显式 Number.isFinite 判断，0 间隔（不限速）可以真正设置为 0。
    const rawConcurrency = Math.floor(settings.fetchConcurrency)
    const baseConcurrency = Number.isFinite(rawConcurrency) && rawConcurrency >= 1
      ? Math.max(1, Math.min(8, rawConcurrency))
      : 2
    const rawInterval = Math.floor(settings.fetchIntervalMs)
    const baseInterval = Number.isFinite(rawInterval) && rawInterval >= 0 ? rawInterval : 600
    // 强制重抓模式：每部都重搜，量极大；并发降到 1、间隔 2 秒，避免触发 JavDB 反爬 (HTTP 403)。
    // 普通补齐保持用户配置的并发/间隔。
    const concurrency = force ? 1 : baseConcurrency
    const interval = force ? 3000 : baseInterval
    let done = 0
    let ok = 0
    let failed = 0
    const bySource: { javapi: number; javinfo: number; javdb: number; javbus: number; javlibrary: number } = { javapi: 0, javinfo: 0, javdb: 0, javbus: 0, javlibrary: 0 }
    const failures: Array<{ title: string; reason: string }> = []
    const smartState: SmartFetchState = { javapiDisabled: false, javapiFails: 0, javinfoDisabled: false, javinfoFails: 0, javdbDisabled: false, javdbFails: 0, javbusFails: 0, stop: false }
    // 系列去重：同 base code 只抓一次，其余分集复用（HUNTA-468CD1/CD2 → 抓一次）
    const seriesCache = new Map<string, JavdbDetail>()
    let idx = 0
    const worker = async () => {
      while (idx < videos.length && !smartState.stop) {
        const v = videos[idx++]
        // 本轮是否发过网络请求（封面抓取 / 详情抓取）——有才延时，避免无请求也空等
        let madeRequest = false
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
          madeRequest = true
          // JavDB 抓封面 → 失败则 ffmpeg 批量截帧兜底（1 封面 + 15 预览图，保证真实画面 + 横屏预览墙素材）
          const javdbPoster = await fetchJavdbPosterForVideo(v, settings)
          let localPath: string | null = javdbPoster
          let source: ImageSource = 'javdb'
          let previews: string[] | undefined
          // 替换前验证图片有效性：下载损坏/截断的坏图视为失败 → 走 ffmpeg 截帧兜底
          if (localPath && !(await isCoverUsable(localPath, settings))) {
            await fs.unlink(localPath).catch(() => {})
            localPath = null
          }
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
          madeRequest = true
          // 智能抓取：JavDB 连续失败自动切 JavBus；JavBus 也连续失败自动停止
          const mr = await fetchDetailSmart(fetchCode, settings, smartState)
          if (mr.detail) {
            if (base) seriesCache.set(base, mr.detail)
            await repo.updateVideo(v.id, { javdbDetail: mr.detail, ...backfillFromDetail(v, mr.detail) })
            // **关键**：如果之前的封面是 ffmpeg 兜底（无 JavDB 海报时），但 detail.cover 有真实海报
            // （JavBus 来源常见），用 detail.cover 下载本地海报覆盖错误的截帧，保证列表/详情一致；
            // 同时删除旧的 ffmpeg 截帧预览图，预览图换成真实截图（本地）
            if (
              mr.detail.cover &&
              (v.posterSource === 'ffmpeg' || v.posterSource === 'placeholder' || !v.posterPath)
            ) {
              const coverLocal = await resolveDetailCover(mr.detail, v.id, settings)
              if (coverLocal) {
                const patch: Partial<Video> = { posterSource: mr.detail.source ?? 'javbus', posterPath: coverLocal }
                const samples = localSamples(mr.detail)
                if (samples.length) patch.previewPaths = samples
                await removeFfmpegPreviewFiles(v.id)
                await repo.updateVideo(v.id, patch)
                for (const w of BrowserWindow.getAllWindows()) {
                  if (!w.isDestroyed()) {
                    w.webContents.send(IPC.javdbFetched, {
                      videoId: v.id,
                      posterPath: coverLocal,
                      posterSource: mr.detail.source ?? 'javbus',
                      previewPaths: samples.length ? samples : undefined
                    })
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
        }
        // 统一限速：本轮发过请求才延时一次（修复旧逻辑封面+详情都抓时延时两次、间隔翻倍）
        if (madeRequest) await new Promise((r) => setTimeout(r, interval))
        if (smartState.stop) break
        done++
        emitProgress({ libraryId, total: videos.length, done, current: v.title })
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, videos.length) }, () => worker()))
    emitProgress({ libraryId, total: videos.length, done: videos.length })
    // 无封面兜底：多数据源都抓不到数据的视频，后台 ffmpeg 截帧显示真实画面（不阻塞补齐返回）
    void (async () => {
      try {
        const all = await repo.listVideos({})
        const noPoster = all
          .filter(
            (v) => v.libraryId === libraryId && (!v.posterPath || v.posterSource === 'placeholder')
          )
          // 批次上限：单轮补齐最多后台截 200 部，其余留待下次
          .slice(0, 200)
        if (noPoster.length === 0) return
        const conc2 = Math.max(1, Math.min(4, Math.floor(settings.scanConcurrency) || 2))
        let i2 = 0
        const w2 = async () => {
          while (i2 < noPoster.length) {
            const v = noPoster[i2++]
            try {
              const set = await generatePreviewSet(v, settings)
              if (set?.coverPath) {
                await repo.updateVideo(v.id, {
                  posterSource: 'ffmpeg',
                  posterPath: set.coverPath,
                  posterPathFfmpeg: set.coverPath,
                  previewPaths: set.previewPaths
                })
                for (const w of BrowserWindow.getAllWindows()) {
                  if (!w.isDestroyed()) {
                    w.webContents.send(IPC.javdbFetched, { videoId: v.id, posterPath: set.coverPath, posterSource: 'ffmpeg' })
                  }
                }
              }
            } catch {
              /* 截帧失败静默 */
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(conc2, noPoster.length) }, () => w2()))
      } catch {
        /* 静默 */
      }
    })()
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

  // ---------- 批量导出番号清单（新建 md 文件向导第一步；支持 txt / Excel） ----------
  ipcMain.handle(IPC.libraryExportCodes, async (_e, libraryId: string, format: 'txt' | 'xlsx' = 'txt') => {
    const lib = (await repo.listLibraries()).find((l) => l.id === libraryId)
    if (!lib) return { ok: false, count: 0, codes: [], error: '媒体库不存在' }
    // 扫描文件夹，收集所有视频文件的「番号」（文件名去扩展名，去重 + 排序）；xlsx 附带文件大小
    const files: string[] = []
    for await (const f of walk(lib.folderPath)) files.push(f)
    const seen = new Set<string>()
    const entries: { name: string; size?: number }[] = []
    for (const f of files) {
      const base = path.basename(f)
      const ext = path.extname(f)
      const name = base.slice(0, base.length - ext.length)
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const st = await fs.stat(f).catch(() => null)
      entries.push({ name, size: st?.size })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    const codes = entries.map((e) => e.name)
    const isXlsx = format === 'xlsx'
    const res = await dialog.showSaveDialog({
      title: '导出番号清单',
      defaultPath: `${lib.name}-番号清单${isXlsx ? '.xlsx' : '.txt'}`,
      filters: isXlsx
        ? [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
        : [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return { ok: false, count: codes.length, codes, error: '已取消' }
    if (isXlsx) {
      // 动态加载 SheetJS（仅导出场景需要，避免常驻内存）；生成带列宽的表单
      const XLSX = await import('xlsx')
      const rows = entries.map((e, i) => ({
        序号: i + 1,
        番号: e.name,
        大小: e.size != null ? `${(e.size / 1024 / 1024).toFixed(1)} MB` : ''
      }))
      const ws = XLSX.utils.json_to_sheet(rows)
      ws['!cols'] = [{ wch: 6 }, { wch: 28 }, { wch: 12 }]
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '番号清单')
      XLSX.writeFile(wb, res.filePath)
    } else {
      await fs.writeFile(res.filePath, codes.join('，') + '\n', 'utf-8')
      // 同时复制到剪贴板，方便直接粘贴给 AI
      try {
        clipboard.writeText(codes.join('，'))
      } catch {
        // 复制失败不影响文件导出
      }
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

  // ---------- 从磁盘删除视频文件（按需连带删同目录的"种子文件夹"） ----------
  // 判定：视频所在目录下除自身外没有其他视频文件、且至少有一个 .torrent 文件
  // → 视为"下载器为这个视频创建的种子文件夹"，整个目录一起删；
  // 否则只删视频文件本身。
  // 安全检查：若目录下除视频与 .torrent 外还有其他文件（文本/字幕/图片等），
  // 保守地只删视频文件（避免误删用户其他资料）。
  // **实现方式：用 Electron `shell.trashItem` 把文件/目录挪到系统回收站**
  //（Windows 回收站 / macOS Trash / Linux trash-cli），不彻底删除。
  // 用户可从回收站恢复，比"直接删"安全得多。
  ipcMain.handle(IPC.videoDeleteFile, async (_e, id: string) => {
    try {
      const v = await repo.getVideo(id)
      if (!v) return { ok: false, error: '视频不存在' }
      if (!v.path) return { ok: false, error: '视频文件路径为空' }

      const filePath = v.path
      const dir = path.dirname(filePath)
      const baseName = path.basename(filePath)

      const VIDEO_EXTS = new Set([
        '.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg'
      ])

      // 无论最终删到什么，都先清理关联缓存图片 + 删除 data.json 里的记录
      //（记录含 javdbDetail 全部文本元数据：演员/时长/导演/片商/女演员/评分等，一并消失）
      const cleanAll = async () => {
        const c = await cleanVideoCacheFiles(v)
        try {
          await repo.removeVideo(id)
        } catch {
          /* 记录删除失败不阻塞主流程 */
        }
        return c
      }

      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        // 目录不存在 / 权限不足 → 仍尝试只挪视频文件到回收站
        await shell.trashItem(filePath).catch(() => {})
        const c = await cleanAll()
        return { ok: true, path: filePath, deletedDir: false, removedCache: c.removed, removedRecord: true, error: `无法读取目录（${(e as Error)?.message ?? '未知错误'}），仅把视频文件挪到回收站` }
      }

      const otherVideoFiles: string[] = []
      const torrentFiles: string[] = []
      const otherFiles: string[] = []
      for (const e of entries) {
        if (!e.isFile()) continue
        if (e.name === baseName) continue
        const ext = path.extname(e.name).toLowerCase()
        if (VIDEO_EXTS.has(ext)) otherVideoFiles.push(e.name)
        else if (ext === '.torrent') torrentFiles.push(e.name)
        else otherFiles.push(e.name)
      }

      // 整目录挪回收站的条件：同目录无其他视频 + 有 .torrent + 无其他非视频非种子文件
      const canDeleteDir = otherVideoFiles.length === 0 && torrentFiles.length > 0 && otherFiles.length === 0

      const c = await cleanAll()

      if (canDeleteDir) {
        // 整目录挪回收站（shell.trashItem 支持目录）
        await shell.trashItem(dir)
        return { ok: true, path: filePath, deletedDir: true, dirPath: dir, removedCache: c.removed, removedRecord: true }
      } else {
        // 只挪视频文件本身
        await shell.trashItem(filePath)
        return { ok: true, path: filePath, deletedDir: false, removedCache: c.removed, removedRecord: true }
      }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '删除失败' }
    }
  })

  // ---------- 删除预检：列出 video 所在目录的视频数 / 种子数 / 其他文件数（不删任何文件） ----------
  ipcMain.handle(IPC.videoInspectForDelete, async (_e, id: string) => {
    try {
      const v = await repo.getVideo(id)
      if (!v) return { ok: false, error: '视频不存在' }
      if (!v.path) return { ok: false, error: '视频文件路径为空' }

      const filePath = v.path
      const dir = path.dirname(filePath)
      const baseName = path.basename(filePath)

      const VIDEO_EXTS = new Set([
        '.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg'
      ])

      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (e) {
        return { ok: false, filePath, dirPath: dir, error: `无法读取目录：${(e as Error)?.message ?? '未知错误'}` }
      }

      let otherVideoCount = 0
      let torrentCount = 0
      let otherFileCount = 0
      for (const e of entries) {
        if (!e.isFile()) continue
        if (e.name === baseName) continue
        const ext = path.extname(e.name).toLowerCase()
        if (VIDEO_EXTS.has(ext)) otherVideoCount++
        else if (ext === '.torrent') torrentCount++
        else otherFileCount++
      }
      return { ok: true, filePath, dirPath: dir, otherVideoCount, torrentCount, otherFileCount }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '预检失败' }
    }
  })

  // ---------- 封面来源切换：数据源图（javdb/javbus/javlibrary）↔ FFmpeg 截帧图 ----------
  // 两套图独立保存：posterPathFfmpeg 始终存 FFmpeg 截帧封面；
  // 切换到 'ffmpeg' → posterPath=截帧图；切换到 'data' → 优先用数据源缓存图，没有则抓取。
  ipcMain.handle(IPC.videoSwitchPoster, async (_e, id: string, source: 'data' | 'ffmpeg') => {
    try {
      const v = await repo.getVideo(id)
      if (!v) return { ok: false, error: '视频不存在' }
      const settings = await repo.getSettings()

      if (source === 'ffmpeg') {
        // 1) 已有 FFmpeg 截帧封面 → 直接切换
        if (v.posterPathFfmpeg) {
          try {
            await fs.access(v.posterPathFfmpeg)
            await repo.updateVideo(id, { posterPath: v.posterPathFfmpeg, posterSource: 'ffmpeg' })
            return { ok: true, posterPath: v.posterPathFfmpeg, posterSource: 'ffmpeg' }
          } catch {
            /* 文件丢失，重新生成 */
          }
        }
        // 2) 生成 FFmpeg 截帧（封面 + 预览图），并持久化两处
        const set = await generatePreviewSet(v, settings)
        if (!set?.coverPath) return { ok: false, error: 'FFmpeg 截帧失败（检查 ffmpeg 是否可用）' }
        await repo.updateVideo(id, {
          posterPath: set.coverPath,
          posterSource: 'ffmpeg',
          posterPathFfmpeg: set.coverPath,
          previewPaths: set.previewPaths
        })
        return { ok: true, posterPath: set.coverPath, posterSource: 'ffmpeg' }
      }

      // source === 'data'：优先复用数据源缓存图（javdb-cover-CODE / javbus-cover-CODE / javlibrary-cover-CODE）
      const code = v.javdbDetail?.code
      const cacheCandidates: string[] = []
      if (code) {
        cacheCandidates.push(
          path.join(postersCacheDir(), `javdb-cover-${code}.jpg`),
          path.join(postersCacheDir(), `javbus-cover-${code}.jpg`),
          path.join(postersCacheDir(), `javlibrary-cover-${code}.jpg`)
        )
      }
      for (const p of cacheCandidates) {
        try {
          await fs.access(p)
          await repo.updateVideo(id, { posterPath: p, posterSource: 'javdb' })
          return { ok: true, posterPath: p, posterSource: 'javdb' }
        } catch {
          /* 继续尝试下一个 */
        }
      }
      // 无缓存 → 从数据源抓封面
      const fetched = await fetchJavdbPosterForVideo(v, settings)
      if (!fetched) return { ok: false, error: '数据源封面获取失败（无网络或数据源无此片）' }
      await repo.updateVideo(id, { posterPath: fetched, posterSource: 'javdb' })
      return { ok: true, posterPath: fetched, posterSource: 'javdb' }
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? '切换失败' }
    }
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
      // 独立保存 FFmpeg 截帧封面，供「数据源图 / FFmpeg 截图」自由切换
      patch.posterPathFfmpeg = set.coverPath
    }
    if (set.previewPaths.length) patch.previewPaths = set.previewPaths
    await frameLog(`[videoGeneratePreviews] update id=${id} cover=${set.coverPath ?? 'none'} previews=${set.previewPaths.length}`)
    return repo.updateVideo(id, patch)
  })

  // ---------- ffmpeg 单帧兜底：无封面时截 1 帧视频画面作封面（列表懒加载用） ----------
  ipcMain.handle(IPC.videoFrameFallback, async (_e, id: string) => {
    const v = await repo.getVideo(id)
    if (!v || !v.path) return null
    const settings = await repo.getSettings()
    // 已有可用的封面文件（含历史生成的截帧）直接复用，避免重复截帧；
    // **必须验证是有效图片**：损坏的 jpg（文件在但 ffprobe 读不出尺寸）会黑屏，
    // 删除坏文件后重新截帧/解析，否则前端一直显示坏图
    if (v.posterPath) {
      if (await isCoverUsable(v.posterPath, settings)) return v.posterPath
      await fs.unlink(v.posterPath).catch(() => {})
    }
    await frameLog(`[videoFrameFallback] start id=${id} path=${v.path}`)
    const lib = (await repo.listLibraries()).find((l) => l.id === v.libraryId) ?? defaultLibrary()
    // resolvePoster 会按 imagePriority 依次尝试：侧车图 → 已缓存抓取 → ffmpeg 截帧，最终兜底占位
    const r = await resolvePoster(v, lib, settings, { allowFfmpeg: true })
    if (!r.posterPath) {
      await frameLog(`[videoFrameFallback] no frame id=${id} source=${r.source}`)
      return null
    }
    await repo.updateVideo(id, { posterSource: r.source, posterPath: r.posterPath })
    await frameLog(`[videoFrameFallback] ok id=${id} source=${r.source} poster=${r.posterPath}`)
    return r.posterPath
  })

  // ---------- 截帧预览帧 → 设为封面：把某张预览帧复制为 <id>.jpg 并更新记录 ----------
  ipcMain.handle(IPC.videoSetPreviewAsCover, async (_e, id: string, previewPath: string) => {
    const v = await repo.getVideo(id)
    if (!v) throw new Error('视频不存在')
    const settings = await repo.getSettings()
    // 校验该预览帧是有效图片（防坏图/不存在）
    if (!(await isCoverUsable(previewPath, settings))) return null
    // 复制到标准封面文件 <id>.jpg（独立于预览图生命周期，预览图清理不影响封面）
    const coverPath = path.join(postersCacheDir(), `${id}.jpg`)
    await fs.copyFile(previewPath, coverPath)
    await frameLog(`[videoSetPreviewAsCover] id=${id} poster=${path.basename(previewPath)}`)
    // posterSource='manual'：手动选择的封面，优先级高于自动抓取的真实封面（详情页/列表立即生效并持久）
    const updated = await repo.updateVideo(id, { posterSource: 'manual', posterPath: coverPath })
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) {
        w.webContents.send(IPC.javdbFetched, { videoId: id, posterPath: coverPath, posterSource: 'manual' })
      }
    }
    return updated
  })
}
