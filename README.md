# TokenSaver
客户端下载 
[https://gitcode.com/dionfang/TokenSaver/releases/download/v2.0.0/TokenSaver-Setup-0.2.24.exe](url)
## 中文项目简介

### 项目简介

TokenSaver 是跑在本机的 Agent 提效工具,有两大核心功能模块。

**模块一:省耗记账(Token Ledger)**——为代码库建语义检索索引,Agent 定位代码只读需要的区间;过长的整文件读取会被守卫改写为语义最相关区间,选不出才拒绝;每轮节约按 token 精确入账,会话状态句实时展示今日与累计。**Cursor、ZCode、Qoder 三端通用**。

**模块二:动态模型路由(AutoTier)**——本地代理即自定义模型端点,客户端多出一个虚拟模型档位 `auto`;选中它的会话由代理按 prompt 难度四档定档(R1-R4,以 R3=1x 为基准),贵模型只在必要时使用;自进化闭环持续降本。**仅 ZCode 与 Qoder 支持,且只对以 Anthropic Messages 协议接入的自定义模型生效**。

适合在本地代码库上用 Agent 开发。默认推荐**桌面客户端(托盘守护程序)**安装,无需命令行;纯命令行只是不装守护程序时的备选。一个 TokenSaver 可以用 `--roots` 索引多个目录。代码、分块和向量写在本机 `data/`,不进入 git。

配置分两层:模型部署参数改 `code-index/config.mjs`;项目配置在 `data/code-index.config.json`(init 自动生成,含 `modelRouting` 路由段)。字段说明见下文「配置」与 [`部署使用说明.txt`](code-index/部署使用说明.txt)。
![微信图片_20261105220119.png](https://raw.gitcode.com/user-images/assets/11189521/7fabff6c-6f9b-44a9-943b-fbc69d24b447/微信图片_20261105220119.png '微信图片_20261105220119.png')
### 工作方式

#### 省耗记账(要点)

- 混合检索:BM25 词法 + 向量余弦;需要更准再加 `--rerank`;嵌入拉起失败自动降为纯 BM25。嵌入默认 local(transformers.js),可选 `--model-in ollama`;判定模型本地运行、零远程调用。
- 读取守卫:整文件 Read 超过 `readMaxLines`(默认 500)的 1.25 倍即改写为语义区间,选不出才拒绝并给出替代方案;Grep 无 `head_limit` 补 100;同一目标 5 分钟内重试一次放行。只对 `exts` 白名单内的文本类型拦截与记账,白名单外(图片/二进制)直接放行。
- 索引保鲜:git 仓库按 HEAD 判断过期;非 git 目录默认 24 小时重建。
- 入账:节约量按 qwen tokenizer 精确计数,只记拦截入口一次;状态句实时展示今日/累计。Cursor 端无 usage 数据源,只计入口一次、不计会话放大。
- 模型清理:切换模型后开会话自动卸掉本工具拉起的驻留模型(自己 pull 的不碰);宿主关闭后统一卸载,不留驻留尾巴。手动清:`node cleanup.mjs --all`。

#### 动态模型路由(要点)

- 会话选 `auto` 虚拟模型即启用;每轮按难度定档 R1-R4,R1 为 sticky 基准,宽限/阶段粘住/切换税门控压低换档频率;短确认/短指令等续接轮沿用阶段档不拆阶段。
- 定档链:词法底档(品牌三档表 + 轻量后缀降档)→ 本地判定模型双臂救回(R1 升 R2、R2 升 R3);R4 唯一入口=显式点名旗舰模型。费率以 R3=1x 为基准(R1≈0.05x / R2≈0.5x / R4≈3.6x),长期实测综合费率 ≈0.15x。
- 上游 429/配额墙同轮滑链或降档;门控连续拦截满 3 次疲劳放行。
- 自进化闭环:真实流量自动生长黄金集,每 6h 学习信号权重与门槛,折外过门控自动晋升,成本恶化自动回滚。
- 生效条件与配置字段见「配置」的 modelRouting 段。

### 环境

- Node.js ≥ 18,以及 git。
- local:模型在 `code-index/hf-cache`(三个本地模型——嵌入/精排 transformers.js、决策 Strands ONNX,约 1.5GB)。该目录超过 git 单文件上限,不入库;缺失时首次使用才下载。复制部署时请整目录带走。
  内存需求:纯 CPU 运行,无显卡要求;三模型常驻内存合计约 2-3GB(权重约 1.5GB + ONNX 运行时),嵌入线程默认限 `min(4, max(2, 物理核数/4))`(`embedCpuThreads`),慢机也不占满核。
- ollama:本机先安装并自行启动 Ollama,再手工 pull。Ollama 模型不随目录复制。
  显存需求:`gpu=auto`(默认)按**总显存 ≥6GB** 判定走 GPU(给系统/其他程序留余量),三模型常驻显存 **≈4.5GB**(`OLLAMA_KEEP_ALIVE=24h` 恒占,空闲不驱逐);总显存不足 6GB 或无独立显卡时自动改用 CPU 跑——功能不变,嵌入吞吐显著变慢。
  版本推荐:**钉 Ollama 0.40.15**——实测嵌入批量 ~0.83s/块;0.40.16 退化至 1.17-1.42s/块(约 1.5 倍慢),0.40.7 居中且波动大;三个版本的 /v1/systemone 决策端点均兼容。升级前先按同口径复测嵌入吞吐(batch 32、腾显存、90s 双采样)。


```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
ollama pull tev1:0.8b
```

模型名若在 `code-index/config.mjs` 里改过,pull 改为改后的名字。

### 使用

`init` 会安装依赖、写配置、接线 hook,并在后台建索引、预热。用 `node status.mjs` 确认就绪。参数名写错或取值非法时报错退出且不改配置。

#### 客户端安装(托盘守护程序,推荐)

安装包随 Release 发布:在线包 ≈225MB(三 CPU 权重装后向导自动在线下载,带镜像回退)与完整离线包 ≈1.48GB(权重随包,离线环境用)。双击安装;未完成首次配置时双击只开安装向导,完成后直接进托盘。

首次配置走安装向导五步:运行模式(cpu/gpu)→ 环境自检(缺项自动安装)→ 数据上传(可选)→ 接线(自动完成 `init`)→ 完成(同会话转入托盘)。

之后由托盘守护程序负责日常运行:四组状态灯 + 面板反映索引与三个本地模型状态;「更新」按钮下载最新公共决策包并上传本地决策包(本地不存在时静默跳过);应用升级走托盘菜单「检查应用更新」(差量下载 + sha512 完整性门)。全程无需命令行。

两类数据落点:①向量索引数据(分块/向量/配置/记账账本)在 `%LOCALAPPDATA%\TokenSaver\data`;②模型文件在 `%USERPROFILE%\.tokensaver\hf-cache`(cpu 模式的三权重,由安装器/向导下载),gpu 模式的模型由 Ollama 自管(默认 `%USERPROFILE%\.ollama\models`)。

![default.jpg](https://raw.gitcode.com/user-images/assets/11189521/99072fb5-0580-4656-a221-c58602df62ec/default.jpg 'default.jpg')

#### 纯命令行工具(不安装托管守护程序)

数据写在本仓库 `data/`,不写进被索引的项目。

两类数据落点:①向量索引数据(分块/向量/配置/记账账本)在仓库根的 `data/`;②模型文件——`--model-in local`(默认)在 `code-index/hf-cache`(三模型约 1.5GB,不入库,缺失时首次使用自动下载),`--model-in ollama` 由 Ollama 自管(默认 `%USERPROFILE%\.ollama\models`,不随目录复制)。

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<项目目录1>,<项目目录2>"
node status.mjs
node search.mjs 关键词 --k 5
```

以后在 `data/code-index.config.json` 的 `roots` 里改路径,再跑一次不带参数的 `node init.mjs`,即可把新目录编进索引,并给那些 git 仓挂钩子。

#### 复制到目标项目

复制 `code-index/` 这一个目录到项目任意位置,建议 `scripts/code-index`。必须带上 `hf-cache`;不要带 `node_modules` 与 `data/`。

数据写在与该目录平级的 `data/`(若 `code-index` 本身是 git 根则写在其下的 `data/`);可用环境变量 `CODE_INDEX_DATA_DIR` 改位置。

```bash
cd 目标项目/scripts/code-index
node init.mjs
node status.mjs
```

只复制了 `code-index/` 时,同目录的 [`部署使用说明.txt`](code-index/部署使用说明.txt) 是同一份说明。

### 初始化参数

```bash
node init.mjs [--roots "<路径1>[,<路径2>...]"] [--set-roots "<路径1>[,<路径2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder] [--routing-on]
```

`--roots`:逗号分隔的扫描目录,写入 `data/code-index.config.json`。正斜杠、反斜杠都可以。

- 不传且还没有配置:用工具仓 git 根。
- 不传且已有配置:按文件里的 `roots` 自愈(仍存在的保留),不把工具仓自己塞进名单。
- 传入:与已有 `roots` 合并。不存在的路径跳过。要删目录,用 `--set-roots` 整表替换(传空=清空),或改 JSON 后重跑不带参数的 `init`。

`--set-roots`:逗号分隔目录**整表替换**(与 `--roots` 的合并语义相反;可重复传,传空=清空)。

`--hooks`:`all` | `cursor` | `zcode` | `qoder`。只写选中工具的会话 hook,不改其他工具已有文件。不传时按「项目简介」的兼容范围:省耗记账三端都装,动态模型路由只装 ZCode 与 Qoder。

`--model-in`:`ollama` 或 `local`,写入 `modelIn`,不改模型名。新建配置时不传则为 `local`,已有配置不传则保持原路径。

`--routing-on`:显式开启路由记账闭环(写入 `modelRouting.enabled=true`)。已有配置人工改的 false 原样保留。

### 配置

模型部署只改 `code-index/config.mjs`。`data` 里 JSON 的同名项无效。

| 项 | 默认 |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto`(还可设 `cpu`、`gpu`;num_gpu 只对嵌入/精排生效) |
| `OLLAMA_KEEP_ALIVE` | `24h`(模型常驻,显存恒占≈4.5GB) |
| `OLLAMA_NUM_CTX` | `4096` |

项目配置在与 `code-index/` 平级的 `data/code-index.config.json`。未写的键用 `config.mjs` 的默认值。

| 键 | 说明 |
|---|---|
| `roots` | 扫描目录。优先级:`--roots` > 环境变量 `CODE_INDEX_ROOTS` > 本文件 |
| `modelIn` | `ollama` 或 `local`。优先级:`--model-in` > 本文件 > `local` |
| `skipDirs` | 跳过的目录名,整表替换。默认跳过依赖、构建产物和编辑器目录 |
| `exts` | 收录的扩展名,不带点 |
| `jsonWhitelist` | 允许收录的 json 文件名 |
| `maxFileBytes` | 单文件上限,默认 `819200` |
| `readMaxLines` | 全量 Read 行数上限,默认 `500`。设得很大等于关掉拦截 |
| `chunk` | `targetLines` 70,`maxLines` 120,`overlapLines` 10,`minTail` 15 |
| `staleNonGitMs` | 非 git 目录重建间隔,毫秒,默认 `86400000` |
| `embedCpuThreads` | 本地嵌入的 CPU 线程上限。默认 `min(4, max(2, 物理核数/4))`;`0`=全核 |
| `warmMinIntervalMs` | 模型缺位后两次自愈补拉的最小间隔,毫秒,默认 `60000` |
| `knownAnnotations` | `"项目名/相对路径"` → 一句职责 |

#### modelRouting(动态模型路由配置)

`modelRouting` 段由 init 自动生成骨架(`enabled` 默认 `true`),**已有配置不覆盖**;只认 `data/code-index.config.json`。常用配置项:

| 键 | 说明 |
|---|---|
| `enabled` | 总开关(默认 `true`)。关闭=停每轮定档行注入、L1 分类、routing-log 落盘;auto 流量无论开关都照常路由 |
| `brandPriority` | 四档链档内品牌调用优先序(默认 glm,deepseek,qwen,minimax,kimi,grok,claude,gpt,gemini),不影响档位归属 |
| `modelTiers` | 品牌三档默认表:`{normal:[deepseek,glm,qwen,minimax]→R2, mid:[kimi,grok,gemini]→R3, high:[claude,gpt]→R4}`,未识别品牌按 normal 兜底 |
| `lightSuffixes` | 轻量版本后缀表(默认 flash,preview,coding,code,coder,turbo,mini,air,nano,event,haiku,luna,lite,base,sol,sonnet):命中降一档(R1 封底,flash 恒 R1) |
| `providerPriority` | 同名模型挂多供应商时的取序,配额尽自动滑下一供应商 |
| `providerOrder` | 宿主 UI 供应商拖动序(快照自动采集,无需手配),配置同键可覆盖 |
| `retryOnRateLimit` / `maxRetries` | 运行时 429/5xx/网络失败同轮换模型重选(默认 true / 2) |
| `maxPhaseTurns` | 升档阶段最多持续的人类轮数(默认 4),到顶回 R1 基准 |
| `switchGuard` | 切换税门控 `{enabled 默认 true, maxContextTokens 默认 200000}`;只拦升档,连续拦满 3 次疲劳放行 |
| `decisionModel` | 判定模型(恒本地零远程):ollama=`models.decision`(tev1:0.8b)/ local=`models.localDecision`(Strands ONNX)。双臂与代签门槛走模型档案 `profiles`;判定失败维持原档,拉不起=决策票弃权,不拖垮检索/路由 |
| `manualSwitch` | 人工改档真值通道 `{enabled 默认 true, live 默认 false}`:只采人工改档动作,默认只采集+审计,live=true 才写进黄金证据;台账 `data/routing/manual-switch.jsonl` |
| `tierOptimize` | 自进化闭环 `{enabled, minIntervalMs, folds, minN, priorN, grow, fitCost, dry, allowBoost}`:enabled=true 后每 6h 学习权重与门槛 |
| `blendNotice` | auto 综合费率行注入开关(默认 true);关=只停注入,记账照常 |

生效范围:仅 ZCode/Qoder 两端;auto 只调度以 Anthropic Messages 协议接入的自定义模型;模型分档按名字自动判定,两表都在 `modelTiers` / `lightSuffixes`,可改配置重排全链。

### 仓库模块

运行时脚本只在 `code-index/` 维护,不提供 npm 安装。

| 目录 | 用途 |
|---|---|
| [`code-index/`](code-index/) | 运行时。直接部署、在本仓运行,或复制到目标项目的就是这一份 |

### 许可

MIT。

## 英文项目简介

### Overview

TokenSaver is a local agent productivity tool with two core feature modules.

**Module 1: Token Ledger (省耗记账)** — builds a semantic search index over the codebase so the agent reads only the spans it needs; over-long full-file reads are rewritten to the closest semantic range, denied only when nothing fits; every turn's savings are accounted in tokens and shown live in the session status line. **Works on all three clients: Cursor, ZCode, and Qoder.**

**Module 2: Dynamic Model Routing (AutoTier)** — the local proxy doubles as a custom-model endpoint and the client gains a virtual model tier `auto`; sessions that select it are dispatched across four difficulty tiers (R1-R4, with R3 = 1x as base), so expensive models run only when needed; a self-evolution loop keeps reducing cost. **ZCode and Qoder only, and only for custom models wired in via the Anthropic Messages protocol.**

Built for agent-based development on local repositories. The **desktop client (tray guardian)** is the recommended install — no command line needed; the pure CLI is the fallback for when you prefer not to install the guardian. One TokenSaver can index several directories with `--roots`. Chunks and vectors stay in a local `data/` directory and are not committed to git.

Configuration has two layers: model deployment parameters in `code-index/config.mjs`; project settings in `data/code-index.config.json` (scaffolded by init, including the `modelRouting` section). See "Configuration" below and `部署使用说明.txt` for the full field reference.

### How it works

#### Token Ledger (key points)

- Hybrid search: BM25 lexical + vector cosine; add `--rerank` for tighter ranking; falls back to BM25-only if the embedding model fails to start. Embedding defaults to local (transformers.js), optionally `--model-in ollama`; the decision model runs locally with zero remote calls.
- Read guard: a full-file Read past 1.25 × `readMaxLines` (default 500) is rewritten to a semantic range, denied only when no range fits, with alternatives offered; Grep without `head_limit` is capped at 100; one retry of the same target within five minutes is allowed. Only file types inside the `exts` whitelist are intercepted and accounted; anything outside (images/binaries) passes through untouched.
- Index freshness: git repositories go stale by HEAD; non-git directories rebuild every 24 hours by default.
- Accounting: savings are counted precisely with the qwen tokenizer, recorded once at the interception point; the status line shows today/cumulative live. Cursor has no usage feed and is booked entry-once only, without session amplification.
- Model cleanup: starting a session after a model switch unloads the leftovers this tool pulled up (chat models you pulled yourself are never touched); after the host closes, everything is unloaded with no resident tail. Manual cleanup: `node cleanup.mjs --all`.

#### Dynamic model routing (key points)

- Selecting the `auto` virtual model enables it; each turn is tiered R1-R4, with R1 as the sticky base and grace / phase stickiness / a switch-tax gate damping tier changes. Short continuation turns keep the current phase tier instead of splitting a new phase.
- Tiering chain: a lexical base tier (brand three-grade table + lightweight-suffix demotion) is rescued by the always-local judge model in two arms (R1 → R2, R2 → R3); R4 is never reached by auto-escalation — the only entry is explicitly naming a flagship model. Rates use R3 = 1x as base (R1≈0.05x / R2≈0.5x / R4≈3.6x), with the long-run blended rate measured at ≈0.15x.
- Upstream 429 / quota walls trigger a same-turn chain slide or downgrade; the gate releases by fatigue after 3 consecutive blocks.
- Self-evolution loop: real traffic grows the golden set automatically; every 6h weights and thresholds are learned, out-of-fold gate passing auto-promotes, and cost regressions auto-roll back.
- Scope and config keys: see the `modelRouting` subsection under "Configuration" below.

### Requirements

- Node.js ≥ 18, and git.
- local: models live in `code-index/hf-cache` (three local models — embedding / reranker via transformers.js, decision via resident Strands ONNX, about 1.5GB). That directory exceeds git's per-file limit and is not in the repository. Missing models are downloaded on first use. When you copy the tool, take the whole directory with you.
  Memory: CPU-only, no GPU required; the three resident models together take about 2-3GB of RAM (~1.5GB weights + ONNX runtime). Embedding threads are capped at `min(4, max(2, cores/4))` by default (`embedCpuThreads`), so slow machines keep some cores free.
- ollama: install and start Ollama yourself, then pull the models by hand. Ollama model weights are not copied with this directory.
  VRAM: with the default `gpu=auto`, the GPU path is taken when **total VRAM ≥ 6GB** (headroom left for the system and other programs), and the three resident models occupy **≈4.5GB** (`OLLAMA_KEEP_ALIVE=24h`, steady, not evicted when idle). Below 6GB or without a discrete GPU, Ollama falls back to CPU — everything still works, but embedding throughput drops markedly.
   Version pin: **Ollama 0.40.15** — measured embedding throughput ~0.83s/chunk; 0.40.16 regressed to 1.17-1.42s/chunk (~1.5x slower), 0.40.7 sits in between with high variance; /v1/systemone decision endpoint is compatible on all three. Re-benchmark with the same protocol (batch 32, free VRAM, 90s double-sampling) before upgrading.


```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
ollama pull tev1:0.8b
```

If the model names were changed in `code-index/config.mjs`, pull those names instead.

### Usage

`init` installs dependencies, writes config, attaches hooks, and builds and warms the index in the background. Confirm it is ready with `node status.mjs`. A bad flag name or an illegal value exits with an error and does not change config.

#### Client install (tray guardian, recommended)

The installer ships with the Release: the online package ≈225MB (three CPU weights are downloaded by the wizard right after install, with mirror fallback) and the full offline package ≈1.48GB (weights bundled, for offline machines). Double-click to install; before first-time setup is finished, double-clicking opens the installer wizard only, and afterwards it opens straight into the tray.

First-time setup runs the five-step wizard: run mode (cpu/gpu) → environment self-check (missing items auto-install) → data upload (optional) → wiring (runs `init` automatically) → finish (hands over to the tray in the same session).

Afterwards the tray guardian handles day-to-day operation: four status lamps + panel reflect the index and the three local models; the "update" button downloads the latest public decision pack and uploads the local one (silently skipped when the local pack is absent); app upgrades go through the tray menu "check for app updates" (differential download + sha512 integrity gate). No command line needed.

Two kinds of data live in fixed locations: (1) vector-index data (chunks / vectors / config / ledgers) in `%LOCALAPPDATA%\TokenSaver\data`; (2) model files in `%USERPROFILE%\.tokensaver\hf-cache` (the three CPU-mode weights, downloaded by the installer/wizard), while gpu-mode models are managed by Ollama itself (default `%USERPROFILE%\.ollama\models`).

![default.jpg](https://raw.gitcode.com/user-images/assets/11189521/99072fb5-0580-4656-a221-c58602df62ec/default.jpg 'default.jpg')

#### Pure CLI (no guardian install)

Data is written to this repo's `data/`, not into the projects being indexed.

Two kinds of data live in fixed locations: (1) vector-index data (chunks / vectors / config / ledgers) in the repo-root `data/`; (2) model files — with `--model-in local` (default) in `code-index/hf-cache` (three models, ~1.5GB, not in git, downloaded on first use), with `--model-in ollama` managed by Ollama itself (default `%USERPROFILE%\.ollama\models`, not copied with the directory).

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<project-dir-1>,<project-dir-2>"
node status.mjs
node search.mjs keywords --k 5
```

Later, edit `roots` in `data/code-index.config.json` and run `node init.mjs` with no arguments. New directories are indexed, and hooks are attached to those git repositories.

#### Copy into a target project

Copy the `code-index/` directory into the project anywhere; `scripts/code-index` is the suggested path. You must include `hf-cache`; do not include `node_modules` or `data/`.

Data is written to a `data/` directory beside it (or inside it when `code-index` is itself the git root). Override the location with `CODE_INDEX_DATA_DIR`.

```bash
cd target-project/scripts/code-index
node init.mjs
node status.mjs
```

If you copied only `code-index/`, [`部署使用说明.txt`](code-index/部署使用说明.txt) in that same directory is the same guide.

### init options

```bash
node init.mjs [--roots "<path1>[,<path2>...]"] [--set-roots "<path1>[,<path2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder] [--routing-on]
```

`--roots`: comma-separated directories to scan, written to `data/code-index.config.json`. Forward slashes and backslashes both work.

- Omitted, and no config yet: use the git root of the tool repo.
- Omitted, and config already exists: heal `roots` from the file (keep paths that still exist). The tool repo itself is never added.
- Passed: merge into the existing `roots`. Skip paths that do not exist. To remove a directory, replace the whole list with `--set-roots` (empty value clears it), or edit the JSON and run `init` with no arguments.

`--set-roots`: comma-separated directories that **replace the whole list** (opposite of `--roots`, which merges; repeatable; an empty value clears it).

`--hooks`: `all` | `cursor` | `zcode` | `qoder`. Only the selected tool's session hooks are written; other tools' files are left as they are. When omitted, detection follows the compatibility scope under "Overview": the Token Ledger installs on all three clients, dynamic model routing on ZCode and Qoder only.

`--model-in`: `ollama` or `local`. It writes `modelIn` and does not change model names. Omitted on a new config, the path is `local`; omitted when a config already exists, the current path is kept.

`--routing-on`: explicitly enable the routing-accounting loop (writes `modelRouting.enabled=true`). A manual `false` in an existing config is preserved.

### Configuration

Change model deployment only in `code-index/config.mjs`. The same keys in the data JSON have no effect.

| Key | Default |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto` (also `cpu` or `gpu`; num_gpu only applies to embedding/reranker) |
| `OLLAMA_KEEP_ALIVE` | `24h` (models stay resident; steady VRAM footprint ≈4.5GB) |
| `OLLAMA_NUM_CTX` | `4096` |

Project settings live in `data/code-index.config.json`, beside `code-index/`. Keys you omit use the defaults in `config.mjs`.

| Key | Meaning |
|---|---|
| `roots` | Directories to scan. Precedence: `--roots` > `CODE_INDEX_ROOTS` > this file |
| `modelIn` | `ollama` or `local`. Precedence: `--model-in` > this file > `local` |
| `skipDirs` | Directory names to skip; a value replaces the whole list |
| `exts` | Extensions to index, without the leading dot |
| `jsonWhitelist` | JSON filenames allowed into the index |
| `maxFileBytes` | Per-file size cap. Default `819200` |
| `readMaxLines` | Line cap for a full-file Read. Default `500`. A very large value turns the guard off |
| `chunk` | `targetLines` 70, `maxLines` 120, `overlapLines` 10, `minTail` 15 |
| `staleNonGitMs` | Non-git directory rebuild interval, in milliseconds. Default `86400000` |
| `embedCpuThreads` | CPU thread cap for local embedding. Default `min(4, max(2, cores/4))`; `0` = all cores |
| `warmMinIntervalMs` | Minimum interval between self-healing re-pulls, in milliseconds. Default `60000` |
| `knownAnnotations` | `"project/relative-path"` → one sentence on what the file does |

#### modelRouting (dynamic model routing config)

The `modelRouting` section is scaffolded by init (`enabled` defaults to `true`), and **an existing config is never overwritten**; it is read only from `data/code-index.config.json`. Common keys:

| Key | Meaning |
|---|---|
| `enabled` | Master switch (default `true`); gates the per-turn `[model-routing]` tier line, L1 classification, and routing-log persistence. Auto traffic is routed the same way regardless |
| `brandPriority` | Within-tier brand call order of the four-tier chains (default glm,deepseek,qwen,minimax,kimi,grok,claude,gpt,gemini); does not affect tier assignment |
| `modelTiers` | Brand three-grade default table: `{normal:[deepseek,glm,qwen,minimax]→R2, mid:[kimi,grok,gemini]→R3, high:[claude,gpt]→R4}`; unrecognized brands fall back to normal |
| `lightSuffixes` | Lightweight-version suffixes (default flash,preview,coding,code,coder,turbo,mini,air,nano,event,haiku,luna,lite,base,sol,sonnet): a hit demotes one tier (floor R1; flash is always R1) |
| `providerPriority` | Same-name ordering when one model is hosted by several providers; an exhausted quota slides to the next one |
| `providerOrder` | Host UI provider drag order (auto-captured into the snapshot, no manual setup); a config key of the same name overrides it |
| `retryOnRateLimit` / `maxRetries` | Same-turn model re-selection on runtime 429/5xx/network failure (default true / 2) |
| `maxPhaseTurns` | How many human turns an upgrade phase may last (default 4), then back to the R1 base |
| `switchGuard` | Switch-tax gate `{enabled default true, maxContextTokens default 200000}`; upgrades only; releases by fatigue after 3 consecutive blocks |
| `decisionModel` | The judge model (always local, zero remote calls): ollama = `models.decision` (tev1:0.8b) / local = `models.localDecision` (Strands ONNX). Arms and signing thresholds follow per-model `profiles`; judge failure keeps the original tier, and a judge that cannot start abstains without affecting search/routing |
| `manualSwitch` | Human-switch truth channel `{enabled default true, live default false}`: only human switch actions are collected; live=true writes the human tier into golden evidence. Ledger `data/routing/manual-switch.jsonl` |
| `tierOptimize` | Self-evolution loop `{enabled, minIntervalMs, folds, minN, priorN, grow, fitCost, dry, allowBoost}`: with enabled=true, every 6h weights and thresholds are learned |
| `blendNotice` | Injection switch for the auto blended-rate line (default true); off = stops the line, accounting continues |

Scope: only ZCode/Qoder take part; auto dispatches only custom models wired via the Anthropic Messages protocol; model tiering is derived from the name, and both tables live in `modelTiers` / `lightSuffixes` and re-derive the whole chain from config.

### Repository layout

Runtime scripts are maintained only in `code-index/`; npm installation is not offered.

| Directory | Role |
|---|---|
| [`code-index/`](code-index/) | Runtime. This is what you deploy directly, run in this repo, or copy into a target project |

### License

MIT.
