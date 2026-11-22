#!/usr/bin/env node
/** 在线包发布命令入口(20261122 起 npm run dist 改走本包装器):electron-builder 构建成功后,
 *  对产物 exe(壳 win-unpacked/TokenSaver.exe + **本版** Setup 安装器)清写 FileDescription,
 *  落实「安装包与客户端 exe 无悬浮说明」裁定。绕过本包装器直接跑 electron-builder,
 *  壳 exe 会被 description||productName 兜底写回 "TokenSaver",悬浮说明回潮。
 *  20261122 事故修复:旧版曾把 Setup 安装器纳入清写——rcedit 对 NSIS『stub+尾部数据』形态的
 *  重写必丢尾部载荷(225MB→47KB stub,历史件同被毁,服务器原件回拉恢复)。安装器 FileDescription
 *  随 package.json 无 description 自动空(NSIS 直引),根本不需要 rcedit——现在只清写壳 exe。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripExeDescription, exeCandidates } from './strip-exe-description.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tray = path.resolve(here, '..');
const version = JSON.parse(fs.readFileSync(path.join(tray, 'package.json'), 'utf8')).version;
const build = spawnSync(process.execPath, [path.join(tray, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', 'nsis'], { cwd: tray, stdio: 'inherit', windowsHide: true, env: { ...process.env } });
if (build.status !== 0) process.exit(build.status ?? 1);
const targets = exeCandidates(path.join(tray, 'release3'), version);
if (targets.length === 0) { console.error(`[strip] release3 下未找到本版(${version})待清写 exe`); process.exit(1); }
try { stripExeDescription(targets); process.exit(0); }
catch (e) { console.error(`[strip] ${e.message}`); process.exit(1); }
