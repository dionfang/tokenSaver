#!/usr/bin/env node
/** A/B 测试脚手架自检:验收器 good/bad、条件切换(含 --mark/--rules 自定义规则段)、精确归属、重复保护、汇总门槛。不跑子代理。启动:cd code-index && npm test(或 node ../test/ab-selftest.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const run = (args) => spawnSync(node, args, { encoding: 'utf8' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ab-'));

try {
  const v = run([path.join(here, 'scripts', 'ab', 'verify.mjs'), '--selftest']);
  assert.equal(v.status, 0, `verify --selftest 失败:\n${v.stdout}\n${v.stderr}`);

  const agents = path.join(tmp, 'AGENTS.md');
  const backup = path.join(tmp, 'AGENTS.backup.md');
  fs.writeFileSync(agents, '# T\n\n## Rules\nkeep\n\n<!-- ponytail -->\n## Ponytail\nbody\n');
  let r = run([path.join(here, 'scripts', 'ab', 'condition.mjs'), 'A', '--agents', agents, '--backup', backup]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.readFileSync(agents, 'utf8').includes('<!-- ponytail -->'), 'A 应去掉 ponytail');
  assert.ok(fs.existsSync(backup), 'A 应留下备份');
  r = run([path.join(here, 'scripts', 'ab', 'condition.mjs'), 'B', '--agents', agents, '--backup', backup]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.readFileSync(agents, 'utf8').includes('<!-- ponytail -->'), 'B 应恢复 ponytail');
  assert.ok(!fs.existsSync(backup), 'B 应删除备份');

  // --mark + --rules 模式:切换任意规则段(不是 ponytail)
  const mark2 = '<!-- output-diet -->';
  const rulesFile = path.join(tmp, 'rules.md');
  fs.writeFileSync(rulesFile, '## Output Diet\nbody\n');
  const agents2 = path.join(tmp, 'AGENTS2.md');
  const backup2 = path.join(tmp, 'AGENTS2.backup.md');
  fs.writeFileSync(agents2, '# T\n\n## base\nkeep\n');
  r = run([path.join(here, 'scripts', 'ab', 'condition.mjs'), 'B', '--agents', agents2, '--backup', backup2, '--mark', mark2, '--rules', rulesFile]);
  assert.equal(r.status, 0, r.stderr);
  let c2 = fs.readFileSync(agents2, 'utf8');
  assert.ok(c2.includes(mark2) && c2.includes('## Output Diet') && c2.endsWith('body\n'), 'B 应在原文末尾追加规则段');
  assert.ok(!fs.existsSync(backup2), 'B 后应删除备份');
  r = run([path.join(here, 'scripts', 'ab', 'condition.mjs'), 'A', '--agents', agents2, '--backup', backup2, '--mark', mark2]);
  assert.equal(r.status, 0, r.stderr);
  c2 = fs.readFileSync(agents2, 'utf8');
  assert.ok(!c2.includes(mark2) && c2.includes('## base'), 'A 应移除规则段并保留原文');
  assert.ok(fs.existsSync(backup2), 'A 应留下备份');
  r = run([path.join(here, 'scripts', 'ab', 'condition.mjs'), 'B', '--agents', agents2, '--backup', backup2, '--mark', mark2, '--rules', rulesFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(agents2, 'utf8').split(mark2).length - 1, 1, 'A→B 循环不应重复追加规则段');

  const rollout = path.join(tmp, 'rollout');
  const runs = path.join(tmp, 'runs');
  const results = path.join(tmp, 'results.jsonl');
  fs.mkdirSync(rollout);
  fs.mkdirSync(runs);
  const agent = 'agent_test-1';
  const sid = `sess_subagent_${agent}`;
  const line = (sessionId, requestId, output, extra = {}) => JSON.stringify({
    type: 'model_io',
    sessionId,
    requestId,
    startedAt: '2026-01-01T00:00:01.000Z',
    model: { modelId: 'm1' },
    response: { usage: { inputTokens: 100, outputTokens: output, totalTokens: 100 + output, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ...extra,
  });
  fs.writeFileSync(path.join(rollout, `model-io-${sid}.jsonl`), [
    line(sid, 's1', 10, { querySource: 'subagent' }),
    line(sid, 's2', 20, { querySource: 'subagent' }),
    line('session_main', 'm1', 999, { note: agent }),
    JSON.stringify({ type: 'model_io', sessionId: sid, requestId: 'bad', error: { message: 'x' }, response: { usage: {} } }),
    'not json',
  ].join('\n'));

  const args = [
    path.join(here, 'scripts', 'ab', 'record.mjs'),
    '--task', 't1', '--cond', 'B', '--pass', 'pass',
    '--agent', agent, '--since', '2026-01-01T00:00:00.000Z',
    '--rollout', rollout, '--runs', runs, '--out', results, '--agents', agents,
  ];
  r = run(args);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(fs.readFileSync(results, 'utf8').trim());
  assert.equal(rec.output, 30, '只统计精确 sessionId 的子代理 usage');
  assert.equal(rec.requests, 2);
  assert.deepEqual(rec.models, ['m1']);
  assert.ok(fs.existsSync(path.join(runs, 't1-B.jsonl')), '应复制子代理 rollout');

  r = run(args);
  assert.notEqual(r.status, 0, '重复记账应被拒绝');
  r = run([...args, '--replace']);
  assert.equal(r.status, 0, '--replace 应允许重跑');
  assert.equal(fs.readFileSync(results, 'utf8').trim().split('\n').length, 1);

  r = run(args.map(x => x === 'B' ? 'A' : x));
  assert.notEqual(r.status, 0, '条件与 AGENTS 状态不一致应被拒绝');

  const missing = args.map(x => x === agent ? 'agent_missing' : x);
  r = run(missing);
  assert.notEqual(r.status, 0, '缺少子代理 rollout 应被拒绝');

  // prepare/record 接受 --mark
  const workRoot = path.join(tmp, 'workroot');
  const results2 = path.join(tmp, 'results2.jsonl');
  r = run([path.join(here, 'scripts', 'ab', 'prepare.mjs'), 't1', 'B', '--mark', mark2, '--agents', agents2, '--work-root', workRoot, '--results', results2]);
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(path.join(tmp, 'AGENTS3.md'), '# T\n');
  r = run([path.join(here, 'scripts', 'ab', 'prepare.mjs'), 't1', 'B', '--mark', mark2, '--agents', path.join(tmp, 'AGENTS3.md'), '--work-root', workRoot, '--results', results2]);
  assert.notEqual(r.status, 0, 'AGENTS.md 无规则段时 prepare B 应拒绝');
  r = run([
    path.join(here, 'scripts', 'ab', 'record.mjs'),
    '--task', 't1', '--cond', 'B', '--pass', 'pass',
    '--agent', agent, '--since', '2026-01-01T00:00:00.000Z',
    '--rollout', rollout, '--runs', path.join(tmp, 'runs2'), '--out', results2, '--agents', agents2,
    '--mark', mark2,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(results2, 'utf8').trim()).rulesActive, true, 'record 应记录规则段状态');

  const summary = path.join(tmp, 'summary.jsonl');
  fs.writeFileSync(summary, [
    JSON.stringify({ task: 't1', cond: 'A', pass: true, promptSha: 'x', models: ['m1'], output: 100, requests: 2 }),
    JSON.stringify({ task: 't1', cond: 'B', pass: true, promptSha: 'x', models: ['m1'], output: 80, requests: 2 }),
  ].join('\n') + '\n');
  r = run([path.join(here, 'scripts', 'ab', 'summarize.mjs'), '--results', summary, '--partial', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const js = JSON.parse(r.stdout);
  assert.equal(js.valid, true);
  assert.equal(js.totals.outputA, 100);
  assert.equal(js.totals.outputB, 80);

  fs.writeFileSync(summary, [
    JSON.stringify({ task: 't1', cond: 'A', pass: true, promptSha: 'x', models: ['m1'], output: 100, requests: 2 }),
    JSON.stringify({ task: 't1', cond: 'B', pass: false, promptSha: 'x', models: ['m1'], output: 80, requests: 2 }),
  ].join('\n') + '\n');
  r = run([path.join(here, 'scripts', 'ab', 'summarize.mjs'), '--results', summary, '--partial', '--json']);
  assert.notEqual(r.status, 0, '通过率不一致应判不可比较');
  assert.equal(JSON.parse(r.stdout).valid, false);

  console.log('ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
