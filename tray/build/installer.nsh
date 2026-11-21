; TokenSaver NSIS 自定义(R1 终案):用户级 CODE_INDEX_DATA_DIR 注入 + 卸载清理
; 数据目录=%LOCALAPPDATA%\TokenSaver\data(升级不清);hf-cache 由 packed 布局归 ~/.tokensaver/hf-cache
; 注意:本文件先于 WinMessages.nsh 被 include,故**不得 !define HWND_BROADCAST/WM_SETTINGCHANGE**
; (会与 WinMessages 内置定义冲突致 makensis abort,2026-11-17 首 build 实测)——System::Call 用字面量。

!macro customInit
  ; 覆盖安装/升级:托盘守护常驻(X=最小化不退出)会触发 NSIS「无法关闭」弹窗——
  ; 安装/卸载前静默强杀本应用进程(手工覆盖安装的兜底)。
  ; 禁止 /T：自动更新时 installer 从旧 app 启动，/T 会连同安装器自身一并终止。
  nsExec::Exec 'taskkill /F /IM TokenSaver.exe'
  Sleep 800
!macroend

; 20261121 三层查杀根治「TokenSaver 无法关闭,请手动关闭…重试」弹窗(测试机每次覆盖安装必弹):
; 真因链(20261121 实锤)——退出托盘只死 TokenSaver.exe,detached node 子进程(代理/常驻/钩子
; 拉起)存活,CWD/已映射模块占住安装目录 → 覆盖安装的旧卸载器(/S _?=安装目录)RMDir 失败 →
; installUtil UninstallLoop 5 轮超限 → appCannotBeClosed 重试弹窗。旧版只杀①主程序不够:
; ② 命令行含 $INSTDIR 的 node.exe(PS CIM——wmic 已被新系统移除;精确匹配不误杀用户其他 node)
; ③ hook-relay.exe(专属名)。12 轮上限,全程静默,超限放行交内置流兜底。安装/卸载两态共用本宏。
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
  ; machine 级残留清理(20261120 测试机实证:C:\ProgramData\TokenSaver\data 残留致旧终端/卸后进程落错目录):
  ; 值含 TokenSaver 即判为我方旧安装器/手工 HKLM 残留并删——HKCU 是唯一权威 scope(user 覆盖 machine)。
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
  ; 广播环境变量变更(HWND_BROADCAST=0xFFFF, WM_SETTINGCHANGE=0x1A);新启动进程继承,已开 IDE 需重启
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
  ; 2026-11-17 全在线模式(用户拍板):安装包只含基础依赖,三 CPU 权重装后由向导在线下载
  ; (HF/镜像,weightsOnline.mjs);安装器不再解包权重。
!macroend

!macro customUnInstall
  ; 仅当值仍是我们写的才删(防误删用户自定义)
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
