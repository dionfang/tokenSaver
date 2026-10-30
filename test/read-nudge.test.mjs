#!/usr/bin/env node
/** read-nudge 纯函数测试:连续区间读导航、全量读清零、Bash 大输出、失败导航、限频、记账字节数。 启动:cd code-index && npm test(或 node ../test/read-nudge.test.mjs) */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateNudge, runReadNudge } from '../code-index/read-nudge.mjs';

const cfg = { enabled: true, bashDumpBytes: 24 * 1024, windowMs: 10 * 60 * 1000 };
const now = 1_800_000_000_000;

// 无关工具直接放行
assert.deepEqual(evaluateNudge({ hookEventName: 'PostToolUse', toolName: 'Edit', toolInput: {}, history: {}, now, config: cfg }), { history: {} });

// 第一次区间读:不提示,记一笔
let h = {};
let r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Read',
  toolInput: { file_path: 'D:/x/a.ts', offset: 1, limit: 100 },
  toolResponse: { stdoutBytes: 4096 },
  history: h, now, config: cfg,
});
assert.equal(r.context, undefined, '首段不提示');
assert.equal(r.accountTokens, 1024, 'bytes/4 记账');
assert.equal(r.history.reads['D:/x/a.ts'].ranges, 1);

// 第二次区间读(10 分钟内):提示合并/检索
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Read',
  toolInput: { file_path: 'D:/x/a.ts', offset: 101, limit: 100 },
  toolResponse: { stdoutBytes: 4096 },
  history: r.history, now: now + 1000, config: cfg,
});
assert.match(r.context, /连续区间读 2 段/);
assert.match(r.context, /offset=起点/);
assert.ok(Number.isFinite(r.history.reads['D:/x/a.ts'].nudgedAt));

// 窗口内不重复提示
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Read',
  toolInput: { file_path: 'D:/x/a.ts', offset: 201, limit: 100 },
  toolResponse: { stdoutBytes: 4096 },
  history: r.history, now: now + 2000, config: cfg,
});
assert.equal(r.context, undefined, '提示窗口内不再提示');

// 全量读清零序列
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Read',
  toolInput: { file_path: 'D:/x/a.ts' },
  toolResponse: { stdoutBytes: 4096 },
  history: r.history, now: now + 3000, config: cfg,
});
assert.equal(r.history.reads['D:/x/a.ts'].ranges, 0, '全量读重置序列');

// 清零后重新累计到 2 段才再提示(窗口已过)
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Read',
  toolInput: { file_path: 'D:/x/a.ts', offset: 1, limit: 50 },
  toolResponse: { stdoutBytes: 4096 },
  history: r.history, now: now + 4000, config: cfg,
});
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Read',
  toolInput: { file_path: 'D:/x/a.ts', offset: 51, limit: 50 },
  toolResponse: { stdoutBytes: 4096 },
  history: r.history, now: now + 5000, config: cfg,
});
assert.match(r.context, /连续区间读 2 段/);

// Bash 大输出:提示;小输出不提示
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Bash',
  toolInput: { command: 'grep -r foo .' },
  toolResponse: { stdoutBytes: 64 * 1024 },
  history: {}, now, config: cfg,
});
assert.match(r.context, /64 KB/);
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Bash',
  toolInput: { command: 'echo hi' },
  toolResponse: { stdoutBytes: 3 },
  history: {}, now, config: cfg,
});
assert.equal(r.context, undefined);

// Bash 限频:窗口内第二次大输出不再提示
const h2 = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Bash',
  toolInput: { command: 'x' }, toolResponse: { stdoutBytes: 64 * 1024 },
  history: {}, now, config: cfg,
}).history;
r = evaluateNudge({
  hookEventName: 'PostToolUse', toolName: 'Bash',
  toolInput: { command: 'y' }, toolResponse: { stdoutBytes: 64 * 1024 },
  history: h2, now: now + 1000, config: cfg,
});
assert.equal(r.context, undefined, 'Bash 提示窗口内不重复');

// 失败导航:首失败提示,5 分钟内不重复
r = evaluateNudge({ hookEventName: 'PostToolUseFailure', toolName: 'Read', toolInput: { file_path: 'D:/gone.ts' }, toolResponse: {}, history: {}, now, config: cfg });
assert.match(r.context, /search\.mjs/);
r = evaluateNudge({ hookEventName: 'PostToolUseFailure', toolName: 'Read', toolInput: { file_path: 'D:/gone2.ts' }, toolResponse: {}, history: r.history, now: now + 1000, config: cfg });
assert.equal(r.context, undefined, '失败提示 5 分钟内不重复');

// 开关
r = evaluateNudge({ hookEventName: 'PostToolUse', toolName: 'Read', toolInput: { file_path: 'D:/x/a.ts', offset: 1, limit: 1 }, toolResponse: { stdoutBytes: 4096 }, history: {}, now, config: { ...cfg, enabled: false } });
assert.equal(r.context, undefined);
assert.equal(r.accountTokens, undefined, '关闭时不记账');

// runReadNudge:Cursor 载荷(tool_output 字符串、toolInput 对象、字节量未知)→ 导航文案省略 KB 段
{
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-nudge-'));
  const sid = 'cursor-style';
  const payload = (offset) => JSON.stringify({
    hookEventName: 'postToolUse', conversation_id: sid,
    tool_name: 'Read', tool_input: { path: 'D:/x/c.ts', offset, limit: 100 },
    tool_output: 'x'.repeat(5000),
  });
  const first = await runReadNudge({ stdinText: payload(1), stateDir, account: false });
  assert.equal(first.additionalContext, undefined, 'Cursor 首段不提示');
  const second = await runReadNudge({ stdinText: payload(101), stateDir, account: false });
  assert.match(second.additionalContext, /连续区间读 2 段/);
  assert.match(second.additionalContext, /约 \d+ KB/, 'tool_output 字符串可算出字节量');
  // 会话归属:按 conversation_id 分文件,不同会话互不干扰
  assert.ok(fs.existsSync(path.join(stateDir, `${sid}.reads.json`)), '按 conversation_id 落状态');
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// Cursor 的事件名是小写驼峰 postToolUseFailure,失败导航要认
{
  const r2 = evaluateNudge({
    hookEventName: 'postToolUseFailure', toolName: 'Read',
    toolInput: { path: 'D:/gone.ts' }, toolResponse: {},
    history: {}, now, config: cfg,
  });
  assert.match(r2.context, /search\.mjs/, 'Cursor 小写事件名也要触发失败导航');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-nudge2-'));
  const out = await runReadNudge({
    stdinText: JSON.stringify({ hookEventName: 'postToolUseFailure', conversation_id: 'cid-fail', tool_name: 'Read', tool_input: { path: 'D:/gone.ts' }, tool_output: 'err' }),
    stateDir, account: false,
  });
  assert.match(out.additionalContext, /search\.mjs/, 'Cursor 失败导航端到端');
  fs.rmSync(stateDir, { recursive: true, force: true });
}

// hook 改写注入的区间读(hookRewrites 标记):只记账、不进连续读计数,标记一次性消费
{
  const mk = 'D:/y/b.ts';
  let hh = { hookRewrites: { [mk]: now } };
  let rr = evaluateNudge({
    hookEventName: 'PostToolUse', toolName: 'Read',
    toolInput: { file_path: mk, offset: 1, limit: 99 },
    toolResponse: { stdoutBytes: 4533 },
    history: hh, now, config: cfg,
  });
  assert.equal(rr.context, undefined, '钩子注入读不触发提示');
  assert.equal(rr.accountTokens, 1134, '字节照常记账');
  assert.equal(rr.history.reads[mk].ranges, 0, '不进连续读计数');
  assert.equal(rr.history.hookRewrites[mk], undefined, '标记已消费');

  // agent 随后的真实区间读:从 1 起算,到 2 段才提示(钩子那次不再叠加)
  rr = evaluateNudge({
    hookEventName: 'PostToolUse', toolName: 'Read',
    toolInput: { file_path: mk, offset: 392, limit: 60 },
    toolResponse: { stdoutBytes: 4096 },
    history: rr.history, now: now + 1000, config: cfg,
  });
  assert.equal(rr.context, undefined, 'agent 第一段(计数 1)不提示');
  rr = evaluateNudge({
    hookEventName: 'PostToolUse', toolName: 'Read',
    toolInput: { file_path: mk, offset: 500, limit: 60 },
    toolResponse: { stdoutBytes: 4096 },
    history: rr.history, now: now + 2000, config: cfg,
  });
  assert.match(rr.context, /连续区间读 2 段/, '真实两段才提示');

  // 过期标记:顺手清除,按正常区间读计
  hh = { hookRewrites: { [mk]: now - 10 * 60 * 1000 }, reads: {} };
  rr = evaluateNudge({
    hookEventName: 'PostToolUse', toolName: 'Read',
    toolInput: { file_path: mk, offset: 1, limit: 10 },
    toolResponse: { stdoutBytes: 400 },
    history: hh, now, config: cfg,
  });
  assert.equal(rr.history.reads[mk].ranges, 1, '过期标记不抑制');
  assert.equal(rr.history.hookRewrites[mk], undefined, '过期标记已清');
}

console.log('ok');
