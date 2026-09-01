!include MUI2.nsh
!include nsDialogs.nsh
!define BUILD_UNINSTALLER
Function foo
  StrCmp $R9 "zh-CN" 0 +3
  MessageBox MB_OK|MB_ICONWARNING "无法完成用户数据清理，用户数据已保留。"
  Goto done2
  MessageBox MB_OK|MB_ICONWARNING "Unable to clean up user data. Your user data has been kept."
done2:
FunctionEnd
Section
SectionEnd
Section un.test
SectionEnd