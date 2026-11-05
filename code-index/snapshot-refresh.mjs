#!/usr/bin/env node
/**
 * snapshot-refresh.mjs — 会话/每轮钩子守卫:把宿主供应商配置(ZCode provider_config + Qoder settings.json)
 * 同步进代理上游快照,并顺带保鲜两端的虚拟 auto 条目。
 *
 * 背景:代理(modelRouteProxy.mjs)每请求读 data/routing/proxy-upstreams.json 做"模型→供应商"库存与转发解析,
 * 但该快照原先只在手动跑 `node modelRouteProxy.mjs --snapshot-upstreams` 时重抓;用户改完 provider_config
 * 若不重跑,新模型不在库存 → 路由链匹配不到、请求落兜底。本脚本由 SessionStart hook 自动执行,等价于重跑该命令,
 * 但加了防呆:临时文件写入 + 校验 + 同目录原子替换,任何异常保留旧快照,绝不把库存清零带崩代理。
 *
 * 幂等:变更判定取 max(provider_config mtime, Qoder settings.json mtime);两者都不晚于
 * 快照 snapshottedAt 时直接跳过,不产生写盘。(此前只看 provider_config ⇒ 只改 Qoder 端
 * settings.json 永不触发重抓,qoder: 上游出池,Qoder 请求空池路由。)
 * 虚拟条目保鲜:配置变更后同时刷新 tokenSaverModel 与 Qoder tokensaver-auto 条目(auto 档位制下清单恒为
 * ["auto"],此处只对账 baseUrl 与陈旧镜像形态,把残留收敛回 auto 档;与快照同源同时机)。
 * 挂载:SessionStart(每次新会话/恢复)+ UserPromptSubmit(每轮消息,mtime 快路径零开销,
 *      解决"会话中途改模型清单"场景)。stdout 恒 {}——本脚本只做同步,永不注入上下文。
 * 出口:始终以退出码 0 结束(hook 失败不该阻断会话),刷新与失败原因写进同目录 snapshot-refresh.log。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { snapshotUpstreams } from './modelRouteProxy.mjs';
import { ensureVirtualProviderEntry } from './virtualProvider.mjs';

const PC_FILE = path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
// Qoder 双目录 settings.json 同受守卫监视(路径口径与 virtualProvider 一致:.qoder-cn 优先)
const QODER_SETTINGS = ['.qoder-cn', '.qoder'].map((d) => path.join(os.homedir(), d, 'settings.json'));
const SNAP_FILE = path.join(DATA_DIR, 'routing', 'proxy-upstreams.json');
const TMP_FILE = SNAP_FILE + '.' + process.pid + '.tmp'; // pid 命名:UserPromptSubmit 每轮跑,防两会话同轮并发互踩
const LOG_FILE = path.join(path.dirname(SNAP_FILE), 'snapshot-refresh.log');

function log(line) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); } catch { /* 日志失败不影响主流程 */ }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/** 文件 mtime(毫秒);不存在/不可 stat 计 0(= 无变更信号)。 */
function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 变更守卫看两边:ZCode provider_config 与 Qoder settings.json 取较新者。 */
function configMtimeMs() {
  return Math.max(mtimeMs(PC_FILE), ...QODER_SETTINGS.map(mtimeMs));
}

function main() {
  const snap = readJson(SNAP_FILE);
  const cfgMtimeMs = configMtimeMs();
  // 无变化快路径:快照已晚于(或等于)两侧配置里较新的修改时间。此路径每轮都会被
  // UserPromptSubmit 触发,必须完全静默(零日志零写盘),只留变更与失败留痕。
  if (snap && snap.snapshottedAt >= cfgMtimeMs) return;
  // 先备份旧快照到临时文件:snapshotUpstreams 的 ingress 继承逻辑读的就是 outFile,
  // 直接写临时路径会让"baseUrl 已指向代理"的入口供应商丢失真实上游继承。
  // 首装(无快照)时跳过备份:snapshotUpstreams 读到空 old 会全量重抓,不能再把这里抛穿。
  fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true });
  if (fs.existsSync(SNAP_FILE)) fs.copyFileSync(SNAP_FILE, TMP_FILE);
  const r = snapshotUpstreams({ outFile: TMP_FILE });
  const next = readJson(TMP_FILE);
  const nextProviders = Object.keys(next?.providers || {}).length;
  if (!next || nextProviders === 0) throw new Error(`新快照供应商为空(config=${r.providers} 条规则),保留旧快照`);
  fs.renameSync(TMP_FILE, SNAP_FILE); // 同盘原子替换
  // 密钥副本清理:快照里存的是真实上游 apiKey,历史 .bak 等于把密钥再多抄一份到磁盘且永不过期
  try {
    const dir = path.dirname(SNAP_FILE);
    const base = path.basename(SNAP_FILE);
    let pruned = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(base + '.bak')) continue;
      try { fs.rmSync(path.join(dir, f), { force: true }); pruned += 1; } catch { /* 删不掉就算了 */ }
    }
    if (pruned) log(`pruned ${pruned} 个含密钥的快照备份`);
  } catch { /* 目录读不到不影响刷新 */ }
  log(`refreshed: providers=${r.providers} ingress=[${(r.ingress || []).join(',')}] snapshottedAt=${new Date(next.snapshottedAt).toLocaleString()}`);
  // 虚拟条目保鲜(2026-11-02 auto 档位制):宿主选器里只有 auto 一个档位,baseUrl/形态变更时在这里对账收敛,
  // 真实模型清单继续由快照(providers)维护。
  try {
    const vp = ensureVirtualProviderEntry();
    if (vp.refreshed) log(`virtual-provider synced: ${vp.note}`);
  } catch (e) { log(`virtual-provider sync FAILED: ${e && e.message || e}`); }
  // Qoder 虚拟条目同源同步(2026-11-04 双端隔离:baseUrl 切宿主专属前缀 /apps/qoder 也在这里自动对齐)
  try {
    const vq = ensureVirtualProviderEntry({ qoder: true, providerId: 'tokensaver-auto', baseUrl: 'http://127.0.0.1:8117/apps/qoder' });
    if (vq.refreshed) log(`qoder virtual-provider synced: ${vq.note}`);
  } catch (e) { log(`qoder virtual-provider sync FAILED: ${e && e.message || e}`); }
}

try { main(); } catch (e) { log(`FAILED: ${e && e.message || e}`); } finally {
  try { fs.rmSync(TMP_FILE, { force: true }); } catch { /* 已替换或本就不在 */ }
  // UserPromptSubmit 宿主契约:输出 {additionalContext} 对象或不输出有效内容。本脚本永不注入,恒回 {}。
  try { process.stdout.write('{}\n'); } catch { /* stdout 不可写也无妨 */ }
}
