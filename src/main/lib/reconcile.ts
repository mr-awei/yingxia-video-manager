import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import type {
  DisplayEntry,
  IntroDoc,
  Library,
  ReconcileResult,
  Settings,
  UnlistedFile,
  Video
} from '../../shared/types'
import { parseIntroExcel } from './excel'
import { applyVideoChanges, findVideoByPath, listVideos, type VideoChange } from './repo'
import { resolvePoster } from './images'
import { walk, VIDEO_EXTS, idForPath } from './scanner'
import { extractBaseCode, isDomestic, normalizeCode } from '../../shared/code'
import { fetchDetailSmart, createSmartFetchState } from './javdb-smart'

/**
 * 无片单兜底自动抓取：每个进程生命周期只自动触发一次（首次 reconcile）。
 * 避免切库/切页面/刷新反复触发 reconcile 时重复发起抓取风暴；之后一律走手动「批量补齐」。
 */
let autoFetchFired = false

/** dead previewPaths 全量清理限频：每 6 小时最多一次（大库下数千次 existsSync 磁盘 IO 会拖慢打开/切库） */
const PREVIEW_CLEANUP_INTERVAL = 6 * 60 * 60 * 1000
let lastPreviewCleanupAt = 0

/**
 * 片单加载结果（含错误信息）。reconcile.ts 把 error 透传给 ipc.ts，
 * 由 ipc.ts 通过 webContents.send 推到 renderer 弹 Toast——
 * "不能藏起问题"是 v2.2.4 的硬性要求：找不到 Excel / 解析失败都要明确告知用户。
 */
export type IntroLookupResult =
  | { doc: IntroDoc; error?: undefined }
  | {
      doc: null
      error: { kind: 'not-configured' | 'parse-failed' | 'auto-find-failed'; message: string; triedPaths: string[] }
    }

async function readIntroDoc(library: Library): Promise<IntroLookupResult> {
  // 仅使用 Excel 片单（已全面切换到 Excel 格式）
  if (library.introExcelPath) {
    // 用户显式配了：直接解析
    const doc = await parseIntroExcel(library.introExcelPath)
    if (doc) return { doc }
    return {
      doc: null,
      error: {
        kind: 'parse-failed',
        message: `配置的片单 Excel 解析失败或为空：${library.introExcelPath}`,
        triedPaths: [library.introExcelPath]
      }
    }
  }
  // v2.2.3 修复：library 没显式配 introExcelPath 时，**自动扫描库根目录找 .xlsx**——用户友好，
  // 避免「明明片单就在库里却因没配字段而全部归未收录」的体验。匹配规则：
  // 1) 优先匹配根目录下含「品番」列的工作簿（顺序按文件名排序）
  // 2) 只在库根（不递归子目录）扫，避免误匹配到无关 xlsx
  const result = await autoFindIntroExcel(library.folderPath)
  if (result.doc) return { doc: result.doc }
  return {
    doc: null,
    error: {
      kind: result.kind ?? 'not-configured',
      message: result.message,
      triedPaths: result.triedPaths
    }
  }
}

/**
 * 在媒体库根目录自动查找 Excel 片单。
 * v2.2.4 改造：返回结构化结果（含失败原因），不再静默吞错——
 * 「藏起问题」是这次回归测试中用户明确反对的设计。
 */
async function autoFindIntroExcel(
  folderPath: string
): Promise<
  | { doc: IntroDoc; kind?: undefined; message?: undefined; triedPaths?: undefined }
  | { doc: null; kind: 'not-configured' | 'parse-failed'; message: string; triedPaths: string[] }
> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true })
  } catch (e) {
    return {
      doc: null,
      kind: 'not-configured',
      message: `无法读取媒体库根目录：${folderPath}（${(e as Error)?.message || e}）`,
      triedPaths: [folderPath]
    }
  }
  const xlsxFiles = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => /\.(xlsx|xls)$/i.test(n))
    .sort((a, b) => a.localeCompare(b, 'zh'))
  if (xlsxFiles.length === 0) {
    return {
      doc: null,
      kind: 'not-configured',
      message: `媒体库根目录未找到任何 .xlsx/.xls 片单文件：${folderPath}`,
      triedPaths: [folderPath]
    }
  }
  // 依次尝试每个 xlsx，找到第一个「品番列可解析」的
  const triedPaths: string[] = []
  for (const name of xlsxFiles) {
    const fullPath = path.join(folderPath, name)
    triedPaths.push(fullPath)
    try {
      const doc = await parseIntroExcel(fullPath)
      if (doc && doc.categories.length > 0) {
        const total = doc.categories.reduce((n, c) => n + c.items.length, 0)
        console.log(`[reconcile] 自动使用库根 Excel 片单: ${fullPath}（${total} 部 / ${doc.categories.length} 类）`)
        return { doc }
      }
    } catch (e) {
      // 单文件解析失败不影响整体，但记录到消息里——让用户能直接看到是哪个文件坏了
      console.warn(`[reconcile] 解析 ${fullPath} 失败:`, (e as Error)?.message || e)
    }
  }
  return {
    doc: null,
    kind: 'parse-failed',
    message: `媒体库根目录下 ${xlsxFiles.length} 个 Excel 文件均无法解析出有效片单（已尝试：${triedPaths.map((p) => path.basename(p)).join('、')}）`,
    triedPaths
  }
}

interface FileEntry {
  path: string
  /** 文件名（去扩展名、小写），用于番号匹配 */
  key: string
  /** 外文件夹名（小写），优先级更高的匹配源（比文件名更干净） */
  folderName: string
}

function collectFiles(files: string[]): FileEntry[] {
  return files.map((p) => {
    const base = path.basename(p)
    const ext = path.extname(p)
    const nameNoExt = base.slice(0, base.length - ext.length).toLowerCase()
    const folder = path.basename(path.dirname(p)).toLowerCase()
    return { path: p, key: nameNoExt, folderName: folder }
  })
}

/**
 * normalizeCode 已抽到 src/shared/code.ts（v2.2.3），reconcile 直接 import 使用。
 * 行为：转大写、去空格/下划线/点（保留连字符，连字符是番号结构的一部分）。
 * SONE-566 / sone-566 / sone.566 / SONE_566 归一化后一致。
 */

/**
 * 判断文件名 key 是否命中番号 code：
 * - 归一化后包含；
 * - 前缀边界：code 前不能紧跟字母数字（防 `1SONE-560` 之类）；
 * - 后缀边界：code 后若紧跟**数字**则不算（防 `SONE-56` 误命中 `SONE-560`）；
 * - **2026-08-30 v2.2.3 修复**：不再拒绝字母后缀——v2.2.2 加的 `/[A-Z0-9]/.test(after)` 会把
 *   `JUR-031.mp4` 归一后 `JUR-031MP4` 的 `M` 误判为「另一番号字母」拒绝，导致正常的
 *   `JUR-031.mp4` 文件都匹配不上 Excel 里的 `JUR-031`（用户实测全 miss）。
 *   系列分集合并（`SONE-566AB` 误并 `SONE-566`）改由 `extractBaseCode/hasSeriesSuffix` 在
 *   抓取源（javdb/javbus）显式处理，不要在文件名 keyMatches 上做强约束。
 */
export function keyMatches(key: string, code: string): boolean {
  // 先用 extractBaseCode 把 key 里的分集后缀剥掉（如 sone-560_1 → SONE-560），
  // 避免 normalizeCode 去下划线后变成 SONE-5601 再被后缀边界杀。
  const keyBase = extractBaseCode(key)
  const codeBase = extractBaseCode(code)
  const k = normalizeCode(keyBase)
  const c = normalizeCode(codeBase)
  const i = k.indexOf(c)
  if (i < 0) return false
  const before = i > 0 ? k[i - 1] : ''
  if (before && /[A-Z0-9]/.test(before)) return false
  const after = k[i + c.length]
  // 后缀边界：数字后缀可能是分集（已在 extractBaseCode 剥掉），
  // 也可能是正常序号的一部分（SSIS-419 的 9 不是 41 的分集）。
  // 现在 keyBase 已经剥过分集后缀，after 不会是分集数字了，
  // 保留 /[0-9]/ 检查只是兜底防 extractBaseCode 漏网。
  if (after && /[0-9]/.test(after)) return false
  return true
}

/**
 * 找出所有匹配该番号的文件（同一番号的多版本文件都算同片，全部标记 used，
 * 避免被误报为「未收录」）。返回按主次排序的文件路径列表。
 * 匹配优先级：外文件夹名 > 文件名（外文件夹名更干净，命中更权威）。
 */
function findFilesForCode(code: string, files: FileEntry[], used: Set<string>): string[] {
  const hits: FileEntry[] = []
  for (const f of files) {
    if (used.has(f.path)) continue
    if (keyMatches(f.folderName, code) || keyMatches(f.key, code)) {
      used.add(f.path)
      hits.push(f)
    }
  }
  const c = normalizeCode(code)
  hits.sort((a, b) => {
    // 外文件夹名完全等于番号 > 文件名完全等于番号 > 其他
    const aFolder = normalizeCode(a.folderName) === c ? 0 : 1
    const bFolder = normalizeCode(b.folderName) === c ? 0 : 1
    if (aFolder !== bFolder) return aFolder - bFolder
    const aKey = normalizeCode(a.key) === c ? 0 : 1
    const bKey = normalizeCode(b.key) === c ? 0 : 1
    return aKey - bKey || a.key.localeCompare(b.key)
  })
  return hits.map((h) => h.path)
}

async function ensureVideo(
  filePath: string,
  library: Library,
  settings: Settings,
  meta: {
    code: string
    description: string
    tags: string[]
    score?: number
    /** Excel 片单结构化分类标签（新格式）；无片单时为 undefined */
    tagCategories?: Record<string, string[]>
    /** Excel 片单「分类」列的单值，独立于 tagCategories */
    introCategory?: string
  },
  changes: VideoChange[]
): Promise<Video> {
  const folderName = path.basename(path.dirname(filePath))
  const domestic = isDomestic(folderName, path.basename(filePath))
  const existing = await findVideoByPath(filePath)
  if (existing) {
    // Excel 为权威来源：简介/标签/评分/tagCategories 以 Excel 为准（仅在变化时记录一次 update，不逐条写盘）
    const nextTags = [...meta.tags]
    const nextCats = meta.tagCategories && Object.keys(meta.tagCategories).length ? { ...meta.tagCategories } : undefined
    if (
      existing.description !== meta.description ||
      JSON.stringify(existing.tags) !== JSON.stringify(nextTags) ||
      JSON.stringify(existing.tagCategories ?? null) !== JSON.stringify(nextCats ?? null) ||
      existing.rating !== meta.score ||
      !!existing.domestic !== domestic ||
      existing.introCategory !== meta.introCategory
    ) {
      const updated: Video = {
        ...existing,
        description: meta.description,
        tags: nextTags,
        tagCategories: nextCats,
        descriptionSource: 'manual',
        rating: meta.score ?? existing.rating,
        domestic,
        introCategory: meta.introCategory ?? existing.introCategory
      }
      changes.push({ type: 'update', video: updated })
      return updated
    }
    return existing
  }
  const stat = await fs.stat(filePath).catch(() => null)
  const video: Video = {
    id: idForPath(filePath),
    libraryId: library.id,
    path: filePath,
    fileName: path.basename(filePath),
    folderName: path.basename(path.dirname(filePath)),
    domestic,
    title: meta.code,
    description: meta.description,
    descriptionSource: 'manual',
    tags: [...meta.tags],
    tagCategories: meta.tagCategories && Object.keys(meta.tagCategories).length ? { ...meta.tagCategories } : undefined,
    rating: meta.score,
    addedAt: Date.now(),
    fileSize: stat?.size,
    introCategory: meta.introCategory
  }
  if (!video.posterPath) {
    const r = await resolvePoster(video, library, settings, { allowFfmpeg: false })
    video.posterSource = r.source
    video.posterPath = r.posterPath
  }
  changes.push({ type: 'upsert', video })
  return video
}

/**
 * 按 Excel 片单对账某个媒体库的视频文件夹。
 * - Excel 条目匹配到文件 → matched（含海报/播放信息）
 * - Excel 有但文件缺失 → missing（提示下载或删除简介）
 * - 文件夹有但 Excel 未收录 → unlisted（提示更新 Excel）
 */
export async function reconcileLibrary(
  library: Library,
  settings: Settings,
  onProgress?: (p: {
    libraryId: string
    total: number
    done: number
    current?: string
    introError?: { kind: string; message: string; triedPaths: string[] }
    fetchEvent?: { code: string; src: 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'javlibrary'; status: 'trying' | 'hit' | 'skipped' | 'no-result' | 'network-failed'; detail?: string }
  }) => void
): Promise<ReconcileResult> {
  const introLookup = await readIntroDoc(library)
  const doc = introLookup.doc

  // 片单加载失败：必须告知用户，不能静默吞错。
  // 通过 onProgress 把 introError 推给 renderer，由 renderer 决定弹 toast 还是引导向导。
  // suppressIntroExcelNotice 只在 renderer 侧判断（主进程不屏蔽任何 kind）。
  if (introLookup.error) {
    onProgress?.({
      libraryId: library.id,
      total: 0,
      done: 0,
      introError: introLookup.error
    })
  }

  // 与 scanLibrary 一致：按设置过滤小文件（短视频/广告样片）
  const minSizeBytes = Math.max(0, Math.floor(settings.scanMinSizeMB ?? 0)) * 1024 * 1024
  const allFiles: string[] = []
  for await (const f of walk(library.folderPath, minSizeBytes)) allFiles.push(f)
  const fileEntries = collectFiles(allFiles)
  const used = new Set<string>()

  const entries: DisplayEntry[] = []
  const changes: VideoChange[] = []
  let mdCount = 0
  let matched = 0
  let missing = 0

  // 已删除标记：用户主动删除过（文件挪回收站 + data.json 记录被删）的番号集合。
  // Excel 里有条目但文件缺失时，若该番号在 data.json 中已无任何记录，说明用户主动删除过，
  // 跳过该条目不标 missing（否则删除后对账又会把它标成"缺失"挂回来）。
  let activeCodeSet: Set<string> | null = null
  const getActiveCodeSet = async (): Promise<Set<string>> => {
    if (activeCodeSet) return activeCodeSet
    const s = new Set<string>()
    try {
      const all = await listVideos({})
      for (const v of all) {
        if (v.javdbDetail?.code) s.add(v.javdbDetail.code.toUpperCase())
        else if (v.title) s.add(String(v.title).toUpperCase())
        else if (v.fileName) s.add(path.basename(v.fileName, path.extname(v.fileName)).toUpperCase())
      }
    } catch {
      /* 拿不到记录列表时保守处理：不跳过（维持原 missing 行为） */
    }
    activeCodeSet = s
    return s
  }

  if (doc) {
    const total = doc.totalCount + allFiles.length
    for (const cat of doc.categories) {
      for (const item of cat.items) {
        mdCount++
        onProgress?.({
          libraryId: library.id,
          total,
          done: mdCount,
          current: item.code
        })
        const files = findFilesForCode(item.code, fileEntries, used)
        if (files.length > 0) {
          // L352: 同 code 多文件（分集 / 多碟）时，主 entry 只绑定第一个文件作为 video（列表页不重复展示），
          // 其余文件也 ensureVideo 后存入 siblingVideos，供详情页渲染分集列表（像爱奇艺那样）。
          const metaForVideo = {
            code: item.code,
            description: item.description,
            tags: item.tags,
            tagCategories: item.tagCategories,
            score: item.score,
            introCategory: item.category
          }
          const video = await ensureVideo(files[0], library, settings, metaForVideo, changes)
          const siblingVideos: Video[] = []
          for (let i = 1; i < files.length; i++) {
            const sib = await ensureVideo(files[i], library, settings, metaForVideo, changes)
            siblingVideos.push(sib)
          }
          entries.push({
            kind: 'matched',
            category: cat.name,
            order: cat.order,
            code: item.code,
            title: item.code,
            description: item.description,
            tags: item.tags,
            tagCategories: item.tagCategories,
            score: item.score,
            video,
            siblingVideos
          })
          if (siblingVideos.length > 0) {
            console.log(`[reconcile] code=${item.code} main=${video.fileName} siblings=${siblingVideos.map(s => s.fileName).join(',')}`)
          }
          matched++
        } else {
          // 文件缺失：若该番号在 data.json 中已无任何记录（用户主动删除过视频 + 记录），
          // 跳过该条目不标 missing，避免"删了又挂回来"。
          const activeCodes = await getActiveCodeSet()
          const upperCode = String(item.code).toUpperCase()
          if (activeCodes.size > 0 && !activeCodes.has(upperCode)) {
            continue
          }
          entries.push({
            kind: 'missing',
            category: cat.name,
            order: cat.order,
            code: item.code,
            title: item.code,
            description: item.description,
            tags: item.tags,
            tagCategories: item.tagCategories,
            score: item.score
          })
          missing++
        }
      }
    }
  } else {
    // 未配置 Excel 片单：全部文件直接展示
    // 需求 B（自动归类）：有数据源元数据（javdbDetail.genres 非空）的视频按 genres 自动归类，
    // 归入「【JavBus】高清·字幕」这类自动分类（order 9000，未分类 9999 之前）；
    // 无元数据的仍归「未分类」（order 0）。
    // 2026-08-30 修复：原 path.basename(f) 含扩展名（SONE-280.mp4），传给 ensureVideo 后写入 video.title，
    // EntryCard 显示就是 `SONE-280.mp4`。先剥扩展名。
    // v2.2.4 兜底：用户明确担忧"万一哪天用户真没有excel怎么办"——
    //   对所有没 javdbDetail 的视频，后台异步按 settings.customSourceOrder 抓一次，
    //   7 天内抓过且失败的跳过（避免反复消耗 JavDB 配额），抓到的写回 video 让 UI 立刻变好看。
    const needFetchAfter: Video[] = []
    for (const f of allFiles) {
      // v2.2.3 P0 修复：原 else 分支没用 used 记账，导致下方 L297「未收录」循环重复 push 同 filePath →
      // 同 code 两条 entry → HomeView `key={e.code}` duplicate key 警告（用户截图「未收录 84 + 未分类 79」）。
      // 这里补全 else 分支的 used 记账，让未配 Excel 时按文件维度只产出 1 条 entry。
      used.add(f)
      const base = path.basename(f)
      const titleNoExt = path.basename(base, path.extname(base))
      const video = await ensureVideo(
        f,
        library,
        settings,
        { code: titleNoExt, description: '', tags: [] },
        changes
      )
      if (!video.domestic && !video.javdbDetail) {
        needFetchAfter.push(video)
      } else if (!video.domestic && video.javdbDetail) {
        // v2.2.14-fix：有 javdbDetail 但 samples 不完整也要进 needFetchAfter —
        // 之前番号脏时可能半拉子抓到 cover 但 samples 空/极少，旧条件只看 !javdbDetail 漏掉了。
        const d = video.javdbDetail
        const localSamples = (d.samples ?? []).filter((s) => !/^https?:\/\//.test(s))
        const coverRemote = !!d.cover && /^https?:\/\//.test(d.cover)
        if (coverRemote || localSamples.length < 2 || d.parseVer !== 2) {
          needFetchAfter.push(video)
        }
      }
      const d = video.javdbDetail
      const hasGenres = !!d && !!d.genres && d.genres.length > 0
      // v2.3.2：分类恢复原 v2.2.0 逻辑（一个视频一条 entry，category 用 genres 拼接长串），
      // 避免方案 A 把一个视频拆多条 entry 导致计数/推荐重复；genres 单标签改由独立的「类别」筛选提供。
      const srcName = d?.source === 'javbus' ? 'JavBus' : d?.source === 'javlibrary' ? 'JavLibrary' : 'JavDB'
      const catName = hasGenres ? `【${srcName}】${d!.genres.join('·')}` : '未分类'
      entries.push({
        kind: 'matched',
        category: catName,
        order: hasGenres ? 9000 : 0,
        code: titleNoExt,
        title: titleNoExt,
        description: '',
        tags: [],
        video
      })
      matched++
    }

    // 后台异步抓元数据（fire-and-forget，不阻塞 reconcile 返回）
    // v2.2.10-fix 防风暴：大库（数千部）+ 无片单时，v2.2.4 的"全量自动兜底"会让启动即对
    // 数千部视频发起网络抓取 + 逐条全量写盘，CPU/IO 拉满。现在：
    //   1) 自动兜底只抓前 AUTO_FETCH_LIMIT 部，其余留给手动「批量补齐」；
    //   2) 抓取结果统一批量落盘（一次 saveDB），不再逐条 updateVideo 全量写 JSON。
    if (needFetchAfter.length > 0) {
      const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
      const now = Date.now()
      const toFetch = needFetchAfter.filter((v) => {
        const last = v.lastMetaFetchAt
        return !last || now - last > SEVEN_DAYS
      })
      const skipped = needFetchAfter.length - toFetch.length
      if (skipped > 0) {
        console.log(`[reconcile] 无片单兜底抓取：跳过 ${skipped} 部（7 天内已抓过且失败）`)
      }
      const AUTO_FETCH_LIMIT = 80
      const autoFetch = toFetch.slice(0, AUTO_FETCH_LIMIT)
      const rest = toFetch.length - autoFetch.length
      if (!autoFetchFired && autoFetch.length > 0) {
        autoFetchFired = true
        const conc = Math.max(1, Math.min(4, Math.floor(settings.scanConcurrency) || 2))
        const state = createSmartFetchState()
        let idx = 0
        const changes: VideoChange[] = []
        console.log(
          `[reconcile] 无片单兜底抓取：自动抓 ${autoFetch.length} 部 / 并发 ${conc}` +
            (rest > 0 ? `（其余 ${rest} 部请手动「批量补齐」）` : '')
        )
        void (async () => {
          const worker = async () => {
            while (idx < autoFetch.length) {
              const v = autoFetch[idx++]
              if (state.stop) return
              try {
                const r = await fetchDetailSmart(v.title, settings, state, (fe) => {
                  // v2.2.10：兜底抓取也把事件推给 renderer（走 onProgress 同管道）
                  onProgress?.({ libraryId: library.id, total: autoFetch.length, done: idx, current: v.title, fetchEvent: fe })
                })
                if (r.detail) {
                  changes.push({
                    type: 'update',
                    video: {
                      ...v,
                      javdbDetail: { ...r.detail, code: v.title, source: r.source ?? r.detail.source },
                      lastMetaFetchAt: now
                    }
                  })
                  console.log(`[reconcile] 兜底抓取成功 ${v.title}（${r.source}）`)
                } else {
                  // 抓不到（不是网络错误也可能是源里没这部）也要标 lastMetaFetchAt，避免下次立即重试
                  changes.push({ type: 'update', video: { ...v, lastMetaFetchAt: now } })
                }
              } catch (e) {
                console.warn(`[reconcile] 兜底抓取异常 ${v.title}:`, (e as Error)?.message || e)
                changes.push({ type: 'update', video: { ...v, lastMetaFetchAt: now } })
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(conc, autoFetch.length) }, () => worker()))
          await applyVideoChanges(changes).catch((e) =>
            console.warn('[reconcile] 兜底抓取批量落盘失败:', (e as Error)?.message || e)
          )
        })()
      } else if (autoFetch.length > 0) {
        console.log(`[reconcile] 无片单兜底抓取：本进程已自动抓过，跳过（剩 ${toFetch.length} 部待抓，请手动「批量补齐」）`)
      }
    }
  }

  const ignoredSet = new Set(settings.ignoredUnlistedPaths ?? [])

  // 所有未 used 的文件都生成「未收录」条目，保证忽略后仍可在主列表/「未收录」分类找到
  const unlistedAll: UnlistedFile[] = allFiles
    .filter((f) => !used.has(f))
    .map((f) => ({ fileName: path.basename(f), path: f }))

  // 对账弹窗/统计里过滤已忽略项，避免重复打扰
  const unlisted: UnlistedFile[] = unlistedAll.filter((u) => !ignoredSet.has(u.path))

  // 把未收录文件也展示出来（否则导入后列表/首页找不到），统一放到「未收录」分类
  const UNLISTED_ORDER = 9999
  for (const u of unlistedAll) {
    const existing = await findVideoByPath(u.path)
    const video =
      existing ??
      (await ensureVideo(
        u.path,
        library,
        settings,
        { code: u.fileName, description: '', tags: [] },
        changes
      ))
    const titleNoExt = path.basename(u.fileName, path.extname(u.fileName))
    entries.push({
      kind: 'matched',
      category: '未收录',
      order: UNLISTED_ORDER,
      code: titleNoExt,
      title: titleNoExt,
      description: '',
      tags: [],
      video
    })
  }

  entries.sort((a, b) => a.order - b.order || a.code.localeCompare(b.code, 'zh'))

  // 一次性批量落盘（避免逐条全量写 JSON）
  await applyVideoChanges(changes)

  // v2.2.10-fix2：不再自动截帧。
  // generatePreviewSet 每部 = 1 个 thumbnail 全片解码 + 4 个预览帧进程（5 个 ffmpeg），
  // 大库自动截帧（哪怕 20 部）会让 CPU 长时间拉满、出现"一大堆 ffmpeg.exe"。
  // 截帧改由用户手动触发：详情页「重新截帧」/ 补齐信息（ffmpeg 截帧兜底）。
  {
    const missing = entries.filter(
      (e) => e.video && (!e.video.posterPath || e.video.posterSource === 'placeholder')
    ).length
    if (missing > 0) {
      console.log(`[reconcile] 有 ${missing} 部无封面视频（已禁用自动截帧，需要时请手动「重新截帧」）`)
    }
  }

  onProgress?.({ libraryId: library.id, total: mdCount + allFiles.length, done: mdCount + allFiles.length })

  // v2.2.5 修复：清理 dead previewPaths —— 上一次升级/installer 可能清掉了 posters 目录里的旧 .jpg，
  // 但 data.json 里的 video.previewPaths 仍指向这些不存在的文件 → hover/详情页 lm:// ENOENT 刷屏。
  // v2.2.10-fix3：大库（数千部）下全量清理 = 遍历全部视频 + 数千次 existsSync 磁盘 IO，
  // 且与当前库无关（切一个库也清全库）→ 打开/切库明显变慢。previewPaths 只在升级/清缓存后
  // 才失效，平时不会变，改为每 6 小时最多清理一次。
  const previewCleanupDue = Date.now() - lastPreviewCleanupAt > PREVIEW_CLEANUP_INTERVAL
  if (previewCleanupDue) {
    lastPreviewCleanupAt = Date.now()
    await cleanupDeadPreviewPaths(changes)
  }

  return {
    libraryId: library.id,
    entries,
    unlisted,
    stats: { mdCount, matched, missing, unlisted: unlisted.length },
    generatedAt: Date.now()
  }
}

/**
 * v2.2.5：清理所有 video.previewPaths 里的死引用。
 * - 任何 previewPath 文件不存在的，从 video.previewPaths 里删掉
 * - 删空后 video.previewPaths = undefined（让 UI 走「无预览」分支）
 * - 改动合并进 changes 数组，由 reconcileLibrary 末尾的 applyVideoChanges 一次性落盘
 * - 不刷屏、不弹窗：这是修复性的清理操作，不是用户该被打扰的事件
 */
async function cleanupDeadPreviewPaths(changes: VideoChange[]): Promise<void> {
  const videos = await listVideos({})
  let cleaned = 0
  for (const v of videos) {
    if (!v.previewPaths || v.previewPaths.length === 0) continue
    const alive = v.previewPaths.filter((p) => {
      try {
        return existsSync(p)
      } catch {
        return false
      }
    })
    if (alive.length === v.previewPaths.length) continue
    cleaned++
    // 合并：先查 changes 里是否已有该 video 的 update，有就改它
    const existing = changes.find((c) => c.type === 'update' && c.video.id === v.id)
    if (existing && existing.type === 'update') {
      existing.video.previewPaths = alive.length > 0 ? alive : undefined
    } else {
      changes.push({
        type: 'update',
        video: { ...v, previewPaths: alive.length > 0 ? alive : undefined }
      })
    }
  }
  if (cleaned > 0) {
    console.log(`[reconcile] 清理 dead previewPaths：${cleaned} 部`)
  }
}

export { VIDEO_EXTS }
