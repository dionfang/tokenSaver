# ts-kill-children.ps1 - kill TokenSaver's node children holding the install dir (20261121).
# Root cause chain: tray quit only kills TokenSaver.exe; detached node children (proxy/resident/
# hook-spawned) survive with CWD/mapped modules inside the install dir -> upgrade-flow old
# uninstaller RMDir fails -> installUtil UninstallLoop exhausts 5 rounds -> appCannotBeClosed
# retry dialog on every overwrite install.
# Match node.exe whose CommandLine contains $Dir (case-insensitive) - never touches user's other
# node processes. Usage: powershell -File ts-kill-children.ps1 -Dir "<INSTDIR>" [-Kill]
# Exit code = remaining matched process count (0 = clean); -Kill kills first then re-counts.
# ASCII-only on purpose: PS 5.1 reads BOM-less ps1 as ANSI and CJK comments corrupt parsing.
# wmic is removed on newer Windows builds; CIM via PowerShell is the portable path.
param([string]$Dir, [switch]$Kill)
$ErrorActionPreference = 'SilentlyContinue'
$p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf($Dir, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($Kill) {
  $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Milliseconds 500
  $p = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($Dir, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
}
exit @($p).Count
