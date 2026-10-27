/**
 * ZCode PostToolUse hook(matcher: Bash):agent 提交代码后自动拉起 auto.mjs(索引保鲜+模型预热)。
 * 输入:stdin 的 JSON { tool_name, tool_input: { command, ... } }
 * 行为:仅当命令包含 git commit 时,分离后台启动 auto.mjs(detached,不阻塞 agent);
 *       auto 自带 PID 锁 + HEAD 比对,重复触发零成本。
 *       子进程的输出写入 data/auto.log,不占用本钩子的 stderr(钩子退出会关掉它)。
 *       本进程 stdout 保持空(hook JSON 契约)。
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const autoAbs = path.resolve(here, 'auto.mjs');

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    const { tool_input } = JSON.parse(input || '{}');
    const cmd = String(tool_input?.command || '');
    // 只认真正的提交动作(排除 git log --grep=commit 之类的误报)
    if (!/(^|\s|["'])git(\.exe)?\s+(-[^-]+\s+)*commit\b/.test(cmd)) process.exit(0);
    const logFd = fs.openSync(path.join(DATA_DIR, 'auto.log'), 'a');
    try {
      const child = spawn(process.execPath, [autoAbs], {
        cwd: path.dirname(here),
        detached: true,
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      });
      child.on('error', (err) => console.error('[commit-refresh] 启动失败:', err.message));
      child.unref();
      console.error(`[commit-refresh] 检测到提交,已后台拉起 auto.mjs(pid ${child.pid})做索引保鲜+模型预热`);
    } finally {
      fs.closeSync(logFd);
    }
  } catch { /* 解析失败静默退出,不阻塞 agent */ }
  process.exit(0);
});
