#!/usr/bin/env node
/**
 * Memorix 跨会话记忆状态判定(B2,2026-11-25;托盘状态面板接入点,照 hooksStatus.mjs 契约)。
 *   node memorixStatus.mjs [--home <dir>] [--project <root>]   # stdout JSON;exit 恒 0(只读,托盘解析 stdout)
 *
 * 采集:spawn memorix CLI `status --json` + `doctor --json`(只取 stdout,日志走 stderr;
 *   extractMemorixJson 防御性提取,B1 已实测闭环)。归一成面板灯契约:
 *   { installed, cliPath, embedding:{state,provider,dimensions}, observations:{total,active},
 *     data:{backend,healthy}, codeMemory:{files,symbols,edges,freshness,state}, maintenance:{pending,failed,state},
 *     conflicts:{found,state}, issues:[], mcp:{registered}, version }
 * 灯口径(照 hooksLamps):拿不到结果/未安装=absent 不判红;装了但嵌入 off=yellow(功能降级非故障)。
 * 纯函数 normalizeMemorixStatus 导出供单测(假 JSON 注入,不 spawn 真 CLI)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractMemorixJson } from './init.mjs';
import { resolveMemorixPathCli } from './memorix-hook.mjs'; // PATH 兜底单源(转发器与托盘同一实现;本文件不被 hook 反向 import,无环)

const here = path.dirname(fileURLToPath(import.meta.url));

/** 解析 memorix CLI 入口:packed resources(装机态)→ staged(开发态)→ 本地 node_modules
 *  (CLI 安装态,2026-11-25 本地化:不占全局 npm)→ PATH 兜底(存量全局安装兼容)。
 *  返回 {command, args, source} 或 null(未安装)。纯路径探测,不执行。 */
export function resolveMemorixCli({ resourcesPath = null, home = os.homedir(), moduleDir = here, platform = process.platform, probeFn = null, stagedEntry = null } = {}) {
  // 20261125 修复(0.2.26 测试机全灰):poller spawn 本微 CLI 不带 --resources,装机态 resourcesPath=null
  // 会跳过 packed 探测(staged 路径拼 ../tray 在装机目录永不存在、测试机 PATH 无 memorix)→ 恒 absent。
  // packed 布局下本文件恒在 resources/node_modules/code-index/,据模块目录后缀自推 resources 根
  // (单源,免调用方接线;moduleDir 注入供单测模拟装机布局)。
  if (!resourcesPath) {
    const parent = path.dirname(moduleDir);
    if (path.basename(moduleDir) === 'code-index' && path.basename(parent) === 'node_modules') resourcesPath = path.dirname(parent);
  }
  // packed 布局:resources/node_modules/memorix/dist/cli/index.js(electron-builder extraResources)
  if (resourcesPath) {
    const packed = path.join(resourcesPath, 'node_modules', 'memorix', 'dist', 'cli', 'index.js');
    if (fs.existsSync(packed)) return { command: process.execPath, args: [packed], source: 'packed' };
  }
  // 开发态:本仓 tray/build/memorix-staged(staging 产物)。stagedEntry 注入供单测(否则开发机恒命中,走不到 PATH 分支)
  const staged = stagedEntry || path.join(here, '..', 'tray', 'build', 'memorix-staged', 'node_modules', 'memorix', 'dist', 'cli', 'index.js');
  if (fs.existsSync(staged)) return { command: process.execPath, args: [staged], source: 'staged' };
  // CLI 本地安装态:code-index/vendor/memorix(init installMemorixLocal 隔离区产物)
  const local = path.join(moduleDir, 'vendor', 'memorix', 'node_modules', 'memorix', 'dist', 'cli', 'index.js');
  if (fs.existsSync(local)) return { command: process.execPath, args: [local], source: 'local' };
  // PATH 上的 memorix(存量全局安装兼容,最后一跳)。2026-11-26 与转发器同病修复:
  // 此前直接返回命令名,Windows 上 spawn .cmd 不带 shell 报 EINVAL、裸 memorix 报 ENOENT(实测 Node 22.19)
  // → 托盘记忆灯恒灰。现收敛到 memorix-hook 的 resolveMemorixPathCli 单源(该处解析真实 JS 入口;
  // memorix-hook 不反向 import 本文件,无环),这里只补 source 标签。解析不出 → null(未安装)。
  const viaPath = resolveMemorixPathCli({ platform, probe: probeFn || null });
  return viaPath ? { ...viaPath, source: 'path' } : null;
}

/** 读 ~/.memorix/config.toml [embedding] 的 base_url/model(极简解析,只认本工具生成的平铺键)。
 *  读不到返回 null(探活跳过,灯回落 doctor 口径)。 */
export function memorixEmbeddingEndpoint({ home = os.homedir() } = {}) {
  try {
    const text = fs.readFileSync(path.join(home, '.memorix', 'config.toml'), 'utf8');
    const lines = text.split('\n');
    const s = lines.findIndex((l) => l.trim() === '[embedding]');
    if (s < 0) return null;
    let baseUrl = null, model = null;
    for (let i = s + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) break;
      const m = /^\s*(base_url|model)\s*=\s*"([^"]*)"/.exec(lines[i]);
      if (m?.[1] === 'base_url') baseUrl = m[2];
      if (m?.[1] === 'model') model = m[2];
    }
    return baseUrl ? { baseUrl, model } : null;
  } catch { return null; }
}

/** 端点真探活(2026-11-25 审查修复):doctor/status 的 ready 可由维度缓存判出(loadCachedDims 命中即建 provider,
 *  不发网络请求),端点死了灯仍绿=假绿。这里对 base_url 发一次真实 /embeddings 微请求兜底。
 *  2026-11-25 二修(自咬循环):4s 超时 × 冷加载窗口(加载+排队可达 4s+)必撞 → 499 断开 → Ollama 记
 *  "llm server error"+aborting load → 探针自己制造加载中止(实测 22:50:51 4.12s 499 即此因)。改为:
 *  ①超时 4s→12s(覆盖冷加载排队;探活低频,不抢时不敏感);②fail-open 分级——超时/断开返回 null(探针
 *  未能完成判定),不返回 false,仅明确 HTTP 响应(4xx/5xx)才判 false。灯口径: null=未知(不吃缓存翻红),
 *  false=确证不可达才红。
 *  返回 true/false/null;探活函数可注入供单测。 */
export async function probeMemorixEndpoint({ home = os.homedir(), timeoutMs = 12_000, fetchFn = fetch } = {}) {
  const ep = memorixEmbeddingEndpoint({ home });
  if (!ep) return null; // 无配置=不探(灯回落 doctor 口径)
  try {
    const r = await fetchFn(`${ep.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer none' },
      body: JSON.stringify({ model: ep.model || 'probe', input: 'probe' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.ok;
  } catch (e) {
    // 超时/连接被拒=探测未完成(极可能撞冷加载窗口),不判死;其余网络错也不判死(端点死由 HTTP 码确证)
    return null;
  }
}

/** 归一 memorix status+doctor JSON → 面板灯契约(纯函数,单测注入假 JSON)。
 *  status/doctor 任一缺失按可得字段降级;全缺=installed:false。
 *  endpointUp(可选,true/false/null):端点真探活结果;false 时嵌入灯强制 red(维度缓存假绿防线)。 */
export function normalizeMemorixStatus({ status = null, doctor = null, cli = null, mcpRegistered = false, endpointUp = null } = {}) {
  const installed = !!(cli && (status || doctor));
  if (!installed) {
    return { installed: false, cliPath: cli ? `${cli.command} ${cli.args.join(' ')}`.trim() : null, mcp: { registered: mcpRegistered }, state: 'absent' };
  }
  // 嵌入后端:doctor.embedding.status 优先(ready/off/error),回落 status.search.embedding
  const emb = doctor?.embedding || status?.search?.embedding || {};
  const embMode = String(emb.mode || status?.search?.embedding?.mode || 'off');
  const embReady = emb.status === 'ready' || emb.available === true;
  const embedding = {
    provider: emb.provider || status?.search?.embedding?.provider || null,
    dimensions: emb.dimensions ?? status?.search?.embedding?.dimensions ?? null,
    // 灯:ready=green / off(降级 BM25)=yellow / 其余(error/探测失败)=red;
    // 真探活一票否决维度缓存假绿;endpointUp 分级(2026-11-25 二修):false=确证不可达才红,
    // null=探测未完成(超时/断连=极可能撞冷加载窗口)不动 doctor 判定——探针不该把自己撞窗口记成故障
    state: endpointUp === false ? 'red' : (embReady ? 'green' : (embMode === 'off' ? 'yellow' : 'red')),
    mode: embMode,
    endpointUp,
  };
  const obs = status?.observations || doctor?.data || {};
  const observations = { total: obs.total ?? obs.observations ?? 0, active: obs.active ?? 0 };
  // 数据后端:doctor.data.backend;issues 里有 data 类问题=不健康
  const issues = Array.isArray(doctor?.issues) ? doctor.issues : [];
  const dataBackend = doctor?.data?.backend || 'unknown';
  const dataHealthy = !issues.some((i) => /data|sqlite|store|backend/i.test(JSON.stringify(i)));
  const data = { backend: dataBackend, healthy: dataHealthy, state: dataHealthy ? 'green' : 'red' };
  // 代码记忆图谱(2026-11-26 用户裁定:取消该状态灯,改为文字信息)
  // 理由:freshness(stale/suspect)是「内容新鲜度」而非运行状态——代码一改,旧符号必然不再被索引,
  // stale>0 是恒真条件,当灯看只会误导(用户明确「不能准确反映 Memorix 运行状态」)。故:
  //   ①stale/suspect 不再产生灯、也不再进总灯,只透传数字供面板写一行文字;
  //   ②parserErrors>0 是**真故障**(语义解析失败 → 注入的上下文不完整),不能跟着灯一起丢掉,
  //     单列 parserErrorState 供面板以红字提示,并单独拉红总灯。
  const cm = doctor?.codeMemory || {};
  const fr = cm.freshness || {};
  const parserErrors = cm.parserErrors ?? 0;
  const codeMemory = {
    files: cm.files ?? 0, symbols: cm.symbols ?? 0, edges: cm.edges ?? 0,
    freshness: fr, parserErrors,
    affectsOverall: false, // 显式声明:新鲜度不参与健康聚合(供面板/单测断言,防后人又接回总灯)
    parserErrorState: parserErrors > 0 ? 'red' : 'green',
  };
  // 维护任务:doctor.lifecycle.maintenance.summary + failedJobs[]
  // 灯口径(2026-11-26 用户令修复,与 codeMemory stale 同理):上游对非 vector-backfill 的失败任务**没有重跑入口**
  // (enqueue 里只有 vector-backfill 有 failed→pending 复活分支),失败记录按 DEFAULT_FAILED_HISTORY_RETENTION_MS
  // 保留 30 天 → 任何一次瞬时失败(如人工并发写库撞 database is locked)都会让红灯常亮 30 天,而后继刷新早已成功。
  // 故按「失败是否新鲜」判:24h 内有失败=red(真在出问题);更早的失败=red→yellow(未处置的历史残留,值得看一眼但不阻断);
  // 无失败=green。failedJobs 缺失(老版本 CLI)时回落有失败即 red,不放宽。
  const maint = doctor?.lifecycle?.maintenance?.summary || {};
  const failedJobs = Array.isArray(doctor?.lifecycle?.maintenance?.failedJobs) ? doctor.lifecycle.maintenance.failedJobs : null;
  const FRESH_FAILURE_MS = 24 * 60 * 60 * 1000;
  let maintState = 'green';
  if ((maint.failed ?? 0) > 0) {
    const times = failedJobs ? failedJobs.map((j) => Number(j?.updatedAt)).filter(Number.isFinite) : [];
    const fresh = times.some((t) => Number.isFinite(t) && Date.now() - t <= FRESH_FAILURE_MS);
    maintState = !failedJobs ? 'red' : (fresh ? 'red' : 'yellow');
  }
  const maintenance = { pending: maint.pending ?? 0, failed: maint.failed ?? 0, completed: maint.completed ?? 0, state: maintState, ...failedJobs?.length ? { failedJobs: failedJobs.slice(0, 5) } : {} };
  // 冲突
  const conflictsFound = doctor?.conflicts?.found === true || (Array.isArray(status?.rules?.conflicts) && status.rules.conflicts.length > 0);
  const conflicts = { found: conflictsFound, state: conflictsFound ? 'red' : 'green' };
  const version = doctor?.autoUpdate?.currentVersion || null;
  // 总灯:任一红=red;黄=yellow;全绿=green。2026-11-26 起 freshness 不进聚合(见 codeMemory 注释),
  // 但 parserErrors 作为真故障单列进聚合。
  const parts = [embedding.state, data.state, codeMemory.parserErrorState, maintenance.state, conflicts.state];
  const state = parts.includes('red') ? 'red' : (parts.includes('yellow') ? 'yellow' : 'green');
  return {
    installed: true, cliPath: `${cli.command} ${cli.args.join(' ')}`.trim(), source: cli.source,
    embedding, observations, data, codeMemory, maintenance, conflicts,
    issues: issues.slice(0, 10), mcp: { registered: mcpRegistered }, version, state,
  };
}

/** 判 Memorix MCP 是否在位(只读,三宿主):ZCode mcp.servers.memorix、Qoder mcpServers.memorix
 *  (CN ~/.qoder-cn / 国际 ~/.qoder)或 Cursor ~/.cursor/mcp.json 的 mcpServers.memorix,
 *  任一在位即算注册——面板单灯口径,不按宿主细分。 */
export function memorixMcpRegistered({ home = os.homedir() } = {}) {
  const per = memorixMcpPerHost({ home });
  return per.zcode || per.qoder || per.cursor;
}

/** per-host MCP 在位判定(阶段C 面板「工具接入状态」用):各宿主独立判,供 per-tool 记忆灯。 */
export function memorixMcpPerHost({ home = os.homedir() } = {}) {
  const out = { zcode: false, qoder: false, cursor: false };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    out.zcode = !!cfg?.mcp?.servers?.memorix;
  } catch { /* 宿主未装/非法 JSON */ }
  for (const dir of ['.qoder-cn', '.qoder']) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, dir, 'settings.json'), 'utf8'));
      if (cfg?.mcpServers?.memorix) { out.qoder = true; break; }
    } catch { /* 同上 */ }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
    out.cursor = !!cfg?.mcpServers?.memorix;
  } catch { /* 未配/非法 JSON */ }
  return out;
}

/** per-host 动态路由 auto 灯(阶段C,口径A 用户拍板):该 host 在 proxy-upstreams 快照里有路由供应商
 *  × 8117 代理可达。Cursor 无 auto 供应商→absent(它本就不走 auto 路由,如实反映)。
 *  返回 {zcode,qoder,cursor} 各 green/red/absent。纯读快照+TCP 探活,fail-open。 */
export function autoRoutePerHost({ dataDir = null, proxyPort = 8117, probeProxy = null } = {}) {
  const out = { zcode: 'absent', qoder: 'absent', cursor: 'absent' };
  let snap = null;
  try {
    const dir = dataDir || process.env.CODE_INDEX_DATA_DIR || path.join(os.homedir(), '.tokensaver', 'data');
    snap = JSON.parse(fs.readFileSync(path.join(dir, 'routing', 'proxy-upstreams.json'), 'utf8'));
  } catch { return out; /* 无快照=全 absent */ }
  const hostHas = { zcode: false, qoder: false, cursor: false };
  for (const p of Object.values(snap?.providers || {})) {
    if (p?.enabled === false || !p?.apiKey) continue;
    const h = p?.host;
    if (h === 'zcode' || h === 'qoder' || h === 'cursor') hostHas[h] = true;
  }
  // 代理可达性:注入 probeProxy 供单测;默认用 proxy.pid 判活(与 proxyKeepalive 同口径,pid 在且进程活≈可达)
  let proxyUp = false;
  if (typeof probeProxy === 'function') proxyUp = !!probeProxy(proxyPort);
  else {
    try {
      const dir = dataDir || process.env.CODE_INDEX_DATA_DIR || path.join(os.homedir(), '.tokensaver', 'data');
      const pj = JSON.parse(fs.readFileSync(path.join(dir, 'usage', 'proxy.pid'), 'utf8'));
      if (pj?.pid) { try { process.kill(pj.pid, 0); proxyUp = true; } catch { proxyUp = false; } }
    } catch { proxyUp = false; }
  }
  for (const h of ['zcode', 'qoder', 'cursor']) {
    out[h] = hostHas[h] ? (proxyUp ? 'green' : 'red') : 'absent';
  }
  return out;
}

/** 采集主流程:resolve CLI → spawn status/doctor --json(只取 stdout)→ 归一。fail-open。 */
export async function collectMemorixStatus({ home = os.homedir(), resourcesPath = null, project = process.cwd(), timeoutMs = 30_000, dataDir = null } = {}) {
  const cli = resolveMemorixCli({ resourcesPath, home });
  const mcpRegistered = memorixMcpRegistered({ home });
  // 阶段C:per-host 子项灯数据(面板「工具接入状态」用),与 memorix 安装与否无关,恒采集
  const mcpPerHost = memorixMcpPerHost({ home });
  const autoPerHost = autoRoutePerHost({ dataDir });
  // 端点真探活(维度缓存假绿防线):仅在 doctor 报 ready 时探(off/未装不浪费请求)
  const endpointUp = await probeMemorixEndpoint({ home });
  const extra = { mcpPerHost, autoPerHost };
  if (!cli) return { ...normalizeMemorixStatus({ cli: null, mcpRegistered }), ...extra };
  const run = (sub) => {
    try {
      // 跳过 memorix CLI 自重启 wrapper(与 memorix-hook.mjs 同源):托盘每分钟轮询这两个 spawn,
      // 实测 status 3992→2105ms、doctor 5238→3237ms,少一半的后台 CPU 占用
      const r = spawnSync(cli.command, [...cli.args, sub, '--json', '--cwd', project], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, cwd: project, env: { ...process.env, __MEMORIX_HEAP: '1' } });
      return extractMemorixJson(r.stdout); // 只取 stdout;日志在 stderr,extractMemorixJson 防御兜底
    } catch { return null; }
  };
  const status = run('status');
  const doctor = run('doctor');
  return { ...normalizeMemorixStatus({ status, doctor, cli, mcpRegistered, endpointUp }), ...extra };
}

// ---------- CLI 入口 ----------
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const out = await collectMemorixStatus({ home: opt('--home', os.homedir()), project: opt('--project', process.cwd()), resourcesPath: opt('--resources', null) });
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0); // 恒 0(只读,托盘解析 stdout)
}
