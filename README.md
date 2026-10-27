# TokenSaver

本地语义代码索引。本仓库分两个目录：

| 目录 | 用途 |
|---|---|
| [`code-index/`](code-index/) | 直接部署。复制到目标项目 `scripts/code-index`，执行 `node init.mjs`（默认 local；`--model-in ollama` 走 Ollama） |
| [`npm/`](npm/) | npm 发布骨架。只含 `package.json` 等基本文件；`npm publish` 前由 [`sync-npm.mjs`](sync-npm.mjs) 从 `code-index/` 生成运行时 |

运行时脚本只在 `code-index/` 维护。发布 npm 包时 `prepack` 会跑 `sync-npm.mjs` 生成 `npm/` 其余文件。

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
```

直接部署：

```bash
# 把 code-index/ 整目录复制为 目标项目/scripts/code-index(含 hf-cache,不要带 node_modules、data)
cd 目标项目/scripts/code-index
node init.mjs
```

npm（发布后）：

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init
npx tokensaver status
```

参数与配置见 [`code-index/部署使用说明.txt`](code-index/部署使用说明.txt)。默认嵌入路径为 local。索引数据不入库。`code-index/hf-cache` 约 439MB(两个 transformers.js 模型),超过 git 单文件上限,不入库;复制部署时请整目录带走。
