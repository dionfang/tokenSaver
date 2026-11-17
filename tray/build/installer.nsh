; TokenSaver NSIS 自定义(R1 终案):用户级 CODE_INDEX_DATA_DIR 注入 + 卸载清理
; 数据目录=%LOCALAPPDATA%\TokenSaver\data(升级不清);hf-cache 由 packed 布局归 ~/.tokensaver/hf-cache
; 注意:本文件先于 WinMessages.nsh 被 include,故**不得 !define HWND_BROADCAST/WM_SETTINGCHANGE**
; (会与 WinMessages 内置定义冲突致 makensis abort,2026-11-17 首 build 实测)——System::Call 用字面量。

!macro customInstall
  WriteRegStr HKCU "Environment" "CODE_INDEX_DATA_DIR" "$LOCALAPPDATA\TokenSaver\data"
  ; 广播环境变量变更(HWND_BROADCAST=0xFFFF, WM_SETTINGCHANGE=0x1A);新启动进程继承,已开 IDE 需重启
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
  ; 2026-11-17 全离线包:三模型权重直解到 packed hfCacheDir 单源落点($PROFILE\.tokensaver\hf-cache)。
  ; 升级时已存在则跳过(保用户已有权重/省解压时间);staging 由 predist stage-weights.mjs 产出。
  IfFileExists "$PROFILE\.tokensaver\hf-cache\strands-decider-2B-hobson-v19\model_q4f16.onnx" weights_done 0
    SetOutPath "$PROFILE\.tokensaver\hf-cache"
    File /r "${PROJECT_DIR}\build\weights\Xenova"
    File /r "${PROJECT_DIR}\build\weights\strands-decider-2B-hobson-v19"
  weights_done:
!macroend

!macro customUnInstall
  ; 仅当值仍是我们写的才删(防误删用户自定义)
  ReadRegStr $0 HKCU "Environment" "CODE_INDEX_DATA_DIR"
  StrCmp $0 "$LOCALAPPDATA\TokenSaver\data" 0 +2
    DeleteRegValue HKCU "Environment" "CODE_INDEX_DATA_DIR"
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
!macroend
