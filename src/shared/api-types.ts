import type {
  JavdbDetail,
  Library,
  Settings,
  Video,
  VideoFilter,
  ScanProgress,
  OpenResult,
  ReconcileResult,
  RenamePreviewItem
} from './types'

/** videoFetchJavdbDetail 返回：成功（含详情 + 来源）或失败（含原因） */
export type FetchDetailResult =
  | { ok: true; detail: JavdbDetail; source: 'javapi' | 'javinfo' | 'javdb' | 'javbus' }
  | { ok: false; error: string }

/** 批量补齐（libraryFetchJavdbAll）结果统计 */
export interface BatchFetchResult {
  /** 成功部数 */
  ok: number
  /** 失败部数 */
  failed: number
  /** 成功来源分布（v2.2.7 加 javlibrary —— 自定义顺序里也可能命中） */
  bySource: { javapi: number; javinfo: number; javdb: number; javbus: number; javlibrary: number }
  /** 失败明细（id + 标题 + 原因） */
  failures: Array<{ id: string; title: string; reason: string }>
  /** 是否因连续失败自动停止 */
  stopped?: boolean
  /** 停止时剩余未处理部数 */
  remaining?: number
}

/** 应用信息（关于模块展示） */
export interface AppInfo {
  /** 应用版本号（package.json version） */
  version: string
  /** Electron 版本 */
  electron: string
  /** Node.js 版本 */
  node: string
  /** Chromium 版本 */
  chrome: string
  /** 用户数据目录（data.json / posters 所在） */
  dataDir: string
  /** 最近一版更新日志正文（CHANGELOG.md 顶部） */
  changelog: string
}

/** 匹配到的发布资源信息 */
export interface UpdateAssetInfo {
  /** 资源文件名 */
  name: string
  /** 文件大小（字节） */
  size: number
  /** 直接下载链接 */
  downloadUrl: string
  /** 资源 Content-Type */
  contentType?: string
}

/** 检查更新结果：基于版本号 + 资源 + 元数据的多维特征判定 */
export interface UpdateCheckResult {
  /** 实际查询的源 */
  source: 'github' | 'gitee'
  /** 当前安装版本 */
  currentVersion: string
  /** 远端最新版本号 */
  latestVersion: string
  /** 远端版本是否比当前新 */
  hasUpdate: boolean
  /** 最新版本发布页 / 下载页链接 */
  releaseUrl: string
  /** 更新说明（release notes，截断） */
  notes?: string
  /** 发布时间 ISO 字符串 */
  publishedAt?: string
  /** 是否为预发布版本 */
  isPrerelease?: boolean
  /** 是否为草稿（通常不应向用户推送） */
  isDraft?: boolean
  /** 是否找到了匹配当前平台（Windows x64 Setup）的安装包资源 */
  assetMatched?: boolean
  /** 匹配到的安装包信息 */
  asset?: UpdateAssetInfo
  /** 校验文件信息（如 .sha256 / .blockmap） */
  checksumAsset?: UpdateAssetInfo
  /** 更新紧急程度：normal=普通 recommended=推荐 critical=重要 mandatory=强制（低于 minimumVersion） */
  urgency?: 'normal' | 'recommended' | 'critical' | 'mandatory'
  /** 发布页声明的最低要求版本；当前版本低于此值时 urgency 自动升级为 mandatory */
  minimumVersion?: string
  /** 判定置信度：full=完整（版本+资源均匹配） partial=仅版本（无对应资源） none=无法判定 */
  confidence?: 'full' | 'partial' | 'none'
  /** 出错信息（网络/解析失败） */
  error?: string
  /** 是否发生了源回退（首选源失败自动切换另一源） */
  fallback?: boolean
}

/** 渲染进程通过 window.api 调用的类型化接口（主进程实现） */
export interface AppApi {
  /** 复制文本到剪贴板（主进程执行） */
  copyText(text: string): Promise<void>
  libraryList(): Promise<Library[]>
  libraryAdd(input: Omit<Library, 'id' | 'createdAt'>): Promise<Library>
  libraryRemove(id: string): Promise<void>
  libraryUpdate(id: string, patch: Partial<Library>): Promise<Library | null>
  /** 按 Excel 片单对账文件夹，返回分类展示数据 */
  libraryReconcile(libraryId: string): Promise<ReconcileResult>
  /** 读上次对账结果的磁盘缓存（秒出，无缓存返回 null） */
  libraryReconcileCache(libraryId: string): Promise<ReconcileResult | null>
  videoList(filter?: VideoFilter): Promise<Video[]>
  videoGet(id: string): Promise<Video | null>
  videoUpdate(id: string, patch: Partial<Video>): Promise<Video | null>
  videoScan(libraryId: string): Promise<Video[]>
  videoOpen(id: string): Promise<OpenResult>
  videoRegeneratePoster(id: string): Promise<Video | null>
  /** 从 javdb.com 按番号抓取封面并缓存到该视频 */
  videoFetchJavdbPoster(id: string): Promise<Video | null>
  /** 批量补齐信息（JavDB → JavBus）；force=true 忽略缓存逐部重抓，返回统计 */
  libraryFetchJavdbAll(libraryId: string, force?: boolean): Promise<BatchFetchResult>
  /** 抓取详情页元数据（JavDB → JavBus 多源），返回是否成功及来源 / 失败原因 */
  videoFetchJavdbDetail(id: string): Promise<FetchDetailResult>
  /** 用 ffprobe 读取视频技术参数（分辨率/编码/码率/帧率/时长），并缓存到视频 */
  videoProbe(id: string): Promise<Video | null>
  /** 预览：库内可安全改名的文件（清理文件名广告） */
  libraryPreviewRenames(libraryId: string): Promise<RenamePreviewItem[]>
  /** 执行改名，返回成功数与失败列表 */
  libraryApplyRenames(
    libraryId: string,
    items: { path: string; newName: string }[]
  ): Promise<{ ok: number; failed: { path: string; reason: string }[] }>
  /** 测试当前代理配置能否连通目标站点（默认 javdb.com），返回连通性结果 */
  proxyTest(settings: Settings): Promise<{ ok: boolean; status?: number; error?: string }>
  /** 清空海报缓存目录（仅删除缓存文件，不动数据） */
  cacheClear(): Promise<{ ok: boolean; removed: number }>
  /** ffmpeg 状态检测：custom（手动指定）/ system（系统 PATH）/ bundled（捆绑版）/ missing。
   *  检测到系统版时主进程自动删除捆绑版 ffmpeg 释放磁盘（62MB）。 */
  ffmpegStatus(): Promise<{
    source: 'custom' | 'system' | 'bundled' | 'missing'
    path?: string
    bundledRemoved?: boolean
    note?: string
  }>
  /** 卸载应用（危险操作）：调用 NSIS 卸载程序，静默卸载 */
  appUninstall(): Promise<{ ok: boolean; error?: string }>
  /** 监听：批量抓取时每抓到一张实时回调 {videoId, posterPath} */
  onJavdbFetched(cb: (p: { videoId: string; posterPath: string }) => void): void
  /** 在系统文件管理器中显示并选中该文件（用于改名） */
  shellRevealInFolder(path: string): Promise<void>
  settingsGet(): Promise<Settings>
  settingsSet(patch: Partial<Settings>): Promise<Settings>
  dialogSelectFolder(): Promise<string | null>
  /** 选择单个文件（Excel 片单 / 其他） */
  dialogSelectFile(): Promise<string | null>
  /** 用系统默认程序打开文件 / 文件夹（如打开 Excel 片单供编辑） */
  openPath(path: string): Promise<void>
  /** 应用信息（版本 / 运行环境 / 数据目录 / 更新日志） */
  appInfo(): Promise<AppInfo>
  /** 用默认浏览器打开外部链接（官网 / 仓库 / issue） */
  openExternal(url: string): Promise<void>
  /** 设置 / 修改 / 清除隐私锁密码（password 为空表示清除锁） */
  lockSet(password: string): Promise<void>
  /** 校验隐私锁密码，返回是否正确 */
  lockVerify(password: string): Promise<boolean>
  /** 退出应用（密码错误超次 / 锁界面退出用） */
  appQuit(): Promise<void>
  /** 按所选源（GitHub / Gitee）检查更新，返回最新版本与发布链接 */
  updateCheck(): Promise<UpdateCheckResult>
  /** 用 ffmpeg 随机截帧生成封面 + 预览图（1 封面 + 15 预览），回填视频记录 */
  videoGeneratePreviews(id: string): Promise<Video | null>
  /** 无封面时截 1 帧视频画面作为封面（懒加载兜底），成功返回本地路径并回填视频记录，失败/无 ffmpeg 返回 null */
  videoFrameFallback(id: string): Promise<string | null>
  /** 把某张截帧预览帧设为封面：复制为 <id>.jpg 并更新记录（posterSource='ffmpeg'），成功返回更新后的视频 */
  videoSetPreviewAsCover(id: string, previewPath: string): Promise<Video | null>
  /**
   * 分享：扫描视频所在文件夹的 .torrent 文件，转换为磁链，并把第一个磁链复制到剪贴板
   */
  videoShareTorrents(id: string): Promise<{
    dir: string
    copied: boolean
    items: { name: string; size: number; infoHash: string; magnet: string }[]
  }>
  /**
   * 把视频文件（可能连带所在目录）**挪到系统回收站**。
   * 智能判定：若视频所在目录除了它本身和 .torrent 文件外**没有其他文件**，
   * 则整个目录一并挪到回收站（避免遗留种子/附属文件）；否则只挪视频文件本身。
   * 用 Electron `shell.trashItem`（Windows 回收站 / macOS Trash / Linux trash），
   * **不彻底删除**——用户可从回收站恢复。
   * 不动 data.json，调用方负责触发扫描以更新库。
   */
  videoDeleteFile(id: string): Promise<{
    ok: boolean
    /** 实际删除的路径（视频文件路径） */
    path?: string
    /** 是否连同所在目录一并删除（"种子文件夹"场景） */
    deletedDir?: boolean
    /** 删除的目录路径（仅 deletedDir=true 时有） */
    dirPath?: string
    /** 一并清理的关联缓存文件数（封面/预览图/ffmpeg 截图/javdb-javbus 信息图） */
    removedCache?: number
    /** 是否已删除 data.json 中的视频记录（含 javdbDetail 全部文本元数据：演员/时长/导演/片商/女演员等） */
    removedRecord?: boolean
    error?: string
  }>
  /** 预检 video 所在目录（不删除任何文件），供删除前确认"会删什么" */
  videoInspectForDelete(id: string): Promise<{
    ok: boolean
    filePath?: string
    dirPath?: string
    /** 同目录其他视频文件数（不含本视频） */
    otherVideoCount?: number
    /** 同目录 .torrent 文件数 */
    torrentCount?: number
    /** 同目录除视频与 .torrent 外的其他文件数 */
    otherFileCount?: number
    error?: string
  }>
  /**
   * 切换封面来源：'data' = 数据源图（javdb/javbus/javlibrary 缓存，没有则抓取）；
   * 'ffmpeg' = FFmpeg 随机截帧图（没有则生成）。两套图片独立保存，可自由来回切换。
   */
  videoSwitchPoster(
    id: string,
    source: 'data' | 'ffmpeg'
  ): Promise<{ ok: boolean; posterPath?: string; posterSource?: string; error?: string }>
  onScanProgress(cb: (p: ScanProgress) => void): () => void
  /** 仅扫描媒体库番号清单（不弹保存对话框、不写文件），供向导打开时自动加载 */
  libraryGetCodes(libraryId: string): Promise<{ count: number; codes: string[] }>
}
