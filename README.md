# TokenSaver

本地语义代码索引。本仓库分两个目录：

| 目录 | 用途 |
|---|---|
| [`code-index/`](code-index/) | 直接部署。复制到目标项目任意位置（建议 `scripts/code-index`），执行 `node init.mjs`（默认 local；`--model-in ollama` 走 Ollama） |
| [`test/`](test/) | 单元测试与全量检索回归。不随 `code-index/` 复制，不进 npm 包 |
| [`npm/`](npm/) | npm 发布骨架。只含 `package.json` 等基本文件；`npm publish` 前由 [`sync-npm.mjs`](sync-npm.mjs) 从 `code-index/` 生成运行时 |

运行时脚本只在 `code-index/` 维护。发布 npm 包时 `prepack` 会跑 `sync-npm.mjs` 生成 `npm/` 其余文件。

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
```

独立工具(推荐)：数据在本仓库 `data/`。`--roots` 纳入业务目录；以后改 `data/code-index.config.json` 再跑一次不带参数的 `init` 即可。

```bash
cd TokenSaver/code-index
node init.mjs --roots "D:/HbuilderX-Project/yiwu-processing-platform"
# 以后在 data/code-index.config.json 的 roots 里加路径,然后:
node init.mjs
```

也可把 `code-index/` 复制进业务仓（建议 `scripts/code-index`，含 hf-cache，不要带 node_modules、data），数据则在业务仓平行 `data/`。

npm（发布后）：

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init
npx tokensaver status
```

参数与配置见 [`code-index/部署使用说明.txt`](code-index/部署使用说明.txt)。默认嵌入路径为 local。索引数据不入库。`code-index/hf-cache` 约 439MB(两个 transformers.js 模型),超过 git 单文件上限,不入库;复制部署时请整目录带走。
