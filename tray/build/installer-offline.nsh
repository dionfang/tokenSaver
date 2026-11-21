; TokenSaver 离线完整包 NSIS 自定义(2026-11-17 双形态发布:dist:offline 专用)。
; 与 installer.nsh 同口径(env 注入/卸载清理+customInit 强杀进程),额外在 customInstall 直解三 CPU 权重。
; 注意:本文件先于 WinMessages.nsh 被 include,不得 !define HWND_BROADCAST/WM_SETTINGCHANGE。

!macro customInit
  ; 覆盖安装/升级:托盘守护常驻(X=最小化不退出)会触发 NSIS「无法关闭」弹窗——
  ; 自动更新的 installer 可能由旧 app 启动；/T 会误杀安装器自身。
  nsExec::Exec 'taskkill /F /IM TokenSaver.exe'
  Sleep 800
!macroend

; 20261121 三层查杀根治「无法关闭」弹窗(与 installer.nsh 同口径,逐字一致):退出托盘只死
; TokenSaver.exe,detached node 子进程存活占住安装目录 → 旧卸载器 RMDir 失败 → UninstallLoop
; 5 轮超限弹 appCannotBeClosed。①主程序 ②命令行含 $INSTDIR 的 node(PS CIM,wmic 已移除)
; ③hook-relay.exe。12 轮上限静默,超限放行交内置流。
!macro customCheckAppRunning
  File /oname=$PLUGINSDIR\ts-kill-children.ps1 "${PROJECT_DIR}\build\ts-kill-children.ps1"
  StrCpy $R9 0
  ts_chk_loop:
    IntOp $R9 $R9 + 1
    IntCmp $R9 12 ts_chk_done 0 0
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" "${APP_EXECUTABLE_FILENAME}"`
    Pop $R0
    StrCmp $R0 0 0 ts_chk_node
    nsExec::Exec `taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Sleep 800
    Goto ts_chk_loop
  ts_chk_node:
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ts-kill-children.ps1" -Dir "$INSTDIR"`
    Pop $R1
    StrCmp $R1 "0" ts_chk_relay ts_chk_nodekill
  ts_chk_nodekill:
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\ts-kill-children.ps1" -Dir "$INSTDIR" -Kill`
    Sleep 800
    Goto ts_chk_loop
  ts_chk_relay:
    nsExec::Exec `"$SYSDIR\cmd.exe" /c tasklist /FI "IMAGENAME eq hook-relay.exe" /FO csv | "$SYSDIR\find.exe" "hook-relay.exe"`
    Pop $R2
    StrCmp $R2 "0" ts_chk_relaykill ts_chk_done
  ts_chk_relaykill:
    nsExec::Exec `taskkill /F /IM "hook-relay.exe"`
    Sleep 500
    Goto ts_chk_loop
  ts_chk_done:
!macroend

!macro customInstall
  ; machine 级残留清理(与 installer.nsh 同口径,20261120):值含 TokenSaver 即我方旧残留,删;HKCU 唯一权威
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "CODE_INDEX_DATA_DIR"
  StrCmp $0 "" ts_i_mdone
  StrLen $2 $0
  StrCpy $3 0
ts_i_mloop:
  StrCpy $1 $0 10 $3
  StrCmp $1 "TokenSaver" 0 ts_i_mnext
    DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "CODE_INDEX_DATA_DIR"
    Goto ts_i_mdone
ts_i_mnext:
  IntOp $3 $3 + 1
  IntOp $4 $2 - 10
  IntCmp $3 $4 ts_i_mloop ts_i_mloop ts_i_mdone
ts_i_mdone:
  WriteRegStr HKCU "Environment" "CODE_INDEX_DATA_DIR" "$LOCALAPPDATA\TokenSaver\data"
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
  ; 完整包:三权重直解到 packed hfCacheDir 单源落点;升级已存在则跳过(保用户权重/省解压)
  IfFileExists "$PROFILE\.tokensaver\hf-cache\strands-decider-2B-hobson-v19\model_q4f16.onnx" weights_done 0
    SetOutPath "$PROFILE\.tokensaver\hf-cache"
    File /r "${PROJECT_DIR}\build\weights\Xenova"
    File /r "${PROJECT_DIR}\build\weights\strands-decider-2B-hobson-v19"
  weights_done:
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "CODE_INDEX_DATA_DIR"
  StrCmp $0 "$LOCALAPPDATA\TokenSaver\data" 0 +2
    DeleteRegValue HKCU "Environment" "CODE_INDEX_DATA_DIR"
  ; machine 级同口径清理(值含 TokenSaver 才删)
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "CODE_INDEX_DATA_DIR"
  StrCmp $0 "" ts_u_mdone
  StrLen $2 $0
  StrCpy $3 0
ts_u_mloop:
  StrCpy $1 $0 10 $3
  StrCmp $1 "TokenSaver" 0 ts_u_mnext
    DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "CODE_INDEX_DATA_DIR"
    Goto ts_u_mdone
ts_u_mnext:
  IntOp $3 $3 + 1
  IntOp $4 $2 - 10
  IntCmp $3 $4 ts_u_mloop ts_u_mloop ts_u_mdone
ts_u_mdone:
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
!macroend
