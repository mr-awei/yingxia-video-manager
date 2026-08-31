!macro customInit
  # 安装器初始化。
  # 注意：此宏在「安装」和「卸载」时都会被 electron-builder 调用。
  # 用 IsUninst 区分场景 —— 卸载流程跳过语言选择和运行检测。
  !ifdef IsUninst
    Goto InitEnd
  !endif

  # ---- 检测旧版本是否仍在运行 ----
  FindWindow $0 "" "影匣"
  IntCmp $0 0 InitEnd
  MessageBox MB_OK|MB_ICONEXCLAMATION "检测到 影匣 正在运行。请先彻底关闭应用（包括右下角的托盘图标），然后重新运行安装器。"
  Abort
InitEnd:
!macroend

!macro customUnInstall
  # 卸载阶段询问是否删除用户数据。
  # 默认不删（MB_YESNO 默认选中"是"，用 /SD NO 切换默认）。
  !ifdef IsUninst
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" "AppData"
    StrCpy $R1 "$R0\local-video-manager"
    IfFileExists "$R1\data.json" AskRemoveData SkipAskData
    AskRemoveData:
      MessageBox MB_YESNO|MB_ICONQUESTION "是否删除所有用户数据？（库配置、Excel 片单、元数据、封面缓存）" /SD NO IDYES DoRemove IDNO SkipAskData
    DoRemove:
      RMDir /r "$R1"
    SkipAskData:
  !endif
!macroend
