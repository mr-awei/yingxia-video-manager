!macro customInit
  # 安装器初始化。
  # 此宏在「安装」和「卸载」时都会被 electron-builder 调用。
  # 用 IsUninst 区分场景 —— 卸载流程跳过语言选择和运行检测。
  !ifdef IsUninst
    Goto InitEnd
  !endif

  # ====================
  # 第一步：nsDialogs 语言选择（仅简体中文 / English）
  # ====================
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 10 12 100% 14u "Select installation language"
  Pop $0
  ${NSD_CreateRadioButton} 18 36 100% 12u "简体中文"
  Pop $1
  ${NSD_CreateRadioButton} 18 54 100% 12u "English"
  Pop $2
  ${NSD_SetState} $1 1   # 默认选中简体中文
  nsDialogs::Show
  Pop $5
  ${NSD_GetState} $1 $6
  ${If} $6 == 1
    StrCpy $LANGUAGE "2052"       # NSIS 简体中文
    StrCpy $R0 "zh-CN"            # 应用内部 locale
  ${Else}
    StrCpy $LANGUAGE "1033"       # NSIS 英文
    StrCpy $R0 "en-US"            # 应用内部 locale
  ${EndIf}

  # 写入注册表，供应用首次启动读取（主进程 readInstallerLanguage）
  WriteRegStr HKCU "Software\YingXia" "InstallerLanguage" $R0

  # ====================
  # 第二步：检测旧版本是否仍在运行
  # ====================
  FindWindow $0 "" "影匣"
  IntCmp $0 0 InitEnd
  ${If} $LANGUAGE == "2052"
    MessageBox MB_OK|MB_ICONEXCLAMATION "检测到 影匣 正在运行。请先彻底关闭应用（包括右下角的托盘图标），然后重新运行安装器。"
  ${Else}
    MessageBox MB_OK|MB_ICONEXCLAMATION "YingXia is currently running. Please close the application completely (including the tray icon), then run the installer again."
  ${EndIf}
  Abort
InitEnd:
!macroend

!macro customUnInstall
  # 卸载阶段：用 nsDialogs 复选框询问是否删除用户数据，文案跟随安装时选定的 $LANGUAGE。
  # 默认不勾选 = 保留数据。
  !ifdef IsUninst
    ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" "AppData"
    StrCpy $R1 "$R0\local-video-manager"
    IfFileExists "$R1\data.json" AskRemoveData SkipAskData
    AskRemoveData:
      nsDialogs::Create 1018
      Pop $0
      ${If} $LANGUAGE == "2052"
        ${NSD_CreateLabel} 10 12 100% 14u "卸载影匣 — 是否删除用户数据？"
        Pop $0
        ${NSD_CreateCheckbox} 18 40 100% 12u "删除所有本地数据（%APPDATA%\local-video-manager）—— 包含库配置、Excel 片单、元数据、封面缓存"
        Pop $2
      ${Else}
        ${NSD_CreateLabel} 10 12 100% 14u "Uninstall YingXia — Remove user data?"
        Pop $0
        ${NSD_CreateCheckbox} 18 40 100% 12u "Delete all local data (%APPDATA%\local-video-manager) — library configs, Excel sheets, metadata, cover cache"
        Pop $2
      ${EndIf}
      ${NSD_SetState} $2 0   # 默认不勾选
      nsDialogs::Show
      Pop $5
      ${NSD_GetState} $2 $6
      ${If} $6 == 1
        RMDir /r "$R1"
      ${EndIf}
    SkipAskData:
  !endif
!macroend
