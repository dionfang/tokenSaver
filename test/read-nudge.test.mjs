#!/usr/bin/env node
/** read-nudge 纯函数测试:连续区间读导航、全量读清零、Bash 大输出、失败导航、限频、记账字节数。 启动:cd code-index && npm test(或 node ../test/read-nudge.test.mjs) */
import assert from 'node:assert/strict';
import { evaluateNudge } from '../code-index/read-nudge.mjs';

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

console.log('ok');
