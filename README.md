# TokenSaver

## 项目简介

TokenSaver 是跑在本机的语义代码索引。编程 Agent 定位代码时，经常把整份文件读进上下文。本工具为代码库建索引，用混合检索返回 `文件:起始行-结束行`，Agent 只读这一段，从而减少运行 Agent 时的 token 消耗。

适合在 Cursor、Qoder、ZCode 里用 Agent 改本地代码库。一个 TokenSaver 可以用 `--roots` 索引多个目录。代码、分块和向量写在本机 `data/`，不进入 git。

TokenSaver is a local semantic code index. Coding agents often pull entire files into context. This tool indexes the repository and uses hybrid search to return `file:start-end` spans, so the agent reads only that slice and spends fewer tokens while it runs.

It is for Cursor, Qoder, and ZCode on local repositories. One TokenSaver can index several directories with `--roots`. Chunks and vectors stay in a local `data/` directory and are not committed to git.

## 工作方式

### 混合检索

BM25 词法（标识符拆分、中文二元组）加向量余弦。需要更准时再加 `--rerank`。嵌入拉起失败时自动降为纯 BM25。

嵌入有两条路径。默认 local，用 transformers.js，不需要 Ollama。也可 `--model-in ollama`，使用本机已经 pull 的模型。本工具不启动 Ollama，也不自动 pull。

### 读取守卫

默认拦截过长的整文件读取（`readMaxLines` 默认 500，超过其 1.25 倍由钩子拦截）。带 `offset` / `limit` 的区间读不受限。同一文件 5 分钟内再试一次即放行。钩子出错不阻断会话。

### 索引保鲜

`init` 后台建索引并预热。git 仓库按 HEAD 判断是否过期。非 git 目录默认 24 小时重建（`staleNonGitMs`，默认 86400000 毫秒）。

### Agent 接线

`init` 给当前 agent 写会话 hook。认得出当前环境就只装那一套（Cursor 看 `CURSOR_AGENT`，Qoder / ZCode 看各自的 `PROJECT_DIR`）。认不出（例如在系统终端里跑）则 Cursor、ZCode、Qoder 三套都装。

## 环境

- Node.js ≥ 18，以及 git。
- local：模型在 `code-index/hf-cache`（两个 transformers.js 模型，约 439MB）。该目录超过 git 单文件上限，不入库；缺失时首次使用才下载。复制部署时请整目录带走。
- ollama：本机先安装并自行启动 Ollama，再手工 pull。Ollama 模型不随目录复制。

```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
```

模型名若在 `code-index/config.mjs` 里改过，pull 改为改后的名字。

## 使用

`init` 会安装依赖、写配置、接线 hook，并在后台建索引、预热。用 `node status.mjs`（或 `npx tokensaver status`）确认就绪。参数名写错、缺少取值，或 `--model-in` / `--hooks` 取值非法时，报错退出且不改配置。`--roots=路径` 与 `--model-in=local` 这种写法也可以。

### 独立工具（推荐）

数据写在本仓库 `data/`，不写进被索引的项目。

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<项目目录1>,<项目目录2>"
node status.mjs
node search.mjs 关键词 --k 5
```

以后在 `data/code-index.config.json` 的 `roots` 里改路径，再跑一次不带参数的 `node init.mjs`，即可把新目录编进索引，并给那些 git 仓挂钩子。

### 复制到目标项目

复制的是 `code-index/` 这一个目录，可放在项目任意位置，建议 `scripts/code-index`。必须带上 `hf-cache`。不要带 `node_modules`，不要带 `data/`。

数据写在与该目录平级的 `data/`（建议路径下即 `scripts/data`）。若 `code-index` 本身就是 git 根，则写在其下的 `data/`。可用环境变量 `CODE_INDEX_DATA_DIR` 改位置。npm 安装固定用仓库 `scripts/data`。

```bash
cd 目标项目/scripts/code-index
node init.mjs
node status.mjs
```

只复制了 `code-index/` 时，同目录的 [`部署使用说明.txt`](code-index/部署使用说明.txt) 是同一份说明。

### npm（发布后）

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init
npx tokensaver status
npx tokensaver search 关键词 --k 5
```

## 初始化参数

```bash
node init.mjs [--roots "<路径1>[,<路径2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder]
```

`--roots`：逗号分隔的扫描目录，写入 `data/code-index.config.json`。正斜杠、反斜杠都可以。

- 不传且还没有配置：用工具仓 git 根。
- 不传且已有配置：按文件里的 `roots` 自愈（仍存在的保留，失踪的按兄弟目录猜一次），不把工具仓自己塞进名单；然后给这些 git 仓挂钩子并后台建索引。
- 传入：与已有 `roots` 合并（纳入，不去掉旧的）。不存在的路径跳过。要删目录，改 JSON 后重跑不带参数的 `init`。

`--hooks`：`all` | `cursor` | `zcode` | `qoder`。只写选中工具的会话 hook，不改其他工具已有文件。不传时的识别规则见「Agent 接线」。

`--model-in`：`ollama` 或 `local`，写入 `modelIn`，不改模型名。新建配置时不传则为 `local`。已有配置时不传则保持原路径。

## 配置

模型部署只改 `code-index/config.mjs`。`data` 里 JSON 的同名项无效。

| 项 | 默认 |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto`（还可设 `cpu`、`gpu`） |
| `OLLAMA_KEEP_ALIVE` | `2h` |
| `OLLAMA_NUM_CTX` | `4096` |

项目配置在与 `code-index/` 平级的 `data/code-index.config.json`。未写的键用 `config.mjs` 的默认值。

| 键 | 说明 |
|---|---|
| `roots` | 扫描目录。优先级：`--roots` > 环境变量 `CODE_INDEX_ROOTS` > 本文件 |
| `modelIn` | `ollama` 或 `local`。优先级：`--model-in` > 本文件 > `local` |
| `skipDirs` | 跳过的目录名。写了就整表替换，不是追加。默认已跳过依赖、构建产物和编辑器目录。新生成的配置还会加上 `code-index`、`.cursor`、`.zcode` |
| `exts` | 收录的扩展名，不带点 |
| `jsonWhitelist` | 允许收录的 json 文件名。默认 `package.json`、`pages.json`、`manifest.json`、`tsconfig.json` |
| `maxFileBytes` | 单文件上限。默认 `819200` |
| `readMaxLines` | 全量 Read 行数上限，默认 `500`。设得很大等于关掉拦截 |
| `chunk` | `targetLines` 70，`maxLines` 120，`overlapLines` 10，`minTail` 15 |
| `staleNonGitMs` | 非 git 目录多久重建一次，毫秒。默认 `86400000` |
| `knownAnnotations` | `"项目名/相对路径"` → 一句职责 |

## 仓库模块

运行时脚本只在 `code-index/` 维护。发布 npm 包时 `prepack` 会跑 [`sync-npm.mjs`](sync-npm.mjs)，把运行时生成到 `npm/`。

| 目录 | 用途 |
|---|---|
| [`code-index/`](code-index/) | 运行时。直接部署、在本仓运行，或复制到目标项目的就是这一份 |
| [`test/`](test/) | 单元测试与全量检索回归。不随 `code-index/` 复制，不进 npm 包 |
| [`npm/`](npm/) | npm 发布骨架。只含 `package.json` 等基本文件；发布前由 `sync-npm.mjs` 生成运行时 |

## 许可

MIT。
