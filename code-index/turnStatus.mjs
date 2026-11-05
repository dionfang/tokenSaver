/**
 * 状态句跨钩子共享层(2026-11-04 用户拍板):一并修两处滞后——
 *   模型名滞后:UserPromptSubmit 注入时本轮请求还没发出,句首【】只能是上一轮;
 *     轮内第一个请求完成后(db 可查)重新渲染最新状态句,由 read-nudge 的 PostToolUse
 *     注入,模型回复末尾照抄的就是本轮真实模型。
 *   入账滞后:回合末由 turn-close(Stop 钩子)结算 applySessionAccumulation,把该轮放大
 *     节约滚进账本,并按回合追加 turns.jsonl(模型/增量/今日/总计)。
 * 状态文件 data/read-guard/<sid>.status.json:{relay, remoteModel, prevTurnId, at}:
 *   prevTurnId 记录"该状态句描述的是哪个 turn"——轮内工具结果回来时,db 最新完成的
 *   turn_id 与之一致=同轮(不再注入),不一致=新轮(注入新鲜句并推进)。
 * 所有路径失败静默,绝不阻塞宿主钩子。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import {
  applySessionAccumulation,
  currentRemoteModel,
  latestCompletedTurn,
  readSessionSavings,
} from './modelStatus.mjs';

export function sanitizeSid(sid) {
  return String(sid || '').replace(/[^\w.-]/g, '_').slice(0, 120);
}

export function statusFile(stateDir, sid) {
  return path.join(stateDir, `${sanitizeSid(sid)}.status.json`);
}

/** prompt 发送时落档:relay 已由 prompt-guard 渲染好,这里补 remoteModel 与 prevTurnId 两个采样点。 */
export function recordAtPrompt({ stateDir = path.join(DATA_DIR, 'read-guard'), sid, relay, now = Date.now(), deps = defaultStatusDeps() } = {}) {
  if (!sid || !relay) return false;
  try {
    let remoteModel = null;
    let prevTurnId = null;
    try { remoteModel = deps.currentModel(sid) || null; } catch { /* 查不到省略 */ }
    try { prevTurnId = deps.latestTurn(sid)?.turnId ?? null; } catch { /* 无 db → null */ }
    deps.writeJson(statusFile(stateDir, sid), { relay, remoteModel, prevTurnId, at: now });
    return true;
  } catch { return false; }
}

/**
 * 轮内新鲜状态句:只有进入新轮才返回可注入的完整句子,同轮重复调用返回 null。
 * zcode 按 db 的 turn_id 判定;非 zcode(无 db)按「模型变了 或 距上次 ≥ minIntervalMs」节流。
 * relayFor 走状态句渲染(内部先结算放大节约),所以注入前数字已经是当时的实时值。
 */
export async function freshStatusLine({ stateDir = path.join(DATA_DIR, 'read-guard'), sid, now = Date.now(), minIntervalMs = 90_000, deps = defaultStatusDeps() } = {}) {
  if (!sid) return null;
  try {
    const st = deps.readJson(statusFile(stateDir, sid)) || {};
    const turn = deps.latestTurn(sid);
    if (turn && st.prevTurnId != null && turn.turnId === st.prevTurnId) return null;
    // 非 zcode(无 db)先用便宜路径取当前模型:模型没变且窗口内直接退出,不渲染、不结算
    const quick = deps.currentModel(sid) || null;
    if (!turn && st.remoteModel === quick && now - (st.at || 0) < minIntervalMs) return null;
    const relay = await deps.relayFor(sid);
    if (!relay) return null;
    const remote = quick || deps.currentModel(sid) || null;
    deps.writeJson(statusFile(stateDir, sid), {
      relay,
      remoteModel: remote ?? st.remoteModel ?? null,
      prevTurnId: turn ? turn.turnId : (st.prevTurnId ?? null),
      at: now,
    });
    return `[code-index] 状态(本轮实时值,回复末尾原样附上):${relay}`;
  } catch { return null; }
}

/** 回合末结算:滚放大节约、取本轮真实模型、追加 turns.jsonl。返回落盘记录或 null。 */
export function settleTurn({ dataDir = DATA_DIR, sid, host = 'unknown', at = Date.now(), deps = defaultStatusDeps() } = {}) {
  try {
    const settled = deps.applySettlement();
    const model = sid ? deps.currentModel(sid) : null;
    const rec = {
      ts: at,
      host,
      session: sid || null,
      model,
      settled: Math.max(0, Number(settled?.total) || 0),
      refund: Math.max(0, Number(settled?.refund) || 0),
      today: deps.todaySavings(),
      total: deps.totalSavings(),
    };
    deps.appendJsonl(path.join(dataDir, 'usage', 'turns.jsonl'), rec);
    return rec;
  } catch { return null; }
}

/** 全历史日求和(总计段口径,与 renderStatusWith 一致)。 */
export function totalSavingsOf(dataDir = DATA_DIR) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'session-savings.json'), 'utf8'));
    return Object.values(doc?.days || {}).reduce((s, d) => s + Math.max(0, Math.round(Number(d?.savedTokens) || 0)), 0);
  } catch { return 0; }
}

/** 默认依赖=真实实现;测试注入替身保持密闭。 */
function defaultStatusDeps() {
  return {
    readJson: (f) => {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
    },
    writeJson: (f, v) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(v));
    },
    appendJsonl: (f, v) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify(v) + '\n');
    },
    latestTurn: (sid) => latestCompletedTurn(sid),
    currentModel: (sid) => currentRemoteModel(sid),
    relayFor: async (sid) => {
      const { assessModelStatusCached } = await import('./modelStatus.mjs');
      return (await assessModelStatusCached(sid))?.relay || null;
    },
    applySettlement: () => applySessionAccumulation(),
    todaySavings: () => readSessionSavings(),
    totalSavings: () => totalSavingsOf(DATA_DIR),
  };
}