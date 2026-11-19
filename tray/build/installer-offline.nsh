; TokenSaver 离线完整包 NSIS 自定义(2026-11-17 双形态发布:dist:offline 专用)。
; 与 installer.nsh 同口径(env 注入/卸载清理+customInit 强杀进程),额外在 customInstall 直解三 CPU 权重。
; 注意:本文件先于 WinMessages.nsh 被 include,不得 !define HWND_BROADCAST/WM_SETTINGCHANGE。

!macro customInit
  ; 覆盖安装/升级:托盘守护常驻(X=最小化不退出)会触发 NSIS「无法关闭」弹窗——
  ; 自动更新的 installer 可能由旧 app 启动；/T 会误杀安装器自身。
  nsExec::Exec 'taskkill /F /IM TokenSaver.exe'
  Sleep 800
!macroend

!macro customInstall
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
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
!macroend
