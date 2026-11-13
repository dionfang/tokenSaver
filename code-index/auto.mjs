#!/usr/bin/env node
/**
 * 会话启动编排入口(各编辑器 hook 指向这里):
 *   保鲜判定(逐 root 的 git HEAD / 非 git 超 24h;当前路径向量缺失、模型不符或块签名过期)→ 需要时 build + 后台增量 embed(上次异常终止残留死 pid 锁时挂起自动续嵌,防 WHEA 再点火)→ 预热双模型。
 * 项目无关:全部路径相对本文件;新项目由 init.mjs 生成指向此文件的 hook。
 * stdout 保持静默(hook 会按严格 JSON 校验 stdout),日志走 stderr;PID 锁防并发;失败不阻断会话。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR, gitHeadOf } from './config.mjs';
import { assessModelStatus } from './modelStatus.mjs';
import { readVectorMeta, vectorStoreNeedsEmbed, wantEmbedModel } from './vectorStore.mjs';
import { takeJsonLock, releaseJsonLock, spawnLogged } from './proc.mjs';
import { embedBusy, embedCrashed } from './embedGate.mjs'; // S4-F3 busy 判定单源化;embedCrashed=崩溃残留判定(WHEA 防再点火,2026-11-11)

const here = path.dirname(fileURLToPath(import.meta.url));
const indexJson = path.join(DATA_DIR, 'index.json');
const lockPath = path.join(DATA_DIR, '.warm.lock');

/** S4-F1(2026-11-10 夜审):git 仓工作区脏度——git status --porcelain 非空=有未提交改动(毫秒级,会话启动才跑)。
 *  未追踪新文件也计入:build 扫描盘面会把它们编进索引,漏了它们新鲜度同样失真。 */
function gitDirtyOf(dir) {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd: dir, timeout: 5000, encoding: 'utf8' });
    return r.status === 0 && String(r.stdout || '').trim() !== '';
  } catch { return false; }
}

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
      if (recorded[key] !== head) { reasons.push(`${name}: HEAD ${recorded[key] ? '变更' : '未记录'}`); continue; }
      // S4-F1(2026-11-10 夜审):HEAD 没变不代表工作区干净——旧口径把未提交改动宣称"新鲜"。
      // 现在纳入脏度:未提交修改即重建,与"索引代表真实工作区"的口径对齐。
      if (gitDirtyOf(key)) reasons.push(`${name}: 工作区有未提交改动`);
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

function runNode(script, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, script)], {
      cwd: here,
      stdio: ['ignore', 'ignore', 'inherit'], // stdout 丢弃(子脚本自身日志走 stderr)
      windowsHide: true,
    });
    // 上限 120s(2026-11-10 审计修复):warm 等子脚本挂起不得拖死 SessionStart 钩子;超时强杀
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      console.error(`[fail] 无法启动 ${script}:`, err.message);
      resolve(1);
    });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
}

// S4-F3(2026-11-11 夜审):busy 判定单源化——本地 embedPidAlive 副本已删,统一走 embedGate.embedBusy。

async function main() {
  // 会话开始:卸掉"切换模型/切换路径"之前拉起的驻留模型(2026-11-08)。
  // 与预热解耦:即使预热随后失败(比如 Ollama 没起),旧驻留也已经卸了,不白占显存。
  // ⚠️ 必须在 takeJsonLock **之外**:锁被别的会话占用时本进程直接退出,清理跟着被跳过
  // ——实测两个 localResident 孤儿(4.8GB)就是这么活过了一个会话(2026-11-09 修)。
  try {
    const { releaseStaleModels } = await import('./cleanup.mjs');
    const rel = await releaseStaleModels({ onInfo: console.error });
    if (rel.unloaded.length) console.error(`[cleanup] 已卸下切换前拉起的模型:${rel.unloaded.join(', ')}`);
    if (rel.stoppedResident) console.error('[cleanup] 本地常驻进程已停(装的是旧模型,或已切到 ollama 路径)');
  } catch (e) {
    console.error('[cleanup] 切换清理跳过:', e.message);
  }
  // 关闭看护(2026-11-08):宿主退出即卸本地模型。ZCode 只有七个钩子事件、没有 SessionEnd,
  // 没有回调能拿到"宿主要走"的信号,只能用脱离父进程的看护盯宿主进程。
  // 去重按进程表(同宿主只留一个在值班的),放锁外也不会重复拉。
  try {
    const { startWatcher } = await import('./cleanupWatch.mjs');
    startWatcher({ onInfo: console.error });
  } catch (e) {
    console.error('[cleanup] 关闭看护未拉起:', e.message);
  }
  if (!takeJsonLock(lockPath)) process.exit(0);
  try {
    // 决策模型断路器自动探活(2026-11-03):仅"开关开 ∧ 断路器开着"才后台拉起 --probe-if-tripped
    // (成功自动复位/失败续跳留痕);健康路径零开销零网关;detached 不占会话启动,拉起失败不影响会话。
    try {
      const { autoProbeDue } = await import('./decisionModel.mjs');
      if (autoProbeDue()) {
        const child = spawn(process.execPath, [path.join(here, 'decisionModel.mjs'), '--probe-if-tripped'], {
          cwd: here, stdio: 'ignore', detached: true, windowsHide: true,
        });
        child.unref();
        console.error('[decision-model] 断路器开启,已后台探活(成功自动复位,失败保持跳闸;留痕 data/routing/decision-model-breaker.json)');
      }
    } catch { /* 探活判定/拉起失败不影响会话 */ }
    // 动态显示名刷新(2026-11-08 用户定案,唯一改名挂载点):会话开启时读全期倍率(globalRate,
    // 跨会话累计)刷进两端条目——Qoder 只进 displayName(id 恒纯 auto),ZCode 进
    // personalModelIds/modelOrder。会话中期禁改(名字变更令绑定失效,2026-11-07 实弹事故);
    // 禁写宿主根级杂字段。fail-open。
    try {
      const blend = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage', 'auto-blend.json'), 'utf8'));
      const rate = blend && Number.isFinite(Number(blend.globalRate)) ? Number(blend.globalRate) : null;
      if (rate != null && rate > 0) {
        const { refreshAutoModelName } = await import('./virtualProvider.mjs');
        const rr = refreshAutoModelName({ rate });
        const changed = [rr.zcode, rr.qoder].some((x) => x && (x.refreshed || x.seeded));
        if (changed) console.error(`[auto-name] 条目名已按全期费率刷成 ${rr.zcode?.note || rr.qoder?.note}(会话开启时刷新)`);
      }
    } catch { /* 刷名失败不影响会话 */ }
// 预热前置(2026-11-12 用户定案①):warm 先于保鲜 build——常驻冷加载(15-40s)不再被
// build(10-20s)顶在后面,首条 prompt 的竞态窗口按同量缩小;build 仍内联(紧随其后),
// 向量同会话新鲜,detached build→embed 链的编排成本与跨进程陈旧签名不值得。
// 顺序副作用=warm 失败时保鲜照跑(fail-open,与原顺序一致)。
const warmCode = await runNode('warm.mjs');
if (warmCode !== 0) console.error(`[warn] 模型预热退出码 ${warmCode}`);
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
    if (embedBusy()) {
      console.error('[index] 后台嵌入进程已在运行,跳过重复启动');
    } else if (embedCrashed()) {
      // 2026-11-11 修:embedPidAlive 已在 S4-F3 单源化中删除,此处漏改的未定义引用会让"需要处理"路径整段 ReferenceError,预热与状态句全被跳过
      console.error('[index] 检测到上次嵌入异常终止(残留 .embed.pid,进程已不在),已挂起自动续嵌(WHEA 防再点火);确认机器稳定后请手动运行 node embed.mjs 恢复');
    } else {
      const pid = spawnLogged(path.join(here, 'embed.mjs'), path.join(DATA_DIR, 'embed.log'), here).pid;
      console.error(`[index] 嵌入已转后台(pid ${pid},日志 data/embed.log;期间检索自动降级 bm25,完成后自动恢复)`);
    }
  }
} else {
  console.error(`[index] 保鲜判定:全部跳过(${f.reason})`);
}
// 模型状态注入:按 Ollama / 已下载模型 / 索引文件逐项判定,禁止只凭预热退出码报「已启动」。
    // stdout 始终输出严格 JSON(hook 契约);Cursor 转发器忽略 stdout,互不影响
    // 每轮 UserPromptSubmit 会注入带会话累计的最新状态句,本句只作首轮兜底。
    const assessed = await assessModelStatus();
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'last-status.txt'), `${assessed.relay}\n`);
    } catch { /* 写失败不影响会话 */ }
    process.stdout.write(JSON.stringify({
      additionalContext: `[code-index] 请以每轮 UserPromptSubmit 注入的"[code-index] 状态(本轮实时值…)"里的 ⚙ 整句为准,原样附在回复末尾;本句仅作首轮兜底:"${assessed.relay}"`,
    }));
  } finally {
    releaseJsonLock(lockPath);
  }
  process.exit(0);
}

main();
