# TokenSaver 直接部署

Use this directory as a standalone tool inside the TokenSaver repo, with index data in the parent `data/` folder. You can also copy it into a target project (suggested path `scripts/code-index`). Include `hf-cache/`, and leave out `node_modules` and `data`. The default embedding path is local transformers.js. `--model-in ollama` uses an Ollama you install, start, and pull models for yourself. `init` installs dependencies, writes config, attaches the current agent's hooks (all three if the agent cannot be detected), and builds the index in the background. Full-file reads over the line limit (default 500×1.25) are denied; reads with offset/limit are allowed, and one retry of the same file within five minutes is allowed. Hook errors fail open. Data is written beside this directory in `data/`. See `部署使用说明.txt` for the parameters.

推荐在 **TokenSaver 本仓** 当独立工具用（数据在上一级 `data/`）：

```bash
cd TokenSaver/code-index
node init.mjs --roots "<项目目录>"
# 改 data/code-index.config.json 的 roots 后:
node init.mjs
```

也可把**本目录**复制到目标项目任意位置（建议 `scripts/code-index`；**带上 `hf-cache/`**，已含 local 两个模型；不要带 `node_modules`、`data`）。

```bash
cd 目标项目/scripts/code-index
node init.mjs
```

默认嵌入路径为 local。要走 Ollama：`node init.mjs --model-in ollama`（需本机已安装并手工 pull 模型）。

`init` 会装依赖、写配置、接线当前 agent 的 hook（认不出则三套都接；`--hooks` 可指定），并后台建索引。Cursor `preToolUse`、ZCode/Qoder `PreToolUse` 都会拦超行数全量 Read（默认 500×1.25）：deny 并指路检索+区间读，带 offset/limit 放行，5 分钟内重试放行，出错 fail-open。完成后用 `node status.mjs` 看是否就绪。数据写在与本目录平级的 `data/`（建议路径下即 `scripts/data`）。详细参数见 [`部署使用说明.txt`](部署使用说明.txt)。
