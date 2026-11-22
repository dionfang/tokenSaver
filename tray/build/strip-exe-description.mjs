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

/** 待清写产物:**仅壳 exe**(win-unpacked/TokenSaver.exe)。
 *  20261122 事故修复(0.2.13 打包审查揪出):旧版把 Setup 安装器也纳入——app-builder rcedit 对
 *  NSIS『stub+尾部追加数据』形态 exe 的资源重写必丢尾部载荷,225MB 安装器毁成 47KB stub
 *  (size 守卫可拦但文件已毁)。安装器 FileDescription 本就随 package.json 无 description 自动空
 *  (NSIS 直引该字段),无需也不可 rcedit——只清写壳 exe。回读把关对壳 exe 保留。 */
export function exeCandidates(outputDir, version) {
  const out = [];
  const unpacked = path.join(outputDir, 'win-unpacked', 'TokenSaver.exe');
  if (fs.existsSync(unpacked)) out.push(unpacked);
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

/** 逐个清写并双重把关(回读非空即抛 + **写前后 size 不变**即抛——NSIS 尾部载荷被 rcedit 丢弃时
 *  225MB→47KB 缩水,FileDescription 回读仍显示空,旧守卫全绿放行,必须靠 size 门拦);
 *  构建链上游必须因此失败退出) */
export function stripExeDescription(files) {
  const bin = path.join(tray, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
  for (const file of files) {
    const sizeBefore = fs.statSync(file).size;
    const r = spawnSync(bin, ['rcedit', '--args', JSON.stringify(rceditArgs(file))],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`rcedit 清写失败(${path.basename(file)}): ${String(r.stderr || r.stdout).trim()}`);
    const sizeAfter = fs.statSync(file).size;
    if (sizeAfter !== sizeBefore) {
      throw new Error(`rcedit 清写改变文件大小(${sizeBefore}→${sizeAfter}):NSIS 安装器尾部载荷被丢弃,产物已废,禁止发布(${path.basename(file)})`);
    }
    const desc = fileDescriptionOf(file);
    if (desc !== '' && desc !== '<null>') throw new Error(`FileDescription 清写后仍非空: "${desc}" (${path.basename(file)})`);
    console.log(`[strip] FileDescription 已清空(size 守卫 ${sizeBefore}B 不变): ${path.basename(file)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error('用法: node build/strip-exe-description.mjs <exe...>'); process.exit(1); }
  try { stripExeDescription(files); process.exit(0); }
  catch (e) { console.error(`[strip] ${e.message}`); process.exit(1); }
}
