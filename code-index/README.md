# TokenSaver 直接部署

Use this directory as a standalone tool inside the TokenSaver repo, with index data in the parent `data/` folder. You can also copy it into a target project (suggested path `scripts/code-index`). Include `hf-cache/`, and leave out `node_modules` and `data`. The default embedding path is local transformers.js. `--model-in ollama` uses an Ollama you install, start, and pull models for yourself. `init` installs dependencies, writes config, attaches the current agent's hooks (all three if the agent cannot be detected), and builds the index in the background. An over-limit full Read (default 500×1.25) is rewritten on Cursor, ZCode, and Qoder to the semantically closest line range, and denied only when no range can be picked. Reads with offset/limit are allowed. A Bash cat of a whole large file is denied. A Grep call without head_limit is capped at 100 on all three. One retry of the same target within five minutes is allowed, and that retry does not reverse accounting already recorded for the denial or the rewrite. Hook errors fail open. Cursor preToolUse uses two literal matchers, Read and Grep; a regex matcher is skipped as a whole group. After git commit, index refresh runs from Cursor postToolUse with the literal matcher Bash (mapped to Shell), from ZCode with Bash, and from Qoder with Bash|Shell. Data is written beside this directory in `data/`. See `部署使用说明.txt` for the parameters. After changing the discipline sections, the output-diet template, or hook code: make `npm test` green, then run `node deploySync.mjs` to verify AGENTS.md matches the templates in this codebase; on drift, rerun `node init.mjs` for a full redeploy (idempotent: rewrites hooks and every repo's AGENTS.md) and rerun the gate. Do not hand-edit deployed AGENTS.md files — change the templates here and redeploy.

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

改变了纪律段/输出纪律段模板/钩子代码后：先 `npm test` 全绿，再 `node deploySync.mjs` 校验本仓 AGENTS.md 与代码库模板一致；不一致就重新运行 `node init.mjs` 全盘部署（幂等：重写 hooks 与各仓 AGENTS.md），再跑门禁。部署后不要手改各仓 AGENTS.md，要改就改本仓模板再重部署。

`init` 会装依赖、写配置、接线当前 agent 的 hook（认不出则三套都接；`--hooks` 可指定），并后台建索引。Cursor、ZCode、Qoder 对超行数全量 Read（默认 500×1.25）都先改写成语义最相关区间，选不出区间才拒绝并指路检索与区间读。带 offset/limit 的区间读放行。Bash 里 cat 整读大文件直接拒绝（带限量管道或重定向放行）。不带 head_limit 的 Grep 三端都补成 100。同一目标 5 分钟内再发一次全量即放行，且不倒扣已入账的拒绝或改写。钩子出错 fail-open。Cursor 的 preToolUse 用两条字面 matcher（Read 与 Grep），正则会被整组跳过。git commit 后做索引保鲜：Cursor 用字面 Bash（映射为 Shell），ZCode 用 Bash，Qoder 用 Bash|Shell。完成后用 `node status.mjs` 看是否就绪。数据写在与本目录平级的 `data/`（建议路径下即 `scripts/data`）。详细参数见 [`部署使用说明.txt`](部署使用说明.txt)。
