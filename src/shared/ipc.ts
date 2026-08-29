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
  // ffmpeg 兜底截帧：随机截 1 张封面 + 15 张预览图
  videoGeneratePreviews: 'video:generatePreviews',
  // ffmpeg 单帧兜底：无封面时截 1 帧视频画面作为封面（列表懒加载用，返回本地路径或 null）
  videoFrameFallback: 'video:frameFallback',
  // 截帧预览帧 → 设为封面：把某张预览帧复制为封面文件 <id>.jpg 并更新记录
  videoSetPreviewAsCover: 'video:setPreviewAsCover',
  // ffprobe 读取视频技术参数
  videoProbe: 'video:probe',
  // 分享：扫描视频文件夹的 .torrent 并转磁链
  videoShareTorrents: 'video:shareTorrents',
  // 从磁盘删除视频文件（按需连带删除同目录种子文件夹）
  videoDeleteFile: 'video:deleteFile',
  // 预检：列出 video 所在目录的"其他视频数"和"是否含 .torrent"，供删除前确认
  videoInspectForDelete: 'video:inspectForDelete',
  // 封面来源切换：数据源图（javdb/javbus/javlibrary）↔ FFmpeg 截帧图
  videoSwitchPoster: 'video:switchPoster',
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
  // 复制文本到剪贴板（主进程执行，sandbox preload 无法直接访问 clipboard 模块）
  copyText: 'system:copyText',
  // 用默认浏览器打开外部链接（官网 / 仓库 / issue）
  openExternal: 'system:openExternal',
  // 应用信息（版本号等）
  appInfo: 'app:info',
  // 隐私锁：设置/清除密码、校验密码、退出应用
  lockSet: 'lock:set',
  lockVerify: 'lock:verify',
  appQuit: 'app:quit',
  // 检查更新：按所选源（GitHub / Gitee）查询最新版本
  updateCheck: 'update:check',
  // 在文件管理器中显示并选中文件
  shellRevealInFolder: 'system:revealInFolder',
  // 事件（主进程 -> 渲染进程）
  scanProgress: 'scan:progress',
  // 简介 md 文件变化（自动重新对账）
  mdChanged: 'md:changed',
  // 内置规范文档（新建 md 文件向导）：读取打包资源中的规范全文
  specGet: 'spec:get',
  // 批量导出媒体库番号清单（新建 md 文件向导第一步，写入 txt 文件）
  libraryExportCodes: 'library:exportCodes',
  // 仅扫描媒体库番号清单（不弹保存对话框、不写文件，供向导打开时自动加载）
  libraryGetCodes: 'library:getCodes'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
