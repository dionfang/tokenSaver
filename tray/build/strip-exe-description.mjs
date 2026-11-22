#!/usr/bin/env node
/** exe 悬浮「文件说明」清写(20261122 用户裁定:安装包与客户端 exe 悬停 tips 不再带说明文案)。
 *  electron-builder 盖章链:壳 exe FileDescription = description||productName(winPackager.js,
 *  删 package.json description 后仍兜底写 "TokenSaver");安装器/卸载器 = description 直引
 *  (NsisTarget.computeVersionKey,删字段即自动空)。本脚本构建后对壳 exe 复用同款
 *  app-builder rcedit 清写为空串,并以 PowerShell 回读把关(非空即失败,防静默回潮)。
 *  用法:node build/strip-exe-description.mjs <exe...> */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tray = path.resolve(here, '..');

/** rcedit 清写参数(与 electron-builder winPackager 同款工具,仅 FileDescription 置空) */
export function rceditArgs(file) {
  return [path.resolve(file), '--set-version-string', 'FileDescription', ''];
}

/** 待清写产物:壳 exe(win-unpacked/TokenSaver.exe)+ 全部 Setup 安装器(排除 .blockmap) */
export function exeCandidates(outputDir) {
  const out = [];
  const unpacked = path.join(outputDir, 'win-unpacked', 'TokenSaver.exe');
  if (fs.existsSync(unpacked)) out.push(unpacked);
  for (const name of fs.readdirSync(outputDir)) {
    if (/^TokenSaver-Setup-.*\.exe$/.test(name)) out.push(path.join(outputDir, name));
  }
  return out;
}

/** PowerShell 回读 FileDescription(env 传路径,绕开跨进程引号搅碎;非 0 即抛) */
function fileDescriptionOf(file) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    '$d=(Get-Item -LiteralPath $env:TS_INFOTIP_FILE).VersionInfo.FileDescription; if($null -eq $d){"<null>"}else{$d}'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, TS_INFOTIP_FILE: file } });
  if (r.status !== 0) throw new Error(`FileDescription 回读失败: ${String(r.stderr).trim()}`);
  return String(r.stdout || '').trim();
}

/** 逐个清写并回读把关;任何一步非空/失败即抛(构建链上游必须因此失败退出) */
export function stripExeDescription(files) {
  const bin = path.join(tray, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
  for (const file of files) {
    const r = spawnSync(bin, ['rcedit', '--args', JSON.stringify(rceditArgs(file))],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`rcedit 清写失败(${path.basename(file)}): ${String(r.stderr || r.stdout).trim()}`);
    const desc = fileDescriptionOf(file);
    if (desc !== '' && desc !== '<null>') throw new Error(`FileDescription 清写后仍非空: "${desc}" (${path.basename(file)})`);
    console.log(`[strip] FileDescription 已清空: ${path.basename(file)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error('用法: node build/strip-exe-description.mjs <exe...>'); process.exit(1); }
  try { stripExeDescription(files); process.exit(0); }
  catch (e) { console.error(`[strip] ${e.message}`); process.exit(1); }
}
