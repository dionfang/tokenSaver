# A/B 实验数据恢复报告(2026-10-31)

## 发生了什么

`data/ab` 整个目录被工作区清理动作删除(疑似 `git clean -xfd` 一类操作,`data/` 不在版本控制内)。
损失范围:GLM n=32、qwen n=16、MiniMax(旧轮) n=16、deepseek n=16 四层的 `results.*.jsonl`、
`runs.*/` 存证与全部汇总 md。幸存的只有 harness(`test/scripts/ab/`,本地沙盒)与记忆里的结论数字。

## 怎么找回来的

ZCode 把每个会话(含子代理会话)的消息、分片与逐请求用量都持久化在本地 SQLite:
`~/.zcode/cli/db/db.sqlite`。`session` / `message` / `part` / `model_usage` 四张表里,子代理的
**思考文本(reasoning 分片)、工具调用参数(含写文件内容)、逐请求 output_tokens / 模型 / 时间戳**全都在,
只是 `rollout/` 目录只保留最近两个文件。恢复脚本:`test/scripts/ab/recover-db.mjs`。

重建规则:

1. **权威标签来自 `record.mjs` 的调用命令本身**——父会话的 Bash 工具调用里带着
   `--task/--cond/--agent/--out`,参数按名解析(与顺序无关);失败的 record 调用(状态守卫报错)自动剔除。
   这一步解决了"用 condition 时间线判臂"在并行会话改过 AGENTS.md 时会错位的问题。
2. 子代理会话按 `parent_id` 挂到父会话,按创建时间与记录配对。
3. 每个 assistant 消息 = 一次 `model_io` 请求(reasoning/text/tool 分片),合成包装消息(`msg_part_*`)剔除。
4. 逐请求用量取自 `model_usage`,模型名逐条核对。

## 四重交叉校验(恢复值 vs 当年汇总,逐位相符)

| 层 | 恢复值 | 当年汇总 | 结论 |
|---|---|---|---|
| deepseek r1/r2 | output 8260/8590、8578/7489;think 21017/22246、20004/17727 | 同 | ✓ 完全一致 |
| qwen 累计 | output 18,382/16,374;请求 61/57;思考 46,455/40,591 | 同 | ✓ 完全一致 |
| GLM 累计(n=32) | output 36,146/32,586(**−9.8%**);强度 −17.2%;请求 101/110 | −9.8%、−18%、+10% | ✓ 一致 |
| MiniMax 旧轮 | output 15,916/15,324(**−3.7%**);强度 −14.8%;请求 54/61(+13%);思考 35,177/28,622(−18.6%) | −3.7%、−14.8%、+13%、−18.6% | ✓ 完全一致 |

**独立复验**:用子代理的 Write/Edit 调用重建任务产物,再跑 `verify.mjs` 复验 →
GLM 64/64、qwen 32/32、deepseek 32/32、MiniMax 旧轮 32/32 **全部 PASS**,与当时记录零不一致。

## 恢复出来的清单

| 层 | 结果文件 | 存证 | n对 | 复验 |
|---|---|---|---:|---|
| deepseek-v4.1-flash-1017 | `results.ds.r1/r2.jsonl` | `runs.ds.r1/r2/` | 16 | 32/32 PASS |
| qwen3.8-flash | `results.qw.r1/r2.jsonl` | `runs.qw.r1/r2/` | 16 | 32/32 PASS |
| GLM-5.3-Flash | `results.v10ab.jsonl` + `results.v10ab.r2/r3/r4.jsonl` | `runs.v10ab/`、`runs.v10ab.r2/r3/r4/` | 32 | 64/64 PASS |
| MiniMax-M3.1-Flash(旧轮,2026-10-31 早) | `results.mm.old.r1/r2.jsonl` | `runs.mm.old.r1/r2/` | 16 | 32/32 PASS |
| MiniMax-M3.1-Flash(本轮复跑) | `results.mm.r1/r2.jsonl`(未丢) | `runs.mm.r1/r2/`(未丢) | 16 | 32/32 PASS |

MiniMax 旧轮文件名加 `.old` 是为了不和本轮复跑的文件混在一起;旧轮与本轮在数据库里天然可分
(同一父会话、相隔约 7 小时,按时间戳切开)。

## 恢复后的跨层全景

| 层 | n对 | 总输出 | 强度 | 请求 | 质量 |
|---|---:|---:|---:|---:|---|
| GLM-5.3-Flash | 32 | −9.8% | −17.2% | +9% | 零失败 |
| MiniMax-M3.1-Flash(旧轮) | 16 | −3.7% | −14.8% | +13% | 零失败 |
| MiniMax-M3.1-Flash(本轮复跑) | 16 | +4.6% | −5.6% | +10.7% | 零失败 |
| qwen3.8-flash | 16 | −10.9% | −4.7% | −7% | 零失败 |
| deepseek-v4.1-flash-1017 | 16 | −4.5% | +3.3% | −7.5% | 零失败 |

**结论不变**:GLM/qwen/deepseek 三层同向为负(−4.5%~−10.9%),MiniMax 两轮符号相反且都不显著——
"跨层同向"只能说 3/4,不能说 4/4。v10 维持部署的理由是零质量代价与不劣于基线。
数据现在全部可复核(重跑 `diagnose.mjs --runs data/ab/runs.*` 即可复算),不再是"只剩结论"。

## 教训(比结论更重要)

1. **实验产物不要只放在 gitignore 目录里**。`data/` 不入库,一次清理即全部归零。
   产物应至少有一份仓库外副本。
2. **ZCode 的本地 SQLite 就是一份现成的会话备份**:子代理的思考文本、工具参数、逐请求用量都在
   `~/.zcode/cli/db/db.sqlite`,只有 `rollout/` 目录会裁剪。`recover-db.mjs` 可从它重建
   results/runs/产物并独立复验,以后再有误清理可以直接回滚。
3. **record.mjs 的调用命令是实验的权威账本**——它同时带 task/cond/agent/out,天然可作为重建索引;
   以后 harness 可以考虑把账本单独落一份到仓库外。
