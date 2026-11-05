# @dionfang/tokensaver

本机 Agent 提效工具,两大功能:

- **省耗记账**:语义索引 + 读取守卫 + 入账统计,Agent 定位代码只读需要的区间,节约量逐轮入账。Cursor / ZCode / Qoder 通用。
- **动态模型路由**:按 prompt 难度把对话调度到不同价位的模型,贵模型只在必要时使用。仅 ZCode / Qoder,且要求自定义模型以 Anthropic Messages 协议接入。

An on-machine agent productivity tool with two features: **Token Ledger** (semantic index + read guard + accounting, works on Cursor/ZCode/Qoder) and **dynamic model routing** (dispatch by difficulty, ZCode/Qoder only, Anthropic Messages custom models).

## 部署前提 / Prerequisites

- Node.js ≥ 18 与 git / Node.js >= 18 and git
- 嵌入模型默认 local(首次使用自动下载);可选 ollama(需自行 pull)/ embedding defaults to local (auto-download on first use); ollama optional (pull yourself)
- 动态模型路由仅 ZCode / Qoder / dynamic model routing: ZCode and Qoder only

## 安装 / Install

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init --roots "项目目录1,项目目录2"
npx tokensaver status
```

init 参数 / init options:

- `--roots "目录1,目录2"`:要索引的项目目录 / directories to index
- `--model-in ollama|local`:嵌入模型来源 / embedding source
- `--hooks all|cursor|zcode|qoder`:钩子安装范围(省耗记账三端都装;动态路由只装 ZCode/Qoder)

常用命令 / commands:`tokensaver search 关键词 --k 5` · `tokensaver status` · `tokensaver auto`

## 配置 / Configuration

| 文件 | 用途 |
|---|---|
| `code-index/config.mjs` | 模型部署:嵌入/精排模型名、ollama 地址等 |
| `项目/data/code-index.config.json` | 项目级配置:`roots`、`readMaxLines`、`skipDirs` 等 |
| 同上 `modelRouting` 段 | 动态模型路由:`enabled`、`brandPriority`、`switchGuard`、`tierOptimize` 等 |

动态模型路由启用:init 自动播种 `auto` 虚拟模型 → 会话选择 `auto` → 建议 `modelRouting.enabled=true`(可选)。自定义模型须以 Anthropic Messages 协议接入。

完整说明见包内 [`部署使用说明.txt`](./部署使用说明.txt) / Full guide: [`部署使用说明.txt`](./部署使用说明.txt).
