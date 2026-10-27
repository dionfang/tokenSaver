# TokenSaver 直接部署

把**本目录**复制到目标项目的 `scripts/code-index`（**带上 `hf-cache/`**，已含 local 两个模型；不要带 `node_modules`、`data`）。

```bash
cd 目标项目/scripts/code-index
node init.mjs
```

默认嵌入路径为 local。要走 Ollama：`node init.mjs --model-in ollama`（需本机已安装并手工 pull 模型）。

`init` 会装依赖、写配置、接线 hook，并后台建索引。完成后用 `node status.mjs` 看是否就绪。数据写在平行目录 `scripts/data`。详细参数见 [`部署使用说明.txt`](部署使用说明.txt)。
