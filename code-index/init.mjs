#!/usr/bin/env node
/**
 * 枢纽初始化。在 TokenSaver/code-index 运行(数据始终写在本工具仓的 data/,不写进业务仓):
 *   node init.mjs [--roots "D:/repoA,D:/repoB"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder]
 *
 * --roots 纳入扫描目录(与已有 roots 合并,不覆盖)。以后改 data/code-index.config.json 的 roots,
 * 再跑一次不带参数的 node init.mjs 即可:自愈仍存在的路径、给新 git 仓挂钩子、后台按配置重建索引。
 *
 * --model-in 决定嵌入路径,写入 data/code-index.config.json 的 modelIn:
 *   local(新建配置时的默认) —— 常驻进程加载 models.localEmbedding 与 models.localReranker;常驻不在时当次进程内加载。不依赖 Ollama
 *   ollama —— 通过已运行的 Ollama 加载 models.embedding 与 models.reranker
 * 不传 --model-in 不改已有 modelIn。参数名写错、缺少取值、取值非法,或 --roots 为空:报错退出且不改配置。
 * 两条路径拉起失败时检索都降级 bm25,运行时不改换另一条路径。
 *
 * 做这些事:
 *   1) 写 data/code-index.config.json(相对本模块的上一级 data/)。没有该文件时新建
 *      (roots 缺省 = 工具仓 git 根,modelIn 缺省 local)。
 *      已有文件保留其余键:传了 --roots 就并入 roots;不传则按文件自愈,不把工具仓自己塞进 roots。
 *      只有传了 --model-in 才写 modelIn。
 *   2) 安装依赖 npm install --ignore-scripts(必装,local 路径需要 transformers.js)
 *   3) **分离后台**启动 auto.mjs 建首版索引(build 内联其内 + embed 后台增量 + 预热;
 *      init 秒级返回不等待;进度看 data/auto.log 与 data/embed.log;期间检索 bm25 可用)
 *   4) 接线会话 hook:**统一装在用户级配置**(ZCode ~/.zcode/cli/config.json;Cursor ~/.cursor/hooks.json;
 *      Qoder ~/.qoder-cn/settings.json,国际版 ~/.qoder),绝对路径直指本模块,所有工作区共享一份,
 *      不依赖各仓的工作区信任审批。同时清理各 root 工作区里本模块的旧钩子与转发器。
 *      默认只装当前 agent(Cursor/ZCode/Qoder)那一套;认不出则三套都装。
 *      Cursor 另接 beforeSubmitPrompt → prompt-guard(会话中改嵌入模型才会后台重嵌)。
 *      三套都接 Read/终端整读拦截(超行数 deny,区间读放行,5 分钟内重试放行,出错 fail-open):
 *      Cursor preToolUse(Read)+beforeShellExecution(cat);ZCode/Qoder PreToolUse ^Read$|^Bash$。
 *      --hooks all|cursor|zcode|qoder 可覆盖。每次运行只重写选中工具的用户级配置里本模块的钩子;
 *      同文件里的其他钩子保留。JSON 解析失败则不改该文件。
 *   5) AGENTS.md:已有 code-index 标记则替换纪律段(含文档英文一条),没有则追加;文件不存在则新建。
 *      再追加或替换末尾的 Ponytail 段(<!-- ponytail -->),不改纪律段和其他原文。
 *      补 .gitignore:本地复制部署忽略整个本目录和平行 data/;npm 安装只忽略 data/。.cursor/.zcode/.qoder 始终忽略。
 *      不存在 CODE_MAP.md 时写一份空模板,已有则不动。
 * 依赖安装与索引构建均不可跳过。
 * data/session-savings.json 按日本机已加载项目的检索累计,本脚本不读不删。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DATA_DIR, PACKED_INSTALL, findGitRoot } from './config.mjs';
import { localOnnxCached } from './localRerank.mjs';
import { spawnLogged } from './proc.mjs';

const here = fs.realpathSync.native(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
export const HOOK_TOOLS = ['cursor', 'zcode', 'qoder'];
const INIT_USAGE = '可用参数: --roots "D:/a,D:/b"  --model-in ollama|local  --hooks all|cursor|zcode|qoder。等号写法也认。';

/**
 * 从进程环境判断当前是哪个 agent。认不出返回 null。
 * Cursor agent 注入 CURSOR_AGENT;Qoder/ZCode 注入各自 PROJECT_DIR。
 * 不看 CLAUDE_* (Qoder/ZCode 会同时带上)。
 */
export function detectAgent(env = process.env) {
  if (env.CURSOR_AGENT || env.CURSOR_CONVERSATION_ID || env.CURSOR_TRACE_ID || env.CURSOR_REQUEST_ID) return 'cursor';
  if (env.QODER_PROJECT_DIR || env.QODER_CONFIG_DIR || env.QODER_SESSION_ID || env.QODER_CWD) return 'qoder';
  if (env.ZCODE_PROJECT_DIR || env.ZCODE_SESSION_ID || env.ZCODE_PLUGIN_ROOT) return 'zcode';
  const cwd = env.VSCODE_CWD || '';
  if (/[\\/][Cc]ursor(?:\.app)?(?:[\\/]|$)/.test(cwd)) return 'cursor';
  if (/[\\/][Qq]oder(?:\.app)?(?:[\\/]|$)/.test(cwd)) return 'qoder';
  if (/[\\/][Zz][Cc]ode(?:\.app)?(?:[\\/]|$)/.test(cwd)) return 'zcode';
  return null;
}

/** --hooks 优先;否则检测到哪个装哪个;都没有则三套都装。 */
export function resolveHookTargets(hooksArg, env = process.env) {
  if (hooksArg === 'all') return [...HOOK_TOOLS];
  if (hooksArg) return [hooksArg];
  const d = detectAgent(env);
  return d ? [d] : [...HOOK_TOOLS];
}

/** 解析 init 参数。错误时返回 { error },不写配置。同一参数出现多次时后者生效。 */
export function parseInitArgs(argv) {
  const out = { roots: null, modelIn: null, hooks: null };
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
    if (name !== '--roots' && name !== '--model-in' && name !== '--hooks') {
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
    else if (name === '--model-in') out.modelIn = value;
    else {
      const v = String(value).trim().toLowerCase();
      if (v !== 'all' && !HOOK_TOOLS.includes(v)) {
        return { error: `--hooks 只能是 all|cursor|zcode|qoder,收到 ${value}` };
      }
      out.hooks = v;
    }
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

export function splitRoots(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 注解保留策略:roots 实际变化时旧注解可能指向已剔除的目录,整表重置;--roots 未变或未传则增量保留。 */
export function rollKnownAnnotations(prev, rootsChanged) {
  if (!prev || typeof prev !== 'object' || Array.isArray(prev)) return {};
  return rootsChanged ? {} : prev;
}

function posixAbs(p) {
  return path.resolve(p).split(path.sep).join('/');
}

/** 已有 ∪ 新增,绝对路径去重(Windows 大小写不敏感)。 */
export function mergeRoots(existing, added) {
  const out = [];
  const seen = new Set();
  const add = (r) => {
    if (r == null || String(r).trim() === '') return;
    const n = posixAbs(r);
    const k = n.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  for (const r of existing || []) add(r);
  for (const r of added || []) add(r);
  return out;
}

/** 仍存在的保留;缺失的按 siblingOf+basename 猜一次。 */
export function healRoots(roots, { siblingOf, exists = fs.existsSync, onMissing, onHeal } = {}) {
  const healed = [];
  for (const r of roots || []) {
    if (exists(r)) {
      healed.push(String(r).split(path.sep).join('/'));
      continue;
    }
    const guess = siblingOf ? path.join(siblingOf, path.basename(r)).split(path.sep).join('/') : '';
    if (guess && exists(guess)) {
      healed.push(guess);
      if (onHeal) onHeal(r, guess);
    } else if (onMissing) onMissing(r);
  }
  return healed;
}

const log = (s) => console.log(s);
const ok = (s) => console.log(`  [ok] ${s}`);

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
// 枢纽以本模块所在仓为准,不跟当前工作区走,避免在业务仓里跑 init 把 data 搞乱。
const repoRoot = findGitRoot(here) || findGitRoot(process.cwd());
if (directRun) {
if (!repoRoot) {
  console.error('[err] 未找到 git 仓库根(从本模块向上未发现 .git);请在 TokenSaver/code-index 内运行');
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
ok(`数据目录 ${DATA_DIR}`);
const hostRoot = repoRoot.split(path.sep).join('/');
const siblingOf = path.dirname(repoRoot);
const takeExistingRoots = (raw) => {
  const wanted = splitRoots(raw);
  const present = [];
  for (const r of wanted) {
    if (fs.existsSync(r)) present.push(r);
    else console.error(`  [warn] --roots 跳过不存在的路径: ${r}`);
  }
  return present;
};
let roots;
const configExisted = fs.existsSync(configPath);
const chosenBackend = modelInArg || 'local';
if (configExisted) {
  const cfgOld = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let dirty = false;
  if (rootsArg) {
    const added = takeExistingRoots(rootsArg);
    if (!added.length && !(cfgOld.roots || []).length) {
      console.error('[err] --roots 没有可用路径,未改配置');
      process.exit(1);
    }
    roots = mergeRoots(cfgOld.roots || [], added);
    if (JSON.stringify(roots) !== JSON.stringify(cfgOld.roots || [])) {
      cfgOld.roots = roots;
      const prevAnn = cfgOld.knownAnnotations;
      cfgOld.knownAnnotations = rollKnownAnnotations(prevAnn, true);
      if (prevAnn && typeof prevAnn === 'object' && !Array.isArray(prevAnn) && Object.keys(prevAnn).length) {
        ok(`roots 已变化,knownAnnotations 整表重置(${Object.keys(prevAnn).length} 条旧注解只对原 roots 有效)`);
      }
      dirty = true;
      ok(`已纳入 roots = ${JSON.stringify(roots)}`);
    } else {
      roots = cfgOld.roots || [];
      ok(`roots 未变化,knownAnnotations 增量保留 ${JSON.stringify(roots)}`);
    }
  } else {
    roots = healRoots(cfgOld.roots || [], {
      siblingOf,
      onHeal: (from, to) => ok(`root 自愈:${from} → ${to}(兄弟目录约定)`),
      onMissing: (r) => console.error(`  [warn] root ${r} 在本机不存在且无法按兄弟目录定位,已剔除;改配置或 --roots 再纳入`),
    });
    if (!roots.length) {
      console.error('  [warn] 配置里没有仍存在的 root,回退为工具仓自身;请在 data/code-index.config.json 填写业务目录后重跑 init');
      roots = [hostRoot];
    }
    if (JSON.stringify(roots) !== JSON.stringify(cfgOld.roots || [])) {
      cfgOld.roots = roots;
      dirty = true;
      ok(`roots 已按配置生效 ${JSON.stringify(roots)}`);
    } else {
      ok(`按配置 roots 接线并重建索引 ${JSON.stringify(roots)}`);
    }
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
  if (rootsArg) {
    roots = mergeRoots([], takeExistingRoots(rootsArg));
    if (!roots.length) {
      console.error('[err] --roots 没有可用路径,未写配置');
      process.exit(1);
    }
  } else {
    roots = [hostRoot];
  }
  const desc = '项目配置。数据在 TokenSaver 自己的 data/。改 roots 后重新 node init.mjs(不必带参)即纳入新目录并挂钩子。未写的键用 config.mjs 默认值。模型名、ollamaBase、gpu、OLLAMA_KEEP_ALIVE、OLLAMA_NUM_CTX 只写 config.mjs。roots: 本文件为清单;init --roots 并入;CODE_INDEX_ROOTS 运行时可临时盖掉。modelIn: --model-in > 本文件 > local。skipDirs 整表替换。knownAnnotations: 首装为空;init --roots 使 roots 变化时整表重置,--roots 未变或未传则原样保留,由深挖后手工追加。';
  const skipDirs = [...new Set([...DEFAULT_CONFIG.skipDirs, path.basename(here), 'code-index', '.cursor', '.zcode', '.qoder'])];
  fs.writeFileSync(configPath, JSON.stringify({
    $说明: desc,
    roots,
    skipDirs,
    modelIn: chosenBackend,
    knownAnnotations: {},
  }, null, 2));
  ok(`已生成,roots = ${JSON.stringify(roots)},嵌入路径 = ${chosenBackend};skipDirs 含内置默认 + "code-index"(hub 模式下由 build 放行工具目录)`);
}
if (!configExisted || modelInArg) {
  if (chosenBackend === 'local') {
    const embId = DEFAULT_CONFIG.models.localEmbedding;
    const rrId = DEFAULT_CONFIG.models.localReranker;
    const bundled = localOnnxCached(embId) && localOnnxCached(rrId);
    console.error(`  [注意] 嵌入路径为 local:transformers.js 由常驻进程加载,不依赖 Ollama。常驻不在时当次进程内加载。`);
    console.error(bundled
      ? '        本目录 hf-cache 已含两个模型权重,无需下载。'
      : '        hf-cache 缺权重,首次使用会下载。');
    console.error(`        嵌入 ${embId}`);
    console.error(`        精排 ${rrId}(q8)`);
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
  if (r.status !== 0) {
    console.error('  [err] npm install 失败(可试 --registry=https://registry.npmmirror.com 后重跑)');
    process.exit(1);
  }
  ok('依赖就绪');
}

log(`\n[3/5] 后台启动首版索引构建(不等待)`);
{
  const child = spawnLogged(path.join(here, 'auto.mjs'), path.join(DATA_DIR, 'auto.log'), here);
  ok(`auto.mjs 已分离后台运行(pid ${child.pid}):build → 增量 embed → 预热;进度看 data/auto.log 与 data/embed.log`);
  console.error('  [note] 所选嵌入路径拉起失败时检索保持 bm25,不自动改换另一条路径。CPU 全量嵌入可达十几分钟(后台进行,不阻塞)');
}
}

/** 仓库根到目标的 gitignore 路径(/scripts/code-index/)。目标在仓外则返回 null。 */
export function toGitignorePath(repoRoot, target) {
  let from = repoRoot;
  let to = target;
  try { from = fs.realpathSync.native(repoRoot); } catch { from = path.resolve(repoRoot); }
  try { to = fs.realpathSync.native(target); } catch { to = path.resolve(target); }
  let rel = path.relative(from, to).split(path.sep).join('/');
  if (!rel || rel === '.' || rel.startsWith('..')) return null;
  if (!rel.startsWith('/')) rel = '/' + rel;
  return rel.endsWith('/') ? rel : rel + '/';
}

const EDITOR_IGNORE = ['/.zcode/', '/.cursor/', '/.qoder/'];

/** 本地复制部署:忽略整个模块目录和平行 data。npm 安装只忽略 data。.cursor/.zcode 始终忽略。 */
export function gitignoreEntries({ packed, repoRoot, moduleDir, dataDir }) {
  const out = [...EDITOR_IGNORE];
  const data = toGitignorePath(repoRoot, dataDir);
  if (data) out.push(data);
  if (!packed) {
    // 枢纽仓源码在 git 根下的 code-index/,不能 ignore;复制部署在 scripts/code-index/ 才忽略。
    const hubSelf = path.resolve(path.dirname(moduleDir)) === path.resolve(repoRoot);
    if (!hubSelf) {
      const mod = toGitignorePath(repoRoot, moduleDir);
      if (mod) out.push(mod);
    }
  }
  return [...new Set(out)];
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
  lines.push('# code-index(部署目录、data、.cursor/.zcode/.qoder 钩子不入库)');
  lines.push(...missing);
  fs.writeFileSync(giPath, lines.join('\n') + '\n');
  ok(`[${path.basename(root)}] .gitignore 已追加:${missing.join(', ')}`);
}

/** 只认本模块的脚本。项目里别的 auto.mjs / warm.mjs 不碰。目录名不限(复制部署常用 code-index)。 */
export function isCodeIndexHookRef(value) {
  const s = String(value || '').replace(/\\/g, '/');
  // output-savings 已下线,仍匹配以便 rewrite 时卸掉旧钩子
  if (/(?:^|\/)(?:warm-code-index|output-savings|prompt-guard|read-guard)\.mjs$/.test(s)) return true;
  // settings.json 里存的是整条命令(`node .qoder/hooks/...`),.qoder 前是空格而非 /,故前缀要含空白和引号
  if (/(?:^|[\s/"'])\.qoder(?:-cn)?\/hooks\/(?:session-start|prompt-guard|commit-refresh|read-guard)\.mjs$/.test(s)) return true;
  if (/(?:^|[\s/"'])\.zcode\/hooks\/(?:session-start|prompt-guard|commit-refresh|read-guard)\.mjs$/.test(s)) return true;
  const dir = path.basename(here).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = 'auto|commit-refresh|prompt-guard|read-guard|warm|output-savings';
  if (new RegExp(`(?:^|/)(?:code-index|tokensaver|${dir})/(?:${names})\\.mjs$`).test(s)) return true;
  const herePosix = here.replace(/\\/g, '/');
  return s.includes(herePosix + '/') || s.endsWith(herePosix);
}

function hookEntryExpr(hooksDir, scriptName) {
  const target = path.join(here, scriptName);
  const rel = path.relative(hooksDir, target);
  if (path.isAbsolute(rel)) return JSON.stringify(target.split(path.sep).join('/'));
  const relPosix = (rel || path.basename(target)).split(path.sep).join('/');
  return `path.resolve(here, ${JSON.stringify(relPosix)})`;
}

function hookPrelude(hooksDir, scriptName) {
  const rel = path.relative(hooksDir, path.join(here, scriptName));
  if (path.isAbsolute(rel)) return `import { spawn } from 'node:child_process'\n\n`;
  return `import { spawn } from 'node:child_process'\nimport path from 'node:path'\nimport { fileURLToPath } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
}

function hookScript(hooksDir, scriptName, comment, body) {
  return `/** ${comment} */\n${hookPrelude(hooksDir, scriptName)}const entry = ${hookEntryExpr(hooksDir, scriptName)}\n${body}`;
}

function cursorForwarderSource(hooksDir) {
  const body = `const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })\nchild.on('error', (err) => { console.error('[fail] 无法启动 code-index:', err.message); process.exit(0) })\nchild.on('exit', () => process.exit(0))\n`;
  return hookScript(hooksDir, 'auto.mjs', 'Cursor sessionStart: 转发到当前 code-index 的 auto.mjs。stdout 保持空。', body);
}

function cursorPromptGuardSource(hooksDir) {
  const body = `const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'ignore', 'inherit'], windowsHide: true })
child.on('error', () => { process.stdout.write('{"continue":true}'); process.exit(0) })
child.on('exit', () => { process.stdout.write('{"continue":true}'); process.exit(0) })
`;
  return hookScript(hooksDir, 'prompt-guard.mjs', 'Cursor beforeSubmitPrompt: 转发 prompt-guard.mjs(模型变更则后台重嵌)。stdout 只回 continue,不注入上下文。', body);
}

function cursorReadGuardSource(hooksDir) {
  const entryExpr = hookEntryExpr(hooksDir, 'read-guard.mjs');
  const rel = path.relative(hooksDir, path.join(here, 'read-guard.mjs'));
  // 同进程读 Cursor 写入的 stdin。Windows 上子进程 inherit 接不到后写入的管道,空输入会放行。
  const head = path.isAbsolute(rel)
    ? `import { pathToFileURL } from 'node:url'\n`
    : `import path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
  return `/** Cursor preToolUse Read: 同进程调用 read-guard.mjs。stdout 含 permission deny 才拦截;失败则 allow。 */\n${head}const entry = ${entryExpr}\nlet raw = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { raw += c })\nprocess.stdin.on('end', async () => {\n  try {\n    const { runReadGuard } = await import(pathToFileURL(entry).href)\n    await runReadGuard({ stdinText: raw })\n  } catch {\n    process.stdout.write('{"permission":"allow"}')\n  }\n})\n`;
}

function qoderReadGuardSource(hooksDir) {
  const body = `const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.on('error', () => { process.stdout.write('{}'); process.exit(0) })
child.on('exit', () => {
  const s = String(out).trim()
  try {
    const j = JSON.parse(s)
    const d = j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision
    if (d === 'deny' || d === 'allow' || d === 'ask') process.stdout.write(s)
    else process.stdout.write('{}')
  } catch { process.stdout.write('{}') }
  process.exit(0)
})
`;
  return hookScript(hooksDir, 'read-guard.mjs', 'Qoder PreToolUse Read: 转发 read-guard.mjs。无合法 permissionDecision 则 {} fail-open。', body);
}

/** 清理后若整个文件只剩空骨架(无任何他人配置),连文件一起删,目录空了就回收。 */
function removeIfPureSkeleton(file, isEmptyFn) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg) && isEmptyFn(cfg)) {
      fs.rmSync(file, { force: true });
      return true;
    }
  } catch { /* JSON 坏了不敢删 */ }
  return false;
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0;

/** 只清理:把本模块接入该工作区的 Cursor 钩子条目与转发器移除(钩子已迁用户级 ~/.cursor/hooks.json)。 */
export function cleanCursorWorkspaceHooks(root) {
  const hooksJson = path.join(root, '.cursor', 'hooks.json');
  const hooksDir = path.join(root, '.cursor', 'hooks');
  let fileGone = false;
  if (fs.existsSync(hooksJson)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));
      let changed = false;
      if (cfg && typeof cfg === 'object' && cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks)) {
        for (const key of Object.keys(cfg.hooks)) {
          if (!Array.isArray(cfg.hooks[key])) continue;
          const before = cfg.hooks[key].length;
          cfg.hooks[key] = cfg.hooks[key].filter(h => !isCodeIndexHookRef(h?.command));
          if (cfg.hooks[key].length !== before) changed = true;
          if (!cfg.hooks[key].length) delete cfg.hooks[key];
        }
        // 只剩骨架(没有 version 之外的其他键、hooks 已空)→ 整个文件删掉
        const skeletonOnly = Object.keys(cfg).every(k => k === 'version' || k === 'hooks') && isPlainObject(cfg.hooks);
        if (skeletonOnly) fileGone = removeIfPureSkeleton(hooksJson, () => true);
        else if (changed) fs.writeFileSync(hooksJson, JSON.stringify(cfg, null, 2) + '\n');
      }
    } catch { /* JSON 坏了不动,只删转发器 */ }
  }
  for (const f of ['warm-code-index.mjs', 'prompt-guard.mjs', 'read-guard.mjs', 'output-savings.mjs']) {
    try { fs.rmSync(path.join(hooksDir, f), { force: true }); } catch { /* 无该文件 */ }
  }
  try { fs.rmdirSync(hooksDir); } catch { /* 非空(如用户的 skills)或不存在 */ }
  try { fs.rmdirSync(path.dirname(hooksDir)); } catch { /* 非空,留着 */ }
  ok(`[${path.basename(root)}] Cursor 工作区钩子已清理${fileGone ? '(空壳 hooks.json 已删除)' : ''}(钩子在用户级 ~/.cursor/hooks.json)`);
}

function zcodeProcess(script, timeoutMs, statusMessage) {
  return { type: 'process', command: 'node', args: [script.split(path.sep).join('/')], timeoutMs, statusMessage };
}

export function isOurZcodeHook(h) {
  const refs = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])];
  return refs.some(isCodeIndexHookRef);
}

/** 按判定函数剔除钩子组;组内清空则整组移除。 */
export function dropHookGroups(groups, isOurs) {
  const kept = [];
  for (const g of groups || []) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.hooks)) { kept.push(g); continue; }
    const hooks = g.hooks.filter((h) => !isOurs(h));
    if (hooks.length) kept.push({ ...g, hooks });
  }
  return kept;
}

/**
 * 只清理:把本模块接入该工作区的 ZCode 钩子条目与转发器移除(钩子已迁用户级 ~/.zcode/cli/config.json)。
 */
export function cleanZcodeWorkspaceHooks(root) {
  const zcodePath = path.join(root, '.zcode', 'config.json');
  const hooksDir = path.join(root, '.zcode', 'hooks');
  let fileGone = false;
  if (fs.existsSync(zcodePath)) {
    try {
      const zc = JSON.parse(fs.readFileSync(zcodePath, 'utf8'));
      if (zc && typeof zc === 'object' && zc.hooks && typeof zc.hooks === 'object' && !Array.isArray(zc.hooks)) {
        const events = zc.hooks.events && typeof zc.hooks.events === 'object' && !Array.isArray(zc.hooks.events) ? zc.hooks.events : {};
        let changed = false;
        for (const key of Object.keys(events)) {
          if (Array.isArray(events[key])) {
            const before = events[key].length;
            events[key] = dropHookGroups(events[key], isOurZcodeHook);
            if (events[key].length !== before) changed = true;
            if (!events[key].length) delete events[key];
          }
        }
        // 只剩骨架(顶层只有 hooks、hooks 里只有 enabled/events 且 events 已空)→ 整个文件删掉
        const skeletonOnly = Object.keys(zc).every(k => k === 'hooks')
          && Object.keys(zc.hooks).every(k => k === 'enabled' || k === 'events')
          && Object.keys(events).length === 0;
        if (skeletonOnly) fileGone = removeIfPureSkeleton(zcodePath, () => true);
        else if (changed) fs.writeFileSync(zcodePath, JSON.stringify(zc, null, 2) + '\n');
      }
    } catch { /* JSON 坏了不动,只删转发器 */ }
  }
  for (const f of ['session-start.mjs', 'prompt-guard.mjs', 'commit-refresh.mjs', 'read-guard.mjs', 'output-savings.mjs']) {
    try { fs.rmSync(path.join(hooksDir, f), { force: true }); } catch { /* 无该文件 */ }
  }
  try { fs.rmdirSync(hooksDir); } catch { /* 非空或不存在 */ }
  try { fs.rmdirSync(path.dirname(hooksDir)); } catch { /* 非空,留着 */ }
  ok(`[${path.basename(root)}] ZCode 工作区钩子已清理${fileGone ? '(空壳 config.json 已删除)' : ''}(钩子在用户级 ~/.zcode/cli/config.json)`);
}

function qoderWrapSource(hooksDir, scriptName, eventName) {
  return hookScript(hooksDir, scriptName, `Qoder ${eventName}: 转发 ${scriptName},把 additionalContext 包成 hookSpecificOutput。`, `const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.on('error', () => process.exit(0))
child.on('exit', (code) => {
  try {
    const j = JSON.parse(String(out).trim() || '{}')
    const ctx = j.additionalContext || j.hookSpecificOutput && j.hookSpecificOutput.additionalContext
    if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ${JSON.stringify(eventName)}, additionalContext: ctx } }))
  } catch { /* 无 JSON 则静默 */ }
  process.exit(code || 0)
})
`);
}

function qoderPassthroughSource(hooksDir, scriptName) {
  return hookScript(hooksDir, scriptName, `Qoder: 转发 ${scriptName}。stdout 保持空。`, `const child = spawn(process.execPath, [entry], { stdio: 'inherit', windowsHide: true })
child.on('error', () => process.exit(0))
child.on('exit', (code) => process.exit(code || 0))
`);
}

function qoderCmd(rel, timeoutSec, statusMessage) {
  return { type: 'command', command: 'node ' + rel, timeout: timeoutSec, statusMessage };
}

/** 只清理:把本模块接入该工作区的 Qoder 钩子条目与转发器移除(钩子已迁用户级 ~/.qoder-cn/settings.json)。 */
export function cleanQoderWorkspaceHooks(root) {
  const settingsPath = path.join(root, '.qoder', 'settings.json');
  const hooksDir = path.join(root, '.qoder', 'hooks');
  let fileGone = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      let changed = false;
      if (cfg && typeof cfg === 'object' && cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks)) {
        for (const key of Object.keys(cfg.hooks)) {
          if (Array.isArray(cfg.hooks[key])) {
            const before = cfg.hooks[key].length;
            cfg.hooks[key] = dropHookGroups(cfg.hooks[key], (h) => isCodeIndexHookRef(h?.command));
            if (cfg.hooks[key].length !== before) changed = true;
            if (!cfg.hooks[key].length) delete cfg.hooks[key];
          }
        }
        // 只剩骨架(顶层只有空 hooks)→ 整个文件删掉
        if (Object.keys(cfg).every(k => k === 'hooks') && isPlainObject(cfg.hooks)) fileGone = removeIfPureSkeleton(settingsPath, () => true);
        else if (changed) fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
      }
    } catch { /* JSON 坏了不动,只删转发器 */ }
  }
  for (const f of ['session-start.mjs', 'prompt-guard.mjs', 'commit-refresh.mjs', 'read-guard.mjs', 'output-savings.mjs']) {
    try { fs.rmSync(path.join(hooksDir, f), { force: true }); } catch { /* 无该文件 */ }
  }
  try { fs.rmdirSync(hooksDir); } catch { /* 非空或不存在 */ }
  try { fs.rmdirSync(path.dirname(hooksDir)); } catch { /* 非空,留着 */ }
  ok(`[${path.basename(root)}] Qoder 工作区钩子已清理${fileGone ? '(空壳 settings.json 已删除)' : ''}(钩子在用户级 ~/.qoder-cn/settings.json)`);
}

/** Qoder CN 版用户级配置目录是 ~/.qoder-cn(国际版 ~/.qoder);已有目录优先,都没有按 CN 建。 */
export function qoderUserDir(home = os.homedir()) {
  const cn = path.join(home, '.qoder-cn');
  const intl = path.join(home, '.qoder');
  if (fs.existsSync(intl) && !fs.existsSync(cn)) return intl;
  return cn;
}

function hubCommand(script) {
  return 'node ' + path.join(here, script).split(path.sep).join('/');
}

/**
 * ZCode 用户级接线:~/.zcode/cli/config.json 的 hooks 键,绝对路径直指本模块脚本。
 * 该文件还存插件开关等其他状态,只动 hooks 键;同文件其他钩子保留。无 workspace 信任门控。
 */
export function rewriteZcodeUserHooks({ home = os.homedir() } = {}) {
  const cfgPath = path.join(home, '.zcode', 'cli', 'config.json');
  let cfg = {};
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      console.error(`[warn] ${cfgPath} 解析失败,未改(${e.message})`);
      return;
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cfg.hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {};
  cfg.hooks.enabled = true;
  const events = cfg.hooks.events && typeof cfg.hooks.events === 'object' && !Array.isArray(cfg.hooks.events) ? cfg.hooks.events : {};
  cfg.hooks.events = events;
  for (const key of Object.keys(events)) {
    if (Array.isArray(events[key])) events[key] = dropHookGroups(events[key], isOurZcodeHook);
  }
  const push = (name, group) => { events[name] = [...(Array.isArray(events[name]) ? events[name] : []), group]; };
  const readNudge = path.join(here, 'read-nudge.mjs');
  push('SessionStart', { matcher: 'startup|resume', hooks: [zcodeProcess(path.join(here, 'auto.mjs'), 420000, '索引保鲜检查(HEAD 驱动)+ 预热本地检索模型')] });
  push('PostToolUse', { matcher: 'Bash', hooks: [zcodeProcess(path.join(here, 'commit-refresh.mjs'), 10000, '提交后索引保鲜')] });
  push('PostToolUse', { matcher: '^Read$|^Bash$', hooks: [zcodeProcess(readNudge, 10000, '连续读导航+工具结果记账')] });
  push('PostToolUseFailure', { matcher: '^Read$|^Bash$', hooks: [zcodeProcess(readNudge, 10000, '读取失败导航')] });
  push('UserPromptSubmit', { hooks: [zcodeProcess(path.join(here, 'prompt-guard.mjs'), 10000, '模型变更检测+语义预取')] });
  push('PreToolUse', { matcher: '^Read$|^Bash$', hooks: [zcodeProcess(path.join(here, 'read-guard.mjs'), 10000, '超行数全量 Read/Bash 拦截')] });
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  ok(`[user] ZCode 用户级钩子已写入 ${cfgPath}(绝对路径直指本模块)`);
}

/**
 * Cursor 用户级接线:~/.cursor/hooks.json + ~/.cursor/hooks/ 转发器(Cursor 自己的用户级初始化也用这个目录)。
 * sessionStart/beforeSubmitPrompt 保留转发器(stdout 契约),preToolUse/beforeShellExecution 直呼 read-guard。
 */
export function rewriteCursorUserHooks({ home = os.homedir() } = {}) {
  const hooksDir = path.join(home, '.cursor', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'warm-code-index.mjs'), cursorForwarderSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'prompt-guard.mjs'), cursorPromptGuardSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'read-guard.mjs'), cursorReadGuardSource(hooksDir));
  try { fs.rmSync(path.join(hooksDir, 'output-savings.mjs'), { force: true }); } catch { /* 旧输出端统计钩子 */ }
  const cfgPath = path.join(home, '.cursor', 'hooks.json');
  let cfg = { version: 1, hooks: {} };
  if (fs.existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      console.error(`[warn] ${cfgPath} 解析失败,未改(${e.message})`);
      return;
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = { version: 1, hooks: {} };
  if (cfg.version == null) cfg.version = 1;
  if (!cfg.hooks || typeof cfg.hooks !== 'object' || Array.isArray(cfg.hooks)) cfg.hooks = {};
  for (const key of Object.keys(cfg.hooks)) {
    if (!Array.isArray(cfg.hooks[key])) continue;
    cfg.hooks[key] = cfg.hooks[key].filter(h => !isCodeIndexHookRef(h?.command));
    if (!cfg.hooks[key].length) delete cfg.hooks[key];
  }
  const win = p => p.split(path.sep).join('/');
  const ours = { command: `node ${win(path.join(hooksDir, 'warm-code-index.mjs'))}`, timeout: 600 };
  const guardHook = { command: `node ${win(path.join(hooksDir, 'prompt-guard.mjs'))}`, timeout: 10 };
  // Cursor 的 matcher 只认字面工具名,正则会被判"全部工具不支持"并整组跳过;转发器同进程读 stdin(Windows 直呼子进程接不到管道)
  const readHook = { command: `node ${win(path.join(hooksDir, 'read-guard.mjs'))}`, matcher: 'Read', timeout: 10 };
  const shellHook = { command: hubCommand('read-guard.mjs'), timeout: 10 };
  cfg.hooks.sessionStart = [ours, ...(cfg.hooks.sessionStart || [])];
  cfg.hooks.beforeSubmitPrompt = [guardHook, ...(cfg.hooks.beforeSubmitPrompt || [])];
  cfg.hooks.preToolUse = [readHook, ...(cfg.hooks.preToolUse || [])];
  cfg.hooks.beforeShellExecution = [shellHook, ...(cfg.hooks.beforeShellExecution || [])];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  ok(`[user] Cursor 用户级钩子已写入 ${cfgPath}`);
}

/**
 * Qoder 用户级接线:~/.qoder-cn/settings.json(CN 版;国际版 ~/.qoder)+ 同目录 hooks/ 转发器。
 * SDK 按 user → project → local 顺序合并 settings,同形状。
 */
export function rewriteQoderUserHooks({ home = os.homedir() } = {}) {
  const userDir = qoderUserDir(home);
  const hooksDir = path.join(userDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'session-start.mjs'), qoderWrapSource(hooksDir, 'auto.mjs', 'SessionStart'));
  fs.writeFileSync(path.join(hooksDir, 'prompt-guard.mjs'), qoderWrapSource(hooksDir, 'prompt-guard.mjs', 'UserPromptSubmit'));
  fs.writeFileSync(path.join(hooksDir, 'commit-refresh.mjs'), qoderPassthroughSource(hooksDir, 'commit-refresh.mjs'));
  fs.writeFileSync(path.join(hooksDir, 'read-guard.mjs'), qoderReadGuardSource(hooksDir));
  try { fs.rmSync(path.join(hooksDir, 'output-savings.mjs'), { force: true }); } catch { /* 旧输出端统计钩子 */ }
  const settingsPath = path.join(userDir, 'settings.json');
  let cfg = { hooks: {} };
  if (fs.existsSync(settingsPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      console.error(`[warn] ${settingsPath} 解析失败,未改(${e.message})`);
      return;
    }
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  const hooks = cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) ? cfg.hooks : {};
  cfg.hooks = hooks;
  for (const key of Object.keys(hooks)) {
    if (Array.isArray(hooks[key])) hooks[key] = dropHookGroups(hooks[key], (h) => isCodeIndexHookRef(h?.command));
  }
  const prepend = (name, group) => { hooks[name] = [group, ...(Array.isArray(hooks[name]) ? hooks[name] : [])]; };
  const fwd = f => path.join(hooksDir, f).split(path.sep).join('/');
  prepend('SessionStart', { hooks: [qoderCmd(fwd('session-start.mjs'), 420, '索引保鲜检查+预热本地检索模型')] });
  prepend('PostToolUse', { matcher: 'Bash|Shell', hooks: [qoderCmd(fwd('commit-refresh.mjs'), 10, '提交后索引保鲜')] });
  prepend('UserPromptSubmit', { hooks: [qoderCmd(fwd('prompt-guard.mjs'), 10, '模型变更检测')] });
  prepend('PreToolUse', { matcher: '^Read$|^Bash$', hooks: [qoderCmd(fwd('read-guard.mjs'), 10, '超行数全量 Read/Bash 拦截')] });
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
  ok(`[user] Qoder 用户级钩子已写入 ${settingsPath}`);
}

if (directRun) {
const hookArg = parseInitArgs(args).hooks;
const hookTools = resolveHookTargets(hookArg);
{
  const detected = detectAgent();
  if (hookArg) ok(`hooks = ${hookTools.join(',')} (--hooks)`);
  else if (detected) ok(`检测到当前为 ${detected},只接线该工具 hooks(其余可用 --hooks all 或 --hooks <名>)`);
  else ok('未识别当前 agent,接线 Cursor/ZCode/Qoder(可用 --hooks 指定)');
}
log(`\n[4/5]+[5/5] 对每个 git 仓库 root 接线会话 hook + AGENTS.md 检索纪律`);

/** 给一个 git 仓库根清理旧工作区钩子、AGENTS.md 纪律段(钩子本体在用户级,只在循环后装一次) */
function wireRepo(root) {
  if (hookTools.includes('zcode')) cleanZcodeWorkspaceHooks(root);
  if (hookTools.includes('cursor')) cleanCursorWorkspaceHooks(root);
  if (hookTools.includes('qoder')) cleanQoderWorkspaceHooks(root);
  const agentsPath = path.join(root, 'AGENTS.md');
  const MARK_V2 = '<!-- code-index:v2 -->';
  const rel = path.relative(root, here).split(path.sep).join('/');
  const dataRel = path.relative(root, DATA_DIR).split(path.sep).join('/');
  const searchCmd = PACKED_INSTALL
    ? 'npx tokensaver search <中英文关键词> --k 5'
    : 'cd ' + rel + ' && node search.mjs <中英文关键词> --k 5';
  const statusCmd = PACKED_INSTALL ? 'npx tokensaver status' : 'node ' + rel + '/status.mjs';
  const autoCmd = PACKED_INSTALL ? 'npx tokensaver auto' : 'cd ' + rel + ' && node auto.mjs';
  const rebuildCmd = PACKED_INSTALL
    ? 'npx tokensaver build && npx tokensaver embed'
    : 'cd ' + rel + ' && node build.mjs && node embed.mjs';
  const embedCmd = PACKED_INSTALL ? 'npx tokensaver embed' : 'node embed.mjs';
  const pathHint = PACKED_INSTALL
    ? '命令在仓库根执行(`npx tokensaver ...`),不要 cd 进 node_modules'
    : '派单/命令里的路径必须用正斜杠+引号(`cd "' + rel + '"`):git bash 下不带引号的反斜杠路径会被转义吞掉';
  const toolLabel = PACKED_INSTALL ? 'npx tokensaver' : rel;
  const P = (n, t) => n + '. ' + t;
  const items = [
    P(1, '**全局背景**:先读 `' + dataRel + '/CODE_MAP.md`(架构速查模板,随使用逐步充实;或自行维护项目架构说明)'),
    P(2, '**无条件先走索引**:定位/阅读/修改代码前先执行至少一次 `' + searchCmd + '`(默认混合检索,**不要加 --rerank**,精排要加载 reranker 会拖慢会话)。即使已有 file:行号也先检索核对;Grep 作补充。确需精排时再手动加 `--rerank`'),
    P(3, '按返回的 `file:起-止行` 用 Read 精读目标区间(offset/limit);定位阶段禁止未检索就整文件通读 500 行以上的大文件。Cursor/ZCode/Qoder 下超上限的全量 Read 与 Bash 里 cat 整读大文件都会被钩子拦截(拒绝信息自带检索/区间读/grep 替代方案),改走检索+区间读;同一目标 5 分钟内重试一次即放行。**修改类任务改动完成后,对所涉及文件做一次较大范围复查**(捕捉跨中间件/跨函数的副作用)'),
    P(4, pathHint),
    P(5, '**模型状态提示(原样转达一句)**:会话开始后先运行 `' + statusCmd + '`,把输出的那一句 ⚙ 原样附在每次回复末尾。该句只含三项:是否启动成功、嵌入模型名与精排模型名、失败时的最可能原因或成功时今日已节约的 tokens 与累计百分比(每天 24:00 清零)。不要加长、不要改写;没有这句输出时不得虚构'),
    P(6, '**知识沉淀**:完成某文件的深挖/修复/排查后,若 `' + dataRel + '/code-index.config.json` 的 knownAnnotations 无该文件条目,追加一条(格式:`"项目名/相对路径": "一句话职责+关键机制"`,≤50 字);仅真实读码理解后写入,禁止批量生成;写后校验 JSON 合法'),
    P(7, '**提交后保鲜**:执行 `git commit` 后,运行 `' + autoCmd + '`(HEAD 没变秒级跳过;有变更时 build 内联约 10s+嵌入转后台)——有 PostToolUse hook 的环境已自动做,重复触发零成本'),
    P(8, '索引保鲜由会话 hook 自动判定(git 仓库按 HEAD,非 git 目录 24h 回退;嵌入路径或模型变更则重嵌)。手动重建:`' + rebuildCmd + '`。向量过期或切换嵌入模型时运行 `' + embedCmd + '`(只更新当前路径 data/vectors;维度不一致或 `--force` 时该目录全量),完成后以 `' + statusCmd + '` 验证。所选嵌入路径(init --model-in ollama|local)拉起失败时检索降级 bm25;显式 `--mode bm25` 可主动选用'),
    P(9, '**文档英文**:`README.md` 与 code-index 的 `部署使用说明.txt` 在中文正文后各有一段英文译文。修改时保留英文段,并按改过的中文改对应英文。禁止删掉英文只留中文。`npm/部署使用说明.txt` 由 sync-npm 从 code-index 那份生成,改源文件后重新同步,不要单独删英文'),
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
      ok(`[${path.basename(root)}] AGENTS.md 纪律段已按当前模板更新(9 条)`);
    }
  } else if (content) {
    fs.appendFileSync(agentsPath, snippet);
    ok(`[${path.basename(root)}] AGENTS.md 已追加检索纪律段(9 条)`);
  } else {
    fs.writeFileSync(agentsPath, block);
    ok(`[${path.basename(root)}] AGENTS.md 已写入检索纪律段(9 条)`);
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
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code-index.config.json'), 'utf8')).roots || []; }
  catch { return []; }
})();
const wireRoots = [...new Set([repoRoot, ...effRoots.map(r => path.resolve(r))])];
for (const r of wireRoots) {
  if (fs.existsSync(path.join(r, '.git'))) {
    wireRepo(r);
    const giEntries = r === repoRoot
      ? gitignoreEntries({ packed: PACKED_INSTALL, repoRoot, moduleDir: here, dataDir: DATA_DIR })
      : [...EDITOR_IGNORE];
    ensureGitignore(r, giEntries);
  } else console.error(`  [note] ${r} 非 git 仓库,只索引不接线(无 AGENTS.md/hooks)`);
}

// 钩子本体统一装在用户级:所有工作区共享一份,绝对路径直指本模块,不依赖各仓的 workspace 信任审批
log(`\n[user] 用户级钩子接线(${hookTools.join(', ')})`);
if (hookTools.includes('zcode')) rewriteZcodeUserHooks();
if (hookTools.includes('cursor')) rewriteCursorUserHooks();
if (hookTools.includes('qoder')) rewriteQoderUserHooks();

log(`\n============ 初始化完成 ============`);
// CODE_MAP 模板(项目资产,位于 data/;已存在则不动)
const codeMapPath = path.join(DATA_DIR, 'CODE_MAP.md');
if (!fs.existsSync(codeMapPath)) {
  fs.writeFileSync(codeMapPath, `# CODE_MAP —— 项目代码知识地图(由 agent 在深挖中持续维护)\n\n> 用法:先读本文获得全局背景 → node search.mjs 检索定位 → 按行区间精读。\n> 建议内容:项目架构图、核心链路、关键文件职责、已知问题速查。\n\n(模板生成于 ${new Date().toISOString().slice(0, 10)};请按项目实际逐步充实,knownAnnotations 同步沉淀)\n`);
  ok(`已生成 CODE_MAP 模板:${codeMapPath}(请逐步充实)`);
}
log(`提示:项目资产在 ${DATA_DIR}(config/CODE_MAP/索引)。Ollama/local 模型权重不随本目录复制。`);
}
