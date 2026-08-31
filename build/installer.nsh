!macro customInit
  # 安装前检测是否已有影匣实例在运行。
  # 如果用户没关闭旧版就覆盖安装，旧进程持有的单实例锁会导致新版 exe 启动后直接
  # app.quit()，用户看到的仍是旧版界面。因此这里先友好提示，让用户手动彻底关闭
  # 应用（包括托盘图标），而不是直接强杀进程，避免意外丢失状态。
  FindWindow $0 "" "影匣"
  IntCmp $0 0 continue
    MessageBox MB_OK|MB_ICONEXCLAMATION "检测到 影匣 正在运行。$
$
请先彻底关闭应用（包括右下角的托盘图标），然后重新运行安装器。$
$
点击确定后安装器将退出。"
    Abort
  continue:
!macroend
