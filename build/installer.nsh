!macro customInit
  # v2.5.1：安装第一步弹出语言选择，并将结果写入注册表供应用首次启动时读取。
  # NSIS 语言 ID：2052 = 简体中文，1033 = 英文。卸载器会自动沿用安装时选择的语言。
  !insertmacro MUI_LANGDLL_DISPLAY
  ${If} $LANGUAGE == "2052"
    StrCpy $R0 "zh-CN"
    StrCpy $R1 "检测到 影匣 正在运行。请先彻底关闭应用（包括右下角的托盘图标），然后重新运行安装器。点击确定后安装器将退出。"
  ${Else}
    StrCpy $R0 "en-US"
    StrCpy $R1 "YingXia is currently running. Please close the application completely (including the tray icon), then run the installer again. Click OK to exit."
  ${EndIf}
  WriteRegStr HKCU "Software\YingXia" "InstallerLanguage" $R0

  # 安装前检测是否已有影匣实例在运行。
  # 如果用户没关闭旧版就覆盖安装，旧进程持有的单实例锁会导致新版 exe 启动后直接
  # app.quit()，用户看到的仍是旧版界面。因此这里先友好提示，让用户手动彻底关闭
  # 应用（包括右下角的托盘图标），而不是直接强杀进程，避免意外丢失状态。
  FindWindow $0 "" "影匣"
  IntCmp $0 0 continue
    MessageBox MB_OK|MB_ICONEXCLAMATION $R1
    Abort
  continue:
!macroend

!macro customUnInit
  # 卸载器自动沿用安装时语言（MUI 默认行为），无需额外操作。
!macroend
