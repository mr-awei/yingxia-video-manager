!macro customInit
  # 升级/覆盖安装前强制结束已运行的影匣进程
  # 避免旧进程持有单实例锁导致新版 exe 启动后 app.quit()，用户始终看到旧 UI
  DetailPrint "正在关闭已运行的影匣..."

  # 方法 1：taskkill 原生命令，最稳
  nsExec::ExecToLog 'taskkill /F /IM "影匣.exe" /T'
  Pop $0

  # 方法 2：FindWindow 兜底（按主窗口类名/标题关闭）
  FindWindow $0 "影匣" ""
  IntCmp $0 0 done
    SendMessage $0 ${WM_CLOSE} 0 0 /TIMEOUT=3000
  done:

  Sleep 800
!macroend
