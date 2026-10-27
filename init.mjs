#!/usr/bin/env node
/**
 * 新项目初始化。npm 安装后在仓库根执行:
 *   npx tokensaver init [--roots "D:/repoA,D:/repoB"] [--model-in ollama|local]
 * 复制目录部署则在模块目录运行:
 *   node init.mjs [--roots "D:/repoA,D:/repoB"] [--model-in ollama|local]
 *
 * --model-in 决定嵌入路径,写入 data/code-index.config.json 的 modelIn:
 *   local(新建配置时的默认) —— 常驻进程加载 models.localEmbedding 与 models.localReranker;常驻不在时当次进程内加载。不依赖 Ollama
 *   ollama —— 通过已运行的 Ollama 加载 models.embedding 与 models.reranker
 * 不传 --model-in 不改已有 modelIn。参数名写错、缺少取值、取值非法,或 --roots 为空:报错退出且不改配置。
 * 两条路径拉起失败时检索都降级 bm25,运行时不改换另一条路径。
 *
 * 做这些事:
 *   1) 写 code-index.config.json。没有该文件时新建(roots 缺省 = 向上找到的 git 根,modelIn 缺省 local)。
 *      已有文件保留其余键:传了 --roots 就覆盖 roots,否则按本机路径自愈;只有传了 --model-in 才写 modelIn。
 *   2) 安装依赖 npm install --ignore-scripts(必装,local 路径需要 transformers.js)
 *   3) **分离后台**启动 auto.mjs 建首版索引(build 内联其内 + embed 后台增量 + 预热;
 *      init 秒级返回不等待;进度看 data/auto.log 与 data/embed.log;期间检索 bm25 可用)
 *   4) 接线会话 hook:每个 git 仓库 root 的 .zcode/config.json 与 .cursor/hooks.json。
 *      每次运行都重写 code-index 自己的钩子与 Cursor 转发器;同文件里的其他钩子保留。
 *      JSON 解析失败则不改该文件。
 *   5) AGENTS.md:已有 code-index 标记则替换纪律段,没有则追加;文件不存在则新建。
 *      再追加或替换末尾的 Ponytail 段(<!-- ponytail -->),不改纪律段和其他原文。
 *      补 .gitignore(依赖、data、hf-cache、.zcode)。hf-cache 权重超过远程单文件限制,不入库。
 *      不存在 CODE_MAP.md 时写一份空模板,已有则不动。
 * 依赖安装与索引构建均不可跳过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DATA_DIR, HF_CACHE_DIR, PACKED_INSTALL, findGitRoot } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const INIT_USAGE = '可用参数: --roots "D:/a,D:/b"  --model-in ollama|local。等号写法(--roots=D:/a、--model-in=local)也认。';

/** 解析 init 参数。错误时返回 { error },不写配置。同一参数出现多次时后者生效。 */
export function parseInitArgs(argv) {
  const out = { roots: null, modelIn: null };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      unknown.push(token);
      continue;
    }
    let name = token;
    let value;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      name = token.slice(0, eq);
      value = token.slice(eq + 1);
    }
    if (name !== '--roots' && name !== '--model-in') {
      unknown.push(name);
      continue;
    }
    if (value === undefined) {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) return { error: `${name} 需要取值。${INIT_USAGE}` };
      value = next;
      i++;
    }
    if (!String(value).trim()) return { error: `${name} 需要取值。${INIT_USAGE}` };
    if (name === '--roots') out.roots = value;
    else out.modelIn = value;
  }
  if (unknown.length) return { error: `无法识别的参数: ${unknown.join(' ')}。${INIT_USAGE}` };
  if (out.modelIn && out.modelIn !== 'ollama' && out.modelIn !== 'local') {
    return { error: `--model-in 只能是 ollama 或 local,收到 ${out.modelIn}` };
  }
  if (out.roots != null && !out.roots.split(',').map(s => s.trim()).filter(Boolean).length) {
    return { error: `--roots 需要至少一个路径。${INIT_USAGE}` };
  }
  return out;
}
const log = (s) => console.log(s);
const ok = (s) => console.log(`  [ok] ${s}`);

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
const repoRoot = findGitRoot(process.cwd()) || findGitRoot(here);
if (directRun) {
if (!repoRoot) {
  console.error('[err] 未找到 git 仓库根(从本目录向上未发现 .git);请在目标项目内使用本模块');
  process.exit(1);
}
const parsedArgs = parseInitArgs(args);
if (parsedArgs.error) {
  console.error(`[err] ${parsedArgs.error}`);
  process.exit(1);
}
const rootsArg = parsedArgs.roots;
const modelInArg = parsedArgs.modelIn;
log(`\n[1/5] 生成配置`);
const configPath = path.join(DATA_DIR, 'code-index.config.json');
fs.mkdirSync(DATA_DIR, { recursive: true }); // 新项目首装:平行 data/ 目录尚不存在
const hostRoot = repoRoot.split(path.sep).join('/');
let roots;
if (rootsArg) {
  roots = rootsArg.split(',').map(s => s.trim()).filter(Boolean);
}
const configExisted = fs.existsSync(configPath);
const chosenBackend = modelInArg || 'local';
if (configExisted) {
  const cfgOld = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let dirty = false;
  if (rootsArg) {
    // 显式 --roots:重写 roots;--model-in 另写 modelIn。其余键保留。
    cfgOld.roots = roots;
    dirty = true;
    ok(`已存在,roots 已更新为 ${JSON.stringify(roots)}`);
  } else {
    // 无 --roots:对已有 roots 做"换机自愈"——
    // 存在的保留;缺失的按兄弟目录约定重建(宿主父目录 + 同名);宿主根确保在列
    const healed = [];
    for (const r of cfgOld.roots || []) {
      if (fs.existsSync(r)) { healed.push(r); continue; }
      const guess = path.join(path.dirname(repoRoot), path.basename(r)).split(path.sep).join('/');
      if (fs.existsSync(guess)) {
        healed.push(guess);
        ok(`root 自愈:${r} → ${guess}(兄弟目录约定)`);
      } else {
        console.error(`  [warn] root ${r} 在本机不存在且无法按兄弟目录定位,已剔除;如需指定请用 --roots`);
      }
    }
    if (!healed.includes(hostRoot)) healed.unshift(hostRoot);
    if (JSON.stringify(healed) !== JSON.stringify(cfgOld.roots || [])) {
      cfgOld.roots = healed;
      dirty = true;
      ok(`roots 已自愈为 ${JSON.stringify(healed)}`);
    } else {
      ok(`roots 已存在且全部有效,跳过(${configPath})`);
    }
    roots = healed;
  }
  if (modelInArg) {
    if (cfgOld.modelIn !== modelInArg) {
      cfgOld.modelIn = modelInArg;
      dirty = true;
      ok(`嵌入路径已设为 ${modelInArg}(${modelInArg === 'local' ? 'transformers.js,不依赖 Ollama' : 'Ollama'})`);
    } else {
      ok(`嵌入路径已是 ${modelInArg}`);
    }
  }
  if (dirty) fs.writeFileSync(configPath, JSON.stringify(cfgOld, null, 2));
} else {
  if (!Array.isArray(roots)) roots = [hostRoot]; // 无 --roots 时 roots 尚未赋值 → 宿主根(rootsArg 分支已提前 split,不会走到这)
  const desc = '项目配置。未写的键用 config.mjs 默认值。模型名、ollamaBase、gpu、OLLAMA_KEEP_ALIVE、OLLAMA_NUM_CTX 只写 config.mjs。roots: 默认 < 本文件 < CODE_INDEX_ROOTS < --roots。modelIn: --model-in > 本文件 > local。不传 --model-in 不改已有 modelIn。skipDirs 整表替换。';
  // 新项目部署:显式写出 skipDirs(内置默认 + 排除部署单元自身及其 hooks 转发器)
  const skipDirs = [...DEFAULT_CONFIG.skipDirs, 'code-index', '.cursor', '.zcode'];
  fs.writeFileSync(configPath, JSON.stringify({
    $说明: desc,
    roots,
    skipDirs,
    modelIn: chosenBackend,
    knownAnnotations: {},
  }, null, 2));
  ok(`已生成,roots = ${JSON.stringify(roots)},嵌入路径 = ${chosenBackend};skipDirs 含内置默认 + "code-index"(部署单元自身不入索引)`);
}
if (!configExisted || modelInArg) {
  if (chosenBackend === 'local') {
    console.error(`  [注意] 嵌入路径为 local:transformers.js 由常驻进程加载,不依赖 Ollama。常驻不在时当次进程内加载。首次使用下载到 hf-cache。`);
    console.error(`        嵌入 ${DEFAULT_CONFIG.models.localEmbedding}`);
    console.error(`        精排 ${DEFAULT_CONFIG.models.localReranker}(q8)`);
  } else {
    console.error('  [注意] 嵌入路径为 ollama。目标电脑需已安装 Ollama 客户端,并**手工** pull(本模块不自动拉取):');
    console.error(`        ollama pull ${DEFAULT_CONFIG.models.embedding}`);
    console.error(`        ollama pull ${DEFAULT_CONFIG.models.reranker}`);
  }
  console.error('        该路径拉起失败时检索降级 bm25,不自动改换另一条路径。');
}

log(`\n[2/5] 安装依赖`);
if (PACKED_INSTALL) {
  ok('npm 包已安装,跳过模块目录 npm install');
} else {
  const r = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: here, stdio: 'inherit', shell: true });
  if (r.status !== 0) console.error('  [warn] npm install 失败(可试 --registry=https://registry.npmmirror.com 后重跑)');
  else ok('依赖就绪');
}

log(`\n[3/5] 后台启动首版索引构建(不等待)`);
{
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const logFd = fs.openSync(path.join(DATA_DIR, 'auto.log'), 'a');
  const child = spawn(process.execPath, [path.join(here, 'auto.mjs')], {
    cwd: here,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  ok(`auto.mjs 已分离后台运行(pid ${child.pid}):build → 增量 embed → 预热;进度看 data/auto.log 与 data/embed.log`);
  console.error('  [note] 所选嵌入路径拉起失败时检索保持 bm25,不自动改换另一条路径。CPU 全量嵌入可达十几分钟(后台进行,不阻塞)');
}
}

/** 确保 .gitignore 含指定行(精确匹配,幂等);有新增时附一行注释标记 */
function ensureGitignore(root, entries) {
  const giPath = path.join(root, '.gitignore');
  let lines = [];
  try { lines = fs.readFileSync(giPath, 'utf8').split(/\r?\n/); } catch { /* 无文件,新建 */ }
  const have = new Set(lines.map(l => l.trim()));
  const missing = entries.map(e => e.startsWith('/') ? e : '/' + e).filter(e => !have.has(e));
  if (!missing.length) { ok(`[${path.basename(root)}] .gitignore 已覆盖所需条目`); return; }
  if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
  lines.push('# code-index(依赖、data 索引产物、hf-cache 权重、.zcode 不入库)');
  lines.push(...missing);
  fs.writeFileSync(giPath, lines.join('\n') + '\n');
  ok(`[${path.basename(root)}] .gitignore 已追加:${missing.join(', ')}`);
}

/** 只认本模块的脚本。项目里别的 auto.mjs / warm.mjs 不碰。 */
export function isCodeIndexHookRef(value) {
  const s = String(value || '').replace(/\\/g, '/');
  if (/(?:^|\/)(?:warm-code-index|output-savings)\.mjs$/.test(s)) return true;
  return /(?:^|\/)(?:code-index|tokensaver)\/(?:auto|commit-refresh|prompt-guard|warm|output-savings)\.mjs$/.test(s);
}

function cursorHookEntry(root, scriptName) {
  const hooksDir = path.join(root, '.cursor', 'hooks');
  const target = path.join(here, scriptName);
  const rel = path.relative(hooksDir, target);
  if (path.isAbsolute(rel)) return JSON.stringify(target.split(path.sep).join('/'));
  const relPosix = (rel || path.basename(target)).split(path.sep).join('/');
  return `path.resolve(here, ${JSON.stringify(relPosix)})`;
}

function cursorHookPrelude(root, scriptName) {
  const hooksDir = path.join(root, '.cursor', 'hooks');
  const rel = path.relative(hooksDir, path.join(here, scriptName));
  if (path.isAbsolute(rel)) return `import { spawn } from 'node:child_process'\n\n`;
  return `import { spawn } from 'node:child_process'\nimport path from 'node:path'\nimport { fileURLToPath } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
}

function cursorForwarderSource(root) {
  const body = `const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })\nchild.on('error', (err) => { console.error('[fail] 无法启动 code-index:', err.message); process.exit(0) })\nchild.on('exit', () => process.exit(0))\n`;
  return `/** Cursor sessionStart: 转发到当前 code-index 的 auto.mjs。stdout 保持空。 */\n${cursorHookPrelude(root, 'auto.mjs')}const entry = ${cursorHookEntry(root, 'auto.mjs')}\n${body}`;
}

function cursorOutputSavingsSource(root) {
  const body = `const child = spawn(process.execPath, [entry], { stdio: 'inherit', windowsHide: true })\nchild.on('error', () => process.exit(0))\nchild.on('exit', (code) => process.exit(code || 0))\n`;
  return `/** Cursor afterAgentResponse: 转发到 output-savings.mjs,沿用 stdin 里的 output_tokens。 */\n${cursorHookPrelude(root, 'output-savings.mjs')}const entry = ${cursorHookEntry(root, 'output-savings.mjs')}\n${body}`;
}

/** 每次重写本模块的 Cursor 钩子与转发器。同文件其他事件保留。JSON 坏了则只重写转发器。 */
export function rewriteCursorHooks(root) {
  const hooksJson = path.join(root, '.cursor', 'hooks.json');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  const forwarderPath = path.join(hooksDir, 'warm-code-index.mjs');
  const outputHookPath = path.join(hooksDir, 'output-savings.mjs');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(forwarderPath, cursorForwarderSource(root));
  fs.writeFileSync(outputHookPath, cursorOutputSavingsSource(root));
  const ours = { command: 'node .cursor/hooks/warm-code-index.mjs', timeout: 600 };
  const outputHook = { command: 'node .cursor/hooks/output-savings.mjs', timeout: 20 };
  let cfg = { version: 1, hooks: {} };
  if (fs.existsSync(hooksJson)) {
    try {
      cfg = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
    } catch (e) {
      console.error(`  [warn] [${path.basename(root)}] .cursor/hooks.json 解析失败,未改 JSON(${e.message});转发器已按当前模块重写`);
      return;
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = { version: 1, hooks: {} };
  if (cfg.version == null) cfg.version = 1;
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) cfg.hooks = {};
  for (const key of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[key])) continue;
    cfg.hooks[key] = cfg.hooks[key].filter(h => !isCodeIndexHookRef(h?.command));
  }
  cfg.hooks.sessionStart = [ours, ...(cfg.hooks.sessionStart || [])];
  cfg.hooks.afterAgentResponse = [outputHook, ...(cfg.hooks.afterAgentResponse || [])];
  fs.writeFileSync(hooksJson, JSON.stringify(cfg, null, 2) + '\n');
  ok(`[${path.basename(root)}] Cursor hooks 已按当前模块重写(其他钩子保留)`);
}

function zcodeProcess(script, timeoutMs, statusMessage) {
  return { type: 'process', command: 'node', args: [script.split(path.sep).join('/')], timeoutMs, statusMessage };
}

function isOurZcodeHook(h) {
  const refs = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])];
  return refs.some(isCodeIndexHookRef);
}

function dropCodeIndexZcodeHooks(groups) {
  const kept = [];
  for (const g of groups || []) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { kept.push(g); continue; }
    const hooks = g.hooks.filter(h => !isOurZcodeHook(h));
    if (hooks.length) kept.push({ ...g, hooks });
  }
  return kept;
}

/**
 * 每次卸掉本模块的 ZCode 钩子再按当前脚本路径写回。
 * 其他事件、其他钩子保留。JSON 解析失败则不改文件。
 */
export function rewriteZcodeHooks(root) {
  const zcodePath = path.join(root, '.zcode', 'config.json');
  const autoAbs = path.join(here, 'auto.mjs');
  const commitRefreshAbs = path.join(here, 'commit-refresh.mjs');
  const promptGuardAbs = path.join(here, 'prompt-guard.mjs');
  let zc = { hooks: { enabled: true, events: {} } };
  if (fs.existsSync(zcodePath)) {
    try {
      zc = JSON.parse(fs.readFileSync(zcodePath, 'utf8'));
    } catch (e) {
      console.error(`  [warn] [${path.basename(root)}] .zcode/config.json 解析失败,未改动(${e.message})`);
      return;
    }
  }
  if (!zc || typeof zc !== 'object' || Array.isArray(zc)) zc = {};
  zc.hooks = zc.hooks && typeof zc.hooks === 'object' && !Array.isArray(zc.hooks) ? zc.hooks : {};
  zc.hooks.enabled = true;
  const events = zc.hooks.events && typeof zc.hooks.events === 'object' && !Array.isArray(zc.hooks.events) ? zc.hooks.events : {};
  zc.hooks.events = events;
  for (const key of Object.keys(events)) {
    if (Array.isArray(events[key])) events[key] = dropCodeIndexZcodeHooks(events[key]);
  }
  const push = (name, group) => { events[name] = [...(Array.isArray(events[name]) ? events[name] : []), group]; };
  push('SessionStart', { matcher: 'startup|resume', hooks: [zcodeProcess(autoAbs, 420000, '索引保鲜检查(HEAD 驱动)+ 预热本地检索模型')] });
  push('PostToolUse', { matcher: 'Bash', hooks: [zcodeProcess(commitRefreshAbs, 10000, '提交后索引保鲜')] });
  push('UserPromptSubmit', { hooks: [zcodeProcess(promptGuardAbs, 10000, '模型变更检测')] });
  fs.mkdirSync(path.dirname(zcodePath), { recursive: true });
  fs.writeFileSync(zcodePath, JSON.stringify(zc, null, 2) + '\n');
  ok(`[${path.basename(root)}] ZCode hooks 已按当前模块重写(其他钩子保留)`);
}

if (directRun) {
log(`\n[4/5]+[5/5] 对每个 git 仓库 root 接线会话 hook + AGENTS.md 检索纪律`);

/** 给一个 git 仓库根接线:.zcode hook、.cursor 转发器、AGENTS.md 纪律段 */
function wireRepo(root) {
  rewriteZcodeHooks(root);
  rewriteCursorHooks(root);
  const agentsPath = path.join(root, 'AGENTS.md');
  const MARK_V2 = '<!-- code-index:v2 -->';
  const rel = path.relative(root, here).split(path.sep).join('/');
  const dataRel = path.relative(root, DATA_DIR).split(path.sep).join('/');
  const searchCmd = PACKED_INSTALL
    ? 'npx tokensaver search <中英文关键词> --rerank --k 5'
    : 'cd ' + rel + ' && node search.mjs <中英文关键词> --rerank --k 5';
  const statusCmd = PACKED_INSTALL ? 'npx tokensaver status' : 'node ' + rel + '/status.mjs';
  const autoCmd = PACKED_INSTALL ? 'npx tokensaver auto' : 'cd ' + rel + ' && node auto.mjs';
  const rebuildCmd = PACKED_INSTALL
    ? 'npx tokensaver build && npx tokensaver embed'
    : 'cd ' + rel + ' && node build.mjs && node embed.mjs';
  const embedCmd = PACKED_INSTALL ? 'npx tokensaver embed' : 'node embed.mjs';
  const pathHint = PACKED_INSTALL
    ? '命令在仓库根执行(`npx tokensaver ...`),不要 cd 进 node_modules'
    : '派单/命令里的路径必须用正斜杠+引号(`cd "' + path.dirname(here).split(path.sep).join('/') + '/code-index"`):git bash 下不带引号的反斜杠路径会被转义吞掉';
  const toolLabel = PACKED_INSTALL ? 'npx tokensaver' : rel;
  const P = (n, t) => n + '. ' + t;
  const items = [
    P(1, '**全局背景**:先读 `' + dataRel + '/CODE_MAP.md`(架构速查模板,随使用逐步充实;或自行维护项目架构说明)'),
    P(2, '**无条件先走索引**:任何定位/阅读/修改代码的任务,动手前必须先执行至少一次 `' + searchCmd + '`——**即使任务已给出 file:行号也要先检索核对**(行号会漂移,以检索结果为准;`--json` 供程序消费);Grep 只能作为索引之后的补充'),
    P(3, '按返回的 `file:起-止行` 用 Read 精读目标区间;定位阶段禁止未检索就整文件通读 500 行以上的大文件;**修改类任务改动完成后,对所涉及文件做一次较大范围复查**(捕捉跨中间件/跨函数的副作用)'),
    P(4, pathHint),
    P(5, '**模型状态提示(原样转达一句)**:会话开始后先运行 `' + statusCmd + '`,把输出的那一句 ⚙ 原样附在每次回复末尾。该句只含三项:是否启动成功、嵌入模型名与精排模型名、失败时的最可能原因或成功时今日已节约的 tokens(每天 24:00 清零)。不要加长、不要改写;没有这句输出时不得虚构'),
    P(6, '**知识沉淀**:完成某文件的深挖/修复/排查后,若 `' + dataRel + '/code-index.config.json` 的 knownAnnotations 无该文件条目,追加一条(格式:`"项目名/相对路径": "一句话职责+关键机制"`,≤50 字);仅真实读码理解后写入,禁止批量生成;写后校验 JSON 合法'),
    P(7, '**提交后保鲜**:执行 `git commit` 后,运行 `' + autoCmd + '`(HEAD 没变秒级跳过;有变更时 build 内联约 10s+嵌入转后台)——有 PostToolUse hook 的环境已自动做,重复触发零成本'),
    P(8, '索引保鲜由会话 hook 自动判定(git 仓库按 HEAD,非 git 目录 24h 回退;嵌入路径或模型变更则重嵌)。手动重建:`' + rebuildCmd + '`。向量过期或切换嵌入模型时运行 `' + embedCmd + '`(只更新当前路径 data/vectors;维度不一致或 `--force` 时该目录全量),完成后以 `' + statusCmd + '` 验证。所选嵌入路径(init --model-in ollama|local)拉起失败时检索降级 bm25;显式 `--mode bm25` 可主动选用'),
  ];
  const snippet = `\n${MARK_V2}\n## 代码检索纪律(节约 token)\n\n本项目已部署本地语义索引(工具在 \`${toolLabel}\`,项目资产在 \`${dataRel}\`):\n\n${items.join('\n\n')}\n`;
  const block = snippet.trim() + '\n';
  // 标记与标题之间允许空行(如 prettier 会插入),否则匹配失败会再追加一段
  const sectionRe = /<!-- code-index[^>]*-->\s*## 代码检索纪律[\s\S]*?(?=\r?\n<!-- ponytail -->|\r?\n## |$)/;
  const content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
  if (content && sectionRe.test(content)) {
    const next = content.replace(sectionRe, block);
    if (next === content) ok(`[${path.basename(root)}] AGENTS.md 纪律段已与当前模板一致,跳过`);
    else {
      fs.writeFileSync(agentsPath, next.endsWith('\n') ? next : next + '\n');
      ok(`[${path.basename(root)}] AGENTS.md 纪律段已按当前模板更新(8 条)`);
    }
  } else if (content) {
    fs.appendFileSync(agentsPath, snippet);
    ok(`[${path.basename(root)}] AGENTS.md 已追加检索纪律段(8 条)`);
  } else {
    fs.writeFileSync(agentsPath, block);
    ok(`[${path.basename(root)}] AGENTS.md 已写入检索纪律段(8 条)`);
  }
  upsertPonytail(agentsPath);
}

const PONYTAIL_MARK = '<!-- ponytail -->';

function ponytailBlock() {
  const body = fs.readFileSync(path.join(here, 'ponytail.md'), 'utf8').trim();
  return `${PONYTAIL_MARK}\n## Ponytail 模式（懒惰资深开发者规则）\n\n${body}\n`;
}

/** 追加或替换文末 Ponytail 段。纪律段和其他原文不动。 */
function upsertPonytail(agentsPath) {
  const block = ponytailBlock();
  let content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const re = /<!-- ponytail -->[\s\S]*$/;
  if (re.test(content)) {
    const next = content.replace(re, block);
    if (next !== content) {
      fs.writeFileSync(agentsPath, next.endsWith('\n') ? next : next + '\n');
      ok(`[ponytail] 已按 ponytail.md 更新文末段落`);
    } else ok(`[ponytail] 已在文末,跳过`);
    return;
  }
  if (content && !content.endsWith('\n')) content += '\n';
  fs.writeFileSync(agentsPath, content + (content ? '\n' : '') + block);
  ok(`[ponytail] 已追加到 AGENTS.md 末尾`);
}

// 宿主仓库 + config 实际生效的每个 root(去重);root 不是 git 仓库(纯目录)则只索引不接线
const effRoots = (() => {
  try { return JSON.parse(fs.readFileSync(configPath, 'utf8')).roots || []; }
  catch { return []; }
})();
const wireRoots = [...new Set([repoRoot, ...effRoots.map(r => path.resolve(r))])];
for (const r of wireRoots) {
  if (fs.existsSync(path.join(r, '.git'))) {
    wireRepo(r);
    // 不入 git:机器本地 hooks;宿主仓库另忽略依赖、项目资产和 hf-cache(权重超过远程单文件限制)。
    const giEntries = ['/.zcode/'];
    if (r === repoRoot) {
      const rel = (p) => '/' + path.relative(repoRoot, p).split(path.sep).join('/');
      giEntries.push(rel(DATA_DIR) + '/');
      if (!PACKED_INSTALL) {
        giEntries.push(rel(path.join(here, 'node_modules')) + '/', rel(HF_CACHE_DIR) + '/');
      }
    }
    ensureGitignore(r, giEntries);
  } else console.error(`  [note] ${r} 非 git 仓库,只索引不接线(无 AGENTS.md/hooks)`);
}

log(`\n============ 初始化完成 ============`);
// CODE_MAP 模板(项目资产,位于 data/;已存在则不动)
const codeMapPath = path.join(DATA_DIR, 'CODE_MAP.md');
if (!fs.existsSync(codeMapPath)) {
  fs.writeFileSync(codeMapPath, `# CODE_MAP —— 项目代码知识地图(由 agent 在深挖中持续维护)\n\n> 用法:先读本文获得全局背景 → node search.mjs 检索定位 → 按行区间精读。\n> 建议内容:项目架构图、核心链路、关键文件职责、已知问题速查。\n\n(模板生成于 ${new Date().toISOString().slice(0, 10)};请按项目实际逐步充实,knownAnnotations 同步沉淀)\n`);
  ok(`已生成 CODE_MAP 模板:${codeMapPath}(请逐步充实)`);
}
log(`提示:工具可用 npm i -D @dionfang/tokensaver 后 npx tokensaver init,也可复制本目录。项目资产在 ${DATA_DIR}(config/CODE_MAP/索引)。Ollama/local 模型权重不在 npm 包内。`);
}
