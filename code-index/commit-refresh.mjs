/**
 * 提交后保鲜:ZCode/Qoder PostToolUse(matcher Bash);Cursor postToolUse 另用一条字面 matcher Bash
 * (Cursor 会把 Bash 映射成 Shell)。agent 执行 git commit 后自动拉起 auto.mjs。
 * 输入:stdin 的 JSON { tool_input: { command } } 或顶层 command。
 * 行为:仅当命令包含 git commit 时,分离后台启动 auto.mjs(detached,不阻塞 agent);
 *       auto 自带 PID 锁 + HEAD 比对,重复触发零成本。
 *       子进程的输出写入 data/auto.log,不占用本钩子的 stderr(钩子退出会关掉它)。
 *       直跑时 stdout 保持空;Cursor 转发器自己回 {}。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';
import { spawnLogged } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const autoAbs = path.resolve(here, 'auto.mjs');

const COMMIT_RE = /(^|\s|["'])git(\.exe)?\s+(-[^-]+\s+)*commit\b/;

/** 解析钩子 stdin。不是 git commit 返回 false,不启动 auto。 */
export function runCommitRefresh(raw) {
  let cmd = '';
  try {
    const parsed = JSON.parse(String(raw || '').replace(/^\uFEFF/, '') || '{}');
    cmd = String(parsed.tool_input?.command ?? parsed.command ?? '');
  } catch { return false; }
  // 只认真正的提交动作(排除 git log --grep=commit 之类的误报)
  if (!COMMIT_RE.test(cmd)) return false;
  const child = spawnLogged(autoAbs, path.join(DATA_DIR, 'auto.log'), path.dirname(here));
  child.on('error', (err) => console.error('[commit-refresh] 启动失败:', err.message));
  console.error(`[commit-refresh] 检测到提交,已后台拉起 auto.mjs(pid ${child.pid})做索引保鲜+模型预热`);
  return true;
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try { runCommitRefresh(input); } catch { /* 解析失败静默退出,不阻塞 agent */ }
    process.exit(0);
  });
}
