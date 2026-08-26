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
  | { ok: true; detail: JavdbDetail; source: 'javdb' | 'javbus' }
  | { ok: false; error: string }

/** 批量补齐（libraryFetchJavdbAll）结果统计 */
export interface BatchFetchResult {
  /** 成功部数 */
  ok: number
  /** 失败部数 */
  failed: number
  /** 成功来源分布 */
  bySource: { javdb: number; javbus: number }
  /** 失败明细（标题 + 原因） */
  failures: Array<{ title: string; reason: string }>
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

/** 渲染进程通过 window.api 调用的类型化接口（主进程实现） */
export interface AppApi {
  /** 复制文本到剪贴板 */
  copyText(text: string): void
  libraryList(): Promise<Library[]>
  libraryAdd(input: Omit<Library, 'id' | 'createdAt'>): Promise<Library>
  libraryRemove(id: string): Promise<void>
  libraryUpdate(id: string, patch: Partial<Library>): Promise<Library | null>
  /** 按简介 md 对账文件夹，返回分类展示数据 */
  libraryReconcile(libraryId: string): Promise<ReconcileResult>
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
  /** 选择单个文件（用于选择简介 md） */
  dialogSelectFile(): Promise<string | null>
  /** 用系统默认程序打开文件 / 文件夹（如打开简介 md 供编辑） */
  openPath(path: string): Promise<void>
  /** 应用信息（版本 / 运行环境 / 数据目录 / 更新日志） */
  appInfo(): Promise<AppInfo>
  /** 用默认浏览器打开外部链接（官网 / 仓库 / issue） */
  openExternal(url: string): Promise<void>
  /**
   * 分享：扫描视频所在文件夹的 .torrent 文件，转换为磁链，并把第一个磁链复制到剪贴板
   */
  videoShareTorrents(id: string): Promise<{
    dir: string
    copied: boolean
    items: { name: string; size: number; infoHash: string; magnet: string }[]
  }>
  onScanProgress(cb: (p: ScanProgress) => void): void
  /** 监听：简介 md 文件变化（需自动重新对账） */
  onMdChanged(cb: (libraryId: string) => void): void
}
