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
const stage = spawnSync(process.execPath, [path.join(here, 'stage-weights.mjs')], { cwd: tray, stdio: 'inherit', windowsHide: true });
if (stage.status !== 0) process.exit(stage.status ?? 1);
const build = spawnSync(process.execPath, [path.join(tray, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', 'nsis', '-c', 'electron-builder.offline.yml'], { cwd: tray, stdio: 'inherit', windowsHide: true, env: { ...process.env } });
process.exit(build.status ?? 1);
