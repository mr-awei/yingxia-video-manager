import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron'
import { IPC } from '../../shared/ipc'
import * as repo from './repo'
import { scanLibrary, walk } from './scanner'
import path from 'node:path'
import { readFileSync, promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { reconcileLibrary } from './reconcile'
import { openVideo } from './player'
import { resolvePoster } from './images'
import { postersCacheDir } from './images'
import { generateFrame } from './images'
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
import { DEFAULT_IMAGE_PRIORITY, type JavdbDetail, type Library, type ScanProgress, type Settings } from '../../shared/types'

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
    await repo.updateVideo(id, { javdbDetail: mr.detail })
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

        // 1) 封面：仅缺封面/占位图才抓。force 不重抓海报——海报是图片、URL 基本不变，
        //    本地缓存命中即可；重抓只会浪费 JavDB/JavBus 请求额度并加剧 403。
        if (!v.posterPath || v.posterSource === 'placeholder') {
          // JavDB 抓封面 → 失败则 ffmpeg 截帧兜底（每个视频都保证有真实画面封面，
          // 不再出现「占位符字母」——刷新推荐时换片肉眼可见）
          const javdbPoster = await fetchJavdbPosterForVideo(v, settings)
          const framePoster = javdbPoster
            ? null
            : await generateFrame(v, settings).catch(() => null)
          const localPath = javdbPoster ?? framePoster
          if (localPath) {
            await repo.updateVideo(v.id, {
              posterSource: javdbPoster ? 'javdb' : 'ffmpeg',
              posterPath: localPath
            })
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
          await repo.updateVideo(v.id, { javdbDetail: seriesHit })
          ok++
          const src = seriesHit.source ?? 'javdb'
          bySource[src] = (bySource[src] ?? 0) + 1
        } else if (force || detailStale) {
          // 智能抓取：JavDB 连续失败自动切 JavBus；JavBus 也连续失败自动停止
          const mr = await fetchDetailSmart(fetchCode, settings, smartState)
          if (mr.detail) {
            if (base) seriesCache.set(base, mr.detail)
            await repo.updateVideo(v.id, { javdbDetail: mr.detail })
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
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
  ipcMain.handle(IPC.dialogSelectFile, async () => {
    const res = await dialog.showOpenDialog({
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
    return previewRenames(lib.folderPath, async (p) => (await repo.findVideoByPath(p)) !== null)
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
}
