# 测试脚本

**根级只有测试启动脚本**（头部注释含启动命令与用法）；辅助脚本、库与数据在 [`scripts/`](scripts/)。不随 `code-index/` 复制部署，也不进 npm 包。npm 脚本写在 [`code-index/package.json`](../code-index/package.json)，**先进入该目录再跑**：

Only test launchers live at the top level (each file's header comment shows how to run it); helpers, libraries and fixtures live under `scripts/`. These tests are not deployed with `code-index/` nor published. The npm scripts live in `code-index/package.json`; change into that directory first.

```bash
cd TokenSaver/code-index
```

## `npm test`（14 个启动脚本）

跑全部单元测试，不读索引、不调检索，几秒结束：

| 启动脚本 | 测什么 |
|---|---|
| `config.test.mjs` | 数据目录落点、`CODE_INDEX_DATA_DIR`、packed / 非 packed 布局 |
| `build.test.mjs` | hub 目录识别（`isHubDir`）|
| `init.test.mjs` | init 接线 Cursor / Qoder / ZCode 用户级与工作区钩子、roots 合并自愈 |
| `uninit.test.mjs` | uninit 移除用户级钩子（保留他人配置）、AGENTS.md 剥离、痕迹清理 |
| `ollamaGuard.test.mjs` | Ollama 模型名比对与替换探测 |
| `read-guard.test.mjs` | 超行数 Read / Bash cat 拦截、offset/limit 放行、5 分钟重试、fail-open |
| `read-nudge.test.mjs` | 连续区间读导航、全量读清零、大输出限频、记账字节数 |
| `prompt-guard.test.mjs` | 提交前模型变更检测（进程级 spawn）|
| `prefetch.test.mjs` | 语义预取：载荷提取、bm25 命中、格式化、开关/去重/短话跳过 |
| `gen-questions.test.mjs` | 按块抽 SYM/GAP 题、按项目过滤、抽题可复现 |
| `modelStatus.test.mjs` | 输入端按日累计记账、比率与历史日期保留 |
| `usageReport.test.mjs` | 输出端报表：解析、来源过滤、去重、A/B 对比 |
| `ab-selftest.test.mjs` | A/B 脚手架自检：验收器 good/bad、条件切换、汇总门槛 |

```bash
npm test
# 单跑:node ../test/<名字>.test.mjs
```

## `npm run regress`（启动脚本 `regress.mjs`）

全量检索回归（慢，会真正调 `search.mjs`）。每次启动都按当前索引现抽题，再跑三臂：
1. 读 `chunks.jsonl` 和 `code-index.config.json` 的 `roots`，抽 30 条 SYM + 20 条 GAP
2. 题目写到数据目录的 `exp-regress/ground-truth*.jsonl`
3. 对 SYM、GAP 各跑 bm25 / hybrid / rerank，成绩写同目录 `suite-summary.json`

数据目录：环境变量 `CODE_INDEX_DATA_DIR`；未设则用 `TokenSaver/data`（需已 `init` 建过索引）。

Full retrieval regression (slow, actually calls `search.mjs`): questions are freshly generated from the current index each run, then three arms (bm25 / hybrid / rerank) are graded for SYM and GAP into `exp-regress/suite-summary.json` under the data directory.

```bash
npm run regress
# 固定抽题 / 改题量
npm run regress -- --seed 1 --n-sym 30 --n-gap 20
```

## `scripts/` 辅助脚本（被启动脚本引用或手动工具）

Helpers under `scripts/` — imported by launchers, or manual tools:

| 文件 | 用途 |
|---|---|
| `scripts/gen-questions.mjs` | 抽题库（`regress.mjs` 与其测试引用）|
| `scripts/usageReport.mjs` | 输出端用量报表（手动工具）：读 ZCode model-io rollout 按会话汇总 tokens，支持 A/B 对比。`node test/scripts/usageReport.mjs --dir <rollout 目录>` |
| `scripts/extractive-ab.mjs` | 抽取式上下文压缩 A/B 实验（手动工具，**依赖 Ollama 在线**）：A=全文 vs B=余弦保真历史。`node test/scripts/extractive-ab.mjs --rollout <jsonl> --cursor <jsonl>` |
| `scripts/ab/` | Ponytail 输出端 A/B 测试脚手架（verify/condition/prepare/record/summarize + fixtures/prompts），操作手册见 [`scripts/ab/README.md`](scripts/ab/README.md) |
