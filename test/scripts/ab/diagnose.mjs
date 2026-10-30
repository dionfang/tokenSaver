#!/usr/bin/env node
/**
 * 输出端 A/B 的机制诊断:把 output 拆成 思考文本 / 可见回复 / 工具参数 三块,
 * 并统计其中「指令冲突权衡」文本的占比。
 *
 * 背景:三轮实验发现 output 差异 100% 来自思考文本(24/24 同向),
 * 而思考里最大的可省项是:指令冲突权衡、方案自我追问、未被要求的额外代码。
 *
 * 用法:
 *   node diagnose.mjs --runs data/ab/runs.od2.r2 [--runs data/ab/runs.od2.r3] [...]
 *   node diagnose.mjs --runs data/ab/runs.od2.r1 --runs data/ab/runs.od2.r2 --per-task
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const runs = argv.reduce((acc, a, i) => (a === '--runs' ? [...acc, argv[i + 1]] : acc), []);
const perTask = argv.includes('--per-task');
if (!runs.length) {
  console.error('用法: node diagnose.mjs --runs <目录> [--runs <目录> ...] [--per-task]');
  process.exit(1);
}

// 与 summarize 的冲突判定保持同一口径:工作区约定、注入的规则、任务要求的冲突
const CONFLICT = /(AGENTS\.md|conflict|override|overrides|instruction|status\.mjs|⚙|脚手架|检索|索引)/i;
// 自我追问:改口、犹豫、并列比较方案的标记
const DOUBT = /(\bHmm\b|\bActually\b|\bWait\b|\bactually\b|\bbut wait\b|\blet me think\b|\bor\b|should I|maybe|Perhaps|\?)/;
// 思考里预演代码:围栏代码块
const CODE = /```/g;

function loadRun(file) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(j => j?.type === 'model_io' && j.response?.usage);
  const think = rows.reduce((s, r) => s + (r.response.reasoningText || '').length, 0);
  const text = rows.reduce((s, r) => s + (r.response.text || '').length, 0);
  const args = rows.reduce((s, r) => s + JSON.stringify(r.response.toolCalls || []).length, 0);
  const out = rows.reduce((s, r) => s + r.response.usage.outputTokens, 0);
  let conflict = 0, doubt = 0, code = 0, extraCmd = 0, bash = 0;
  for (const r of rows) {
    const s = r.response.reasoningText || '';
    for (const sent of s.split(/(?<=[.。!?\n])/)) {
      if (CONFLICT.test(sent)) conflict += sent.length;
      if (DOUBT.test(sent)) doubt += sent.length;
    }
    code += (s.match(CODE) || []).length;
    for (const tc of r.response.toolCalls || []) {
      const inp = JSON.stringify(tc.input || {});
      if (tc.name === 'Bash') bash++;
      // 任务没要求的额外命令:状态查询、索引检索等
      if (/status\.mjs|code-index|search\.mjs/i.test(inp)) extraCmd++;
    }
  }
  return { think, text, args, out, conflict, doubt, code, extraCmd, bash, requests: rows.length };
}

const tasks = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
for (const dir of runs) {
  const abs = path.isAbsolute(dir) ? dir : path.resolve(root, dir);
  if (!fs.existsSync(abs)) {
    console.error(`[err] 找不到 ${abs}`);
    continue;
  }
  console.log(`\n## ${dir}`);
  const agg = { A: { think: 0, text: 0, args: 0, out: 0, conflict: 0, doubt: 0, code: 0, extraCmd: 0, bash: 0, requests: 0 }, B: { think: 0, text: 0, args: 0, out: 0, conflict: 0, doubt: 0, code: 0, extraCmd: 0, bash: 0, requests: 0 } };
  const pairs = [];
  for (const t of tasks) {
    const rec = {};
    for (const cond of ['A', 'B']) {
      const f = path.join(abs, `${t}-${cond}.jsonl`);
      if (!fs.existsSync(f)) { rec[cond] = null; continue; }
      rec[cond] = loadRun(f);
      for (const k of Object.keys(agg[cond])) agg[cond][k] += rec[cond][k] || 0;
    }
    pairs.push({ t, ...rec });
  }
  const { A, B } = agg;
  const pct = (x, y) => (y ? `${((x / y - 1) * 100).toFixed(0)}%` : '—');
  console.log(`- output:A ${A.out} / B ${B.out} (${pct(B.out, A.out)})`);
  console.log(`- 思考字符:A ${A.think} / B ${B.think} (${pct(B.think, A.think)})`);
  console.log(`- 可见回复字符:A ${A.text} / B ${B.text}`);
  console.log(`- 工具参数字符:A ${A.args} / B ${B.args}`);
  console.log(`- 冲突权衡字符:A ${A.conflict}(${(A.conflict / (A.think || 1) * 100).toFixed(0)}%) / B ${B.conflict}(${(B.conflict / (B.think || 1) * 100).toFixed(0)}%)`);
  console.log(`- 自我追问字符:A ${A.doubt}(${(A.doubt / (A.think || 1) * 100).toFixed(0)}%) / B ${B.doubt}(${(B.doubt / (B.think || 1) * 100).toFixed(0)}%)`);
  console.log(`- 思考里预演代码块:A ${A.code} / B ${B.code}`);
  console.log(`- 请求数:A ${A.requests} / B ${B.requests};Bash 调用:A ${A.bash} / B ${B.bash};额外索引/状态命令:A ${A.extraCmd} / B ${B.extraCmd}`);
  if (perTask) {
    console.log('| 任务 | A out | B out | B−A | A think | B think | think 差 | A 追问 | B 追问 |');
    console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const p of pairs) {
      if (!p.A || !p.B) continue;
      const dt = p.B.think - p.A.think;
      console.log(`| ${p.t} | ${p.A.out} | ${p.B.out} | ${p.B.out - p.A.out > 0 ? '+' : ''}${p.B.out - p.A.out} | ${p.A.think} | ${p.B.think} | ${dt > 0 ? '+' : ''}${dt} | ${p.A.doubt} | ${p.B.doubt} |`);
    }
  }
}
