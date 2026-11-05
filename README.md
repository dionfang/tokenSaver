# TokenSaver

## 中文项目简介

### 项目简介

TokenSaver 是跑在本机的 Agent 提效工具,有两大核心功能模块。

**模块一:省耗记账(Token Ledger)**——语义索引 + 读取守卫 + 入账统计。为代码库建混合检索索引,Agent 定位代码只读需要的区间;过长的整文件 Read 改写为语义最相关区间,选不出才拒绝;每一轮的节约量按 token 精确入账,会话状态句实时展示今日与累计。**Cursor、ZCode、Qoder 三端通用**。

**模块二:动态模型路由(AutoTier)**——init 后本地代理(127.0.0.1:8117)即自定义模型端点,客户端多出一个虚拟模型档位 `auto`;选中它的会话由代理按 prompt 难度四档定档(R1 日常 1x / R2 增强 8x / R3 最强 15x / R4 奢侈 100x)调度真实模型,贵模型只在必要时使用;配合健康滑链、门控疲劳放行与自进化闭环持续降本。**仅 ZCode 与 Qoder 两个客户端支持,且只对自定义模型中以 Anthropic Messages 协议接入的模型生效**(会话不选 auto 或模型不是该接入方式时,零行为)。

适合在本地代码库上用 Agent 开发。一个 TokenSaver 可以用 `--roots` 索引多个目录。代码、分块和向量写在本机 `data/`,不进入 git。
![微信图片_20261105220119.png](https://raw.gitcode.com/user-images/assets/11189521/7fabff6c-6f9b-44a9-943b-fbc69d24b447/微信图片_20261105220119.png '微信图片_20261105220119.png')

### 工作方式

#### 省耗记账(要点)

- 混合检索:BM25 词法 + 向量余弦;需要更准再加 `--rerank`;嵌入拉起失败自动降为纯 BM25。嵌入默认 local(transformers.js),可选 `--model-in ollama`。
- 读取守卫:整文件 Read 超过 `readMaxLines`(默认 500)的 1.25 倍即改写为语义区间,选不出才拒绝并给出替代方案;Grep 无 `head_limit` 补 100;同一目标 5 分钟内重试一次放行。Cursor 的 preToolUse 用字面 matcher。
- 索引保鲜:git 仓库按 HEAD 判断过期;非 git 目录默认 24 小时重建。
- 入账:节约量按 qwen tokenizer 精确计数,只记拦截入口一次(下限口径,真实节约随后续轮数复利);状态句实时展示今日/累计。

#### 动态模型路由(要点)

- 会话选 `auto` 虚拟模型即启用;每轮按难度定档 R1-R4,R1 为 sticky 基准,宽限/阶段粘住/切换税门控压低换档频率。
- 上游 429/配额墙同轮滑链或降档;门控连续拦截满 3 次疲劳放行,拦截时注入一次压缩建议。
- 自进化闭环:真实流量自动生长黄金集,每 6h 学习信号权重与门槛,折外过门控自动晋升 live,观察窗成本恶化自动回滚。
- 生效条件、接入要求与配置字段见下文「配置」的 modelRouting 段与 `部署使用说明.txt` 的配置说明。

### 环境

- Node.js ≥ 18,以及 git。
- local:模型在 `code-index/hf-cache`(两个 transformers.js 模型,约 439MB)。该目录超过 git 单文件上限,不入库;缺失时首次使用才下载。复制部署时请整目录带走。
- ollama:本机先安装并自行启动 Ollama,再手工 pull。Ollama 模型不随目录复制。

```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
```

模型名若在 `code-index/config.mjs` 里改过,pull 改为改后的名字。

### 使用

`init` 会安装依赖、写配置、接线 hook,并在后台建索引、预热。用 `node status.mjs`(或 `npx tokensaver status`)确认就绪。参数名写错、缺少取值,或 `--model-in` / `--hooks` 取值非法时,报错退出且不改配置。`--roots=路径` 与 `--model-in=local` 这种写法也可以。

#### 独立工具(推荐)

数据写在本仓库 `data/`,不写进被索引的项目。

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<项目目录1>,<项目目录2>"
node status.mjs
node search.mjs 关键词 --k 5
```

以后在 `data/code-index.config.json` 的 `roots` 里改路径,再跑一次不带参数的 `node init.mjs`,即可把新目录编进索引,并给那些 git 仓挂钩子。

#### 复制到目标项目

复制的是 `code-index/` 这一个目录,可放在项目任意位置,建议 `scripts/code-index`。必须带上 `hf-cache`。不要带 `node_modules`,不要带 `data/`。

数据写在与该目录平级的 `data/`(建议路径下即 `scripts/data`)。若 `code-index` 本身就是 git 根,则写在其下的 `data/`。可用环境变量 `CODE_INDEX_DATA_DIR` 改位置。npm 安装固定用仓库 `scripts/data`。

```bash
cd 目标项目/scripts/code-index
node init.mjs
node status.mjs
```

只复制了 `code-index/` 时,同目录的 [`部署使用说明.txt`](code-index/部署使用说明.txt) 是同一份说明。

#### npm(发布后)

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init
npx tokensaver status
npx tokensaver search 关键词 --k 5
```

### 初始化参数

```bash
node init.mjs [--roots "<路径1>[,<路径2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder]
```

`--roots`:逗号分隔的扫描目录,写入 `data/code-index.config.json`。正斜杠、反斜杠都可以。

- 不传且还没有配置:用工具仓 git 根。
- 不传且已有配置:按文件里的 `roots` 自愈(仍存在的保留,失踪的按兄弟目录猜一次),不把工具仓自己塞进名单;然后给这些 git 仓挂钩子并后台建索引。
- 传入:与已有 `roots` 合并(纳入,不去掉旧的)。不存在的路径跳过。要删目录,改 JSON 后重跑不带参数的 `init`。

`--hooks`:`all` | `cursor` | `zcode` | `qoder`。只写选中工具的会话 hook,不改其他工具已有文件。不传时的识别规则见「项目简介」的两模块兼容范围:省耗记账三端都装,动态模型路由只装 ZCode 与 Qoder。

`--model-in`:`ollama` 或 `local`,写入 `modelIn`,不改模型名。新建配置时不传则为 `local`。已有配置时不传则保持原路径。

### 配置

模型部署只改 `code-index/config.mjs`。`data` 里 JSON 的同名项无效。

| 项 | 默认 |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto`(还可设 `cpu`、`gpu`) |
| `OLLAMA_KEEP_ALIVE` | `2h` |
| `OLLAMA_NUM_CTX` | `4096` |

项目配置在与 `code-index/` 平级的 `data/code-index.config.json`。未写的键用 `config.mjs` 的默认值。

| 键 | 说明 |
|---|---|
| `roots` | 扫描目录。优先级:`--roots` > 环境变量 `CODE_INDEX_ROOTS` > 本文件 |
| `modelIn` | `ollama` 或 `local`。优先级:`--model-in` > 本文件 > `local` |
| `skipDirs` | 跳过的目录名。写了就整表替换,不是追加。默认已跳过依赖、构建产物和编辑器目录。新生成的配置还会加上 `code-index`、`.cursor`、`.zcode` |
| `exts` | 收录的扩展名,不带点 |
| `jsonWhitelist` | 允许收录的 json 文件名。默认 `package.json`、`pages.json`、`manifest.json`、`tsconfig.json` |
| `maxFileBytes` | 单文件上限。默认 `819200` |
| `readMaxLines` | 全量 Read 行数上限,默认 `500`。设得很大等于关掉拦截 |
| `chunk` | `targetLines` 70,`maxLines` 120,`overlapLines` 10,`minTail` 15 |
| `staleNonGitMs` | 非 git 目录多久重建一次,毫秒。默认 `86400000` |
| `knownAnnotations` | `"项目名/相对路径"` → 一句职责 |

#### modelRouting(动态模型路由配置)

`data/code-index.config.json` 的 `modelRouting` 段由 init 自动生成骨架(`enabled` 默认 `false`),**已有配置不覆盖**;与上面两层口径不同,这一段只认 `data/code-index.config.json`。常用配置项:

| 键 | 说明 |
|---|---|
| `enabled` | 总开关;只控制每轮 `[model-routing]` 定档行的注入,auto 流量无论开关都照常路由 |
| `brandPriority` | 四档链档内品牌调用优先序(默认 glm,minimax,deepseek,qwen,kimi,grok,claude,gpt,gemini),不影响档位归属 |
| `providerPriority` | 同名模型挂多供应商时的同名取序,配额尽自动滑下一供应商 |
| `retryOnRateLimit` / `maxRetries` | 运行时 429/5xx/网络失败同轮换模型重选(默认 true / 2) |
| `maxPhaseTurns` | 升档阶段最多持续的人类轮数(默认 4),到顶回 R1 基准 |
| `switchGuard` | 切换税门控 `{enabled 默认 true, maxContextTokens 默认 200000}`;只拦升档;同会话被拦满 3 次疲劳放行,拦截时注入一次压缩建议 |
| `l2Shadow` / `l2` | L2 向量投票通电开关与阈值 `{minSim, minConf}` |
| `decisionModel` | 四票代签的判定模型 `{enabled, model, providers:[{baseUrl,apiKey,path}], chunkSize}` |
| `tierOptimize` | 自进化闭环 `{enabled, minIntervalMs, folds, minN, priorN, grow, fitCost, dry, allowBoost}`:enabled=true 后每 6h 学习信号权重与门槛,折外过门控自动晋升 live,观察窗成本恶化自动回滚 |

生效范围与边界:仅 ZCode/Qoder 两端参与;auto 只调度自定义模型中以 Anthropic Messages 协议接入的模型;模型分档按名字自动判定(flash/haiku/lite→R1,普通/preview→R2,max/pro→R3,旗舰品牌无便宜后缀→R4),无需配置。接入步骤与配置字段见 [`部署使用说明.txt`](code-index/部署使用说明.txt) 的配置说明。

### 仓库模块

运行时脚本只在 `code-index/` 维护。发布 npm 包时 `prepack` 会跑 [`sync-npm.mjs`](sync-npm.mjs),把运行时生成到 `npm/`。

| 目录 | 用途 |
|---|---|
| [`code-index/`](code-index/) | 运行时。直接部署、在本仓运行,或复制到目标项目的就是这一份 |
| [`npm/`](npm/) | npm 发布骨架。只含 `package.json` 等基本文件;发布前由 `sync-npm.mjs` 生成运行时 |

### 许可

MIT。

## 英文项目简介

### Overview

TokenSaver is a local agent productivity tool with two core feature modules.

**Module 1: Token Ledger (省耗记账)** — semantic index + read guard + accounting. It builds a hybrid-search index over the codebase so the agent reads only the spans it needs; over-long full-file Reads are rewritten to the semantically closest range and denied only when no range fits; every turn's savings are accounted in tokens and shown live in the session status line. **Works on all three clients: Cursor, ZCode, and Qoder.**

**Module 2: Dynamic Model Routing (AutoTier)** — after init the local proxy (127.0.0.1:8117) is itself a custom-model endpoint and the client gains a virtual model tier `auto`; sessions that select it are dispatched by the proxy through a four-tier difficulty rating (R1 daily 1x / R2 enhanced 8x / R3 strongest 15x / R4 luxury 100x), so expensive models are used only when needed; health-based chain sliding, gate-fatigue release, and a self-evolution loop keep reducing cost. **Supported on ZCode and Qoder only, and only for custom models wired in via the Anthropic Messages protocol** (sessions that never select auto, or models wired otherwise, see zero behavior).

Built for agent-based development on local repositories. One TokenSaver can index several directories with `--roots`. Chunks and vectors stay in a local `data/` directory and are not committed to git.

### How it works

#### Token Ledger (key points)

- Hybrid search: BM25 lexical + vector cosine; add `--rerank` for tighter ranking; falls back to BM25-only if the embedding model fails to start. Embedding defaults to local (transformers.js), optionally `--model-in ollama`.
- Read guard: a full-file Read past 1.25 × `readMaxLines` (default 500) is rewritten to a semantic range, denied only when no range fits, with alternatives offered; Grep without `head_limit` is capped at 100; one retry of the same target within five minutes is allowed. Cursor's preToolUse uses literal matchers.
- Index freshness: git repositories go stale by HEAD; non-git directories rebuild every 24 hours by default.
- Accounting: savings are counted precisely with the qwen tokenizer, recorded once at the interception point (a lower bound; real savings compound over later turns); the status line shows today/cumulative live.

#### Dynamic model routing (key points)

- Selecting the `auto` virtual model enables it; each turn is tiered R1-R4, with R1 as the sticky base and grace / phase stickiness / a switch-tax gate damping tier changes.
- Upstream 429 / quota walls trigger a same-turn chain slide or downgrade; the gate releases by fatigue after 3 consecutive blocks and injects a one-shot compression suggestion while blocking.
- Self-evolution loop: real traffic grows the golden set automatically; every 6h signal weights and thresholds are learned, out-of-fold gate passing auto-promotes to live, and cost regressions inside the observation window auto-roll back.
- Scope, wiring requirements, and the config keys: see the `modelRouting` subsection under "Configuration" below and the configuration section of `部署使用说明.txt`.

### Requirements

- Node.js ≥ 18, and git.
- local: models live in `code-index/hf-cache` (two transformers.js models, about 439MB). That directory exceeds git's per-file limit and is not in the repository. Missing models are downloaded on first use. When you copy the tool, take the whole directory with you.
- ollama: install and start Ollama yourself, then pull the models by hand. Ollama model weights are not copied with this directory.

```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
```

If the model names were changed in `code-index/config.mjs`, pull those names instead.

### Usage

`init` installs dependencies, writes config, attaches hooks, and builds and warms the index in the background. Confirm it is ready with `node status.mjs` (or `npx tokensaver status`). A bad flag name, a missing value, or an illegal `--model-in` / `--hooks` value exits with an error and does not change config. `--roots=path` and `--model-in=local` are also accepted.

#### Standalone tool (recommended)

Data is written to this repo's `data/`, not into the projects being indexed.

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<project-dir-1>,<project-dir-2>"
node status.mjs
node search.mjs keywords --k 5
```

Later, edit `roots` in `data/code-index.config.json` and run `node init.mjs` with no arguments. New directories are indexed, and hooks are attached to those git repositories.

#### Copy into a target project

Copy the `code-index/` directory only. It can sit anywhere in the project; `scripts/code-index` is the suggested path. You must include `hf-cache`. Do not include `node_modules` or `data/`.

Data is written to a `data/` directory beside it (`scripts/data` on the suggested path). If `code-index` is itself the git root, data is written to `data/` inside it. Override the location with `CODE_INDEX_DATA_DIR`. An npm install always uses the repo's `scripts/data`.

```bash
cd target-project/scripts/code-index
node init.mjs
node status.mjs
```

If you copied only `code-index/`, [`部署使用说明.txt`](code-index/部署使用说明.txt) in that same directory is the same guide.

#### npm (after publish)

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init
npx tokensaver status
npx tokensaver search keywords --k 5
```

### init options

```bash
node init.mjs [--roots "<path1>[,<path2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder]
```

`--roots`: comma-separated directories to scan, written to `data/code-index.config.json`. Forward slashes and backslashes both work.

- Omitted, and no config yet: use the git root of the tool repo.
- Omitted, and config already exists: heal `roots` from the file (keep paths that still exist; guess a missing one once from a sibling directory). Do not add the tool repo itself. Then attach hooks to those git repositories and build the index in the background.
- Passed: merge into the existing `roots` (add, do not drop old entries). Skip paths that do not exist. To remove a directory, edit the JSON and run `init` with no arguments.

`--hooks`: `all` | `cursor` | `zcode` | `qoder`. Only the selected tool's session hooks are written. Files for the other tools are left as they are. When the flag is omitted, detection follows the two-module compatibility scope under "Overview": the Token Ledger installs on all three clients, dynamic model routing on ZCode and Qoder only.

`--model-in`: `ollama` or `local`. It writes `modelIn` and does not change model names. Omitted on a new config, the path is `local`. Omitted when a config already exists, the current path is kept.

### Configuration

Change model deployment only in `code-index/config.mjs`. The same keys in the data JSON have no effect.

| Key | Default |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto` (also `cpu` or `gpu`) |
| `OLLAMA_KEEP_ALIVE` | `2h` |
| `OLLAMA_NUM_CTX` | `4096` |

Project settings live in `data/code-index.config.json`, beside `code-index/`. Keys you omit use the defaults in `config.mjs`.

| Key | Meaning |
|---|---|
| `roots` | Directories to scan. Precedence: `--roots` > `CODE_INDEX_ROOTS` > this file |
| `modelIn` | `ollama` or `local`. Precedence: `--model-in` > this file > `local` |
| `skipDirs` | Directory names to skip. A value replaces the whole list; it does not append. The default already skips dependency, build, and editor directories. A newly generated config also adds `code-index`, `.cursor`, and `.zcode` |
| `exts` | Extensions to index, without the leading dot |
| `jsonWhitelist` | JSON filenames allowed into the index. Default: `package.json`, `pages.json`, `manifest.json`, `tsconfig.json` |
| `maxFileBytes` | Per-file size cap. Default `819200` |
| `readMaxLines` | Line cap for a full-file Read. Default `500`. A very large value turns the guard off |
| `chunk` | `targetLines` 70, `maxLines` 120, `overlapLines` 10, `minTail` 15 |
| `staleNonGitMs` | How often a non-git directory is rebuilt, in milliseconds. Default `86400000` |
| `knownAnnotations` | `"project/relative-path"` → one sentence on what the file does |

#### modelRouting (dynamic model routing config)

The `modelRouting` section of `data/code-index.config.json` is scaffolded by init (`enabled` defaults to `false`), and **an existing config is never overwritten**; unlike the two layers above, this section is read only from `data/code-index.config.json`. Common keys:

| Key | Meaning |
|---|---|
| `enabled` | Master switch; only gates the per-turn `[model-routing]` tier line. Auto traffic is routed the same way regardless |
| `brandPriority` | Within-tier brand call order of the four-tier chains (default glm,minimax,deepseek,qwen,kimi,grok,claude,gpt,gemini); does not affect tier assignment |
| `providerPriority` | Same-name ordering when one model is hosted by several providers; an exhausted quota slides to the next one |
| `retryOnRateLimit` / `maxRetries` | Same-turn model re-selection on runtime 429/5xx/network failure (default true / 2) |
| `maxPhaseTurns` | How many human turns an upgrade phase may last (default 4), then back to the R1 base |
| `switchGuard` | Switch-tax gate `{enabled default true, maxContextTokens default 200000}`; upgrades only; releases by fatigue after 3 consecutive blocks and injects a one-shot compression suggestion while blocking |
| `l2Shadow` / `l2` | Power switch and thresholds `{minSim, minConf}` for L2 vector voting |
| `decisionModel` | The judge model for four-vote auto-signing `{enabled, model, providers:[{baseUrl,apiKey,path}], chunkSize}` |
| `tierOptimize` | Self-evolution loop `{enabled, minIntervalMs, folds, minN, priorN, grow, fitCost, dry, allowBoost}`: with enabled=true, every 6h it learns signal weights and thresholds from the golden set, auto-promotes a candidate that passes the out-of-fold gate, and auto-rolls back if cost worsens inside the observation window |

Scope and boundaries: only ZCode/Qoder take part; auto dispatches only custom models wired via the Anthropic Messages protocol; model tiering is derived from the name (flash/haiku/lite→R1, normal/preview→R2, max/pro→R3, flagship brands without a cheap suffix→R4) and needs no configuration. Wiring steps and config keys live in [`部署使用说明.txt`](code-index/部署使用说明.txt), configuration section.

### Repository layout

Runtime scripts are maintained only in `code-index/`. On npm publish, `prepack` runs [`sync-npm.mjs`](sync-npm.mjs) and generates the runtime into `npm/`.

| Directory | Role |
|---|---|
| [`code-index/`](code-index/) | Runtime. This is what you deploy directly, run in this repo, or copy into a target project |
| [`npm/`](npm/) | npm publish skeleton. Only `package.json` and a few basic files; `sync-npm.mjs` generates the runtime before publish |

### License

MIT.
