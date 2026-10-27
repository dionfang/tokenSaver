# TokenSaver (`@dionfang/tokensaver`)

本地语义代码索引。源码在本仓库维护，也可 `npm i -D @dionfang/tokensaver` 安装（发布到 npm 后）。

部署步骤、`init` 参数、可配置项见 [`部署使用说明.txt`](部署使用说明.txt)。

## 从 GitCode 拉取

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver
npm install --ignore-scripts
node init.mjs
node status.mjs
```

开发本仓库时，索引数据写在本目录 `data/`（不入库）。复制到其他项目的 `scripts/code-index` 时，数据仍写在平行的 `scripts/data`。

## npm 安装（发布后）

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init [--roots "<路径1>[,<路径2>...]"] [--model-in ollama|local]
npx tokensaver search 关键词 --rerank --k 5
npx tokensaver status
```

- `--roots`:写入项目 `scripts/data/code-index.config.json` 的 `roots`。省略时,无配置则用当前 git 根;已有配置则按本机路径自愈。
- `--model-in`: `ollama` 或 `local`。只决定嵌入路径,不改模型名。已有配置时不传则保持原路径;新建配置缺省为 local。

模型名、`ollamaBase`、`gpu`、`OLLAMA_KEEP_ALIVE`、`OLLAMA_NUM_CTX` 只改包内 `config.mjs`。项目配置写在 `data/code-index.config.json` 或目标项目的 `scripts/data/code-index.config.json`。

Ollama 模型和 transformers.js 权重不在 git / npm 包内。
