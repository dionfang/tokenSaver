#!/usr/bin/env node
/**
 * npm bin 入口。子命令对应同目录 *.mjs,参数原样转发。
 *   npx tokensaver init [--roots ...] [--model-in ollama|local]
 *   npx tokensaver search 关键词 --rerank --k 5
 *   npx tokensaver status | build | embed | auto | warm | details
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = {
  init: 'init.mjs',
  search: 'search.mjs',
  status: 'status.mjs',
  build: 'build.mjs',
  embed: 'embed.mjs',
  auto: 'auto.mjs',
  warm: 'warm.mjs',
  details: 'details.mjs',
};

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(`tokensaver <命令> [...参数]

命令: ${Object.keys(COMMANDS).join(', ')}
安装后在仓库根执行 npx tokensaver init
模型权重不在本包内:ollama 需本机已 pull;local 首次下载到 hf-cache。`);
  process.exit(cmd ? 0 : 1);
}
if (cmd.startsWith('-')) {
  console.error(`[err] 未知参数 ${cmd}。先写命令,例如 tokensaver search 关键词`);
  process.exit(1);
}
const file = COMMANDS[cmd];
if (!file) {
  console.error(`[err] 未知命令 ${cmd}。可用: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(here, file), ...argv.slice(1)], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(`[err] 无法启动 ${file}: ${err.message}`);
  process.exit(1);
});
