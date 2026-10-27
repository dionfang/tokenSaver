#!/usr/bin/env node
/**
 * 模型部署状态(供 agent 在会话开始后运行并原样转达):
 *   node status.mjs
 * 每次现场核对,不复用 data/last-status.txt:
 *   Ollama 是否在听、两个模型是否已下载且正在驻留(/api/ps,即 ollama ps)、
 *   chunks.jsonl 与当前路径的 vectors/<modelIn>/embeddings.bin 是否已建立、模型名是否与配置一致。
 *   模型已下载但未拉起,不算启动成功。status 本身不负责拉起。
 * 对外只输出一句 ⚙ 状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { assessModelStatus } from './modelStatus.mjs';

const { relay } = await assessModelStatus();
try {
  if (fs.existsSync(DATA_DIR)) fs.writeFileSync(path.join(DATA_DIR, 'last-status.txt'), `${relay}\n`);
} catch { /* 落盘失败不影响转达 */ }
console.log(relay);
