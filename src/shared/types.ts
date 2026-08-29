// 跨主进程/渲染进程的共享类型定义（纯接口，无 Node/DOM 依赖）

export type ImageSource = 'manual' | 'sidecar' | 'javapi' | 'javinfo' | 'javdb' | 'javbus' | 'ffmpeg' | 'placeholder'
export type SortKey = 'title' | 'year' | 'added' | 'lastPlayed' | 'random' | 'score'
/** 浏览页视图模式：竖屏预览墙 / 横屏预览墙 / 纯文件名列表 */
export type ViewMode = 'grid-portrait' | 'grid-landscape' | 'list-filename'
/** 更新检查源 */
export type UpdateSource = 'github' | 'gitee'

/** 媒体库：对应一个被扫描的本地文件夹 + 一个简介 md 文件 */
export interface Library {
  id: string
  name: string
  folderPath: string
  /** 简介 md 文件路径（分类/简介/标签的权威来源）；为空则仅按文件夹展示 */
  introMdPath?: string
  /** 海报图片来源优先级链，越靠前优先级越高 */
  imagePriority: ImageSource[]
  createdAt: number
}

/** 单个视频条目 */
export interface Video {
  id: string
  libraryId: string
  path: string
  fileName: string
  /** 视频所在外文件夹名（用于匹配/封面查找/javdb 搜索的更干净来源） */
  folderName?: string
  title: string
  year?: number
  description?: string
  descriptionSource?: 'manual' | null
  rating?: number
  tags: string[]
  /** 解析后的海报本地路径（缓存文件或手动指定文件） */
  posterPath?: string
  posterSource?: ImageSource
  durationSec?: number
  fileSize?: number
  /** ffprobe 读取的视频技术参数（编码/分辨率/码率等） */
  techInfo?: TechInfo
  addedAt: number
  lastPlayedAt?: number
  /** 用户收藏（♥），持久化到视频记录 */
  favorite?: boolean
  /** javdb 详情页抓取的元数据（缓存；缺失时点击卡片时再抓） */
  javdbDetail?: JavdbDetail
  /** 演员名单（从数据源抓取回填，用于检索/展示；演员维度筛选仍优先用 javdbDetail.actresses） */
  actors?: string[]
  /** ffmpeg 批量截帧生成的预览图本地路径（横屏预览墙使用），最多 PREVIEW_COUNT 张 */
  previewPaths?: string[]
  /** 国产片：纯中文文件夹且无番号，不自动抓取元数据，仅用 ffmpeg 截帧 */
  domestic?: boolean
}

/** javdb 视频详情页抓取的元数据 */
export interface JavdbDetail {
  uid: string
  code: string
  /** 完整标题（含系列等） */
  title: string
  /** 封面原图 URL（javdb） */
  cover?: string
  date?: string
  duration?: string
  director?: string
  studio?: string
  series?: string
  rating?: string
  /** 类别（通常是有碼/無碼/歐美/動漫等） */
  genres: string[]
  /** 演员名（全部演员，男女混合） */
  actors: string[]
  /** 女演员名单（JavDB 页面中演员链接后的 ♀ 标识）；旧数据可能缺失，facet 会回退到 actors */
  actresses?: string[]
  /** 关键截图（原图 URL 列表） */
  samples: string[]
  /** 解析器版本标记：v2 = zip 配对解析器（2026-08-26 修复男演员混入）。旧数据无此字段。 */
  parseVer?: number
  /** 数据来源：javapi / javinfo / javdb / javbus（旧数据无此字段，默认视为 javdb） */
  source?: 'javapi' | 'javinfo' | 'javdb' | 'javbus'
  fetchedAt: number
}

/** ffprobe 读取的视频技术参数 */
export interface TechInfo {
  /** 视频流宽度（像素） */
  width?: number
  /** 视频流高度（像素） */
  height?: number
  /** 时长（秒） */
  durationSec?: number
  /** 视频码率（kbps） */
  bitrateKbps?: number
  /** 视频编码，如 H.264 / HEVC */
  videoCodec?: string
  /** 音频编码，如 AAC */
  audioCodec?: string
  /** 平均帧率（fps） */
  fps?: number
}

/** 代理模式：none 关闭 / http / https / socks4 / socks5 / system 自动读取系统代理 */
export type ProxyMode = 'none' | 'http' | 'https' | 'socks4' | 'socks5' | 'system'

export interface Settings {
  /** 外部播放器路径，为空则用系统默认程序打开 */
  playerPath: string
  /** ffmpeg 可执行文件路径，为空则在 PATH 中查找 */
  ffmpegPath: string
  /** 皮肤：cinema 影院沉浸 / light 现代明亮 / magazine 杂志艺术 / glass 玻璃拟态 / system 跟随系统 */
  theme: 'cinema' | 'light' | 'magazine' | 'glass' | 'system'
  /** 海报墙密度：large 大图沉浸 / standard 标准 / compact 高密度 */
  posterDensity: 'large' | 'standard' | 'compact'
  /** 可选：javdb.com 登录 Cookie（某些网络/登录态下搜索需带 Cookie） */
  javdbCookie: string
  /** 数据源：auto 自动降级（Javapi→Javinfo→JavDB→JavBus）/ javapi 只用本地 Javapi / javinfo 只用 Javinfo / javdb 只用 JavDB / javbus 只用 JavBus（调试用） */
  dataSource: 'auto' | 'javapi' | 'javinfo' | 'javdb' | 'javbus'
  /** 本地自托管 javapi 服务地址（如 http://127.0.0.1:8080），留空则跳过该源 */
  javapiUrl: string
  /** 本地自托管 javapi 的 API key（启动时 AUTH_API_KEYS 指定的值） */
  javapiKey: string
  /** javinfo.dev 聚合 API key（app.javinfo.dev 注册领取免费额度，按量计费） */
  javinfoKey: string
  /** 代理模式（取代旧版单一 javdbProxy 字符串） */
  proxyMode: ProxyMode
  /** 代理主机（IP 或域名），system 模式可留空 */
  proxyHost: string
  /** 代理端口 */
  proxyPort: string
  /** 代理认证用户名（可选） */
  proxyUser: string
  /** 代理认证密码（可选） */
  proxyPass: string
  /** 启动时/库变化时自动重扫本库（MD 驱动对账） */
  autoRescan: boolean
  /** JavDB 批量抓取并发数（1-8，越大越快但风控风险高） */
  fetchConcurrency: number
  /** JavDB 批量抓取每条之间的间隔毫秒（限速，降低封禁风险，默认 600） */
  fetchIntervalMs: number
  /** 开机自启 */
  launchAtLogin: boolean
  /** 启动时自动对账当前库 */
  scanOnStartup: boolean
  /** 最小化到系统托盘（关窗不退出） */
  minimizeToTray: boolean
  /** 默认排序方式（浏览页初始排序） */
  defaultSort: SortKey
  /** 隐私护盾默认开启（启动时自动进入隐私模式） */
  privacyDefaultOn: boolean
  /** 扫描富集并发数（1-8：ffprobe 探测 / 截帧等） */
  scanConcurrency: number
  /** 扫描最小文件大小（MB）；0 = 不限。小于该值的视频不进入媒体库（过滤短视频/广告） */
  scanMinSizeMb: number
  /** 隐私锁密码哈希（SHA-256 salt+password）；为空表示未上锁 */
  lockHash?: string
  /** 隐私锁随机盐（十六进制），与 lockHash 配套 */
  lockSalt?: string
  /** 检查更新时使用的源（GitHub / Gitee） */
  updateSource?: UpdateSource
  /** 自动检查更新频率：关闭 / 每天 / 每周 / 每月。按此频率在启动时自动检测更新 */
  autoUpdateFrequency?: 'off' | 'daily' | 'weekly' | 'monthly'
  /** 上次自动检查更新的时间戳（ms），用于频率判定 */
  lastUpdateCheck?: number
  /** 待处理（可用）更新；为空表示无可用更新或已是最新 */
  pendingUpdate?: {
    version: string
    url: string
    /** 更新紧急程度 */
    urgency?: 'normal' | 'recommended' | 'critical' | 'mandatory'
    /** 发布时间 ISO 字符串 */
    publishedAt?: string
    /** 匹配到的安装包文件名 */
    assetName?: string
    /** 安装包大小（字节） */
    assetSize?: number
  } | null
  /** 用户已选择忽略的对账未收录文件路径列表（不再弹窗/不再进入「未收录」分类） */
  ignoredUnlistedPaths: string[]
}

export interface VideoFilter {
  libraryId?: string
  search?: string
  tag?: string
  sort?: SortKey
  desc?: boolean
}

export interface ScanProgress {
  libraryId: string
  total: number
  done: number
  current?: string
}

export interface OpenResult {
  ok: boolean
  method: 'custom' | 'system'
}

export const DEFAULT_SETTINGS: Settings = {
  playerPath: '',
  ffmpegPath: '',
  theme: 'cinema',
  posterDensity: 'standard',
  javdbCookie: '',
  javinfoKey: '',
  javapiUrl: 'http://127.0.0.1:8080',
  javapiKey: '',
  proxyMode: 'none',
  proxyHost: '',
  proxyPort: '',
  dataSource: 'auto',
  proxyUser: '',
  proxyPass: '',
  autoRescan: false,
  fetchConcurrency: 2,
  fetchIntervalMs: 600,
  launchAtLogin: false,
  scanOnStartup: true,
  minimizeToTray: false,
  defaultSort: 'title',
  privacyDefaultOn: false,
  scanConcurrency: 4,
  scanMinSizeMb: 0,
  updateSource: 'gitee',
  autoUpdateFrequency: 'off',
  pendingUpdate: null,
  ignoredUnlistedPaths: []
}

/** 默认海报来源优先级：手动 > 同名图 > javapi（本地免费）> javinfo > javdb > javbus > 截帧 > 占位 */
export const DEFAULT_IMAGE_PRIORITY: ImageSource[] = [
  'manual',
  'sidecar',
  'javapi',
  'javinfo',
  'javdb',
  'javbus',
  'ffmpeg',
  'placeholder'
]

// ---------- 简介 md 解析结果 ----------

/** md 文件中的单条影片信息（名字=番号，简介，标签） */
export interface IntroItem {
  /** 番号 / 文件名匹配键，如 SONE-560 */
  code: string
  /** 简介正文 */
  description: string
  /** 标签（平铺去重，兼容旧格式；新格式为各分类标签合并） */
  tags: string[]
  /** 结构化标签：分类 → 标签列表（新格式 `**标签**：` 块解析；旧格式无此块为空） */
  tagCategories?: Record<string, string[]>
  /** 推荐评分（md `- **推荐评分**：9.60 / 10`，0-10 分；权威，覆盖 javdb） */
  score?: number
  /** 原始行文本 */
  raw: string
}

/** md 中的一个分类分组 */
export interface IntroCategory {
  name: string
  /** 分类出现顺序，用于稳定排序 */
  order: number
  items: IntroItem[]
}

/** 整篇简介 md 的解析结果 */
export interface IntroDoc {
  categories: IntroCategory[]
  totalCount: number
}

// ---------- 对账展示（MD 驱动 + 文件夹对账） ----------

/** 海报墙展示条目 */
export interface DisplayEntry {
  kind: 'matched' | 'missing'
  /** 所属分类名（来自 md） */
  category: string
  /** 分类顺序，用于排序 */
  order: number
  /** 番号 / 文件名匹配键 */
  code: string
  /** 展示标题（默认等于 code） */
  title: string
  description: string
  tags: string[]
  /** 结构化标签（文档分类），供侧栏按文档类别分组展示 */
  tagCategories?: Record<string, string[]>
  /** 推荐评分（md 权威，覆盖 javdb） */
  score?: number
  /** 匹配到磁盘文件时的视频记录（用于海报与播放）；缺失时为 undefined */
  video?: Video
}

/** 文件夹存在但未收录进 md 的文件 */
export interface UnlistedFile {
  fileName: string
  path: string
}

/** 文件名广告清理的预览项 */
export interface RenamePreviewItem {
  path: string
  oldName: string
  newName: string
}

/** 一次对账的结果 */
export interface ReconcileResult {
  libraryId: string
  /** 已分类的展示条目（含匹配到文件的与 md 有但文件缺失的） */
  entries: DisplayEntry[]
  /** 文件夹存在但 md 未收录的文件 */
  unlisted: UnlistedFile[]
  stats: {
    /** md 中条目总数 */
    mdCount: number
    /** md 条目前在文件夹中找到文件的 */
    matched: number
    /** md 有但文件夹缺失文件的 */
    missing: number
    /** 文件夹有但 md 未收录的 */
    unlisted: number
  }
  generatedAt: number
}
