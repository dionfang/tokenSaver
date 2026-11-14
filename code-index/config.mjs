/**
 * 配置加载器。⚠️ 没有统一优先级链,不同键走不同的层:
 *   模型部署(models / ollamaBase / gpu):只认本文件。不读环境变量,也不读 data/code-index.config.json。
 *   改完随 git 可见,协作排查时打开本文件即可。单次命令仍可用 CLI(--rr-model)。嵌入模型名与 ollamaBase 不接受命令行覆盖。
 *   rerankBlend(精排混排权重,默认 0.275):data/code-index.config.json 顶层键可覆盖(loadConfig 的展开层直接接住;
 *     night 点扫"blend 无配置通道"即此通道,2026-11-10 夜审 S8-F1 起此为准)。modelIn:init.mjs --model-in > code-index.config.json > 内置默认 local
 *   roots:init --roots 与已有合并(纳入);无参数重跑只读本文件并自愈。运行时 env(CODE_INDEX_ROOTS) 仍可临时盖掉。内置默认空。
 *   skipDirs/exts/chunk/staleNonGitMs/readMaxLines:code-index.config.json > 内置默认(无 env/CLI)
 *   knownAnnotations(2026-11-07 拆出):**独立文件 data/known-annotations.json**(不再存 config),
 *     loadKnownAnnotations() 读取;init 负责旧 config 键的一次性迁移与 roots 变化时的整表重置。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_PHASE_TURNS, SWITCH_GUARD_MAX_CONTEXT_TOKENS } from './thresholds.mjs'; // S1-F4:阈值单源(thresholds.mjs,叶子无环)
export { MAX_PHASE_TURNS, SWITCH_GUARD_MAX_CONTEXT_TOKENS }; // 供 init 播种骨架引用同一单源

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
/** 关键文件注解库(2026-11-07 自 config 拆出):独立 JSON,顶层即 {路径: 注解} 映射。 */
export const KNOWN_ANNOTATIONS_PATH = path.join(DATA_DIR, 'known-annotations.json');

/** 读注解库:缺失/坏 JSON/非对象回落 {}(只读展示面,不值得硬失败)。 */
export function loadKnownAnnotations(file = KNOWN_ANNOTATIONS_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}
/**
 * Ollama 加载参数。warm、search、embed 必须用同一组:
 * 换 num_ctx 会重载模型,更短的 keep_alive 会把预热的 2 小时驻留改掉。
 */
/** Ollama 模型空闲驻留时长,也是 local 常驻进程的空闲自退周期(2026-11-14 用户定案 B:'2h'→'24h',
 *  三模型常驻不因空闲消失,状态句不再反复"未拉起";显存恒占 ≈4.5GB,桌面上由 Ollama 按压力自行驱逐并自愈)。
 *  取值 'Nh'/'Nm'/'Ns';'-1' 不允许(常驻侧解析仅认数字单位),要近似永久用超大时长如 '168h'(一周)。 */
export const OLLAMA_KEEP_ALIVE = '24h';
export const OLLAMA_NUM_CTX = 4096;
/** ollama 批量嵌入批间节流:已废并移除(2026-11-14 审查回退——死导出零消费;节流仅存于 embed.mjs --pace CLI,默认 0)。
 *  WHEA 复发时的应急旋钮仍是 embed.mjs --pace;历史见 agent_reports/fix-logs/fix-20261112-whea-mitigation.md */

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
  exts: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'scss', 'css', 'less', 'html', 'sql', 'wxs', 'json', 'md', 'txt', 'rst', 'yaml', 'yml', 'toml', 'ini', 'xml', 'properties', 'gradle', 'conf', 'py', 'java', 'kt', 'go', 'rs', 'php', 'rb', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'dart', 'scala', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'graphql', 'gql', 'proto'],
  jsonWhitelist: ['package.json', 'pages.json', 'manifest.json', 'tsconfig.json'],
  maxFileBytes: 800 * 1024,
  // Cursor 全量 Read 行数上限。超过 ×1.25 由 preToolUse 拦截;带 offset/limit 的区间读不受限。
  readMaxLines: 500,
  chunk: { targetLines: 70, maxLines: 120, overlapLines: 10, minTail: 15 },
  // L2 样本库配额(2026-11-10 配置化,原 120 硬编码在 autoExemplars/buildExemplars):
  //   capPerLabel=单类硬上限(防单一类别垄断近邻票);dynamicQuota=true 时实际配额按各类供给的
  //   sqrt 平滑分摊 totalCap 总预算,cap 只在某类占比过高时兜底(默认 200 ≈ 总预算一半);
  //   totalCap=全库总预算(控 kNN 全库扫描/构建成本与内存);
  //   dynamicQuota=false 退回旧行为(每类 cap、无全局预算分配)。
  //   authority=同名内容键的标签权威层:'local'(默认,= 项目当前四票自签模式)用本地标签覆盖服务器;
  //     'base' 保留服务器清洗结果(本地只补向量、不改标签)。
  // data/code-index.config.json 的 exemplars 段可覆盖(深合并)。
  // 2026-11-14:base+local 双层向量合并生效 ⇒ 本地层**不限比例**——capPerLabel/totalCap 默认
  //   **0=不生效**(全量入库);显式配正数才重新启用配额治理(两键可独立生效,见 buildExemplars)。
  exemplars: { capPerLabel: 0, totalCap: 0, dynamicQuota: true, authority: 'local' },
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
  // 本地 transformers.js 嵌入的 CPU 线程上限(2026-11-14 用户定案:嵌入默认"后台缓慢运行"不拉满 CPU):
  //   传给 ORT 会话 intraOpNumThreads(interOp 恒 1);默认=min(4, max(2, 物理核数/4))≈25% CPU。
  //   data/code-index.config.json 顶层键可覆盖;0=全核(旧行为)。embed.mjs 另可用 --cpu-threads 单次覆盖。
  embedCpuThreads: Math.max(2, Math.min(4, Math.floor(os.cpus().length / 4))),
  // 自愈补拉节流(2026-11-14 用户定案:可配置):模型被驱逐/缺位后,两次补拉之间的最小间隔。
  //   默认 600000=10 分钟(防持续故障时的进程风暴);调小=驱逐后拉回更快,代价是故障时 spawn 频率高。
  //   data/code-index.config.json 顶层键可覆盖,最小 1000ms。
  warmMinIntervalMs: 600000,
  models: {
    embedding: 'qwen3-embedding:0.6b',
    reranker: 'sam860/qwen3-reranker:0.6b-F16',
    localEmbedding: 'Xenova/jina-embeddings-v2-base-zh',
    localReranker: 'Xenova/bge-reranker-base',
    // 本地决策模型双轨定档(2026-11-09):decision=ollama 路径(tev1:0.8b,systemone 协议),
    // localDecision=纯 Node 常驻路径(Strands-Decider-2B ONNX q4f16 指针头,1.04GB;同批 60 条对照 73.3% vs q8 70.0% 且快 2.1 倍,实测取代 q8)。
    // strands: 前缀指 code-index/hf-cache/<目录>;分词 offsets 走官方 tokenizers Rust binding(零 Python 运行时)。
    // 旧 Decision-2.0-Eos 已废(16.9% 类别崩塌);远程 systemone 端点代码保留,仅显式注入 providers/fetchFn 时可用。
    decision: 'tev1:0.8b',
    localDecision: 'strands:strands-decider-2B-hobson-v19:q4f16',
  },
  modelIn: 'local', // ollama | local。data JSON 可覆盖;缺省或非法值按 local。
  ollamaBase: 'http://localhost:11434',
  gpu: 'auto', // auto=按显存判定;cpu / gpu=强制。改这里,不要设环境变量。
  // 多模型路由门控(model-routing.md #11):默认全关。enabled=true 后 prompt-guard 才跑 L1 分类+路由日志;
  // 二次人工配置:改 data/code-index.config.json 的 modelRouting 段(2026-11-03 起 role 两档制已废:routeMode/roles/chains
  // 均不再被读取,四档链恒由快照派生;providerPriority/brandPriority 仍生效)。
  // l2(2026-11-07 收口为嵌套键;旧顶层 l2Shadow/l2Live/旧 l2.minSim 兼容读一个版本期,读法统一在 modelRoute.mjs mrL2Options):
  //   {shadow=false 嵌入器总闸——L2 kNN/影子级联要 true 才加载嵌入模型(影子起子进程会与主会话争资源,默认关);
  //    vote:{minSim 0.55, minConf 0.6} 代签投票阈值;
  //    live:{enabled=false, minConf=0.3} 代理实弹 L2 融合票(词法判 R1 但 kNN 投 multi 且置信≥minConf ⇒ 救回 R2,
  //    只救回不压制),依赖嵌入模型与向量库;shadow 关则两条支路都拿不到嵌入器。
  //   minConf 2026-11-06 实测定档 0.3(=旧口径 0.75 的同分位操作点;置信口径换边际差值后旧 0.6-0.8 几乎不触发)。
  // brandPriority(2026-11-03 用户需求):自定义品牌调用顺序,只决定"同一档位内谁先被调"(四档链档内排序主键),
  //   **不影响档位归属**(tierOfModel/classifyDifficulty/resolveTier 级联照旧)——即"不影响动态模型路由的调用档位"。
  //   未在列表里的品牌排到所有已列品牌之后;可改 data/code-index.config.json 的 modelRouting.brandPriority 覆盖。
  // modelTiers/lightSuffixes(2026-11-06 v4 用户定档;v4.1 grok/gemini 移入 mid、后缀表补 sol/sonnet):模型名→档位的品牌面,全部可改 data JSON。
  //   modelTiers=品牌三档默认表(normal=deepseek/glm/qwen/minimax→R2 / mid=kimi/grok/gemini→R3 / high=claude/gpt→R4,
  //   未识别品牌按 normal 兜底);lightSuffixes=轻量版本后缀(命中即默认档降一档,R1 封底,flash 恒 R1)。
  //   pro/max 不特殊:档位语义与品牌等级一一对应。改这里即可重排四档链,不用动代码。
  // retryOnRateLimit(2026-11-03):运行时 429/5xx 同轮重选开关,默认 true——转发拿到可重试错误时不向客户端透传空回复,
  //   而是同轮冷却失败模型→重跑 resolveTier(档内滑下一个 / R4→R3→R2→R1 降档)→换模型重发;maxRetries=同轮最多重发次数
  //   (默认 2,硬上限 5)。只在 tier 模式且能重解析出新模型时才真的重发,否则等价旧的单次透传;设 false 整体关闭回到旧行为。
  // providerPriority(2026-11-03 恢复):同名模型挂多供应商(多 Token Plan)时的同名取序,空=按快照键序。
  // decisionModel(v4 2026-11-09 本地化收口):决策票恒本地判定(modelIn=ollama 打 models.decision
  //   tev1:0.8b / modelIn=local 打常驻 models.localDecision Strands q4f16),零远程调用、零 key 依赖;
  //   旧键 model/providers/chunkSize/rRef 已废弃不读——实弹定档 arm1/arm2 参数与代签门槛全部走
  //   模型判定档案(resolveDecisionProfile:默认表 tev1 0.4/strands 0.4+FALLBACK,data JSON
  //   modelRouting.decisionModel.profiles 可覆盖)。四票合议口径见 autoLabel.mjs 头注;
  //   失败自动跳闸(断路器),恢复=人工 --probe 探活或下次会话启动自动探活;
  //   独立复核 CLI(node decisionModel.mjs --review-golden)只出报告不改量尺。
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
  modelRouting: { enabled: false, retryOnRateLimit: true, maxRetries: 2, providerPriority: [], blendNotice: { enabled: true }, l2: { shadow: false, vote: { minSim: 0.55, minConf: 0.6 }, live: { enabled: false, minConf: 0.3 } }, decisionModel: { enabled: false, model: '', providers: [{ baseUrl: '', apiKey: '', path: '' }] }, brandPriority: ['glm', 'deepseek', 'qwen', 'minimax', 'kimi', 'grok', 'claude', 'gpt', 'gemini'], modelTiers: { normal: ['deepseek', 'glm', 'qwen', 'minimax'], mid: ['kimi', 'grok', 'gemini'], high: ['claude', 'gpt'] }, lightSuffixes: ['flash', 'preview', 'coding', 'code', 'coder', 'turbo', 'mini', 'air', 'nano', 'event', 'haiku', 'luna', 'lite', 'base', 'sol', 'sonnet'], maxPhaseTurns: MAX_PHASE_TURNS, switchGuard: { enabled: true, maxContextTokens: SWITCH_GUARD_MAX_CONTEXT_TOKENS }, tierOptimize: { enabled: false, minIntervalMs: 6 * 60 * 60 * 1000, folds: 5, minN: 6, priorN: 8, grow: true, fitCost: false, dry: false, allowBoost: false } },
};

export function loadConfig({ soft = false } = {}) {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      // 显式失败而非静默回退:config 含 roots/models/注解库,坏 JSON 会让 roots 丢失、行为回默认,必须让人看到
      console.error(`[err] ${CONFIG_PATH} 解析失败(${e.message})——请修复 JSON 后重试;拒绝以默认值静默运行`);
      if (soft) return { ...DEFAULT_CONFIG, _configError: e.message }; // 热路径(判定层)soft 模式:带回错误让调用方 fail-open(夜审 S12-C13)
      process.exit(1);
    }
  }
  const cfg = {
    ...DEFAULT_CONFIG,
    ...fileCfg,
    chunk: { ...DEFAULT_CONFIG.chunk, ...(fileCfg.chunk || {}) },
    exemplars: { ...DEFAULT_CONFIG.exemplars, ...(fileCfg.exemplars || {}) },
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

/** 决策模型路由面判定(2026-11-08 用户定档)。providers 全空模板条目/缺键均不算远程。
 *  - decisionActive=判定总闸:v4(2026-11-09)远程链删后恒 true——本地判定恒启用,断路器另有挡闸
 *  - decisionLocalWanted=本次是否要加载/预热/自愈本地决策模型:恒 true(唯一判定路径)
 *  arm1/arm2 的 live/rescue 闸走模型判定档案(resolveDecisionProfile),不再读 enabled */
export function decisionRemoteConfigured(cfg = null) { return false; } // v4 兼容桩:远程已删,恒 false(仅防旧调用方炸)
export function decisionActive(cfg = null) { return true; }
export function decisionLocalWanted(cfg = null) { return true; }
