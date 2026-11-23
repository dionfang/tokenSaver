#!/usr/bin/env node
/** 离线完整包发布命令入口(2026-11-17):npm run dist:offline。
 *  先 staging 三权重(build/weights,源缺失即报错),再 electron-builder 走 offline 配置
 *  (extends 在线基配置 + installer-offline.nsh 权重解包 + release-offline 输出)。
 *  在线包发布仍为 npm run dist(不含权重,装后向导在线下载)。 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tray = path.resolve(here, '..');
// 20261123 用户裁定「托盘图标与桌面图标使用同一个」:构建前从 build/icon.png 派生 assets/tray.png(与 dist-online 同口径,失败即中止)。
const trayIcon = spawnSync(process.execPath, [path.join(here, 'tray-from-icon.mjs')], { cwd: tray, stdio: 'inherit', windowsHide: true });
if (trayIcon.status !== 0) process.exit(trayIcon.status ?? 1);
const stage = spawnSync(process.execPath, [path.join(here, 'stage-weights.mjs')], { cwd: tray, stdio: 'inherit', windowsHide: true });
if (stage.status !== 0) process.exit(stage.status ?? 1);
const build = spawnSync(process.execPath, [path.join(tray, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', 'nsis', '-c', 'electron-builder.offline.yml'], { cwd: tray, stdio: 'inherit', windowsHide: true, env: { ...process.env } });
if (build.status !== 0) process.exit(build.status ?? 1);
const { stripExeDescription, exeCandidates } = await import('./strip-exe-description.mjs');
// 20261122 事故同修:只清写壳 exe——rcedit 会毁 NSIS 安装器尾部载荷(225MB→47KB stub)
const targets = exeCandidates(path.join(tray, 'release-offline'));
if (targets.length === 0) { console.error('[strip] release-offline 下未找到待清写 exe'); process.exit(1); }
try { stripExeDescription(targets); process.exit(0); }
catch (e) { console.error(`[strip] ${e.message}`); process.exit(1); }
