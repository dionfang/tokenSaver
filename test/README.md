# 测试脚本

不随 `code-index/` 复制部署，也不进 npm 包。npm 脚本写在 [`code-index/package.json`](../code-index/package.json)，**先进入该目录再跑**：

```bash
cd TokenSaver/code-index
```

## `npm test`

跑全部单元测试，不读索引、不调检索，几秒结束。依次执行：

| 文件 | 测什么 |
|---|---|
| `config.test.mjs` | 数据目录落点、`CODE_INDEX_DATA_DIR`、packed / 非 packed 布局 |
| `init.test.mjs` | init 接线 Cursor / Qoder / ZCode hooks |
| `ollamaGuard.test.mjs` | Ollama 探测与卸旧模型 |
| `read-guard.test.mjs` | 超行数 Read 拦截、offset/limit 放行、fail-open |
| `gen-questions.test.mjs` | 按块抽 SYM/GAP 题、按项目过滤、抽题可复现 |

```bash
npm test
```

## `npm run regress`

全量检索回归（慢，会真正调 `search.mjs`）。每次启动都按当前索引现抽题，再跑三臂：

1. 读 `chunks.jsonl` 和 `code-index.config.json` 的 `roots`，抽 30 条 SYM（只拆符号、去掉文件名和泛词）+ 20 条 GAP（短中文或 `knownAnnotations`，不拼符号、不用整段口号）
2. 题目写到数据目录的 `exp-regress/ground-truth*.jsonl`
3. 对 SYM、GAP 各跑 bm25 / hybrid / rerank，成绩写同目录 `suite-summary.json`

数据目录：环境变量 `CODE_INDEX_DATA_DIR`；未设则用 `TokenSaver/data`（需已 `init` 建过索引）。

```bash
npm run regress
```

`--` 后面的参数传给 `regress.mjs`：

```bash
# 固定抽题，方便对比两次回归
npm run regress -- --seed 1

# 改题量
npm run regress -- --seed 1 --n-sym 30 --n-gap 20
```

指定已有索引（PowerShell / CMD）：

```powershell
$env:CODE_INDEX_DATA_DIR="D:\HbuilderX-Project\yiwu-processing-platform\scripts\data"
npm run regress
```

```bat
set CODE_INDEX_DATA_DIR=D:\HbuilderX-Project\yiwu-processing-platform\scripts\data
npm run regress
```
