/**
 * 每条用户消息触发一次。钩子进程立刻退出,签名检查放到分离的 --check。
 * 整文件 md5 要数秒,Cursor beforeSubmitPrompt 超时 10s,算完再拉起 auto 会被杀掉。
 *   向量与块清单一致 → --check 静默退出
 *   不一致且无嵌入进程 → 分离后台拉起 auto.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, DATA_DIR } from './config.mjs';
import { vectorStoreNeedsEmbed, wantEmbedModel } from './vectorStore.mjs';
import { pidAlive, spawnLogged, LOCK_TTL_MS } from './proc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const self = fileURLToPath(import.meta.url);
const autoAbs = path.resolve(here, 'auto.mjs');

if (!process.argv.includes('--check')) {
  const child = spawn(process.execPath, [self, '--check'], {
    cwd: here,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  process.stdout.write('{}\n');
  process.exit(0);
}

function embedRunning() {
  try {
    const { pid, ts } = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '.embed.pid'), 'utf8'));
    if (!pidAlive(pid)) return false;
    return Number.isFinite(ts) && Date.now() - ts < LOCK_TTL_MS;
  } catch { return false; }
}

try {
  const { backend: wantBackend, model: wantModel } = wantEmbedModel(loadConfig());
  const check = vectorStoreNeedsEmbed(wantBackend, wantModel);
  if (!check.need || embedRunning()) process.exit(0);
  spawnLogged(autoAbs, path.join(DATA_DIR, 'auto.log'), here);
} catch { /* 不阻断已经返回的钩子 */ }
process.exit(0);
