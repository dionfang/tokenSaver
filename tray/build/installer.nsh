; TokenSaver NSIS 自定义(R1 终案):用户级 CODE_INDEX_DATA_DIR 注入 + 卸载清理
; 数据目录=%LOCALAPPDATA%\TokenSaver\data(升级不清);hf-cache 由 packed 布局归 ~/.tokensaver/hf-cache
; 注意:本文件先于 WinMessages.nsh 被 include,故**不得 !define HWND_BROADCAST/WM_SETTINGCHANGE**
; (会与 WinMessages 内置定义冲突致 makensis abort,2026-11-17 首 build 实测)——System::Call 用字面量。

!macro customInit
  ; 覆盖安装/升级:托盘守护常驻(X=最小化不退出)会触发 NSIS「无法关闭」弹窗——
  ; 安装/卸载前静默强杀本应用进程树(2026-11-18 用户实测覆盖安装弹窗;数据均原子写,强杀安全)。
  nsExec::Exec 'taskkill /F /T /IM TokenSaver.exe'
  Sleep 800
!macroend

!macro customInstall
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
  System::Call 'user32::SendMessageTimeout(i 0xFFFF, i 0x1A, i 0, t "Environment", i 0, i 1000, *i .r0)'
!macroend
