// 类型化 IPC 通道名集合（主进程 handle / 渲染进程 invoke 共用）

export const IPC = {
  // 媒体库
  libraryList: 'library:list',
  libraryAdd: 'library:add',
  libraryRemove: 'library:remove',
  libraryUpdate: 'library:update',
  // 对账（MD 驱动 + 文件夹对账）
  libraryReconcile: 'library:reconcile',
  // 视频
  videoList: 'video:list',
  videoGet: 'video:get',
  videoUpdate: 'video:update',
  videoScan: 'video:scan',
  videoOpen: 'video:open',
  videoRegeneratePoster: 'video:regeneratePoster',
  // javdb 封面抓取
  videoFetchJavdbPoster: 'video:fetchJavdbPoster',
  // javdb 补齐所有信息：批量抓封面 + 详情（演员/时长/关键截图等），标签来自 MD
  libraryFetchJavdbAll: 'library:fetchJavdbAll',
  // javdb 详情抓取
  videoFetchJavdbDetail: 'video:fetchJavdbDetail',
  // ffprobe 读取视频技术参数
  videoProbe: 'video:probe',
  // 分享：扫描视频文件夹的 .torrent 并转磁链
  videoShareTorrents: 'video:shareTorrents',
  // 文件批量改名（清理文件名广告）
  libraryPreviewRenames: 'library:previewRenames',
  libraryApplyRenames: 'library:applyRenames',
  // 代理测试连接
  proxyTest: 'proxy:test',
  // 清理海报缓存目录
  cacheClear: 'cache:clear',
  // ffmpeg 状态检测（系统 / 捆绑 / 缺失）；检测到系统版时删除捆绑版释放磁盘
  ffmpegStatus: 'ffmpeg:status',
  // 卸载应用（危险操作）
  appUninstall: 'app:uninstall',
  // 事件：批量抓取时，每抓到一张实时推送（main -> renderer）
  javdbFetched: 'javdb:fetched',
  // 设置
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // 系统对话框
  dialogSelectFolder: 'dialog:selectFolder',
  dialogSelectFile: 'dialog:selectFile',
  // 用系统默认程序打开路径（文件或文件夹）
  openPath: 'system:openPath',
  // 用默认浏览器打开外部链接（官网 / 仓库 / issue）
  openExternal: 'system:openExternal',
  // 应用信息（版本号等）
  appInfo: 'app:info',
  // 在文件管理器中显示并选中文件
  shellRevealInFolder: 'system:revealInFolder',
  // 事件（主进程 -> 渲染进程）
  scanProgress: 'scan:progress',
  // 简介 md 文件变化（自动重新对账）
  mdChanged: 'md:changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
