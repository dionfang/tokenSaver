# @dionfang/tokensaver

本目录只放 npm 发布骨架（`package.json` / 本 README / `.gitignore`）。

运行时脚本、`cli.mjs`、`部署使用说明.txt` 都由仓库根 `sync-npm.mjs` 从 `code-index/` 生成。不要在这里改逻辑。

This directory is only the npm publish skeleton (`package.json`, this README, and `.gitignore`). Runtime scripts, `cli.mjs`, and `部署使用说明.txt` are generated from `code-index/` by `sync-npm.mjs` at the repo root. Do not edit runtime logic here. To copy-deploy, copy `code-index/` from the repo, not this directory.

```bash
cd npm
npm publish --access public
```

`prepack` 会先跑 `node ../sync-npm.mjs`。只想预览包内容：`npm pack --dry-run`。

目标项目：

```bash
npm i -D @dionfang/tokensaver
npx tokensaver init
npx tokensaver search 关键词 --rerank --k 5
npx tokensaver status
```

直接复制部署用仓库里的 `code-index/`，不要复制本目录。
