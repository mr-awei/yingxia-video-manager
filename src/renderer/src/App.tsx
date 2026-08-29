import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DisplayEntry,
  ImageSource,
  Library,
  ReconcileResult,
  Settings,
  SortKey,
  Video,
  ViewMode
} from '../../shared/types'
import { DEFAULT_IMAGE_PRIORITY, DEFAULT_SETTINGS } from '../../shared/types'
import { categorizeTag } from '../../shared/tagCategories'
import { extractBaseCode } from '../../shared/code'
import { api } from './lib/api'
import Toolbar from './components/Toolbar'
import Sidebar, { type TagInfo, type SectionInfo, type MetaFacet, type ViewName, type SmartFilter } from './components/Sidebar'
import VirtualizedWall, { type WallSection } from './components/VirtualizedWall'
import ReconcileDialog from './components/ReconcileDialog'
import LibraryModal from './components/LibraryModal'
import SettingsModal from './components/SettingsModal'
import EditMetaModal from './components/EditMetaModal'
import VideoDetail from './components/VideoDetail'
import StatsPanel from './components/StatsPanel'
import AboutModal from './components/AboutModal'
import HomeView from './components/HomeView'
import HomeSkeleton from './components/HomeSkeleton'
import BrowseBar from './components/BrowseBar'
import ListView from './components/ListView'
import Icon from './components/Icon'
import OnboardMdModal from './components/OnboardMdModal'
import { ToastProvider, toast, updateToast, dismissToast } from './components/Toast'
import ConfirmDeleteModal, { type DeletePreview } from './components/ConfirmDeleteModal'
import type { AppInfo } from '../../shared/api-types'

interface FilterState {
  search: string
  sort: SortKey
  desc: boolean
  /** 分组模式：grouped 按 md 分类分组 / flat 全库单网格（适用于所有排序） */
  groupMode: 'grouped' | 'flat'
  /** 当前选中的分类（点击侧栏分类切换；null = 全部） */
  category: string | null
}

/** Fisher-Yates 洗牌（默认用 Math.random，保证每次重建队列都不同；可传入 rand 做可复现） */
function shuffleEntries<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---- 多维筛选：连续维度离散化（分辨率 / 时长 / 评分） ----
function resolutionBucket(v?: Video): string {
  const h = v?.techInfo?.height ?? 0
  const w = v?.techInfo?.width ?? 0
  const px = Math.max(h, w)
  if (px >= 3840) return '4K'
  if (px >= 2560) return '2K'
  if (px >= 1920) return '1080p'
  if (px >= 1280) return '720p'
  if (px >= 640) return '480p'
  if (px > 0) return 'SD'
  return '未知'
}
function durationBucket(sec?: number): string {
  if (!sec || sec <= 0) return '未知'
  if (sec < 1800) return '30分钟内'
  if (sec < 3600) return '30-60分'
  if (sec < 7200) return '1-2小时'
  if (sec < 10800) return '2-3小时'
  return '3小时以上'
}
function scoreBucketOf(e: DisplayEntry): string {
  const s = e.score ?? e.video?.rating
  if (s == null) return '未评分'
  if (s >= 9) return '9-10'
  if (s >= 8) return '8-9'
  if (s >= 7) return '7-8'
  if (s >= 6) return '6-7'
  return '6以下'
}
const RES_ORDER = ['4K', '2K', '1080p', '720p', '480p', 'SD', '未知']
const DUR_ORDER = ['30分钟内', '30-60分', '1-2小时', '2-3小时', '3小时以上', '未知']
const SCORE_ORDER = ['9-10', '8-9', '7-8', '6-7', '6以下', '未评分']

export default function App() {
  const [libraries, setLibraries] = useState<Library[]>([])
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS })
  const [libraryId, setLibraryId] = useState('')
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null)
  const [filter, setFilter] = useState<FilterState>({
    search: '',
    sort: 'title',
    desc: false,
    groupMode: 'grouped' as 'grouped' | 'flat',
    category: null
  })
  /** 搜索输入框的值（立即更新 UI）；实际过滤用防抖后的 filter.search */
  const [searchInput, setSearchInput] = useState('')
  /** 多选标签 AND 过滤（侧栏交互） */
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set())
  /** 演员 / 片商 / 系列 维度筛选（各维度内 OR，跨维度 AND；点击详情页字段触发） */
  const [selectedActors, setSelectedActors] = useState<Set<string>>(new Set())
  const [selectedStudios, setSelectedStudios] = useState<Set<string>>(new Set())
  const [selectedSeries, setSelectedSeries] = useState<Set<string>>(new Set())
  /** 技术规格 / 时间 维度筛选（分辨率 / 时长 / 评分 / 年份），各维度内 OR、跨维度 AND */
  const [selectedResolutions, setSelectedResolutions] = useState<Set<string>>(new Set())
  const [selectedDurations, setSelectedDurations] = useState<Set<string>>(new Set())
  const [selectedScores, setSelectedScores] = useState<Set<string>>(new Set())
  const [selectedYears, setSelectedYears] = useState<Set<string>>(new Set())
  const [statsOpen, setStatsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  /** true = 「添加媒体库」新建表单；false = 库设置编辑模式 */
  const [addingLibrary, setAddingLibrary] = useState(false)
  /** 新建 md 文件向导（添加媒体库无 md / 库设置「按规范新建」时弹出） */
  const [onboard, setOnboard] = useState<Library | null>(null)
  const [editing, setEditing] = useState<Video | null>(null)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [detail, setDetail] = useState<Video | null>(null)
  /** 删除二次确认弹窗：非空时显示；保存预检结果与删除范围 */
  const [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null)
  /** 删除执行中（防重复点击） */
  const [deleting, setDeleting] = useState(false)
  const [scanning, setScanning] = useState(false)
  // 隐私护盾：一键模糊所有预览图（防截图泄露成人内容），持久化到 localStorage
  const [privacy, setPrivacy] = useState<boolean>(() => localStorage.getItem('vm-privacy') === '1')
  const [progress, setProgress] = useState<{ total: number; done: number; current?: string } | null>(null)

  // ---- 新增：导航 / 视图状态 ----
  /** 主导航：home 首页概览 / browse 浏览 */
  const [view, setView] = useState<ViewName>('home')
  /** 智能筛选（我的清单 / 快捷过滤） */
  const [smart, setSmart] = useState<SmartFilter>('all')
  /** 浏览视图模式：竖屏预览墙 / 横屏预览墙 / 纯文件名列表 */
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('vm-viewmode')
    if (saved === 'list') return 'list-filename'
    if (saved === 'grid') return 'grid-portrait'
    return (saved as ViewMode) || 'grid-landscape'
  })
  /** 是否已加载完基础设置（未加载前显示启动遮罩，避免锁界面闪烁泄露内容） */
  const [loaded, setLoaded] = useState(false)
  /** 隐私锁是否已解锁（未上锁时恒为 true） */
  const [unlocked, setUnlocked] = useState(false)
  /** 命令面板 ⌘K */
  /** 随机推荐：手动刷新 nonce（每日刷新由种子里的日期自动驱动） */
  const [recommendNonce, setRecommendNonce] = useState(0)

  // ---- Hero 独立洗牌队列：整库全部影片入队，点一次取下一个，走完一轮自动重新洗牌 ----
  const [heroQueue, setHeroQueue] = useState<DisplayEntry[]>([])
  const [heroIdx, setHeroIdx] = useState(0)
  const heroQueueRef = useRef<DisplayEntry[]>([])
  const heroIdxRef = useRef(0)
  heroQueueRef.current = heroQueue
  heroIdxRef.current = heroIdx

  useEffect(() => {
    localStorage.setItem('vm-viewmode', viewMode)
  }, [viewMode])

  const currentLibrary = useMemo(
    () => libraries.find((l) => l.id === libraryId) ?? null,
    [libraries, libraryId]
  )

  /** 跳过首次自动对账（scanOnStartup=false 时） */
  const skipFirstAutoScanRef = useRef(false)

  // 初始加载：媒体库 + 设置 + 版本号
  useEffect(() => {
    ;(async () => {
      const [libs, s, info] = await Promise.all([api.libraryList(), api.settingsGet(), api.appInfo()])
      setLibraries(libs)
      setSettings(s)
      setAppInfo(info)
      // 隐私护盾默认开（仅在用户从未手动设置过时生效）
      if (s.privacyDefaultOn && localStorage.getItem('vm-privacy') === null) setPrivacy(true)
      // 默认排序（仅当用户还没手动改过排序时应用）
      if (s.defaultSort && s.defaultSort !== 'title') {
        setFilter((f) => (f.sort === 'title' ? { ...f, sort: s.defaultSort } : f))
      }
      // 启动时自动对账开关：关闭则跳过首次自动对账
      if (s.scanOnStartup === false) skipFirstAutoScanRef.current = true
      if (libs.length > 0) setLibraryId(libs[0].id)
      setLoaded(true)
    })()
  }, [])

  // 后台轻量刷新设置：让「自动检查更新」写入的 pendingUpdate / lastUpdateCheck 自动回流到 UI（徽标、设置页横幅）
  useEffect(() => {
    const t = setInterval(() => {
      void api.settingsGet().then(setSettings).catch(() => {})
    }, 60000)
    return () => clearInterval(t)
  }, [])

  // 对账：选中库变化时重新对账
  useEffect(() => {
    if (!libraryId) return
    // 启动时自动对账关闭：跳过首次自动对账（后续手动/库变化仍正常）
    if (skipFirstAutoScanRef.current) {
      skipFirstAutoScanRef.current = false
      return
    }
    let alive = true
    setScanning(true)
    api
      .libraryReconcile(libraryId)
      .then((res) => {
        if (!alive) return
        setReconcile(res)
        if (res.stats.missing > 0 || res.stats.unlisted > 0) setReconcileOpen(true)
      })
      .catch(() => {
        /* 忽略 */
      })
      .finally(() => alive && setScanning(false))
    return () => {
      alive = false
    }
  }, [libraryId])

  // 扫描进度（主进程推送）
  useEffect(() => {
    api.onScanProgress((p) =>
      setProgress(p.total ? { total: p.total, done: p.done, current: p.current } : null)
    )
  }, [])

  // 进度条卡死保险：done===total 时 2.5s 后自动清空（处理 runReconcile 收尾时不再推事件的边界情况）
  const clearTimer = useRef<number | null>(null)
  useEffect(() => {
    if (progress && progress.total > 0 && progress.done >= progress.total) {
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
      clearTimer.current = window.setTimeout(() => setProgress(null), 2500)
    }
    return () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current)
    }
  }, [progress])

  // 扫描 / 补齐进度 → 统一 Toast（进度变体常驻，完成后停留 0.9s 再消失）
  const progressToastId = useRef<string | null>(null)
  useEffect(() => {
    if (progress && progress.total > 0) {
      if (!progressToastId.current) {
        progressToastId.current = toast({
          text: '扫描 / 补齐中…',
          tone: 'info',
          progress: { done: progress.done, total: progress.total, current: progress.current },
          duration: 0
        })
      } else {
        updateToast(progressToastId.current, {
          progress: { done: progress.done, total: progress.total, current: progress.current }
        })
      }
    } else if (progressToastId.current) {
      const id = progressToastId.current
      progressToastId.current = null
      window.setTimeout(() => dismissToast(id), 900)
    }
  }, [progress])

  // 简介 md 文件变化 → 自动重新对账（用 ref 拿最新 libraryId，避免重复监听）
  const libraryIdRef = useRef(libraryId)
  useEffect(() => {
    libraryIdRef.current = libraryId
  }, [libraryId])
  useEffect(() => {
    api.onMdChanged((changedId) => {
      if (changedId === libraryIdRef.current) void runReconcile(changedId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 启动时自动重扫：所有「非当前」媒体库各跑一次对账（当前库由上方 reconcile 副作用覆盖），仅刷新数据、不切换展示
  const autoRescanDone = useRef(false)
  useEffect(() => {
    if (autoRescanDone.current) return
    if (!settings.autoRescan) return
    if (libraries.length === 0) return
    autoRescanDone.current = true
    for (const l of libraries) {
      if (l.id === libraryId) continue
      void api.libraryReconcile(l.id).catch(() => {})
    }
  }, [settings, libraries, libraryId])

  // JavDB 批量抓取：每抓到一张实时刷新该卡片的封面
  useEffect(() => {
    api.onJavdbFetched(
      ({ videoId, posterPath, posterSource }: { videoId: string; posterPath: string; posterSource?: string }) => {
        setReconcile((prev) =>
          prev
            ? {
                ...prev,
                entries: prev.entries.map((e) =>
                  e.video && e.video.id === videoId
                    ? {
                        ...e,
                        video: {
                          ...e.video,
                          posterPath,
                          posterSource: (posterSource ?? 'javdb') as ImageSource
                        }
                      }
                    : e
                )
              }
            : prev
        )
      }
    )
  }, [])

  // 搜索防抖：输入停止 200ms 后才真正触发过滤（大库避免每敲一个字符全量过滤+重排）
  useEffect(() => {
    const t = setTimeout(() => setFilter((f) => (f.search === searchInput ? f : { ...f, search: searchInput })), 200)
    return () => clearTimeout(t)
  }, [searchInput])

  // 皮肤同步：cinema/light/magazine/glass + 跟随系统
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const raw = settings.theme as string
      const effective =
        raw === 'system'
          ? mq.matches
            ? 'cinema'
            : 'light'
          : raw === 'dark'
            ? 'cinema'
            : raw
      const root = document.documentElement
      root.classList.remove('theme-cinema', 'theme-light', 'theme-magazine', 'theme-glass')
      root.classList.add(`theme-${effective}`)
      root.style.colorScheme = effective === 'light' ? 'light' : 'dark'
    }
    apply()
    if (settings.theme === 'system') {
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [settings.theme])


  // 第一层：仅应用搜索 + 多选 tag（不含 category 过滤）—— 用于驱动侧栏所有计数
  const applyTagsOnly = useMemo(() => {
    let list = [...(reconcile?.entries ?? [])]
    const q = filter.search.trim().toLowerCase()
    // 搜 hunta-468-cd2 时提取 base code 'hunta-468'，同时匹配同系列其他分集
    const qBase = extractBaseCode(q).toLowerCase()
    if (q) {
      list = list.filter((e) => {
        const codeLower = e.code.toLowerCase()
        if (codeLower.includes(q)) return true
        if (qBase && qBase !== q && codeLower.includes(qBase)) return true
        if (e.title.toLowerCase().includes(q)) return true
        if ((e.description ?? '').toLowerCase().includes(q)) return true
        if (e.tags.some((t) => t.toLowerCase().includes(q))) return true
        return false
      })
    }
    if (selectedTags.size > 0) {
      list = list.filter((e) => {
        for (const t of selectedTags) if (!e.tags.includes(t)) return false
        return true
      })
    }
    return list
  }, [reconcile, filter.search, selectedTags])

  // 分类集合（来自 applyTagsOnly 的结果，计数 = 再点该分类会变多少）
  const sectionList = useMemo<SectionInfo[]>(() => {
    const order: { name: string; order: number }[] = []
    const counts = new Map<string, number>()
    for (const e of applyTagsOnly) {
      if (!counts.has(e.category)) order.push({ name: e.category, order: e.order })
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
    }
    return order
      .map((s) => ({ name: s.name, order: s.order, count: counts.get(s.name) ?? 0 }))
      .sort((a, b) => a.order - b.order)
  }, [applyTagsOnly])

  // 标签集合：文档结构化分类优先，未知标签用内置字典兜底归类；类别顺序按文档首次出现动态排列
  const { categories: tagCategoriesOrder, tags } = useMemo<{ categories: string[]; tags: TagInfo[] }>(() => {
    const counts = new Map<string, { count: number; category: string }>()
    const catOrder: string[] = []
    const ensureCat = (cat: string) => {
      if (cat !== '其他' && !catOrder.includes(cat)) catOrder.push(cat)
    }
    for (const e of applyTagsOnly) {
      const cats = e.tagCategories ?? {}
      for (const [cat, list] of Object.entries(cats)) {
        ensureCat(cat)
        for (const t of list) {
          const k = counts.get(t)
          if (k) {
            k.count++
            if (k.category === '其他') k.category = cat
          } else {
            counts.set(t, { count: 1, category: cat })
          }
        }
      }
      for (const t of e.tags) {
        if (counts.has(t)) continue
        const cat = categorizeTag(t)
        ensureCat(cat)
        counts.set(t, { count: 1, category: cat })
      }
    }
    catOrder.push('其他')
    const list: TagInfo[] = [...counts.entries()].map(([tag, v]) => ({
      tag,
      count: v.count,
      category: v.category
    }))
    return { categories: catOrder, tags: list }
  }, [applyTagsOnly])

  // 演员 / 片商 / 系列 facet（基于 applyTagsOnly，计数随搜索+tag 联动；用于侧栏像标签一样筛选）
  const metaFacets = useMemo<{ actors: MetaFacet[]; studios: MetaFacet[]; series: MetaFacet[] }>(() => {
    const actors = new Map<string, number>()
    const studios = new Map<string, number>()
    const series = new Map<string, number>()
    for (const e of applyTagsOnly) {
      const d = e.video?.javdbDetail
      const female = d?.actresses?.length ? d.actresses : d?.actors ?? []
      for (const a of female) actors.set(a, (actors.get(a) ?? 0) + 1)
      if (d?.studio) studios.set(d.studio, (studios.get(d.studio) ?? 0) + 1)
      if (d?.series) series.set(d.series, (series.get(d.series) ?? 0) + 1)
    }
    const sort = (m: Map<string, number>) =>
      [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    return { actors: sort(actors), studios: sort(studios), series: sort(series) }
  }, [applyTagsOnly])

  // 技术规格 facet：分辨率 / 时长 / 评分 / 年份（基于 applyTagsOnly，计数随搜索+tag 联动）
  const specFacets = useMemo(() => {
    const res = new Map<string, number>()
    const dur = new Map<string, number>()
    const score = new Map<string, number>()
    const year = new Map<string, number>()
    for (const e of applyTagsOnly) {
      const r = resolutionBucket(e.video); res.set(r, (res.get(r) ?? 0) + 1)
      const sec = e.video?.durationSec ?? e.video?.techInfo?.durationSec
      const d = durationBucket(sec); dur.set(d, (dur.get(d) ?? 0) + 1)
      const s = scoreBucketOf(e); score.set(s, (score.get(s) ?? 0) + 1)
      const y = e.video?.year
      const yk = y ? String(y) : '未知'
      year.set(yk, (year.get(yk) ?? 0) + 1)
    }
    const fromOrder = (m: Map<string, number>, order: string[]): MetaFacet[] => {
      const out: MetaFacet[] = []
      for (const k of order) if ((m.get(k) ?? 0) > 0) out.push({ name: k, count: m.get(k)! })
      for (const [k, c] of m) if (!order.includes(k) && c > 0) out.push({ name: k, count: c })
      return out
    }
    const years = [...year.entries()]
      .filter(([, c]) => c > 0)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name === '未知' ? 1 : b.name === '未知' ? -1 : Number(b.name) - Number(a.name)))
    return {
      resolutions: fromOrder(res, RES_ORDER),
      durations: fromOrder(dur, DUR_ORDER),
      scores: fromOrder(score, SCORE_ORDER),
      years
    }
  }, [applyTagsOnly])

  // 第二层：在 applyTagsOnly 基础上再应用 演员/片商/系列 维度筛选（各维度内 OR，跨维度 AND）
  const applyMetaFilters = useMemo(() => {
    let list = applyTagsOnly
    if (selectedActors.size > 0) {
      list = list.filter((e) => {
        const d = e.video?.javdbDetail
        const female = d?.actresses?.length ? d.actresses : d?.actors ?? []
        return female.some((a) => selectedActors.has(a))
      })
    }
    if (selectedStudios.size > 0) {
      list = list.filter(
        (e) => !!e.video?.javdbDetail?.studio && selectedStudios.has(e.video.javdbDetail.studio)
      )
    }
    if (selectedSeries.size > 0) {
      list = list.filter(
        (e) => !!e.video?.javdbDetail?.series && selectedSeries.has(e.video.javdbDetail.series)
      )
    }
    if (selectedResolutions.size > 0) {
      list = list.filter((e) => selectedResolutions.has(resolutionBucket(e.video)))
    }
    if (selectedDurations.size > 0) {
      list = list.filter((e) => {
        const sec = e.video?.durationSec ?? e.video?.techInfo?.durationSec
        return selectedDurations.has(durationBucket(sec))
      })
    }
    if (selectedScores.size > 0) {
      list = list.filter((e) => selectedScores.has(scoreBucketOf(e)))
    }
    if (selectedYears.size > 0) {
      list = list.filter((e) => {
        const y = e.video?.year
        return !!y && selectedYears.has(String(y))
      })
    }
    return list
  }, [applyTagsOnly, selectedActors, selectedStudios, selectedSeries, selectedResolutions, selectedDurations, selectedScores, selectedYears])

  // 第三层：应用 智能筛选（我的清单 / 快捷过滤）
  const applySmart = useMemo(() => {
    let list = applyMetaFilters
    switch (smart) {
      case 'favorite':
        list = list.filter((e) => !!e.video?.favorite)
        break
      case 'recent':
        list = list.filter((e) => (e.video?.lastPlayedAt ?? 0) > 0)
        break
      case 'unrated':
        list = list.filter((e) => (e.score ?? e.video?.rating) == null)
        break
      case 'nocover':
        list = list.filter((e) => !e.video?.posterPath)
        break
      case 'unlisted':
        list = list.filter((e) => e.category === '未收录')
        break
    }
    return list
  }, [applyMetaFilters, smart])

  // 客户端排序（在 applySmart 基础上 + category 过滤）
  const filtered = useMemo(() => {
    let list = applySmart
    if (filter.category) list = list.filter((e) => e.category === filter.category)
    const dir = filter.desc ? -1 : 1
    list = list.slice().sort((a, b) => {
      if (filter.sort === 'title') return a.code.localeCompare(b.code, 'zh') * dir
      if (filter.sort === 'year') return ((a.video?.year ?? 0) - (b.video?.year ?? 0)) * dir
      if (filter.sort === 'lastPlayed')
        return ((a.video?.lastPlayedAt ?? 0) - (b.video?.lastPlayedAt ?? 0)) * dir
      if (filter.sort === 'random') return Math.random() - 0.5
      if (filter.sort === 'score') return ((b.score ?? 0) - (a.score ?? 0)) // 评分始终高分在前
      return ((a.video?.addedAt ?? 0) - (b.video?.addedAt ?? 0)) * dir
    })
    return list
  }, [applySmart, filter.category, filter.sort, filter.desc])

  // 分组：选中分类 → 单一 section；flat → 全库单网格；其他 → 按 md 分类分组
  const sections = useMemo<WallSection[]>(() => {
    if (filter.category) {
      return [{ title: `📁 ${filter.category}`, entries: filtered }]
    }
    if (filter.groupMode === 'flat') {
      return [{ title: '全库（按当前排序）', entries: filtered }]
    }
    const map = new Map<string, { order: number; entries: DisplayEntry[] }>()
    for (const e of filtered) {
      const g = map.get(e.category) ?? { order: e.order, entries: [] }
      g.entries.push(e)
      map.set(e.category, g)
    }
    return [...map.entries()]
      .map(([title, g]) => ({ title, entries: g.entries }))
      .sort((a, b) => {
        const oa = map.get(a.title)?.order ?? 0
        const ob = map.get(b.title)?.order ?? 0
        return oa - ob
      })
  }, [filtered, filter.sort, filter.groupMode, filter.category])

  // 我的清单 / 待处理 计数（侧栏徽标）
  const flagCounts = useMemo(() => {
    let fav = 0
    let recent = 0
    let unrated = 0
    let nocover = 0
    for (const e of reconcile?.entries ?? []) {
      if (e.video?.favorite) fav++
      if ((e.video?.lastPlayedAt ?? 0) > 0) recent++
      if (e.video && (e.score ?? e.video.rating) == null) unrated++
      if (e.video && !e.video.posterPath) nocover++
    }
    // 未收录 仅统计待处理（已忽略的不计入徽标，但仍可在「待处理」里找到）
    const unlisted = reconcile?.unlisted?.length ?? 0
    return { fav, recent, unrated, nocover, unlisted }
  }, [reconcile])

  // 随机推荐：整库真随机洗牌（每次点击 nonce 变化即重新 Fisher-Yates 洗牌整页）。
  // 改用 Math.random 而非确定性 hash 洗牌，保证「点一次必换一次、绝不原地不动」，
  // 且整库所有影片都参与循环（无海报影片也会以占位符形式出现）。
  const recommend = useMemo<DisplayEntry[]>(() => {
    const list = (reconcile?.entries ?? []).filter((e) => e.video)
    if (list.length === 0) return []
    return shuffleEntries(list).slice(0, 14)
  }, [reconcile, recommendNonce])

  // 库内容变化（扫描 / 切换库 / 补齐信息）→ 用整库全部影片重建 hero 洗牌队列（Fisher-Yates 乱序）
  useEffect(() => {
    const all = (reconcile?.entries ?? []).filter((e) => e.video)
    if (all.length === 0) {
      setHeroQueue([])
      heroQueueRef.current = []
      setHeroIdx(0)
      return
    }
    const q = shuffleEntries(all)
    setHeroQueue(q)
    heroQueueRef.current = q
    setHeroIdx(0)
  }, [reconcile])

  // Hero：从独立队列取当前项（整库参与、不重复、点一次换一次）；队列未就绪时回退到随机推荐首条 / 首个影片
  const hero =
    heroQueue[heroIdx] ??
    recommend[0] ??
    (reconcile?.entries ?? []).filter((e) => e.video)[0] ??
    undefined

  // 点一次 → 取下一项；走到队尾自动重新洗牌（并避免与上一轮尾项重复）
  const onHeroNext = useCallback(() => {
    const q = heroQueueRef.current
    if (q.length <= 1) return
    const next = heroIdxRef.current + 1
    if (next < q.length) {
      setHeroIdx(next)
      return
    }
    const all = (reconcile?.entries ?? []).filter((e) => e.video)
    if (all.length <= 1) return
    const nq = shuffleEntries(all)
    const lastCode = q[q.length - 1]?.code
    if (nq[0]?.code === lastCode && nq.length > 1) nq.push(nq.shift()!)
    setHeroQueue(nq)
    heroQueueRef.current = nq
    setHeroIdx(0)
  }, [reconcile])

  // 详情页相关推荐（同片商 / 系列 / 女演员）
  /**
   * 系列分组：按 folderName 分桶 → 桶内 groupBy base code → 仅保留 ≥2 部的组。
   * 关键：必须限制在同 folderName 内，否则 SSIS-419 单独一个会被其他文件夹的 SSIS-4 误并入系列。
   */
  const seriesGroups = useMemo(() => {
    const m = new Map<string, DisplayEntry[]>()
    const byFolder = new Map<string, DisplayEntry[]>()
    for (const e of reconcile?.entries ?? []) {
      if (!e.video?.folderName) continue
      const list = byFolder.get(e.video.folderName) ?? []
      list.push(e)
      byFolder.set(e.video.folderName, list)
    }
    for (const list of byFolder.values()) {
      const inner = new Map<string, DisplayEntry[]>()
      for (const e of list) {
        const base = extractBaseCode(e.code)
        const g = inner.get(base) ?? []
        g.push(e)
        inner.set(base, g)
      }
      for (const [base, g] of inner) {
        if (g.length >= 2) m.set(base, g)
      }
    }
    return m
  }, [reconcile])

  /** 同文件夹内疑似「系列但后缀未识别」提醒（只弹一次，不重复） */
  const seriesWarnRef = useRef('')
  useEffect(() => {
    if (!reconcile) return
    const byFolder = new Map<string, DisplayEntry[]>()
    for (const e of reconcile.entries) {
      const folder = e.video?.folderName
      if (!folder) continue
      const list = byFolder.get(folder) ?? []
      list.push(e)
      byFolder.set(folder, list)
    }
    const warns: string[] = []
    for (const list of byFolder.values()) {
      if (list.length < 2) continue
      const known = new Set<string>()
      for (const e of list) {
        const b = extractBaseCode(e.code)
        if (b !== e.code.toUpperCase()) known.add(b)
      }
      for (const e of list) {
        const c = e.code.toUpperCase()
        if (extractBaseCode(c) === c) {
          for (const k of known) {
            if (c.startsWith(k) && c !== k) {
              warns.push(e.code)
              break
            }
          }
        }
      }
    }
    if (warns.length) {
      const sig = warns.join(',')
      if (sig !== seriesWarnRef.current) {
        seriesWarnRef.current = sig
        showBatchToast({
          title: '检测到可能的同系列视频',
          ok: 0,
          failed: 0,
          bySource: { javapi: 0, javinfo: 0, javdb: 0, javbus: 0 },
          reasons: warns.slice(0, 8).map((c) => `${c}${warns.length > 8 ? '…' : ''}`),
          stopped: false,
          remaining: 0
        })
      }
    }
  }, [reconcile])

  const relatedEntries = useMemo<DisplayEntry[]>(() => {
    if (!detail) return []
    const d = detail.javdbDetail
    if (!d?.studio && !d?.series && !(d?.actresses && d.actresses.length)) return []
    return (reconcile?.entries ?? [])
      .filter(
        (e) =>
          e.video &&
          e.video.id !== detail.id &&
          ((d.studio && e.video.javdbDetail?.studio === d.studio) ||
            (d.series && e.video.javdbDetail?.series === d.series) ||
            (d.actresses &&
              e.video.javdbDetail?.actresses?.some((a) => d.actresses!.includes(a))))
      )
      .slice(0, 12)
  }, [detail, reconcile])

  const totalSelected = selectedTags.size
  const metaSelectedCount = selectedActors.size + selectedStudios.size + selectedSeries.size
  const techSelectedCount = selectedResolutions.size + selectedDurations.size + selectedScores.size + selectedYears.size
  const hasActiveFilters = totalSelected + metaSelectedCount + techSelectedCount + (filter.category ? 1 : 0) > 0 || smart !== 'all'

  // ---------- 回调 ----------

  const runReconcile = useCallback(async (id: string) => {
    setScanning(true)
    setProgress(null)
    try {
      const res = await api.libraryReconcile(id)
      setReconcile(res)
      if (res.stats.missing > 0 || res.stats.unlisted > 0) setReconcileOpen(true)
    } catch {
      /* 忽略 */
    }
    setScanning(false)
  }, [])

  /** 添加媒体库：打开「添加媒体库」表单（不再直接连弹两个系统对话框），表单内提供两步引导说明 */
  const handleAddLibrary = useCallback(() => {
    setAddingLibrary(true)
    setLibraryOpen(true)
  }, [])

  const handleScan = useCallback(() => {
    if (libraryId) void runReconcile(libraryId)
  }, [libraryId, runReconcile])

  const handleOpenEntry = useCallback((entry: DisplayEntry) => {
    if (entry.video) setDetail(entry.video)
  }, [])

  const handleEditEntry = useCallback((v: Video) => setEditing(v), [])

  /** 从磁盘删除视频文件：预检 → 打开二次确认弹窗（Impeccable 设计 ConfirmDeleteModal） */
  const openDeleteConfirm = useCallback(
    async (v: Video) => {
      if (!v.path) {
        window.alert('该视频没有文件路径，无法删除')
        return
      }
      const fileName = v.path.split(/[\\/]/).pop() || v.path

      // 预检：让用户在确认前看到准确的删除范围（不删任何文件）
      const inspect = await api.videoInspectForDelete(v.id).catch((e) => ({ ok: false as const, error: String(e) }))
      if (!inspect.ok) {
        window.alert('删除预检失败：' + inspect.error)
        return
      }
      const otherVideoCount = inspect.otherVideoCount ?? 0
      const torrentCount = inspect.torrentCount ?? 0
      const otherFileCount = inspect.otherFileCount ?? 0
      const willDeleteDir = otherVideoCount === 0 && torrentCount > 0 && otherFileCount === 0

      setDeletePreview({
        id: v.id,
        title: v.title,
        filePath: v.path,
        fileName,
        otherVideoCount,
        torrentCount,
        otherFileCount,
        scope: willDeleteDir ? 'dir' : 'file',
        dirPath: willDeleteDir ? inspect.dirPath : undefined
      })
    },
    []
  )

  /** 弹窗确认后：把文件/目录挪到回收站 → 关详情页 → 全库扫描 */
  const confirmDelete = useCallback(async () => {
    if (!deletePreview || deleting) return
    const fileName = deletePreview.fileName
    setDeleting(true)
    try {
      const r = await api.videoDeleteFile(deletePreview.id)
      if (!r.ok) {
        window.alert('删除失败：' + (r.error ?? '未知错误'))
        setDeletePreview(null)
        return
      }
      const desc = r.deletedDir
        ? `已把整个目录挪到回收站（含视频和种子）：${r.dirPath}`
        : `已把文件挪到回收站：${fileName}`
      const cacheDesc = r.removedCache ? `\n已清理 ${r.removedCache} 个关联缓存（封面/截图/javdb 信息）` : ''
      const recordDesc = r.removedRecord ? `\n已清除该视频的 javdb 元数据（演员/时长/导演/片商等）` : ''
      toast({ title: '已挪到回收站', text: desc + cacheDesc + recordDesc + '\n（可从回收站恢复）', tone: 'ok', duration: 5000 })
      // 删除/挪到回收站后关闭详情页（用户已无该视频的打开需求）
      setDetail(null)
      setDeletePreview(null)
      // 触发全库扫描，让 data.json 重新同步
      if (libraryId) {
        await runReconcile(libraryId)
      }
    } catch (e) {
      window.alert('删除失败：' + ((e as Error)?.message ?? String(e)))
    } finally {
      setDeleting(false)
    }
  }, [deletePreview, deleting, libraryId])

  const handleDetailFetched = useCallback((videoId: string, detail: Video['javdbDetail']) => {
    setReconcile((prev) =>
      prev
        ? {
            ...prev,
            entries: prev.entries.map((e) =>
              e.video && e.video.id === videoId ? { ...e, video: { ...e.video, javdbDetail: detail } } : e
            )
          }
        : prev
    )
  }, [])

  const handlePosterFetched = useCallback(
    (videoId: string, posterPath: string, previewPaths?: string[]) => {
      setReconcile((prev) =>
        prev
          ? {
              ...prev,
              entries: prev.entries.map((e) =>
                e.video && e.video.id === videoId
                  ? { ...e, video: { ...e.video, posterPath, posterSource: 'ffmpeg', previewPaths } }
                  : e
              )
            }
          : prev
      )
    },
    []
  )

  const handleOpenMissing = useCallback(
    (_entry: DisplayEntry) => {
      if (currentLibrary?.introMdPath) void api.openPath(currentLibrary.introMdPath)
    },
    [currentLibrary]
  )

  const handleSaveLibrary = useCallback(
    async (patch: Partial<Library>): Promise<boolean> => {
      if (addingLibrary) {
        const lib = await api.libraryAdd({
          name: patch.name?.trim() || patch.folderPath || '未命名媒体库',
          folderPath: patch.folderPath || '',
          introMdPath: patch.introMdPath ?? '',
          imagePriority: [...DEFAULT_IMAGE_PRIORITY]
        })
        if (!lib) return false
        setLibraries((prev) => [...prev, lib])
        setLibraryId(lib.id)
        setLibraryOpen(false)
        setAddingLibrary(false)
        await runReconcile(lib.id)
        // 未选择 md 文件：自动弹出「新建简介文件向导」，引导用户按内置规范生成 md
        if (!patch.introMdPath) setOnboard(lib)
        return true
      }
      if (!currentLibrary) return false
      const updated = await api.libraryUpdate(currentLibrary.id, patch)
      if (updated) {
        setLibraries((prev) => prev.map((l) => (l.id === updated.id ? updated : l)))
        setLibraryOpen(false)
        await runReconcile(updated.id)
        return true
      }
      return false
    },
    [addingLibrary, currentLibrary, runReconcile]
  )

  const handleRemoveLibrary = useCallback(async () => {
    if (!currentLibrary) return
    await api.libraryRemove(currentLibrary.id)
    setLibraries((prev) => prev.filter((l) => l.id !== currentLibrary.id))
    setLibraryOpen(false)
    setAddingLibrary(false)
    setReconcile(null)
    const rest = libraries.filter((l) => l.id !== currentLibrary.id)
    setLibraryId(rest[0]?.id ?? '')
  }, [currentLibrary, libraries])

  const handleSaveMeta = useCallback(async (id: string, patch: Partial<Video>) => {
    const updated = await api.videoUpdate(id, patch)
    if (updated) {
      setReconcile((prev) =>
        prev
          ? {
              ...prev,
              entries: prev.entries.map((e) => (e.video && e.video.id === id ? { ...e, video: updated } : e))
            }
          : prev
      )
      setEditing(null)
    }
  }, [])

  const handleFetchJavdb = useCallback(async (videoId: string) => {
    const updated = await api.videoFetchJavdbPoster(videoId)
    if (updated) {
      setReconcile((prev) =>
        prev
          ? {
              ...prev,
              entries: prev.entries.map((e) =>
                e.video && e.video.id === videoId ? { ...e, video: updated } : e
              )
            }
          : prev
      )
    }
    return updated
  }, [])

  /** 批量补齐结果：结构化数据 → 统一 Toast（含来源分布 / 失败原因） */
  interface BatchToastData {
    title?: string
    tone?: 'ok' | 'warn' | 'err'
    ok: number
    failed: number
    bySource: { javapi: number; javinfo: number; javdb: number; javbus: number }
    reasons: string[]
    stopped: boolean
    remaining: number
  }
  const showBatchToast = (data: Omit<BatchToastData, 'tone'> & { tone?: 'ok' | 'warn' | 'err' }) => {
    // 自动推断 tone：err（异常）> 停止 > 部分失败 > 全成功
    const tone: 'ok' | 'warn' | 'err' = data.tone ?? (data.stopped || data.failed > 0 ? 'warn' : 'ok')
    const total = data.ok + data.failed
    const jd = data.bySource.javdb
    const jb = data.bySource.javbus
    const ji = data.bySource.javinfo ?? 0
    const jp = data.bySource.javapi ?? 0
    const title = data.title ?? (tone === 'ok' ? '补齐完成' : tone === 'warn' ? '补齐部分失败' : '补齐失败')
    const subtitle = data.failed > 0 ? `成功 ${data.ok} 部 · 失败 ${data.failed} 部` : data.ok > 0 ? `成功 ${data.ok} 部` : ''
    const detail = (
      <div className="space-y-2">
        {total > 0 ? (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] uppercase tracking-wider text-white/45 font-medium">来源分布</span>
              <span className="text-[10px] text-white/65 font-mono tabular-nums">
                Javapi {jp} · Javinfo {ji} · JavDB {jd} · JavBus {jb} · 失败 {data.failed}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-white/8 overflow-hidden flex">
              <div
                className={`h-full transition-all ${data.failed > 0 ? 'bg-emerald-500' : 'bg-brand'}`}
                style={{ width: `${total > 0 ? (data.ok / total) * 100 : 0}%` }}
              />
              {data.failed > 0 ? (
                <div className="bg-red-500/60 h-full transition-all" style={{ width: `${total > 0 ? (data.failed / total) * 100 : 0}%` }} />
              ) : null}
            </div>
          </div>
        ) : null}
        {data.reasons.length > 0 ? (
          <div className="space-y-0.5">
            {data.reasons.map((r, i) => (
              <div key={i} className="text-[12px] text-white/55 truncate">· {r}</div>
            ))}
          </div>
        ) : null}
        {data.stopped ? (
          <div className="text-[11px] text-amber-400/90">⚠ 已自动停止，剩余 {data.remaining} 部未处理</div>
        ) : null}
      </div>
    )
    toast({ title, text: subtitle, tone, detail, duration: 9000 })
  }

  const handleBatchJavdb = useCallback(async (force = false) => {
    if (!libraryId) return
    setScanning(true)
    setProgress(null)
    try {
      const res = await api.libraryFetchJavdbAll(libraryId, force)
      // 失败原因按文本去重计数，Top3 给 toast 显示
      const reasonCount: Record<string, number> = {}
      for (const f of res.failures ?? []) {
        const key = f.reason || '未知原因'
        reasonCount[key] = (reasonCount[key] ?? 0) + 1
      }
      const reasons = Object.entries(reasonCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([r, n]) => `${r}（×${n}）`)
      const tone: 'ok' | 'warn' | 'err' = res.stopped || res.failed > 0 ? 'warn' : 'ok'
      showBatchToast({
        title: tone === 'ok' ? '补齐完成' : '补齐部分失败',
        tone,
        ok: res.ok,
        failed: res.failed,
        bySource: { javapi: res.bySource.javapi ?? 0, javinfo: res.bySource.javinfo ?? 0, javdb: res.bySource.javdb ?? 0, javbus: res.bySource.javbus ?? 0 },
        reasons,
        stopped: res.stopped ?? false,
        remaining: res.remaining ?? 0
      })
      await runReconcile(libraryId)
    } catch (e) {
      showBatchToast({
        title: '补齐失败',
        tone: 'err',
        ok: 0,
        failed: 0,
        bySource: { javapi: 0, javinfo: 0, javdb: 0, javbus: 0 },
        reasons: [`请求异常：${(e as Error)?.message ?? e}`],
        stopped: false,
        remaining: 0
      })
    } finally {
      // 批量补齐结束后再保留进度条 1 秒，让用户看到「完成」
      setTimeout(() => setProgress(null), 1000)
      setScanning(false)
    }
  }, [libraryId, runReconcile])

  const handlePreviewRenames = useCallback(async () => {
    if (!libraryId) return []
    return api.libraryPreviewRenames(libraryId)
  }, [libraryId])

  const handleApplyRenames = useCallback(
    async (items: { path: string; newName: string }[]) => {
      if (!libraryId) return { ok: 0, failed: [] }
      const r = await api.libraryApplyRenames(libraryId, items)
      if (r.ok > 0) await runReconcile(libraryId)
      return r
    },
    [libraryId, runReconcile]
  )

  const handleSaveSettings = useCallback(async (patch: Partial<Settings>) => {
    const s = await api.settingsSet(patch)
    setSettings(s)
    setSettingsOpen(false)
    // 刚开启自动更新频率时，立即联网检测一次，让「待处理更新」尽快可见
    if (patch.autoUpdateFrequency && patch.autoUpdateFrequency !== 'off') {
      void api.updateCheck().then(() => api.settingsGet().then(setSettings)).catch(() => {})
    }
  }, [])

  const togglePrivacy = useCallback(() => {
    setPrivacy((p) => {
      const next = !p
      localStorage.setItem('vm-privacy', next ? '1' : '0')
      return next
    })
  }, [])

  const toggleTag = useCallback((t: string) => {
    setSelectedTags((prev) => {
      const n = new Set(prev)
      if (n.has(t)) n.delete(t)
      else n.add(t)
      return n
    })
  }, [])

  const clearTags = useCallback(() => setSelectedTags(new Set()), [])

  // 收藏切换（持久化到视频记录，同步本地 reconcile）
  const toggleFlag = useCallback(
    async (id: string, key: 'favorite') => {
      const entry = reconcile?.entries.find((e) => e.video?.id === id)
      const v = entry?.video
      if (!v) return
      const next = !v[key]
      const updated = await api.videoUpdate(id, { [key]: next } as Partial<Video>)
      if (updated) {
        setReconcile((prev) =>
          prev
            ? {
                ...prev,
                entries: prev.entries.map((e) =>
                  e.video && e.video.id === id ? { ...e, video: updated } : e
                )
              }
            : prev
        )
      }
    },
    [reconcile]
  )

  // ---------- 导航 ----------

  const clearAllFilters = useCallback(() => {
    setSmart('all')
    setFilter((f) => ({ ...f, category: null }))
    setSelectedTags(new Set())
    setSelectedActors(new Set())
    setSelectedStudios(new Set())
    setSelectedSeries(new Set())
    clearTechFilters()
  }, [])

  const onNav = useCallback((v: ViewName, s?: SmartFilter) => {
    setView(v)
    if (s) setSmart(s)
    // 进入具体智能筛选时清空其它筛选，避免叠加混乱
    setFilter((f) => ({ ...f, category: null }))
    setSelectedTags(new Set())
    setSelectedActors(new Set())
    setSelectedStudios(new Set())
    setSelectedSeries(new Set())
    clearTechFilters()
    if (s === 'recent') setFilter((f) => ({ ...f, sort: 'lastPlayed', desc: true }))
  }, [])

  const handleNavLibrary = useCallback((id: string) => {
    setLibraryId(id)
    setView('browse')
    setSmart('all')
    setFilter((f) => ({ ...f, category: null, sort: 'title', desc: false }))
    setSelectedTags(new Set())
    setSelectedActors(new Set())
    setSelectedStudios(new Set())
    setSelectedSeries(new Set())
    clearTechFilters()
  }, [])


  const onSmart = useCallback((s: SmartFilter) => {
    setSmart(s)
    if (s !== 'all') {
      setFilter((f) => ({ ...f, category: null }))
      setSelectedTags(new Set())
      setSelectedActors(new Set())
      setSelectedStudios(new Set())
      setSelectedSeries(new Set())
    }
    if (s === 'recent') setFilter((f) => ({ ...f, sort: 'lastPlayed', desc: true }))
  }, [])

  // ---------- 演员 / 片商 / 系列 维度筛选 ----------
  const toggleActor = useCallback((a: string) => {
    setSelectedActors((prev) => {
      const n = new Set(prev)
      if (n.has(a)) n.delete(a)
      else n.add(a)
      return n
    })
  }, [])
  const toggleStudio = useCallback((s: string) => {
    setSelectedStudios((prev) => {
      const n = new Set(prev)
      if (n.has(s)) n.delete(s)
      else n.add(s)
      return n
    })
  }, [])
  const toggleSeries = useCallback((s: string) => {
    setSelectedSeries((prev) => {
      const n = new Set(prev)
      if (n.has(s)) n.delete(s)
      else n.add(s)
      return n
    })
  }, [])
  const clearMetaFilters = useCallback(() => {
    setSelectedActors(new Set())
    setSelectedStudios(new Set())
    setSelectedSeries(new Set())
    clearTechFilters()
  }, [])

  const clearActors = useCallback(() => setSelectedActors(new Set()), [])
  const clearStudios = useCallback(() => setSelectedStudios(new Set()), [])
  const clearSeries = useCallback(() => setSelectedSeries(new Set()), [])

  // ---------- 技术规格 / 时间 维度筛选 ----------
  const toggleResolution = useCallback((v: string) => {
    setSelectedResolutions((prev) => {
      const n = new Set(prev)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  }, [])
  const toggleDuration = useCallback((v: string) => {
    setSelectedDurations((prev) => {
      const n = new Set(prev)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  }, [])
  const toggleScore = useCallback((v: string) => {
    setSelectedScores((prev) => {
      const n = new Set(prev)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  }, [])
  const toggleYear = useCallback((v: string) => {
    setSelectedYears((prev) => {
      const n = new Set(prev)
      if (n.has(v)) n.delete(v)
      else n.add(v)
      return n
    })
  }, [])
  const clearResolutions = useCallback(() => setSelectedResolutions(new Set()), [])
  const clearDurations = useCallback(() => setSelectedDurations(new Set()), [])
  const clearScores = useCallback(() => setSelectedScores(new Set()), [])
  const clearYears = useCallback(() => setSelectedYears(new Set()), [])
  const clearTechFilters = useCallback(() => {
    setSelectedResolutions(new Set())
    setSelectedDurations(new Set())
    setSelectedScores(new Set())
    setSelectedYears(new Set())
  }, [])

  const handlePickFilter = useCallback((f: { type: 'actor' | 'studio' | 'series'; value: string }) => {
    setDetail(null)
    if (f.type === 'actor') setSelectedActors(new Set([f.value]))
    else if (f.type === 'studio') setSelectedStudios(new Set([f.value]))
    else setSelectedSeries(new Set([f.value]))
    setView('browse')
    setSmart('all')
    setFilter((p) => ({ ...p, category: null }))
  }, [])

  // 详情页 / 卡片点击标签 → 一键筛选该标签全部影片
  const handlePickTag = useCallback((tag: string) => {
    setDetail(null)
    setSelectedTags(new Set([tag]))
    setSmart('all')
    setView('browse')
    setFilter((p) => ({ ...p, category: null }))
  }, [])

  const handleTechInfoFetched = useCallback((videoId: string, tech: Video['techInfo']) => {
    setReconcile((prev) =>
      prev
        ? {
            ...prev,
            entries: prev.entries.map((e) =>
              e.video && e.video.id === videoId ? { ...e, video: { ...e.video, techInfo: tech } } : e
            )
          }
        : prev
    )
  }, [])

  const toggleCategory = useCallback((c: string) => {
    setFilter((f) => ({ ...f, category: f.category === c ? null : c }))
  }, [])

  const clearCategory = useCallback(() => setFilter((f) => ({ ...f, category: null })), [])

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), [])

  const mismatch =
    reconcile && (reconcile.stats.missing > 0 || reconcile.stats.unlisted > 0)
      ? { missing: reconcile.stats.missing, unlisted: reconcile.stats.unlisted }
      : null


  const currentEntry = detail
    ? (reconcile?.entries ?? []).find((e) => e.video && e.video.id === detail.id)
    : undefined
  const currentBase = currentEntry ? extractBaseCode(currentEntry.code) : undefined
  const seriesMembers =
    currentBase && seriesGroups.has(currentBase) ? seriesGroups.get(currentBase) : undefined

  // 启动遮罩：未加载完基础设置前不渲染任何内容（防止隐私锁闪烁泄露）
  if (!loaded) {
    return <SplashScreen />
  }
  // 隐私锁：已上锁且未解锁 → 拦截整个界面
  const locked = !!settings.lockHash && !unlocked
  if (locked) {
    return <LockScreen onUnlock={() => setUnlocked(true)} />
  }

  return (
    <ToastProvider>
    <div
      className={`h-full flex flex-col text-white ${privacy ? 'privacy-on' : ''} density-${settings.posterDensity}`}
      style={{ contain: 'layout' }}
    >
      <Toolbar
        search={searchInput}
        onSearch={(v) => {
          setSearchInput(v)
          if (v.trim()) {
            setView('browse')
            setSmart('all')
          }
        }}
        onHome={() => setView('home')}
        onAddLibrary={handleAddLibrary}
        privacy={privacy}
        onTogglePrivacy={togglePrivacy}
        libraryName={currentLibrary?.name}
        onScan={handleScan}
        onBatchJavdb={handleBatchJavdb}
      />

      <div className="flex-1 flex min-h-0">
        <Sidebar
          view={view}
          smart={smart}
          onNav={onNav}
          libraries={libraries}
          libraryId={libraryId}
          onLibrary={handleNavLibrary}
          onEditLibrary={() => {
            setAddingLibrary(false)
            setLibraryOpen(true)
          }}
          onAddLibrary={handleAddLibrary}
          favoriteCount={flagCounts.fav}
          recentCount={flagCounts.recent}
          unlistedCount={flagCounts.unlisted}
          unratedCount={flagCounts.unrated}
          nocoverCount={flagCounts.nocover}
          pendingUpdate={settings.pendingUpdate}
          sections={sectionList}
          selectedCategory={filter.category}
          onToggleCategory={toggleCategory}
          onClearCategory={clearCategory}
          tags={tags}
          categories={tagCategoriesOrder}
          selected={selectedTags}
          onToggle={toggleTag}
          onClear={clearTags}
          actorFacets={metaFacets.actors}
          studioFacets={metaFacets.studios}
          seriesFacets={metaFacets.series}
          selectedActors={selectedActors}
          selectedStudios={selectedStudios}
          selectedSeries={selectedSeries}
          onToggleActor={toggleActor}
          onToggleStudio={toggleStudio}
          onToggleSeries={toggleSeries}
          onClearActors={clearActors}
          onClearStudios={clearStudios}
          onClearSeries={clearSeries}
          onClearMetaFilters={clearMetaFilters}
          resolutionFacets={specFacets.resolutions}
          durationFacets={specFacets.durations}
          scoreFacets={specFacets.scores}
          yearFacets={specFacets.years}
          selectedResolutions={selectedResolutions}
          selectedDurations={selectedDurations}
          selectedScores={selectedScores}
          selectedYears={selectedYears}
          onToggleResolution={toggleResolution}
          onToggleDuration={toggleDuration}
          onToggleScore={toggleScore}
          onToggleYear={toggleYear}
          onClearResolutions={clearResolutions}
          onClearDurations={clearDurations}
          onClearScores={clearScores}
          onClearYears={clearYears}
          onClearTechFilters={clearTechFilters}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          onOpenStats={() => setStatsOpen(true)}
          onOpenAbout={() => setAboutOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <div className="flex-1 min-w-0">
          {libraries.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center animate-fadeIn">
              <div className="w-16 h-16 rounded-2xl bg-brand/10 ring-1 ring-brand/30 flex items-center justify-center mb-5">
                <Icon name="film" size={30} className="text-brand" />
              </div>
              <div className="text-2xl font-semibold mb-2">欢迎使用影匣</div>
              <div className="text-white/50 text-sm mb-6 max-w-md leading-relaxed">
                选择一个视频文件夹，再选择对应的「简介 md 文件」。
                海报墙会按简介文件中的分类展示影片，并自动对账文件夹与简介的差异。
              </div>
              <button className="btn btn-brand px-5 py-2.5" onClick={handleAddLibrary}>
                <Icon name="plus" size={16} />
                添加媒体库
              </button>
            </div>
          ) : !reconcile ? (
            <HomeSkeleton
              aspect={viewMode === 'grid-portrait' ? 'portrait' : 'landscape'}
              label={scanning ? '正在对账…' : '正在加载媒体库…'}
            />
          ) : view === 'home' ? (
            <HomeView
              key="home"
              entries={reconcile.entries}
              onOpen={handleOpenEntry}
              onEdit={handleEditEntry}
              onOpenMissing={handleOpenMissing}
              onToggleFlag={toggleFlag}
              onBrowse={(s) => onNav('browse', s)}
              recommend={recommend}
              onRefreshRecommend={() => setRecommendNonce((n) => n + 1)}
              hero={hero}
              onHeroNext={onHeroNext}
              onPickTag={handlePickTag}
              onDelete={openDeleteConfirm}
              viewMode={viewMode}
              onSetView={setViewMode}
            />
          ) : filtered.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-white/40 text-sm px-6 text-center animate-fadeIn">
              <div className="w-14 h-14 rounded-2xl bg-ink-800 ring-1 ring-white/5 flex items-center justify-center mb-4">
                <Icon name="search" size={26} />
              </div>
              当前筛选条件下没有匹配的影片，试试调整搜索或标签。
            </div>
          ) : (
            <div key="browse" className="h-full flex flex-col p-4 min-h-0 animate-fadeIn">
              <BrowseBar
                libraryName={currentLibrary?.name}
                categoryLabel={filter.category}
                smart={smart}
                onSmart={onSmart}
                resultCount={filtered.length}
                sort={filter.sort}
                onSort={(v) => setFilter((f) => ({ ...f, sort: v }))}
                desc={filter.desc}
                onToggleDesc={() => setFilter((f) => ({ ...f, desc: !f.desc }))}
                groupMode={filter.groupMode}
                onToggleGroup={() => setFilter((f) => ({ ...f, groupMode: f.groupMode === 'grouped' ? 'flat' : 'grouped' }))}
                viewMode={viewMode}
                onSetView={setViewMode}
                onClearAll={clearAllFilters}
                hasActiveFilters={hasActiveFilters}
                mismatch={mismatch}
                onShowReconcile={() => setReconcileOpen(true)}
              />

              {/* 活跃筛选条：多维筛选可视化，可单独移除 */}
              {(metaSelectedCount + techSelectedCount) > 0 ? (
                <div className="mb-3 flex flex-wrap items-center gap-2 animate-fadeIn-fast">
                  <span className="text-white/40 text-xs">筛选：</span>
                  {[...selectedActors].map((a) => (
                    <button
                      key={`a-${a}`}
                      onClick={() => toggleActor(a)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-brand/15 text-brand ring-1 ring-brand/30 hover:bg-brand/25 transition-colors"
                    >
                      女演员：{a}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  {[...selectedStudios].map((s) => (
                    <button
                      key={`s-${s}`}
                      onClick={() => toggleStudio(s)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-brand/15 text-brand ring-1 ring-brand/30 hover:bg-brand/25 transition-colors"
                    >
                      片商：{s}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  {[...selectedSeries].map((s) => (
                    <button
                      key={`se-${s}`}
                      onClick={() => toggleSeries(s)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-brand/15 text-brand ring-1 ring-brand/30 hover:bg-brand/25 transition-colors"
                    >
                      系列：{s}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  {[...selectedResolutions].map((r) => (
                    <button
                      key={`r-${r}`}
                      onClick={() => toggleResolution(r)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                    >
                      分辨率：{r}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  {[...selectedDurations].map((d) => (
                    <button
                      key={`d-${d}`}
                      onClick={() => toggleDuration(d)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                    >
                      时长：{d}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  {[...selectedScores].map((s) => (
                    <button
                      key={`sc-${s}`}
                      onClick={() => toggleScore(s)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                    >
                      评分：{s}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  {[...selectedYears].map((y) => (
                    <button
                      key={`y-${y}`}
                      onClick={() => toggleYear(y)}
                      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
                    >
                      年份：{y}
                      <Icon name="x" size={11} className="opacity-70" />
                    </button>
                  ))}
                  <button
                    onClick={clearAllFilters}
                    className="h-6 px-2 rounded-md text-[11px] text-white/50 hover:text-white hover:bg-ink-700 transition-colors"
                  >
                    清除全部
                  </button>
                </div>
              ) : null}

              <div className="flex-1 min-h-0">
                {viewMode === 'list-filename' ? (
                  <ListView
                    entries={filtered}
                    onOpen={handleOpenEntry}
                    onEdit={handleEditEntry}
                    onOpenMissing={handleOpenMissing}
                    onToggleFlag={toggleFlag}
                    onPickTag={handlePickTag}
                    mode="filename"
                  />
                ) : (
                  <VirtualizedWall
                    key={viewMode}
                    sections={sections}
                    onOpen={handleOpenEntry}
                    onEdit={handleEditEntry}
                    onOpenMissing={handleOpenMissing}
                    onToggleFlag={toggleFlag}
                    onPickTag={handlePickTag}
                    onDelete={openDeleteConfirm}
                    aspect={viewMode === 'grid-landscape' ? 'landscape' : 'portrait'}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <ReconcileDialog
        open={reconcileOpen}
        result={reconcile}
        mdPath={currentLibrary?.introMdPath}
        ignoredUnlistedPaths={settings.ignoredUnlistedPaths}
        onClose={() => setReconcileOpen(false)}
        onOpenFile={(p) => void api.openPath(p)}
        onRevealInFolder={(p) => void api.shellRevealInFolder(p)}
        onPreviewRenames={handlePreviewRenames}
        onApplyRenames={handleApplyRenames}
        onIgnoreUnlisted={async (p) => {
          if (!libraryId) return
          const next = [...new Set([...settings.ignoredUnlistedPaths, p])]
          const s = await api.settingsSet({ ignoredUnlistedPaths: next })
          setSettings(s)
          await runReconcile(libraryId)
        }}
        onUnignoreUnlisted={async (p) => {
          if (!libraryId) return
          const next = settings.ignoredUnlistedPaths.filter((x) => x !== p)
          const s = await api.settingsSet({ ignoredUnlistedPaths: next })
          setSettings(s)
          await runReconcile(libraryId)
        }}
      />

      <LibraryModal
        open={libraryOpen}
        library={addingLibrary ? null : currentLibrary}
        onClose={() => {
          setLibraryOpen(false)
          setAddingLibrary(false)
        }}
        onSave={handleSaveLibrary}
        onRemove={handleRemoveLibrary}
        onOnboard={() => {
          setLibraryOpen(false)
          setAddingLibrary(false)
          setOnboard(currentLibrary)
        }}
      />

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={handleSaveSettings}
        onSaved={() => {
          void api.settingsGet().then(setSettings)
        }}
      />

      <AboutModal
        open={aboutOpen}
        info={appInfo}
        onClose={() => setAboutOpen(false)}
        onOpenExternal={(u) => void api.openExternal(u)}
      />

      <EditMetaModal
        video={editing}
        onClose={() => setEditing(null)}
        onSave={handleSaveMeta}
        onFetchJavdb={handleFetchJavdb}
      />

      {detail ? (
        <VideoDetail
          video={detail}
          onClose={() => setDetail(null)}
          onPlay={(v) => {
            setDetail(null)
            void api.videoOpen(v.id)
          }}
          onDetailFetched={handleDetailFetched}
          onPosterFetched={handlePosterFetched}
          onTechInfoFetched={handleTechInfoFetched}
          onPickFilter={handlePickFilter}
          onPickTag={handlePickTag}
          onToggleFlag={toggleFlag}
          related={relatedEntries}
          seriesBase={currentBase}
          seriesMembers={seriesMembers}
          onOpenRelated={(e) => {
            if (e.video) setDetail(e.video)
          }}
          onEdit={(v) => {
            setDetail(null)
            setEditing(v)
          }}
          onDelete={openDeleteConfirm}
        />
      ) : null}

      {statsOpen && reconcile ? (
        <StatsPanel
          open={statsOpen}
          result={reconcile}
          onClose={() => setStatsOpen(false)}
          onOpen={(entry) => {
            setStatsOpen(false)
            handleOpenEntry(entry)
          }}
        />
      ) : null}

      <OnboardMdModal
        open={!!onboard}
        library={onboard}
        onClose={() => setOnboard(null)}
        onOpenExternal={(u) => void api.openExternal(u)}
        onOpenSpec={(p) => void api.openPath(p)}
        onOpenLibrarySettings={() => {
          setOnboard(null)
          setAddingLibrary(false)
          setLibraryOpen(true)
        }}
      />

      {/* 删除文件二次确认（Impeccable 设计：琥珀=仅删文件 / 红=整目录删） */}
      <ConfirmDeleteModal
        open={!!deletePreview}
        preview={deletePreview}
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeletePreview(null)}
      />

    </div>
    </ToastProvider>
  )
}

/** 启动遮罩：加载基础设置期间显示，避免隐私锁闪烁泄露内容 */
function SplashScreen() {
  return (
    <div className="h-full flex flex-col items-center justify-center bg-ink-900 text-white/70 animate-fadeIn">
      <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand to-[#ff9db6] flex items-center justify-center shadow-glow-sm mb-4">
        <Icon name="film" size={24} className="text-white" />
      </div>
      <div className="text-sm">影匣启动中…</div>
    </div>
  )
}

/** 隐私锁界面：软件上锁后每次打开需输入密码；连续错误 5 次自动退出 */
function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [pwd, setPwd] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const attempts = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async () => {
    if (!pwd || busy) return
    setBusy(true)
    setError('')
    try {
      const ok = await api.lockVerify(pwd)
      if (ok) {
        onUnlock()
        return
      }
      attempts.current += 1
      if (attempts.current >= 5) {
        await api.appQuit()
        return
      }
      setError(`密码错误（已尝试 ${attempts.current}/5 次，错误 5 次将自动退出）`)
      setPwd('')
    } catch {
      setError('校验失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-ink-900 px-4 animate-fadeIn">
      <div className="w-full max-w-sm rounded-2xl bg-ink-800 ring-1 ring-white/10 shadow-2xl p-7">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand to-[#ff9db6] flex items-center justify-center shadow-glow-sm">
            <Icon name="lock" size={20} className="text-white" />
          </div>
          <div>
            <div className="text-white font-semibold text-lg">影匣已上锁</div>
            <div className="text-white/45 text-xs">输入密码后继续使用</div>
          </div>
        </div>
        <input
          ref={inputRef}
          type="password"
          className="w-full bg-ink-900/60 text-white text-sm rounded-lg px-3 py-2.5 outline-none border border-white/10 focus:border-brand/60 focus:ring-1 focus:ring-brand/40 transition-colors"
          placeholder="密码"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
          }}
        />
        {error ? <div className="text-red-400 text-xs mt-2">{error}</div> : null}
        <button
          className="w-full mt-4 px-4 py-2.5 rounded-lg bg-brand hover:bg-brand-hover text-white text-sm font-medium transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
          onClick={() => void submit()}
          disabled={busy}
        >
          <Icon name="unlock" size={15} />
          解锁
        </button>
      </div>
    </div>
  )
}
