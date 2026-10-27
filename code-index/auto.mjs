#!/usr/bin/env node
/**
 * 会话启动编排入口(各编辑器 hook 指向这里):
 *   保鲜判定(逐 root 的 git HEAD / 非 git 超 24h;当前路径向量缺失、模型不符或块签名过期)→ 需要时 build + 后台增量 embed → 预热双模型。
 * 项目无关:全部路径相对本文件;新项目由 init.mjs 生成指向此文件的 hook。
 * stdout 保持静默(hook 会按严格 JSON 校验 stdout),日志走 stderr;PID 锁防并发;失败不阻断会话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR, gitHeadOf } from './config.mjs';
import { assessModelStatus } from './modelStatus.mjs';
import { readVectorMeta, vectorStoreNeedsEmbed, wantEmbedModel } from './vectorStore.mjs';
import { pidAlive, takeJsonLock, releaseJsonLock, spawnLogged, LOCK_TTL_MS } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexJson = path.join(DATA_DIR, 'index.json');
const lockPath = path.join(DATA_DIR, '.warm.lock');

/**
 * 保鲜判定(逐 root 独立):
 *   git 仓库 → 与构建时记录的 HEAD(index.json.rootsHeads)比对:变了→重建,没变→跳过
 *   非 git   → 24h 时间回退(当前路径 meta.builtAt 超时才重建)
 *   当前路径向量缺失、模型不符或块签名过期(HEAD 未变)→ 只重嵌该目录(embedOnly)
 * 无切块清单 → 重建。全部 root 跳过且当前路径向量有效 → 不跑 build
 */
function evalFreshness() {
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(indexJson, 'utf8')); } catch { /* 无索引 */ }
  if (!idx?.files) return { need: true, reason: '无索引' };
  const recorded = idx.rootsHeads || {};
  const cfg = loadConfig();
  const { backend: wantBackend, model: wantModel } = wantEmbedModel(cfg);
  const meta = readVectorMeta(wantBackend);
  const builtAt = Date.parse(meta?.builtAt || idx.builtAt) || 0;
  const staleNonGit = cfg.staleNonGitMs ?? 24 * 60 * 60 * 1000;
  const now = Date.now();
  const reasons = [];
  for (const root of cfg.roots) {
    const key = path.resolve(root); // 与 build.mjs 记录键一致(统一反斜杠/绝对路径)
    if (!fs.existsSync(key)) continue; // 目录不存在,build 时自然跳过
    const name = path.basename(key);
    const head = gitHeadOf(key);
    if (head) {
      if (recorded[key] !== head) reasons.push(`${name}: HEAD ${recorded[key] ? '变更' : '未记录'}`);
    } else if (!builtAt || now - builtAt > staleNonGit) {
      reasons.push(`${name}: 非git且超24h`);
    }
  }
  if (reasons.length) return { need: true, reason: reasons.join(';') };
  // 代码没变:只看当前路径的向量目录,缺向量、模型不符或块签名过期才重嵌
  if (vectorStoreNeedsEmbed(wantBackend, wantModel).need) {
    const have = meta?.model ? `${meta.backend || wantBackend}/${meta.model}` : '无向量';
    return { need: true, embedOnly: true, reason: `当前路径向量需更新(${have} → ${wantBackend}/${wantModel})` };
  }
  return { need: false, reason: '全部 root 均新鲜' };
}

function runNode(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, script)], {
      cwd: here,
      stdio: ['ignore', 'ignore', 'inherit'], // stdout 丢弃(子脚本自身日志走 stderr)
      windowsHide: true,
    });
    child.on('error', (err) => {
      console.error(`[fail] 无法启动 ${script}:`, err.message);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function embedPidAlive() {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.embed.pid'), 'utf8'));
    const pid = Number(prev.pid);
    if (!pidAlive(pid)) return false;
    if (Number.isFinite(prev.ts) && Date.now() - prev.ts > LOCK_TTL_MS) return false;
    return true;
  } catch { return false; }
}

async function main() {
  if (!takeJsonLock(lockPath)) process.exit(0);
  try {
    const f = evalFreshness();
    if (f.need) {
      console.error(`[index] 保鲜判定:需要处理(${f.reason})`);
      let buildCode = 0;
      if (!f.embedOnly) {
        buildCode = await runNode('build.mjs');
        if (buildCode !== 0) console.error(`[warn] build.mjs 退出码 ${buildCode},跳过嵌入`);
      } else {
        console.error('[index] 代码未变仅模型变更,跳过 build 直接重嵌');
      }
      if (buildCode === 0) {
        if (embedPidAlive()) {
          console.error('[index] 后台嵌入进程已在运行,跳过重复启动');
        } else {
          const pid = spawnLogged(path.join(here, 'embed.mjs'), path.join(DATA_DIR, 'embed.log'), here).pid;
          console.error(`[index] 嵌入已转后台(pid ${pid},日志 data/embed.log;期间检索自动降级 bm25,完成后自动恢复)`);
        }
      }
    } else {
      console.error(`[index] 保鲜判定:全部跳过(${f.reason})`);
    }
    const warmCode = await runNode('warm.mjs');
    if (warmCode !== 0) console.error(`[warn] 模型预热退出码 ${warmCode}`);
    // 模型状态注入:按 Ollama / 已下载模型 / 索引文件逐项判定,禁止只凭预热退出码报「已启动」。
    // stdout 始终输出严格 JSON(hook 契约);Cursor 转发器忽略 stdout,互不影响
    const assessed = await assessModelStatus();
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'last-status.txt'), `${assessed.relay}\n`);
    } catch { /* 写失败不影响会话 */ }
    process.stdout.write(JSON.stringify({
      additionalContext: `[code-index] 请在每次回复末尾原样附上这一句:"${assessed.relay}"`,
    }));
  } finally {
    releaseJsonLock(lockPath);
  }
  process.exit(0);
}

main();
