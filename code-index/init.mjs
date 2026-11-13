#!/usr/bin/env node
/**
 * 枢纽初始化。在 TokenSaver/code-index 运行(数据始终写在本工具仓的 data/,不写进业务仓):
 *   node init.mjs [--roots "D:/repoA,D:/repoB"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder]
 *
 * --roots 纳入扫描目录(与已有 roots 合并,不覆盖)。以后改 data/code-index.config.json 的 roots,
 * 再跑一次不带参数的 node init.mjs 即可:自愈仍存在的路径、给新 git 仓挂钩子、后台按配置重建索引。
 *
 * --model-in 决定嵌入路径,写入 data/code-index.config.json 的 modelIn;本地决策判定(2026-11-08 本地化)
 * 跟随同一路径,不再依赖任何远程网关:
 *   local(新建配置时的默认) —— 常驻进程加载 models.localEmbedding、models.localReranker 与
 *     models.localDecision(strands:strands-decider-2B-hobson-v19,权重在 code-index/hf-cache/,纯 Node 指针头);常驻不在时嵌入当次进程内加载,决策票弃权。不依赖 Ollama
 *   ollama —— 通过已运行的 Ollama 加载 models.embedding、models.reranker 与 models.decision(tev1:0.8b)
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
 *      Cursor 另接 beforeSubmitPrompt → prompt-guard(透传 additionalContext 注入;改嵌入模型才后台重嵌)+ afterAgentResponse → agent-usage(token 记账)。
 *      三套都接 Read/终端整读拦截(超限先改写语义区间,选不出再 deny;区间读放行;5 分钟内重试放行;出错 fail-open):
 *      Cursor preToolUse 两条字面 matcher(Read、Grep)+beforeShellExecution(cat)+postToolUse 字面 Bash(git commit 保鲜);
 *      ZCode/Qoder PreToolUse ^Read$|^Bash$|^Grep$。正则不能写进 Cursor 的 matcher,否则整组被跳过。
 *      (三端 PostToolUse → read-nudge;ZCode/Qoder 的提交保鲜 matcher 为 Bash / Bash|Shell)。
 *      --hooks all|cursor|zcode|qoder 可覆盖。每次运行只重写选中工具的用户级配置里本模块的钩子;
 *      同文件里的其他钩子保留。JSON 解析失败则不改该文件。
 *   4b) ZCode 专用:幂等播种虚拟供应商条目 tokenSaverModel(~/.zcode/v2/provider_config.json;
 *      baseUrl→本地代理(auto 前缀 /apps/zcode(2026-11-07 前缀统一 /apps/<宿主>)),模型清单恒为单 auto 档(2026-11-02 档位制取代镜像清单制),
 *      占位 key 零真实凭据)。
 *      条目惰性:不被会话选中即零行为,选中=人工启用(#11 口径);已存在(含人工改过)原样保留,
 *      刷新=删条目重跑 init;写前备份 .bak-tokensaver;uninit 对称移除。宿主行为三项已活体验证
 *      (2026-11-01):外部写入被接受、热生效(改后 12s 内客户端按新 baseUrl 发请求)、运行期与重启不反向覆写。
 *   4c) Qoder 专用:同策略播种用户级自定义模型条目 tokensaver-auto(单 auto 档,
 *      baseUrl=http://127.0.0.1:8117/apps/qoder;前缀区分宿主,代理按前缀判路由池,见 #14 双端隔离)。
 *   5) AGENTS.md:已有 code-index 标记则替换纪律段(含文档英文一条),没有则追加;文件不存在则新建。
 *      再追加或替换末尾的输出纪律段(<!-- output-diet-v10 -->;遇旧版本段与旧 Ponytail 段一并迁移剥离),不改纪律段和其他原文。
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
import { DEFAULT_CONFIG, DATA_DIR, PACKED_INSTALL, findGitRoot, KNOWN_ANNOTATIONS_PATH, loadKnownAnnotations } from './config.mjs';
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

/**
 * knownAnnotations 迁移(2026-11-07 用户拍板:注解库拆出 config,独立 data/known-annotations.json):
 * 旧 config 键存在 ⇒ 条目并入新文件(新文件已有条目优先,旧条目补缺),然后从 config 删键。
 * 幂等:config 无该键时零动作。纯 I/O 在调用方(init 主流程),本函数可测。
 */
export function migrateKnownAnnotations(cfgOld, annFile = KNOWN_ANNOTATIONS_PATH) {
  const old = cfgOld && cfgOld.knownAnnotations;
  if (old === undefined) return { migrated: 0, removedKey: false };
  if (!old || typeof old !== 'object' || Array.isArray(old) || !Object.keys(old).length) {
    delete cfgOld.knownAnnotations;
    return { migrated: 0, removedKey: true };
  }
  let cur = {};
  try {
    const j = JSON.parse(fs.readFileSync(annFile, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) cur = j;
  } catch { cur = {}; }
  let added = 0;
  for (const [k, v] of Object.entries(old)) if (!(k in cur)) { cur[k] = v; added += 1; }
  fs.mkdirSync(path.dirname(annFile), { recursive: true });
  fs.writeFileSync(annFile, JSON.stringify(cur, null, 2) + '\n');
  delete cfgOld.knownAnnotations;
  return { migrated: added, removedKey: true, total: Object.keys(cur).length };
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

export const DIET_MARK = '<!-- output-diet-v10 -->';

/** 输出纪律块:标记行 + output-diet.md 全文(内容同步自 A/B 实验的 v7 定稿,防漂移由 init.test 断言)。 */
export function dietBlock(hereDir) {
  const body = fs.readFileSync(path.join(hereDir, 'output-diet.md'), 'utf8').trim();
  return `${DIET_MARK}\n${body}\n`;
}

/** 纯函数:给定 AGENTS.md 原文与纪律块,返回应用后的全文(追加/替换文末输出纪律段,剥离旧 Ponytail 段)。
 * shortcut: 注入段按 init 惯例恒为文末段,剥离即从标记切到文末。 */
export function applyDiet(content, block) {
  const pi = content.indexOf('<!-- ponytail -->');
  if (pi >= 0) content = content.slice(0, pi).replace(/\s+$/, '');
  const re = /<!-- output-diet[^>]* -->[\s\S]*$/;
  if (re.test(content)) return content.replace(re, block);
  if (content && !content.endsWith('\n')) content += '\n';
  return content + (content ? '\n' : '') + block;
}

/** 注入段跟随目标文件行尾:模板恒为 LF,仓内多是 CRLF,混用会让整文件显示为已改。 */
export function withEol(text, eol) {
  return eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
}

/** 刷新单仓 AGENTS.md 两个注入段(检索纪律 + 输出纪律),不碰 hooks/索引;init 与 deploySync 共用。 */
function wireAgents(root) {
  const agentsPath = path.join(root, 'AGENTS.md');
  const rel = path.relative(root, here).split(path.sep).join('/');
  const dataRel = path.relative(root, DATA_DIR).split(path.sep).join('/');
  const content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
  const eol = content && content.includes('\r\n') ? '\r\n' : '\n';
  const nItems = disciplineItems({ rel, dataRel, packed: PACKED_INSTALL }).length; // 条数从清单推导,不再硬编码
  const block = withEol(disciplineBlock({ rel, dataRel, packed: PACKED_INSTALL }), eol);
  const snippet = eol + block;
  // 标记与标题之间允许空行(如 prettier 会插入),否则匹配失败会再追加一段
  // 标记行做锚(2026-11-08 加固):不再锚定标题文字——用户改过 `## 代码检索纪律` 标题也能命中替换,
  // 不会走追加分支产生双段;lookahead 兼容另一段 code-index/ponytail/output-diet 标记与任意 H2。
  // 匹配体必须吞掉标记行+标题行(标题文字可变),否则 lookahead 会命中段内自己的 H2 只换掉标记行。
  const sectionRe = /<!-- code-index[^>]*-->[^\r\n]*\r?\n[^\r\n]*[\s\S]*?(?=\r?\n<!-- (?:code-index|ponytail|output-diet)[^>]* -->|\r?\n## |$)/;
  if (content && sectionRe.test(content)) {
    // 全局替换兼历史双段自愈:第一段换新块,旧版本(标题被改时追加)残留的多余 code-index 段一并剥除
    let seen = false;
    const next = content.replace(new RegExp(sectionRe.source, 'g'), (m) => {
      if (seen) return '';
      seen = true;
      return block;
    });
    if (next === content) ok(`[${path.basename(root)}] AGENTS.md 纪律段已与当前模板一致,跳过`);
    else {
      fs.writeFileSync(agentsPath, next.endsWith('\n') ? next : next + eol);
      ok(`[${path.basename(root)}] AGENTS.md 纪律段已按当前模板更新(${nItems} 条)`);
    }
  } else if (content) {
    fs.appendFileSync(agentsPath, snippet);
    ok(`[${path.basename(root)}] AGENTS.md 已追加检索纪律段(${nItems} 条)`);
  } else {
    fs.writeFileSync(agentsPath, block);
    ok(`[${path.basename(root)}] AGENTS.md 已写入检索纪律段(${nItems} 条)`);
  }
  upsertDiet(agentsPath);
}

/** 追加或替换文末输出纪律段;旧 Ponytail 段一并剥离(实测反效果)。 */
function upsertDiet(agentsPath) {
  const content = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const next = withEol(applyDiet(content, dietBlock(here)), eol);
  if (next === content) { ok(`[output-diet] 已在文末,跳过`); return; }
  fs.writeFileSync(agentsPath, next.endsWith('\n') ? next : next + eol);
  ok(content.includes('output-diet') ? `[output-diet] 已按 output-diet.md 更新文末段落` : `[output-diet] 已追加到 AGENTS.md 末尾`);
}

/** modelRouting 配置骨架(#11):结构就位、开关默认关闭;四档链由运行时快照自动派生,无 chains 配置。人工配置后 init 绝不覆盖。配置方法见 部署使用说明.txt 与 README。 */
export function modelRoutingScaffold() {
  return {
    enabled: false,
    // 实弹路由(2026-11-03 用户终裁):role 两档制已废,tier 四档难度制唯一(classifyDifficulty 定档 →
    // resolveTier 降档级联;routeMode/roles/chains 配置键已删,不再被读取)。
    // 运行时 429/5xx 同轮重选(2026-11-03):默认 true——转发拿到可重试错误(429/500/502/503/529)时不向客户端
    // 透传空回复,而是同轮冷却失败模型→重跑 resolveTier(档内滑下一个 / R4→R3→R2→R1 降档)→换模型重发;
    // maxRetries=同轮最多重发次数(默认 2,硬上限 5)。只在 tier 模式且能重解析出新模型时才真的重发,否则等价旧的单次透传。
    // 失败轮本就拿不到回复,同轮重试是纯改善;设 retryOnRateLimit:false 整体关闭回到"透传单次错误"旧行为。
    retryOnRateLimit: true,
    maxRetries: 2,
    // L2 配置(2026-11-07 嵌套收口):shadow=嵌入器资源总闸(原顶层 l2Shadow);vote=代签投票阈值(原 l2.minSim/minConf);
    // live=线上路由救回(原顶层 l2Live)——总闸关则两条支路都拿不到嵌入器、静默零影响。旧键双读兼容一个版本期。
    l2: { shadow: false, vote: { minSim: 0.55, minConf: 0.6 }, live: { enabled: false, minConf: 0.3 } },
    // R3 词法通道总闸(2026-11-08 v2 重建裁定):enabled=词法 R3(顶格词+独立印证同击)总闸;eagerEscalate=
    // P2 提前一拍(R2 难度任务第 1 次报错即上 R3,不等第 2 连败)。缺省双开(直接实弹用户裁定),
    // 代码 fail-open 同价语义;任一显式 false 即关对应通道。词表本体在 tierClassify.mjs,不进优化器网格。
    r3Lexical: { enabled: true, eagerEscalate: true },
    // 决策模型判定(v4 2026-11-09 本地化收口,2026-11-03 三投票定档已正式化为四票合议):
    // 判定**恒本地**(modelIn=ollama 打 models.decision tev1:0.8b / local 打常驻 models.localDecision
    // Strands q8),零远程调用;整段旧键 model/providers/chunkSize/rRef 已废弃不读——实弹 arm1/arm2
    // 参数与代签门槛全走模型判定档案(modelRouting.decisionModel.profiles 可覆盖,未建档回退代码默认)。
    // 失败自动跳闸(恢复=人工 --probe 探活或下次会话启动自动探活);复核 CLI 只出报告不改量尺。
    // model=判定模型名(仅显式远程用,空=内置 decision-model-preview);providers=[{baseUrl,apiKey,path?}]
    // 配了真条目才走远程;空数组/全空模板条目(占位示例)/未配=本地判定(默认启用)。
    // 判定恒 1 题一判(2026-11-08 v2.7:chunkSize 不再支持配置——16 题批量稀释置信 97% 弃权,1 题/请求最佳)。
    decisionModel: {
      enabled: false, model: '', providers: [{ baseUrl: '', apiKey: '', path: '' }],
      // R-ref 预兜底票(2026-11-08 v2.1→v2.6):前置到路由侧,两臂——arm1 只补"词法最瞎区"(歧义 R1,置信≤0.5
      // 的 default 兜底前一段);arm2(R2→R3 判定救回)在词法定档 R2 时现查判定模型,法官投 R3 且过 r3MinConf ⇒
      // 救回 R3 执行,判定失败/投他档维持 R2(fail-open)。本段参数与总闸一样只对显式远程生效:
      // 本地判定时恒 live=true / r3Rescue=true(参数走代码默认);远程才按本配置读写。
      rRef: { live: true, minConf: 0.75, maxChars: 1200, r3Rescue: true, r3MinConf: 0.85 },
    },
    // auto 综合费率行开关(2026-11-06):prompt-guard 每轮注入"最近会话实际费 ÷ R3 基准费"倍率行的总开关
    // (仅路由宿主);enabled=false 只停注入,记账照常。价格表=data/routing/model-prices.json。
    blendNotice: { enabled: true },
    // 生效宿主范围(2026-11-03 用户终裁):hosts 配置项已废——运行时恒按用户级目录自动检测
    // (prompt-guard.mjs routingHostsOf),检测不到的端不在路由面,重新部署 init 即恢复,不兜底。
    // 四档链恒由运行时从实时快照自主派生(2026-11-03 起 role 人工链/roles 映射/routeMode 已废,
    // 不再有 chains 配置逃生通道;档内排序=brandPriority 品牌优先序+价格)。
    // 供应商优先级(2026-11-03 恢复播种):**同名模型挂多个供应商**(如多个 Token Plan、额度不同)时
    // 决定"同名谁先被调"——数组越靠前越先;冷却/配额尽自动滑到下一供应商的同名模型(健康冷却按
    // providerId/modelId 隔离)。空数组=按快照键序取第一个持有者;也可在链里用 模型@供应商 钉死。
    providerPriority: [],
    // 品牌调用优先序(2026-11-03 用户需求):自定义品牌顺序,只决定"四档链同一档位内谁先被调",
    // **不影响档位归属**(tierOfModel/classifyDifficulty/resolveTier 级联照旧)= 不影响动态路由的调用档位。
    // 未列出的品牌排到所有已列品牌之后;改这里即可覆盖默认序。tier 模式(或四档影子)消费。
    brandPriority: ['glm', 'deepseek', 'qwen', 'minimax', 'kimi', 'grok', 'claude', 'gpt', 'gemini'],
    // 品牌三档默认表(2026-11-06 v4 用户定档;v4.1 grok/gemini 移入 mid):模型名 → 档位的品牌面。
    // normal=deepseek/glm/qwen/minimax(默认 R2),mid=kimi/grok/gemini(默认 R3),high=claude/gpt(默认 R4);未识别品牌按 normal 兜底。
    // 轻量后缀(lightSuffixes)把默认档降一档(flash 恒 R1)。pro/max 不特殊:档位语义与品牌等级一一对应。改这里即重排全链。
    modelTiers: { normal: ['deepseek', 'glm', 'qwen', 'minimax'], mid: ['kimi', 'grok', 'gemini'], high: ['claude', 'gpt'] },
    // 轻量版本后缀(2026-11-06 v4;v4.1 补 sol/sonnet,再补 code/coder——编码款按轻量款降档):命中任一 token 视为轻量版,品牌默认档降一档(R1 封底);可增删。
    lightSuffixes: ['flash', 'preview', 'coding', 'code', 'coder', 'turbo', 'mini', 'air', 'nano', 'event', 'haiku', 'luna', 'lite', 'base', 'sol', 'sonnet'],
    // 阶段轮数上限(2026-11-04 自 switchGuard 迁出):升档阶段最多持续的人类轮数,到顶回主循环;
    //   恒生效、不受切换税门控开关控制——语义属阶段生命周期,不属门控;旧位置 switchGuard.maxPhaseTurns 仍兼容读取。
    maxPhaseTurns: 4,
    // 切换税门控(#3):升档前估算上下文 tokens(标定口径 bytes/3.2),超阈值则不换档;**只拦升档**——
    // R1 降档当轮即省钱,不受门控(2026-11-04 成本复算修正)。
    // 阈值口径:冷读一口税 ≈ 0.34 credits/千 tokens(reasoner 档实测);原 32000(≈11 credits)与用户
    // 2026-11-01 定调"切换税相对长期占用高价模型划算、不是障碍"冲突 ⇒ 抬到 200000(≈640KB 请求体),
    // 只在极厚上下文才拦;2026-11-05 用户定档:门控默认开启(极厚上下文升档的冷读税不值得付),
    // 要放行改 data 配置 switchGuard.enabled=false。
    switchGuard: { enabled: true, maxContextTokens: 200000 },
// 难度档迭代优化 + 自进化闭环(2026-11-04):enabled=true 后 --check 后台分支在扩样后顺跑一轮 tierOptimize——
  //   学逐信号倍数 + 搜门槛小网格,折外代价过门控才落候选(恒 disabled,绝不碰 live);
  //   自动晋升=连续 2 轮接受(间隔≥半节流窗)+逐折无回归+签名异于 live 才通电,晋升满观察窗(默认 24h)后
  //   成本中位恶化>15% 自动回滚 prev 并冷却签名;--enable/--disable/--rollback-now 手动晋升/关回/回滚。
  //   词表永不自动改;allowBoost=false 时高纯度信号只降不升(升档 8 倍价,升权等于加杠杆)。
    tierOptimize: { enabled: false, minIntervalMs: 6 * 60 * 60 * 1000, folds: 5, minN: 6, priorN: 8, grow: true, fitCost: false, dry: false, allowBoost: false },
  };
}

/**
 * 确保 cfg 有 modelRouting 段(三级播种,人工配置零覆盖):
 *   ① modelRouting 段缺失 → 播种整骨架;
 *   ② 段在但缺 decisionModel / tierOptimize / blendNotice(或非对象)→ 只补缺的键,骨架各参数全关(enabled:false);
 *   ③ 已存在 → 原样保留(含人工配置的 model/providers/key),init 绝不覆盖。
 * 返回 {cfg,seeded,patched}:seeded=整段新建,patched=只补了缺失子键。
 */
export function ensureModelRoutingSection(cfg) {
  if (cfg && typeof cfg === 'object' && cfg.modelRouting && typeof cfg.modelRouting === 'object' && !Array.isArray(cfg.modelRouting)) {
    const mr = cfg.modelRouting;
    const scaffold = modelRoutingScaffold();
    const add = {};
    if (!mr.decisionModel || typeof mr.decisionModel !== 'object' || Array.isArray(mr.decisionModel)) add.decisionModel = scaffold.decisionModel;
    // tierOptimize 缺失补默认关的骨架(2026-11-04):补上键不等于通电,enabled 仍 false
    if (!mr.tierOptimize || typeof mr.tierOptimize !== 'object' || Array.isArray(mr.tierOptimize)) add.tierOptimize = scaffold.tierOptimize;
    // blendNotice 缺失补默认开骨架(2026-11-06):人工改过则原样保留
    if (!mr.blendNotice || typeof mr.blendNotice !== 'object' || Array.isArray(mr.blendNotice)) add.blendNotice = scaffold.blendNotice;
    // 品牌三档表/轻量后缀缺失补默认骨架(2026-11-06 v4):人工配置过(哪怕空数组)原样保留
    if (!mr.modelTiers || typeof mr.modelTiers !== 'object' || Array.isArray(mr.modelTiers)) add.modelTiers = scaffold.modelTiers;
    if (!Array.isArray(mr.lightSuffixes)) add.lightSuffixes = scaffold.lightSuffixes;
    // l2 嵌套骨架缺失补默认关(2026-11-07 收口):旧配置有 l2Shadow/l2Live/旧 l2 任一键时不补(由 resolveL2Config 双读兼容接管,人工配置原样保留)
    if ((!mr.l2 || typeof mr.l2 !== 'object' || Array.isArray(mr.l2)) && mr.l2Shadow === undefined && mr.l2Live === undefined) add.l2 = scaffold.l2;
    // r3Lexical 缺失补默认开骨架(2026-11-08 v2):词法 R3 同击制 kill-switch(缺省双开=代码 fail-open 同价语义),人工改过则原样保留
    if (!mr.r3Lexical || typeof mr.r3Lexical !== 'object' || Array.isArray(mr.r3Lexical)) add.r3Lexical = scaffold.r3Lexical;
    if (Object.keys(add).length) {
      return { cfg: { ...cfg, modelRouting: { ...mr, ...add } }, seeded: false, patched: true };
    }
    return { cfg, seeded: false, patched: false };
  }
  return { cfg: { ...cfg, modelRouting: modelRoutingScaffold() }, seeded: true, patched: false };
}

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
  // knownAnnotations 迁移(2026-11-07):旧 config 键 → data/known-annotations.json(幂等,无键零动作)。
  // 必须先于 roots 逻辑:roots 变化会重置注解库,先迁移才不会丢掉旧 config 里的沉淀。
  const annMig = migrateKnownAnnotations(cfgOld);
  if (annMig.removedKey) {
    dirty = true;
    ok(`knownAnnotations 已迁出 config → data/known-annotations.json(并入 ${annMig.migrated} 条,库内共 ${annMig.total ?? 0} 条)`);
  }
  if (rootsArg) {
    const added = takeExistingRoots(rootsArg);
    if (!added.length && !(cfgOld.roots || []).length) {
      console.error('[err] --roots 没有可用路径,未改配置');
      process.exit(1);
    }
    roots = mergeRoots(cfgOld.roots || [], added);
    if (JSON.stringify(roots) !== JSON.stringify(cfgOld.roots || [])) {
      cfgOld.roots = roots;
      // roots 变化 ⇒ 注解库整表重置(2026-11-07 起作用于独立文件,不再在 config 里)
      const prevAnn = loadKnownAnnotations();
      const rolled = rollKnownAnnotations(prevAnn, true);
      if (Object.keys(prevAnn).length) {
        fs.writeFileSync(KNOWN_ANNOTATIONS_PATH, JSON.stringify(rolled, null, 2) + '\n');
        ok(`roots 已变化,known-annotations.json 整表重置(${Object.keys(prevAnn).length} 条旧注解只对原 roots 有效)`);
      }
      dirty = true;
      ok(`已纳入 roots = ${JSON.stringify(roots)}`);
    } else {
      roots = cfgOld.roots || [];
      ok(`roots 未变化,known-annotations.json 增量保留 ${JSON.stringify(roots)}`);
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
  // modelRouting 骨架播种(#11):段缺失建整骨架,缺可选子键(decisionModel/tierOptimize/blendNotice/modelTiers/lightSuffixes/l2Live)只补对应键;人工配置原样保留
  const mr = ensureModelRoutingSection(cfgOld);
  if (mr.seeded) {
    cfgOld.modelRouting = mr.cfg.modelRouting;
    dirty = true;
    ok('[user] data 配置已建 modelRouting 骨架(开关关闭,四档链运行时自动派生)');
  } else if (mr.patched) {
    cfgOld.modelRouting = mr.cfg.modelRouting;
    dirty = true;
    ok('[user] data 配置 modelRouting 缺可选子键(decisionModel/tierOptimize/blendNotice/modelTiers/lightSuffixes/l2),已补默认骨架(其余键原样保留,不覆盖人工配置)');
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
    // 首装不带 --roots(2026-11-07 用户定案):roots 留空完成安装(钩子/配置/纪律段全就位),
    // 索引面等用户配置项目目录后重跑 init 或 build 再建——成功框会给出配置指引。
    roots = [];
    ok('未传 --roots:roots 置空完成安装(钩子与配置已就位);请在 data/code-index.config.json 的 roots 填入项目目录后重跑 node init.mjs(见下方提示框)');
  }
  const desc = '项目配置。数据在 TokenSaver 自己的 data/。改 roots 后重新 node init.mjs(不必带参)即纳入新目录并挂钩子。未写的键用 config.mjs 默认值。模型名、ollamaBase、gpu、OLLAMA_KEEP_ALIVE、OLLAMA_NUM_CTX 只写 config.mjs。roots: 本文件为清单;init --roots 并入;CODE_INDEX_ROOTS 运行时可临时盖掉。modelIn: --model-in > 本文件 > local。skipDirs 整表替换。v2Dir: ZCode 数据存储路径迁移后填实际路径(带/不带 .zcode/v2 均可,空=默认 ~/.zcode/v2)。staleNonGitMs: 非git root 的重建回退时钟(毫秒,默认 86400000=24h;git root 走 HEAD 指纹,不受此值影响)。knownAnnotations 已拆出本文件(2026-11-07):独立存 data/known-annotations.json,首装为空;init --roots 使 roots 变化时整表重置,未变则原样保留,由深挖后手工追加。';
  const skipDirs = [...new Set([...DEFAULT_CONFIG.skipDirs, path.basename(here), 'code-index', '.cursor', '.zcode', '.qoder'])];
  fs.writeFileSync(configPath, JSON.stringify({
    $说明: desc,
    // v2Dir/staleNonGitMs 落盘(2026-11-08):结果框指引与实物对齐——用户直接改值即可,不必自建键
    v2Dir: '',
    roots,
    modelIn: chosenBackend,
    skipDirs,
    staleNonGitMs: DEFAULT_CONFIG.staleNonGitMs,
    modelRouting: modelRoutingScaffold(),
  }, null, 2));
  // 注解库独立文件(2026-11-07 拆出 config):首装建空表,已有则不动(增量沉淀)
  if (!fs.existsSync(KNOWN_ANNOTATIONS_PATH)) {
    fs.mkdirSync(path.dirname(KNOWN_ANNOTATIONS_PATH), { recursive: true });
    fs.writeFileSync(KNOWN_ANNOTATIONS_PATH, '{}\n');
  }
  ok(`已生成,roots = ${JSON.stringify(roots)},嵌入路径 = ${chosenBackend};skipDirs 含内置默认 + "code-index"(hub 模式下由 build 放行工具目录)`);
}
if (!configExisted || modelInArg) {
  if (chosenBackend === 'local') {
    const embId = DEFAULT_CONFIG.models.localEmbedding;
    const rrId = DEFAULT_CONFIG.models.localReranker;
    const decId = DEFAULT_CONFIG.models.localDecision;
    const bundled = localOnnxCached(embId) && localOnnxCached(rrId) && localOnnxCached(decId);
    console.error(`  [注意] 嵌入路径为 local:transformers.js 由常驻进程加载,不依赖 Ollama。常驻不在时当次进程内加载。`);
    console.error(bundled
      ? '        本目录 hf-cache 已含嵌入/精排/决策三个模型权重,无需下载。'
      : '        hf-cache 缺权重,首次使用会下载。');
    console.error(`        嵌入 ${embId}`);
    console.error(`        精排 ${rrId}(q8)`);
    console.error(`        决策 ${decId}(本地判定,替代远程 decision-model-preview)`);
  } else {
    console.error('  [注意] 嵌入路径为 ollama。目标电脑需已安装 Ollama 客户端,并**手工** pull(本模块不自动拉取):');
    console.error(`        ollama pull ${DEFAULT_CONFIG.models.embedding}`);
    console.error(`        ollama pull ${DEFAULT_CONFIG.models.reranker}`);
    console.error(`        ollama pull ${DEFAULT_CONFIG.models.decision}(本地决策判定,替代远程 decision-model-preview)`);
  }
  console.error('        该路径拉起失败时检索降级 bm25,不自动改换另一条路径;决策模型拉起失败则决策票弃权(fail-open)。');
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
  // output-savings 已下线,仍匹配以便 rewrite 时卸掉旧钩子;尾部允许附加事件名参数(read-nudge 复用同一转发器)
  if (/(?:^|\/)(?:warm-code-index|output-savings|prompt-guard|read-guard|read-nudge|commit-refresh|snapshot-refresh|agent-usage-scan|agent-usage|turn-close)\.mjs(?:\s+\S+)?$/.test(s)) return true;
  // settings.json 里存的是整条命令(`node .qoder/hooks/...`),.qoder 前是空格而非 /,故前缀要含空白和引号
  if (/(?:^|[\s/"'])\.qoder(?:-cn)?\/hooks\/(?:session-start|prompt-guard|commit-refresh|read-guard|read-nudge|turn-close)\.mjs(?:\s+\S+)?$/.test(s)) return true;
  if (/(?:^|[\s/"'])\.zcode\/hooks\/(?:session-start|prompt-guard|commit-refresh|read-guard)\.mjs$/.test(s)) return true;
  const dir = path.basename(here).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = 'agent-usage|agent-usage-scan|auto|commit-refresh|prompt-guard|read-guard|read-nudge|snapshot-refresh|warm|output-savings|turn-close';
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
  const body = `const child = spawn(process.execPath, [entry, '--host', 'cursor'], { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let out = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => { out += c })
child.on('error', () => { process.stdout.write('{"continue":true}'); process.exit(0) })
child.on('exit', () => {
  try {
    const parsed = JSON.parse(out)
    const payload = { continue: parsed.continue !== false }
    if (typeof parsed.additionalContext === 'string' && parsed.additionalContext) payload.additionalContext = parsed.additionalContext
    process.stdout.write(JSON.stringify(payload))
  } catch {
    process.stdout.write('{"continue":true}')
  }
  process.exit(0)
})
`;
  return hookScript(hooksDir, 'prompt-guard.mjs', 'Cursor beforeSubmitPrompt: 转发 prompt-guard.mjs(模型变更则后台重嵌)。透传 additionalContext(Cursor 3.27.22 beforeSubmitPrompt schema 原生支持,实证见 model-routing.md #15);解析失败/超时一律 fail-open 回 {"continue":true},绝不拦截用户输入。', body);
}

function cursorReadGuardSource(hooksDir) {
  const entryExpr = hookEntryExpr(hooksDir, 'read-guard.mjs');
  const rel = path.relative(hooksDir, path.join(here, 'read-guard.mjs'));
  // 同进程读 Cursor 写入的 stdin。Windows 上子进程 inherit 接不到后写入的管道,空输入会放行。
  const head = path.isAbsolute(rel)
    ? `import { pathToFileURL } from 'node:url'\n`
    : `import path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
  return `/** Cursor preToolUse Read/Grep: 同进程调用 read-guard.mjs。改写输出 updated_input;选不出区间才 deny;失败则 allow。 */\n${head}const entry = ${entryExpr}\nlet raw = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { raw += c })\nprocess.stdin.on('end', async () => {\n  try {\n    const { runReadGuard } = await import(pathToFileURL(entry).href)\n    await runReadGuard({ stdinText: raw })\n  } catch {\n    process.stdout.write('{"permission":"allow"}')\n  }\n})\n`;
}

function cursorReadNudgeSource(hooksDir) {
  const entryExpr = hookEntryExpr(hooksDir, 'read-nudge.mjs');
  const rel = path.relative(hooksDir, path.join(here, 'read-nudge.mjs'));
  const head = path.isAbsolute(rel)
    ? `import { pathToFileURL } from 'node:url'\n`
    : `import path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
  return `/** Cursor postToolUse/postToolUseFailure: 同进程调用 read-nudge.mjs,输出 additionalContext 导航;失败静默。 */\n${head}const entry = ${entryExpr}\nlet raw = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { raw += c })\nprocess.stdin.on('end', async () => {\n  try {\n    const { runReadNudge } = await import(pathToFileURL(entry).href)\n    await runReadNudge({ stdinText: raw })\n  } catch {\n    process.stdout.write('{}')\n  }\n})\n`;
}

function cursorCommitRefreshSource(hooksDir) {
  const entryExpr = hookEntryExpr(hooksDir, 'commit-refresh.mjs');
  const rel = path.relative(hooksDir, path.join(here, 'commit-refresh.mjs'));
  const head = path.isAbsolute(rel)
    ? `import { pathToFileURL } from 'node:url'\n`
    : `import path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
  return `/** Cursor postToolUse Bash: 同进程调用 commit-refresh.mjs。非 git commit 立即返回;失败静默。 */\n${head}const entry = ${entryExpr}\nlet raw = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { raw += c })\nprocess.stdin.on('end', async () => {\n  try {\n    const { runCommitRefresh } = await import(pathToFileURL(entry).href)\n    runCommitRefresh(raw)\n  } catch { /* 提交保鲜失败不阻断 */ }\n  process.stdout.write('{}')\n})\n`;
}

function cursorAgentUsageSource(hooksDir) {
  const entryExpr = hookEntryExpr(hooksDir, 'agent-usage.mjs');
  const rel = path.relative(hooksDir, path.join(here, 'agent-usage.mjs'));
  const head = path.isAbsolute(rel)
    ? `import { pathToFileURL } from 'node:url'\n`
    : `import path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
  return `/** Cursor afterAgentResponse: 同进程调用 agent-usage.mjs 记账(input/output/cache tokens)。只落盘不注入;失败静默回 {}。 */\n${head}const entry = ${entryExpr}\nlet raw = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { raw += c })\nprocess.stdin.on('end', async () => {\n  try {\n    const { runAgentUsage } = await import(pathToFileURL(entry).href)\n    await runAgentUsage({ stdinText: raw, tool: 'cursor' })\n  } catch { /* 记账失败不阻断 */ }\n  process.stdout.write('{}')\n})\n`;
}

function qoderReadGuardSource(hooksDir) {
  const body = `const child = spawn(process.execPath, [entry], { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.on('error', () => { process.stdout.write('{}'); process.exit(0) })
child.on('exit', () => {
  const s = String(out).trim()
  try {
    const o = JSON.parse(s).hookSpecificOutput
    // deny 与 updatedInput(语义区间改写)都要透传;其余(含 allow 的 {})一律 {} fail-open
    if (o && (o.permissionDecision || o.updatedInput)) process.stdout.write(s)
    else process.stdout.write('{}')
  } catch { process.stdout.write('{}') }
  process.exit(0)
})
`;
  return hookScript(hooksDir, 'read-guard.mjs', 'Qoder PreToolUse: 透传 read-guard.mjs 的 deny/区间改写;无 hookSpecificOutput 则 {} fail-open。', body);
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
  for (const f of ['warm-code-index.mjs', 'prompt-guard.mjs', 'read-guard.mjs', 'read-nudge.mjs', 'commit-refresh.mjs', 'output-savings.mjs']) {
    try { fs.rmSync(path.join(hooksDir, f), { force: true }); } catch { /* 无该文件 */ }
  }
  try { fs.rmdirSync(hooksDir); } catch { /* 非空(如用户的 skills)或不存在 */ }
  try { fs.rmdirSync(path.dirname(hooksDir)); } catch { /* 非空,留着 */ }
  ok(`[${path.basename(root)}] Cursor 工作区钩子已清理${fileGone ? '(空壳 hooks.json 已删除)' : ''}(钩子在用户级 ~/.cursor/hooks.json)`);
}

function zcodeProcess(script, timeoutMs, statusMessage, extraArgs = []) {
  return { type: 'process', command: 'node', args: [script.split(path.sep).join('/'), ...extraArgs], timeoutMs, statusMessage };
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

function qoderWrapSource(hooksDir, scriptName, eventName, extraArgs = []) {
  const argsExpr = extraArgs.map((a) => `, ${JSON.stringify(a)}`).join('');
  return hookScript(hooksDir, scriptName, `Qoder ${eventName}: 转发 ${scriptName},把 additionalContext 包成 hookSpecificOutput(argv[2] 可覆盖事件名)。`, `const child = spawn(process.execPath, [entry${argsExpr}], { stdio: ['inherit', 'pipe', 'inherit'], windowsHide: true })
let out = ''
child.stdout.on('data', (d) => { out += d })
child.on('error', () => process.exit(0))
child.on('exit', (code) => {
  const eventName = process.argv[2] || ${JSON.stringify(eventName)}
  try {
    const j = JSON.parse(String(out).trim() || '{}')
    const ctx = j.additionalContext || j.hookSpecificOutput && j.hookSpecificOutput.additionalContext
    if (ctx) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: ctx } }))
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
  for (const f of ['session-start.mjs', 'prompt-guard.mjs', 'commit-refresh.mjs', 'read-guard.mjs', 'read-nudge.mjs', 'output-savings.mjs']) {
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

/** Qoder SessionStart 记账转发器:同进程调用 agent-usage.mjs 扫描 Qoder 会话日志增量记账(Qoder 无 afterAgentResponse 事件)。 */
function qoderAgentUsageScanSource(hooksDir) {
  const entryExpr = hookEntryExpr(hooksDir, 'agent-usage.mjs');
  const rel = path.relative(hooksDir, path.join(here, 'agent-usage.mjs'));
  const head = path.isAbsolute(rel)
    ? `import { pathToFileURL } from 'node:url'\n`
    : `import path from 'node:path'\nimport { fileURLToPath, pathToFileURL } from 'node:url'\n\nconst here = path.dirname(fileURLToPath(import.meta.url))\n`;
  return `/** Qoder SessionStart: 同进程调用 agent-usage.mjs 扫描 Qoder 会话日志做增量记账(→ data/usage/agent-usage.jsonl)。只落盘不注入;失败静默回 {}。 */\n${head}const entry = ${entryExpr}\nlet raw = ''\nprocess.stdin.setEncoding('utf8')\nprocess.stdin.on('data', (c) => { raw += c })\nprocess.stdin.on('end', async () => {\n  try {\n    const { scanQoderUsage } = await import(pathToFileURL(entry).href)\n    scanQoderUsage({})\n  } catch { /* 记账失败不阻断 */ }\n  process.stdout.write('{}')\n})\n`;
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
  push('SessionStart', { matcher: 'startup|resume', hooks: [zcodeProcess(path.join(here, 'auto.mjs'), 420000, '索引保鲜检查(HEAD 驱动)+ 预热本地嵌入/精排/决策模型')] });
  push('SessionStart', { matcher: 'startup|resume', hooks: [zcodeProcess(path.join(here, 'snapshot-refresh.mjs'), 10000, '上游快照保鲜(provider_config 变更时重抓)')] });
  push('PostToolUse', { matcher: 'Bash', hooks: [zcodeProcess(path.join(here, 'commit-refresh.mjs'), 10000, '提交后索引保鲜')] });
  push('PostToolUse', { matcher: '^Read$|^Bash$', hooks: [zcodeProcess(readNudge, 10000, '连续读导航+工具结果记账')] });
  push('PostToolUseFailure', { matcher: '^Read$|^Bash$', hooks: [zcodeProcess(readNudge, 10000, '读取失败导航')] });
  push('UserPromptSubmit', { hooks: [
    zcodeProcess(path.join(here, 'snapshot-refresh.mjs'), 10000, '上游快照保鲜(mtime 快路径)'),
    zcodeProcess(path.join(here, 'prompt-guard.mjs'), 10000, '模型变更检测+语义预取', ['--host', 'zcode']),
  ] });
  push('PreToolUse', { matcher: '^Read$|^Bash$|^Grep$', hooks: [zcodeProcess(path.join(here, 'read-guard.mjs'), 10000, '超限 Read 改写为语义区间,选不出再拒绝;Grep 补 head_limit')] });
  push('Stop', { hooks: [zcodeProcess(path.join(here, 'turn-close.mjs'), 15000, '回合末结算+真实模型按回合落账', ['--host', 'zcode'])] });
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  ok(`[user] ZCode 用户级钩子已写入 ${cfgPath}(绝对路径直指本模块)`);
}

// 虚拟供应商清单逻辑已抽到 virtualProvider.mjs(与 snapshot-refresh 的自动同步共用同一实现)
import { mirroredModelUnion, virtualProviderStaleness, ensureVirtualProviderEntry } from './virtualProvider.mjs';
export { mirroredModelUnion, virtualProviderStaleness, ensureVirtualProviderEntry };

/** 用户级转发器文件名单一来源(2026-11-10 纪律段第 10 条):uninit 的清理清单与 deploySync 的
 *  hooks 同步门禁都从这里取,禁止在 uninit 手抄。增删/改名 rewrite*UserHooks 里的转发器时,
 *  先来这里登记再写安装——漏登记会被 deploySync 拦下(安装⊆登记、卸载≡登记)。
 *  CURRENT=现装文件名;LEGACY=历史版本装过、卸载/清理仍要扫的文件名。 */
export const USER_FORWARDER_FILES = {
  cursor: {
    current: ['warm-code-index.mjs', 'prompt-guard.mjs', 'read-guard.mjs', 'read-nudge.mjs', 'commit-refresh.mjs', 'agent-usage.mjs'],
    legacy: ['output-savings.mjs'],
  },
  qoder: {
    current: ['session-start.mjs', 'snapshot-refresh.mjs', 'prompt-guard.mjs', 'commit-refresh.mjs', 'read-guard.mjs', 'read-nudge.mjs', 'agent-usage-scan.mjs', 'turn-close.mjs'],
    legacy: ['output-savings.mjs'],
  },
};

/**
 * Cursor 用户级接线:~/.cursor/hooks.json + ~/.cursor/hooks/ 转发器(Cursor 自己的用户级初始化也用这个目录)。
 * sessionStart/beforeSubmitPrompt 保留转发器(stdout 契约)。preToolUse 的 Read 与 Grep、postToolUse 的提交保鲜各用字面 matcher。
 */
export function rewriteCursorUserHooks({ home = os.homedir() } = {}) {
  const hooksDir = path.join(home, '.cursor', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(path.join(hooksDir, 'warm-code-index.mjs'), cursorForwarderSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'prompt-guard.mjs'), cursorPromptGuardSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'read-guard.mjs'), cursorReadGuardSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'read-nudge.mjs'), cursorReadNudgeSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'commit-refresh.mjs'), cursorCommitRefreshSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'agent-usage.mjs'), cursorAgentUsageSource(hooksDir));
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
  // matcher 只认字面工具名。^Read$ 这类正则会被判「全部工具不支持」并整组跳过,所以 Grep/Bash 各写一条,不并进 Read。
  // 转发器同进程读 stdin(Windows 直呼子进程接不到管道)
  const guardCmd = `node ${win(path.join(hooksDir, 'read-guard.mjs'))}`;
  const readHook = { command: guardCmd, matcher: 'Read', timeout: 10 };
  const grepHook = { command: guardCmd, matcher: 'Grep', timeout: 10 };
  const shellHook = { command: guardCmd, timeout: 10 };
  // Bash 在 Cursor 的工具名是 Shell(transformToolMapper: Bash→Shell),matcher 写 Bash 即得 Shell
  const nudgeHook = { command: `node ${win(path.join(hooksDir, 'read-nudge.mjs'))}`, matcher: 'Read|Bash', timeout: 10 };
  const refreshHook = { command: `node ${win(path.join(hooksDir, 'commit-refresh.mjs'))}`, matcher: 'Bash', timeout: 10 };
  const usageHook = { command: `node ${win(path.join(hooksDir, 'agent-usage.mjs'))}`, timeout: 10 };
  const failHook = { command: `node ${win(path.join(hooksDir, 'read-nudge.mjs'))}`, timeout: 10 };
  cfg.hooks.sessionStart = [ours, ...(cfg.hooks.sessionStart || [])];
  cfg.hooks.beforeSubmitPrompt = [guardHook, ...(cfg.hooks.beforeSubmitPrompt || [])];
  cfg.hooks.preToolUse = [readHook, grepHook, ...(cfg.hooks.preToolUse || [])];
  cfg.hooks.beforeShellExecution = [shellHook, ...(cfg.hooks.beforeShellExecution || [])];
  cfg.hooks.postToolUse = [nudgeHook, refreshHook, ...(cfg.hooks.postToolUse || [])];
  cfg.hooks.postToolUseFailure = [failHook, ...(cfg.hooks.postToolUseFailure || [])];
  cfg.hooks.afterAgentResponse = [usageHook, ...(cfg.hooks.afterAgentResponse || [])];
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
  fs.writeFileSync(path.join(hooksDir, 'snapshot-refresh.mjs'), qoderPassthroughSource(hooksDir, 'snapshot-refresh.mjs'));
  fs.writeFileSync(path.join(hooksDir, 'prompt-guard.mjs'), qoderWrapSource(hooksDir, 'prompt-guard.mjs', 'UserPromptSubmit', ['--host', 'qoder']));
  fs.writeFileSync(path.join(hooksDir, 'commit-refresh.mjs'), qoderPassthroughSource(hooksDir, 'commit-refresh.mjs'));
  fs.writeFileSync(path.join(hooksDir, 'read-guard.mjs'), qoderReadGuardSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'read-nudge.mjs'), qoderWrapSource(hooksDir, 'read-nudge.mjs', 'PostToolUse'));
  fs.writeFileSync(path.join(hooksDir, 'agent-usage-scan.mjs'), qoderAgentUsageScanSource(hooksDir));
  fs.writeFileSync(path.join(hooksDir, 'turn-close.mjs'), qoderWrapSource(hooksDir, 'turn-close.mjs', 'Stop', ['--host', 'qoder']));
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
  prepend('SessionStart', { hooks: [qoderCmd(fwd('session-start.mjs'), 420, '索引保鲜检查+预热本地嵌入/精排/决策模型')] });
  prepend('SessionStart', { hooks: [qoderCmd(fwd('agent-usage-scan.mjs'), 10, 'Qoder 日志增量记账')] });
  // 快照保鲜独立挂 Qoder 端(2026-11-05 修):此前只挂 ZCode,Qoder 里改自定义模型清单要等 ZCode 会话才同步
  prepend('SessionStart', { hooks: [qoderCmd(fwd('snapshot-refresh.mjs'), 10, '上游快照保鲜(mtime 快路径)')] });
  prepend('UserPromptSubmit', { hooks: [qoderCmd(fwd('snapshot-refresh.mjs'), 10, '上游快照保鲜')] });
  prepend('PostToolUse', { matcher: '^Read$|^Bash$', hooks: [qoderCmd(fwd('read-nudge.mjs'), 10, '连续读导航+工具结果记账')] });
  prepend('PostToolUse', { matcher: 'Bash|Shell', hooks: [qoderCmd(fwd('commit-refresh.mjs'), 10, '提交后索引保鲜')] });
  // PostToolUseFailure 实测只认字面量工具名(^Read$|^Bash$ 这类锚定正则不触发)
  prepend('PostToolUseFailure', { matcher: 'Read|Bash', hooks: [qoderCmd(fwd('read-nudge.mjs') + ' PostToolUseFailure', 10, '读取失败导航')] });
  prepend('UserPromptSubmit', { hooks: [qoderCmd(fwd('prompt-guard.mjs'), 10, '模型变更检测')] });
  prepend('PreToolUse', { matcher: '^Read$|^Bash$|^Grep$', hooks: [qoderCmd(fwd('read-guard.mjs'), 10, '超限 Read 改写为语义区间,选不出再拒绝;Grep 补 head_limit')] });
  prepend('Stop', { hooks: [qoderCmd(fwd('turn-close.mjs'), 15, '回合末结算+真实模型按回合落账')] });
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2) + '\n');
  ok(`[user] Qoder 用户级钩子已写入 ${settingsPath}`);
}

/** AGENTS.md 检索纪律条目(纪律段的事实来源;init 与 deploySync 共用)。
 *  rel=本模块相对目标仓的路径;dataRel=data 相对路径;packed=npx 安装模式。 */
export function disciplineItems({ rel, dataRel, packed = false }) {
  const searchCmd = packed
    ? 'npx tokensaver search <中英文关键词> --k 5'
    : 'cd ' + rel + ' && node search.mjs <中英文关键词> --k 5';
  const statusCmd = packed ? 'npx tokensaver status' : 'node ' + rel + '/status.mjs';
  const autoCmd = packed ? 'npx tokensaver auto' : 'cd ' + rel + ' && node auto.mjs';
  const rebuildCmd = packed
    ? 'npx tokensaver build && npx tokensaver embed'
    : 'cd ' + rel + ' && node build.mjs && node embed.mjs';
  const embedCmd = packed ? 'npx tokensaver embed' : 'node embed.mjs';
  const annotationCmd = packed ? 'npx tokensaver annotationCheck' : 'cd ' + rel + ' && node annotationCheck.mjs';
  const pathHint = packed
    ? '命令在仓库根执行(`npx tokensaver ...`),不要 cd 进 node_modules'
    : '派单/命令里的路径必须用正斜杠+引号(`cd "' + rel + '"`):git bash 下不带引号的反斜杠路径会被转义吞掉';
  const toolLabel = packed ? 'npx tokensaver' : rel;
  const P = (n, t) => n + '. ' + t;
  const items = [
    P(1, '**全局背景**:先读 `' + dataRel + '/CODE_MAP.md`(架构速查模板,随使用逐步充实;或自行维护项目架构说明)'),
    P(2, '**无条件先走索引**:定位/阅读/修改代码前先执行至少一次 `' + searchCmd + '`(默认混合检索,**不要加 --rerank**,精排要加载 reranker 会拖慢会话)。即使已有 file:行号也先检索核对;Grep 作补充。确需精排时再手动加 `--rerank`'),
    P(3, '按返回的 `file:起-止行` 用 Read 精读目标区间(offset/limit);定位阶段禁止未检索就整文件通读 500 行以上的大文件。Cursor/ZCode/Qoder 下超上限的全量 Read 与 Bash 里 cat 整读大文件都会被钩子拦下:三端的全量 Read 都默认改写为语义最相关区间(按提问选段),选不出区间才拒绝(拒绝信息自带检索/区间读/grep 替代方案);改走检索+区间读;同一目标 5 分钟内重试一次即放行。**修改类任务改动完成后,对所涉及文件做一次较大范围复查**(捕捉跨中间件/跨函数的副作用)'),
    P(4, pathHint),
    P(5, '**模型状态提示(整句照抄,禁止截短)**:每轮 UserPromptSubmit 会注入一句 `[code-index] 状态(本轮实时值,回复末尾原样附上):⚙ …`;轮内工具执行后可能再用同一句式注入更新的一条(此时句首已是本轮实际调用的模型,数字也已结算)。把其中 ⚙ 开头的**整句**原样附在每次回复末尾——从 ⚙ 一直到句末,包括句首的"【当前远程模型名】"段(该会话最近一轮实际服务的远程模型;查无记录时该段省略)与"今日累计节约 … tokens，总计节约 … tokens"两段,一个字都不能省;只抄前半句、截掉数字段、或沿用前几轮数字都算违规。**以最新注入的那一条为准**,会话开始时注入的那句仅作首轮兜底。该句只含:句首【当前远程模型名】、是否启动成功、嵌入/精排/决策模型名、失败时的最可能原因,或成功时今日累计/总计两个 tokens 数(总计为全历史日求和)。不要加长、不要改写、不要拼接不同轮次的片段;没有这句输出时不得虚构'),
    P(6, '**知识沉淀**:完成某文件的深挖/修复/排查后,若 `' + dataRel + '/known-annotations.json` 无该文件条目,追加一条(格式:`"项目名/相对路径": "一句话职责+关键机制"`,≤50 字);仅真实读码理解后写入,禁止批量生成;写后必跑 `' + annotationCmd + '` 体检——键必须命中索引路径(死链在 details.mjs 里永不显示,先改键名或删条),文本 ≤50 字,JSON 保持合法'),
    P(7, '**提交后保鲜**:执行 `git commit` 后,运行 `' + autoCmd + '`(HEAD 没变秒级跳过;有变更时 build 内联约 10s+嵌入转后台)——有 PostToolUse hook 的环境已自动做,重复触发零成本'),
    P(8, '索引保鲜由会话 hook 自动判定(git 仓库按 HEAD,非 git 目录 24h 回退;嵌入路径或模型变更则重嵌)。手动重建:`' + rebuildCmd + '`。向量过期或切换嵌入模型时运行 `' + embedCmd + '`(只更新当前路径 data/vectors;维度不一致或 `--force` 时该目录全量),完成后以 `' + statusCmd + '` 验证。所选嵌入路径(init --model-in ollama|local)拉起失败时检索降级 bm25;显式 `--mode bm25` 可主动选用'),
    P(9, '**文档英文**:`README.md` 与 code-index 的 `部署使用说明.txt` 在中文正文后各有一段英文译文。修改时保留英文段,并按改过的中文改对应英文。禁止删掉英文只留中文。`npm/部署使用说明.txt` 由 sync-npm 从 code-index 那份生成,改源文件后重新同步,不要单独删英文'),
    P(10, '**部署产物同步**:改了 `init.mjs` 的纪律段/输出纪律段/hooks、`output-diet.md` 等部署模板或 AGENTS.md 段规则后,先让测试全绿,再运行 `' + (packed ? 'npx tokensaver sync' : 'cd ' + rel + ' && node deploySync.mjs') + '` 校验一致性;不一致就重新运行 `' + (packed ? 'npx tokensaver init' : 'node init.mjs') + '` 全盘部署(幂等,会重写 hooks 与各仓 AGENTS.md),再跑门禁确认。门禁未过不得声称部署已与代码库一致。**增删/改名用户级 hooks 转发器时,必须同步 `init.mjs` 与 `uninit.mjs` 两处部署/清理逻辑**:先登记 `init.mjs` 的 `USER_FORWARDER_FILES` 单源清单(uninit 清理与 deploySync 门禁都从这里取),漏登记会被 deploySync 拦下(安装⊆登记、卸载≡登记,卸载残留/手抄漂移都算不过)'),
    P(11, '**实验数据保护**:`agent_reports/ab-logs/`(A/B 实验结果,2026-11-07 自 data/ab 迁入、2026-11-11 自 test/ab/result 迁入)等实验目录里是唯一的原始证据,删了不可再生(已入版本控制受 git 保护,但 `test/` 其余部分仍是本地沙盒):禁止 `git clean -x/-X`、`rm -rf agent_reports/ab-logs` 这类顺手清理;要重跑实验就直接覆盖写(`prepare` 只清任务工作目录),确需清理先征得用户同意'),
    P(12, '**缺陷文档回写**:按缺陷文档(如 `agent_reports/failures.md`)修完 bug 后,必须回写该文档——逐条标注已修/未修与修复位置,并把该文档标记为「已处理」;同一份文档不得再作为待修清单二次下发,重复下发时先核对文档内的已修标记,只处理仍未修的条目'),
    P(13, '**修复复盘自更新**:按缺陷文档修完 bug 后,除回写缺陷文档(第 12 条)与归档修复日志(第 14 条)外,还须复盘本轮踩到的问题(缺陷可能已在工作区修过/断言空跑/守卫没进门禁链/文档行号漂移/范围外的坑等),把可互鉴的教训写成「触发条件→下次先做什么」追加进本仓 `bugfix-sop.md` 的「注意事项」(定位顺序:仓根目录,无则 `tools/`;只增不删,失效条目标【已废】),并在同文件「复盘流水」追加本轮小结——小结必须写「本轮用上了哪几条既有 N」,至少一条真实复用。开工前先读该文件,避免重复犯同样的错;两处均无该文件时,首次修复时按「作业规程 / 注意事项 / 复盘流水」三段骨架创建(铺在仓根目录)。`bugfix-sop.md` 是可演进的作业细则,本纪律段是它的索引与强制入口'),
    P(14, '**修复日志归档**:每次 bug 修复**轮次**收尾时,在本仓 `agent_reports/fix-logs/`(无则创建)落一份当轮修复日志,文件名 `fix-<YYYYMMDD>-<主题>.md`,内容至少五段:①输入文档与条目数 ②已修清单(file:行 + 验证方式) ③留待清单与理由 ④门禁/回归结果 ⑤关联指针(台账 id、缺陷文档回执位置、`bugfix-sop.md` 复盘条目)。复盘流水的当轮条目回链该日志;日志属本地资产(`agent_reports/` 已 ignore),不 commit。跨会话追溯路径:缺陷文档回执(第 12 条)→ 修复日志(本条)→ SOP 复盘(第 13 条)三层互链'),
    P(15, '**测试脚本组织**:test/ 按被测域分目录——`routing/`(模型路由与成本)/`decision/`(判定与代签)/`hooks/`(钩子与端上守卫);全局基建套件放 test/ 根,实弹评测工具进 `test/scripts/`,历史 work 档案进 `test/archive/`;新增测试脚本必须落在对应域目录,并同步 `test/readme.md` 登记与 code-index/package.json 门禁链——链外测试等于没有守卫'),
  ];
  return items;
}

/** AGENTS.md 检索纪律段(纯函数,供 init 与 deploySync 共用;内容即部署产物的事实来源)。 */
export function disciplineBlock({ rel, dataRel, packed = false }) {
  const MARK_V2 = '<!-- code-index:v2 -->';
  const toolLabel = packed ? 'npx tokensaver' : rel;
  const items = disciplineItems({ rel, dataRel, packed });
  const snippet = `\n${MARK_V2}\n## 代码检索纪律(节约 token)\n\n本项目已部署本地语义索引(工具在 \`${toolLabel}\`,项目资产在 \`${dataRel}\`):\n\n${items.join('\n\n')}\n`;
  return snippet.trim() + '\n';
}

if (directRun) {
let currentStep = 'parse-args';
try {
const hookArg = parseInitArgs(args).hooks;
const hookTools = resolveHookTargets(hookArg);
{
  const detected = detectAgent();
  if (hookArg) ok(`hooks = ${hookTools.join(',')} (--hooks)`);
  else if (detected) ok(`检测到当前为 ${detected},只接线该工具 hooks(其余可用 --hooks all 或 --hooks <名>)`);
  else ok('未识别当前 agent,接线 Cursor/ZCode/Qoder(可用 --hooks 指定)');
}
log(`\n[4/5]+[5/5] 对每个 git 仓库 root 接线会话 hook + AGENTS.md 检索纪律`);

/** 给一个 git 仓库根清理旧工作区钩子、刷新 AGENTS.md(钩子本体在用户级,只在循环后装一次) */
function wireRepo(root) {
  if (hookTools.includes('zcode')) cleanZcodeWorkspaceHooks(root);
  if (hookTools.includes('cursor')) cleanCursorWorkspaceHooks(root);
  if (hookTools.includes('qoder')) cleanQoderWorkspaceHooks(root);
  wireAgents(root);
  ensureBugfixSop(root);
}

/** 缺陷修复作业规程(bugfix-sop.md):纪律段第 13 条指定的复盘落点。
 *  只在缺失时铺骨架骨架(三段:作业规程/注意事项/复盘流水),**已存在绝不覆盖**——里面是各仓自己累积的经验。 */
function ensureBugfixSop(root) {
  const p = path.join(root, 'bugfix-sop.md');
  if (fs.existsSync(p)) return;
  // 2026-11-11:允许收进 tools/(本工具仓即此布局);tools/ 已有就绝不重铺,防根目录出现第二份骨架
  if (fs.existsSync(path.join(root, 'tools', 'bugfix-sop.md'))) return;
  fs.writeFileSync(p, `# 缺陷文档修复 · 作业规程与复盘

> 本文件由 code-index init 铺骨架(纪律段第 13 条指定);内容由 agent 在每次「按缺陷文档修完 bug」后复盘追加。
> 三段结构:一、作业规程(固定步骤) 二、注意事项(累积,每条写成「触发条件 → 下次先做什么」) 三、复盘流水(按日期追加)。
> 分工:缺陷文档**本身**由纪律段第 12 条负责回写;本文件只管「我该怎么干」。

## 一、作业规程

0. 划范围:只做文档里的 Bug;文档没提的问题即使是真 bug 也不擅自修,发现了只报告。
1. 定位:先走 code-index 检索核对文档给的 file:行号(行号会漂移,以检索结果为准)。
2. 判状态:先 git diff 看工作区(缺陷可能已修过只是没提交),再在 HEAD 版本上复现确认缺陷真的存在;已修则转为「补回归守卫 + 回写文档」。
3. 改:按根因改,不顺手改坏别处;范围外的坑记录不改。
4. 验:断言在缺陷代码上确实失败、在修复代码上确实通过(防空跑);全量门禁绿;校验类逻辑另扫假阴性。
5. 守卫入链:回归断言必须挂在 npm test 门禁链上,链外的测试等于没有守卫。
6. 回写缺陷文档:逐条标状态 + 顶部标「已处理」+ 配套台账置 fixed。
7. 复盘回写本文件:新教训进「注意事项」,本轮小结进「复盘流水」;小结必须写「本轮用上了哪几条既有 N」(至少一条真实复用)。
8. 归档修复日志:当轮收尾在本仓 \`agent_reports/fix-logs/\` 落 \`fix-<YYYYMMDD>-<主题>.md\`(输入/已修/留待/门禁/关联指针五段),复盘条目回链它。

## 二、注意事项

(暂无。每轮修复后按「触发条件 → 下次先做什么」追加。只增不删:失效条目标题改 \`**Nn【已废】原标题**\`,正文与原因保留供考古。)

## 三、复盘流水

(暂无。每轮修复后追加一条:本轮范围 / 新踩的坑 / 更新到第几条注意事项 / 本轮用上了哪几条既有 N。)
`, 'utf8');
  ok(`[${path.basename(root)}] bugfix-sop.md 作业规程骨架已铺(纪律段第 13 条的复盘落点)`);
}

// 宿主仓库 + config 实际生效的每个 root(去重);root 不是 git 仓库(纯目录)则只索引不接线
currentStep = 'wire-repos(接线各仓库 hooks + AGENTS.md)';
const effRoots = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code-index.config.json'), 'utf8')).roots || []; }
  catch { return []; }
})();
const wireRoots = [...new Set([repoRoot, ...effRoots.map(r => path.resolve(r))])];
for (const r of wireRoots) {
  if (!fs.existsSync(path.join(r, '.git'))) {
    console.error(`  [note] ${r} 非 git 仓库,只索引不接线(无 AGENTS.md/hooks)`);
    continue;
  }
  wireRepo(r);
  const giEntries = r === repoRoot
    ? gitignoreEntries({ packed: PACKED_INSTALL, repoRoot, moduleDir: here, dataDir: DATA_DIR })
    : [...EDITOR_IGNORE];
  ensureGitignore(r, giEntries);
}

// 钩子本体统一装在用户级:所有工作区共享一份,绝对路径直指本模块,不依赖各仓的 workspace 信任审批
currentStep = 'user-hooks(用户级钩子接线)';
log(`\n[user] 用户级钩子接线(${hookTools.join(', ')})`);
if (hookTools.includes('zcode')) {
  currentStep = 'zcode-virtual-entry(ZCode auto 档播种)';
  rewriteZcodeUserHooks();
  // autoName 不传(2026-11-07 定影语义):现有 auto 系名原样保持,改名权只在会话开启钩子
  const vp = ensureVirtualProviderEntry();
  // 播种/同步时函数内已打过日志,这里只补"无事发生"的说明,避免重复两行
  if (!vp.seeded && !vp.refreshed) console.log(`  [note] 虚拟供应商 tokenSaverModel:${vp.note}`);
}
if (hookTools.includes('qoder')) {
  currentStep = 'qoder-virtual-entry(Qoder auto 档播种)';
  // Qoder 接入(2026-11-02 用户实测:自定义模型可写用户级 settings.json):播种 tokensaver-auto
  // 虚拟条目(单 auto 档,同 ZCode 策略);快照/清单同步由 snapshot-refresh 双端共用。
  // 双端隔离(2026-11-04 用户定档):Qoder 走宿主专属前缀 /apps/qoder——代理按前缀判宿主,
  // 各宿主只在快照中带自己 host 标签的供应商里路由,auto 不再混入另一端配置的模型。
  const vq = ensureVirtualProviderEntry({ qoder: true, providerId: 'tokensaver-auto', baseUrl: 'http://127.0.0.1:8117/apps/qoder' });
  if (!vq.seeded && !vq.refreshed) console.log(`  [note] Qoder 虚拟供应商 tokensaver-auto:${vq.note}`);
}
if (hookTools.includes('cursor')) rewriteCursorUserHooks();
if (hookTools.includes('qoder')) rewriteQoderUserHooks();

currentStep = 'code-map(CODE_MAP 模板)';
log(`\n============ 初始化完成 ============`);// CODE_MAP 模板(项目资产,位于 data/;已存在则不动)
const codeMapPath = path.join(DATA_DIR, 'CODE_MAP.md');
if (!fs.existsSync(codeMapPath)) {
  fs.writeFileSync(codeMapPath, `# CODE_MAP —— 项目代码知识地图(由 agent 在深挖中持续维护)\n\n> 用法:先读本文获得全局背景 → node search.mjs 检索定位 → 按行区间精读。\n> 建议内容:项目架构图、核心链路、关键文件职责、已知问题速查。\n\n(模板生成于 ${new Date().toISOString().slice(0, 10)};请按项目实际逐步充实,knownAnnotations 同步沉淀)\n`);
  ok(`已生成 CODE_MAP 模板:${codeMapPath}(请逐步充实)`);
}
log(`提示:项目资产都在 ${DATA_DIR} 目录下——配置 code-index.config.json、知识地图 CODE_MAP.md、索引 chunks.jsonl/index.json/vectors/(向量)。Ollama/local 模型权重不随本目录复制。`);
// 结果框(2026-11-07 用户要求):顶部大字安装结果 + v2Dir 重要提示。
// ZCode 数据存储路径可在其设置里修改,迁移是复制不是移动——旧 ~/.zcode/v2 文件仍在但不再更新,
// 快照/auto 播种会读到陈旧数据。醒目告知用户改 v2Dir。
// roots 终态从盘上 config 读(本块与 roots 决策块是两个独立 directRun 作用域,变量不互通;
// config 在上一块已写盘,读盘即最终态)
const rootsEmptyNow = (() => {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code-index.config.json'), 'utf8'));
    return !(Array.isArray(c.roots) && c.roots.length);
  } catch { return false; }
})();
printResultBox(null, { rootsEmpty: rootsEmptyNow });
} catch (e) {
  console.error(`\n[err] 安装中断于环节「${currentStep}」: ${e && e.message ? e.message : e}`);
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  printResultBox(currentStep);
  process.exit(1);
}
}

/** 安装结果框(成功=█ 块大字"安装成功";失败=✖ 大字"安装失败"+环节)。72 列等宽;
 *  中文按 2 列手工对齐(padEnd 按字符数算会在宽字符行溢出)。
 *  opts.rootsEmpty(2026-11-07 首装免 roots):成功框追加"配置项目目录"指引段。 */
function printResultBox(failedStep, opts = {}) {
  const W = '*'.repeat(72);
  const blank = '*' + ' '.repeat(70) + '*';
  if (failedStep) {
    console.error(W);
    console.error(blank);
    console.error('*   ✖✖✖  安 装 失 败  ✖✖✖' + ' '.repeat(47) + '*');
    console.error(('*   失败环节: ' + String(failedStep).slice(0, 40)).padEnd(71, ' ') + '*');
    console.error(blank);
    console.error(W);
    console.error('*   排查后重跑 node init.mjs(幂等);仍失败请把上方 [err] 反馈维护者' + ' '.repeat(8) + '*');
    console.error(W);
  } else {
    log(W);
    log(blank);
    log('*   ███  安 装 成 功  ███   (dionfang/TokenSaver)' + ' '.repeat(22) + '*');
    log(blank);
    log(W);
    if (opts.rootsEmpty) {
      log('*  下一步(必做):roots 当前为空,索引尚未覆盖任何项目——请编辑' + ' '.repeat(9) + '*');
      log(('*  ' + DATA_DIR + path.sep + 'code-index.config.json').padEnd(71, ' ') + '*');
      log('*  的 "roots": [] 填入您的项目目录(可多个),例如:' + ' '.repeat(21) + '*');
      log('*    "roots": ["D:/HbuilderX-Project/my-app", "D:/work/shop"]' + ' '.repeat(11) + '*');
      log('*  然后重跑 node init.mjs(纳入索引+接线各仓钩子与 AGENTS.md)。' + ' '.repeat(10) + '*');
      log(W);
    }
    log('*  重要:如果您在 ZCode 设置中修改过「数据存储路径」,请编辑' + ' '.repeat(15) + '*');
    log(('*  ' + DATA_DIR + path.sep + 'code-index.config.json').padEnd(71, ' ') + '*');
    log('*  中的根级字段  "v2Dir": ""  ,填入迁移后的实际数据路径' + ' '.repeat(17) + '*');
    log('*  (示例:"v2Dir": "D:/hello/.zcode/v2"),然后重启 ZCode。' + ' '.repeat(13) + '*');
    log('*  不填写则按默认 ~/.zcode/v2 读取——迁移后那里是陈旧副本,' + ' '.repeat(11) + '*');
    log('*  会导致 auto 档快照为空、模型清单缺失。' + ' '.repeat(29) + '*');
    log(W);
  }
}
