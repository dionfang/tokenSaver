/**
 * 配置加载器。⚠️ 没有统一优先级链,不同键走不同的层:
 *   模型部署(models / ollamaBase / gpu / rerankBlend):只认本文件。不读环境变量,也不读 data/code-index.config.json。
 *     改完随 git 可见,协作排查时打开本文件即可。单次命令仍可用 CLI(--rr-model)。嵌入模型名与 ollamaBase 不接受命令行覆盖。
 *   modelIn:init.mjs --model-in > code-index.config.json > 内置默认 local
 *   roots:init --roots 与已有合并(纳入);无参数重跑只读本文件并自愈。运行时 env(CODE_INDEX_ROOTS) 仍可临时盖掉。内置默认空。
 *   skipDirs/exts/chunk/knownAnnotations/staleNonGitMs/readMaxLines:code-index.config.json > 内置默认(无 env/CLI)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 模块目录(部署单元:纯工具,零项目内容)。realpath 保证与磁盘大小写一致,不受调用写法影响。 */
export const MODULE_DIR = realpathOr(__dirname);

export function isInsideNodeModules(dir) {
  return String(dir || '').split(path.sep).includes('node_modules');
}

/** 已存在的路径收成同一条(Windows 短路径 vs 长路径),不存在则 path.resolve */
function realpathOr(p) {
  const abs = path.resolve(p || '.');
  try { return fs.realpathSync.native(abs); } catch { return abs; }
}

/** 从 start 向上找 .git。找不到返回 null */
export function findGitRoot(start) {
  let dir = path.resolve(start || '.');
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return realpathOr(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 项目资产 vs 模型缓存落点。
 * 非 npm:data 只跟模块走(code-index 的上一级 data/,或模块自己就是 git 根时用模块内 data/),不跟当前工作区走。
 *   TokenSaver 仓:data 在仓库根;复制到某项目 scripts/code-index:data 在 scripts/data。
 * npm 安装:data 在当前仓 scripts/data(可用 CODE_INDEX_DATA_DIR 覆盖),hf-cache 在用户主目录。
 */
export function resolveLayout({
  moduleDir,
  cwd,
  env = process.env,
  homedir = os.homedir(),
  gitRoot = null,
} = {}) {
  const packed = isInsideNodeModules(moduleDir);
  const dataFromEnv = env.CODE_INDEX_DATA_DIR && String(env.CODE_INDEX_DATA_DIR).trim();
  const root = realpathOr(gitRoot || findGitRoot(cwd) || findGitRoot(moduleDir) || cwd || '.');
  const moduleAbs = realpathOr(moduleDir);
  const moduleGit = findGitRoot(moduleAbs);
  const dataDir = dataFromEnv
    ? path.resolve(dataFromEnv)
    : packed
      ? path.join(root, 'scripts', 'data')
      : moduleGit && realpathOr(moduleGit) === moduleAbs
        ? path.join(moduleAbs, 'data')
        : path.resolve(moduleAbs, '..', 'data');
  const hfCacheDir = packed
    ? path.join(homedir, '.tokensaver', 'hf-cache')
    : path.join(moduleAbs, 'hf-cache');
  return { dataDir, hfCacheDir, packed };
}

const layout = resolveLayout({ moduleDir: MODULE_DIR, cwd: process.cwd() });
/** 项目资产:索引产物、config、CODE_MAP/CODE_DETAILS。模型部署不在这里。 */
export const DATA_DIR = layout.dataDir;
/** transformers.js 模型缓存。权重超过远程单文件限制,不入库。 */
export const HF_CACHE_DIR = layout.hfCacheDir;
export const PACKED_INSTALL = layout.packed;
/** 项目配置:位于项目资产目录(随 data 走,不随模块复制) */
export const CONFIG_PATH = path.join(DATA_DIR, 'code-index.config.json');
/**
 * Ollama 加载参数。warm、search、embed 必须用同一组:
 * 换 num_ctx 会重载模型,更短的 keep_alive 会把预热的 2 小时驻留改掉。
 */
export const OLLAMA_KEEP_ALIVE = '2h';
export const OLLAMA_NUM_CTX = 4096;

/** 读取目录的 git HEAD;非 git 仓库/命令失败返回 null(保鲜判定与构建记录共用) */
export function gitHeadOf(dir) {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status === 0) return (r.stdout || '').trim() || null;
  } catch { /* 非 git 或 git 不可用 */ }
  return null;
}

export const DEFAULT_CONFIG = {
  roots: [],
  skipDirs: ['node_modules', '.git', 'unpackage', 'dist', 'dist-dev', 'dist-pro', 'public', 'coverage', '.husky', '.vscode', '.cache', 'mock', 'plop', 'uni_modules', 'static', 'uploadAvatar', '.uni', '.idea'],
  exts: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'scss', 'css', 'less', 'html', 'sql', 'wxs'],
  jsonWhitelist: ['package.json', 'pages.json', 'manifest.json', 'tsconfig.json'],
  maxFileBytes: 800 * 1024,
  // Cursor 全量 Read 行数上限。超过 ×1.25 由 preToolUse 拦截;带 offset/limit 的区间读不受限。
  readMaxLines: 500,
  chunk: { targetLines: 70, maxLines: 120, overlapLines: 10, minTail: 15 },
  // 非 git root 的保鲜回退阈值(git root 走 HEAD 比对,不用时间)
  staleNonGitMs: 24 * 60 * 60 * 1000,
  // 模型部署只写在本文件(入库)。不读 OLLAMA_EMBEDDING / OLLAMA_RERANKER / OLLAMA_BASE / OLLAMA_FORCE_*。
  // 迁移前提:目标电脑已安装 Ollama,并手工 pull 下列两个 Ollama 模型(缺失时工具只报错提示,不做自动拉取)。
  // localEmbedding / localReranker 是 modelIn=local 时的 Transformers.js 模型。
  // 不依赖 Ollama。精排用 q8 的 bge-reranker-base(约 279MB)。路径由 init.mjs --model-in 写入 data JSON。
  // 精排与一阶段的混合权重(仅 --rerank 显式开精排时生效):final = w*精排分 + (1-w)*一阶段分。0=精排无效,1=精排全量接管排序。
  // 实测(w=1)两个精排模型都会把一阶段的好序翻坏;细网格调参 w∈[0.25,0.35] 为 fileR5=44/50 平台,
  // 0.275 是平台内 MRR 峰且各子集 maximin 最优,见 exp-2026-10-26/rerank-bench(tune.mjs/maximin.mjs)。
  rerankBlend: 0.275,
  models: {
    embedding: 'qwen3-embedding:0.6b',
    reranker: 'sam860/qwen3-reranker:0.6b-F16',
    localEmbedding: 'Xenova/jina-embeddings-v2-base-zh',
    localReranker: 'Xenova/bge-reranker-base',
  },
  modelIn: 'local', // ollama | local。data JSON 可覆盖;缺省或非法值按 local。
  ollamaBase: 'http://localhost:11434',
  gpu: 'auto', // auto=按显存判定;cpu / gpu=强制。改这里,不要设环境变量。
  knownAnnotations: {},
  // 多模型路由门控(model-routing.md #11):默认全关。enabled=true 后 prompt-guard 才跑 L1 分类+路由日志;
  // 二次人工配置:改 data/code-index.config.json 的 modelRouting 段(2026-11-03 起 role 两档制已废:routeMode/roles/chains
  // 均不再被读取,四档链恒由快照派生;providerPriority/brandPriority 仍生效)。
  // l2Shadow=true 才让影子级联加载嵌入模型(L2 kNN 通电);默认关——每轮影子起子进程加载模型会与主会话争资源。
  // brandPriority(2026-11-03 用户需求):自定义品牌调用顺序,只决定"同一档位内谁先被调"(四档链档内排序主键),
  //   **不影响档位归属**(tierOfModel/classifyDifficulty/resolveTier 级联照旧)——即"不影响动态模型路由的调用档位"。
  //   未在列表里的品牌排到所有已列品牌之后;可改 data/code-index.config.json 的 modelRouting.brandPriority 覆盖。
  // retryOnRateLimit(2026-11-03):运行时 429/5xx 同轮重选开关,默认 true——转发拿到可重试错误时不向客户端透传空回复,
  //   而是同轮冷却失败模型→重跑 resolveTier(档内滑下一个 / R4→R3→R2→R1 降档)→换模型重发;maxRetries=同轮最多重发次数
  //   (默认 2,硬上限 5)。只在 tier 模式且能重解析出新模型时才真的重发,否则等价旧的单次透传;设 false 整体关闭回到旧行为。
  // providerPriority(2026-11-03 恢复):同名模型挂多供应商(多 Token Plan)时的同名取序,空=按快照键序。
  // decisionModel(2026-11-03 用户定档:三投票+一加权):决策模型(网关判定 API)开关,默认 false——
  //   生效时按置信加权参与代签计票(可影响结果),断网/失败自动跳闸零网关重试
  //   (恢复=人工 --probe 探活,或下次会话开始自动探活成功,2026-11-03);
  //   独立复核 CLI(node decisionModel.mjs --review-golden)同样受此开关与断路器约束。
  //   model(2026-11-03):判定模型名,空=内置 decision-model-preview;providers(2026-11-03):
  //   [{baseUrl,apiKey,path?}] 显式供应商与 key(path=专属端点路径,空=内置 /compatible-mode/v1/systemone),
  //   配了就只走这些;空数组/全空模板条目(占位示例)/未配=自动收集客户端带 key 的供应商(排除本地代理);
  //   填了一半=配置错误会显式报错。换判定模型/换网关改 data/code-index.config.json 即可。
  //   chunkSize(2026-11-03 实测定档):判定分片 1..16,默认 1——16 题批量稀释置信(97% 弃权),
  //   1 题/请求覆盖与一致率最佳(74%);要省请求数可按量调大。
  // maxPhaseTurns(2026-11-04 自 switchGuard 迁出):升档阶段最多持续的人类轮数,到顶回主循环;
  //   恒生效、不受 switchGuard.enabled 控制(旧位置 switchGuard.maxPhaseTurns 仍兼容读取)。
  // switchGuard(切换税门控,2026-11-05 用户定档:默认开启):enabled=true 时极厚上下文(估算 tokens 超阈值)不升档,
  //   只拦升档——R1 降档当轮即省钱不受门控;maxContextTokens 默认 200000(≈640KB 请求体)。要放行设 enabled=false。
  // tierOptimize(2026-11-04 黄金集迭代优化 + 自进化闭环,默认全关):enabled=true 后 prompt-guard 的 --check
  //   后台分支才在扩样后顺跑一轮 tierOptimize.mjs——用行为侧真值学"逐信号倍数"+搜门槛小网格,5 折折外代价
  //   过门控(改善≥3% 或代价不升且准确率≥+5%,且 R1 召回不倒退>2%)才落候选。迭代只写候选文件(恒 disabled,
  //   绝不碰 live);自动晋升=连续 2 轮接受(间隔≥半节流窗)+逐折无回归+签名异于 live 才通电,晋升满观察窗
  //   (默认 24h)后成本中位恶化>15% 自动回滚 prev 并冷却签名(默认 7 天);--enable/--disable/--rollback-now
  //   手动晋升/关回/回滚(词表永不自动改,预测不回灌)。
  //   minIntervalMs=节流间隔(默认 6h);folds/minN/priorN=折数/最小支持/平滑先验,量尺小时加大 priorN 更保守;
  //   grow=false 只评不扩样;fitCost=true 从 proxy-usage.jsonl 反标定冷热轮实测值(默认用人工画像);
  //   dry=true 只出报告不落档案;allowBoost=false 学到的高纯度信号也只降不升(升档代价 8 倍,升权是加杠杆)。
  modelRouting: { enabled: false, retryOnRateLimit: true, maxRetries: 2, providerPriority: [], l2Shadow: false, decisionModel: { enabled: false, model: '', providers: [{ baseUrl: '', apiKey: '', path: '' }], chunkSize: 1 }, brandPriority: ['glm', 'minimax', 'deepseek', 'qwen', 'kimi', 'grok', 'claude', 'gpt', 'gemini'], maxPhaseTurns: 4, switchGuard: { enabled: true, maxContextTokens: 200000 }, tierOptimize: { enabled: false, minIntervalMs: 6 * 60 * 60 * 1000, folds: 5, minN: 6, priorN: 8, grow: true, fitCost: false, dry: false, allowBoost: false } },
};

export function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      // 显式失败而非静默回退:config 含 roots/models/注解库,坏 JSON 会让 roots 丢失、行为回默认,必须让人看到
      console.error(`[err] ${CONFIG_PATH} 解析失败(${e.message})——请修复 JSON 后重试;拒绝以默认值静默运行`);
      process.exit(1);
    }
  }
  const cfg = {
    ...DEFAULT_CONFIG,
    ...fileCfg,
    chunk: { ...DEFAULT_CONFIG.chunk, ...(fileCfg.chunk || {}) },
    // 模型部署以本文件为准,盖掉 data JSON 里的同名键(该 JSON 不入库,协作时看不见)
    models: { ...DEFAULT_CONFIG.models },
    ollamaBase: DEFAULT_CONFIG.ollamaBase,
    gpu: DEFAULT_CONFIG.gpu,
    // modelIn 由 init --model-in 写入 data JSON。缺省或非法值按 local。
    modelIn: fileCfg.modelIn === 'ollama' ? 'ollama' : 'local',
    modelRouting: { ...DEFAULT_CONFIG.modelRouting, ...(fileCfg.modelRouting && typeof fileCfg.modelRouting === 'object' ? fileCfg.modelRouting : {}) },
  };
  const hiddenDeployKeys = ['models', 'ollamaBase', 'gpu'].filter((k) => fileCfg[k] != null);
  if (hiddenDeployKeys.length) {
    console.error(`[warn] ${hiddenDeployKeys.join('/')} 只认本目录 config.mjs(入库,协作可见);data/code-index.config.json 中的同名键已忽略`);
  }
  // env 覆盖层(机器/CI 临时场景)
  if (process.env.CODE_INDEX_ROOTS) {
    cfg.roots = process.env.CODE_INDEX_ROOTS.split(',').map(s => s.trim()).filter(Boolean);
  }
  return cfg;
}
