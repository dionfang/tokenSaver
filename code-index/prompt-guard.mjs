/**
 * ZCode UserPromptSubmit hook:同一会话内检测"嵌入模型变更"并自动切换。
 * 每条用户消息触发一次(开销:读两个小文件+字符串比较,约 1ms):
 *   config 嵌入模型 = 索引记录的模型 → 静默退出(无需处理)
 *   不一致           → 分离后台拉起 auto.mjs(模型变更检测→跳过build→后台重嵌),
 *                      并注入 additionalContext 告知 agent"重嵌中/已完成"。
 * stdout 输出严格 JSON(仅 additionalContext);解析失败/无变更一律静默 exit 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR } from './config.mjs';
import { activeBackend, vectorStoreNeedsEmbed } from './vectorStore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const autoAbs = path.resolve(here, 'auto.mjs');

function embedRunning() {
  try {
    const { pid, ts } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.embed.pid'), 'utf8'));
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); } catch (e) { return e?.code === 'EPERM'; }
    return Number.isFinite(ts) && Date.now() - ts < 6 * 60 * 60 * 1000; // PID 重用防护
  } catch { return false; }
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  try {
    JSON.parse(input || '{}'); // 仅校验格式;prompt 内容与本检测无关
    const cfg = loadConfig();
    const wantBackend = activeBackend();
    const wantModel = wantBackend === 'local' ? cfg.models.localEmbedding : cfg.models.embedding;
    const check = vectorStoreNeedsEmbed(wantBackend, wantModel);
    if (!check.need) process.exit(0);
    const from = check.meta?.model ? `${check.meta.backend || wantBackend}/${check.meta.model}` : '无向量';
    const to = `${wantBackend}/${wantModel}`;
    const sameModel = check.meta?.model === wantModel;

    // 有变更:embed 运行中 → 只播报;否则分离后台拉起 auto(锁/单实例守卫防重)
    let note;
    if (embedRunning()) {
      note = sameModel
        ? `[code-index] 当前路径向量与块清单不一致,后台增量重嵌进行中;期间检索 bm25 兜底。`
        : `[code-index] 嵌入路径变更(${from} → ${to})后台增量更新当前目录,另一路径的向量保留;期间检索 bm25 兜底。`;
    } else {
      const logFd = fs.openSync(path.join(DATA_DIR, 'auto.log'), 'a');
      const child = spawn(process.execPath, [autoAbs], {
        cwd: here, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      });
      child.unref();
      fs.closeSync(logFd);
      note = sameModel
        ? `[code-index] 当前路径向量与块清单不一致,已后台增量重嵌;期间检索 bm25 兜底。`
        : `[code-index] 检测到嵌入路径变更(${from} → ${to}),已后台增量更新当前目录(另一路径的向量保留);期间检索 bm25 兜底。`;
    }
    process.stdout.write(JSON.stringify({
      additionalContext: `${note} 请在本回复末尾转达(⚙ 本地模型切换中)。`,
    }));
  } catch { /* 任何异常静默退出,不阻塞用户消息 */ }
  process.exit(0);
});
