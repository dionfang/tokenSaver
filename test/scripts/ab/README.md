# Ponytail 输出端 A/B 测试

验证 ponytail(AGENTS.md 末尾的行为规则)是否降低子代理的输出 tokens。结果**不写入** `data/session-savings.json`;该账只记输入端。

## 硬约束(违反则结果作废)

1. **先自测验收器**:`node test/scripts/ab/verify.mjs --selftest` 必须通过。验收脚本自己也会错(T4 曾把数组长度 3 断言成 1),不能靠肉眼。
2. **每次运行前 `prepare`**:它会清空任务工作目录(否则下一次会看到上一次的文件,只核对不重写)、校验 AGENTS.md 状态、拒绝已存在的 task+cond 记录。
3. **`start` 原样传递**:用 `prepare` 输出的 `start` 作为 `record --since`;dispatch 之前生成,不能事后猜。
4. **立即 record**:ZCode 只保留最近两个子代理 rollout;Agent 返回后马上记账,`record` 会把源文件复制到 `data/ab/runs/` 存证。
5. **精确归属**:只接受 `sessionId === 'sess_subagent_' + agentId` 的记录。**禁止**用“整行包含 agentId”匹配——主会话历史里也会出现这个 id,会把主会话的 input/output 混进来(第一轮实验就是这样污染的)。
6. **只比较全通过 + 同模型 + 同 promptSha 的配对**:`summarize.mjs` 不满足会退出 1,不要手改结论。
7. **收尾恢复**:`node test/scripts/ab/condition.mjs B`(或 `--restore`),再 `git diff --exit-code AGENTS.md`。实验期间不要手工编辑 AGENTS.md。

## 一次运行

```bash
# 1. 选条件并检查
node test/scripts/ab/condition.mjs A        # A=无 ponytail;B=有
node test/scripts/ab/verify.mjs --selftest

# 2. 准备(输出 start、prompt 路径、work 目录)
node test/scripts/ab/prepare.mjs t1 A

# 3. 用 Agent(general-purpose)派发 test/scripts/ab/prompts/t1.md 的原文,
#    不追加任何额外指令;记录返回的 agentId 和 prepare 的 start

# 4. 验收并记账(Agent 返回后立刻做)
node test/scripts/ab/verify.mjs t1 data/ab/work/t1
node test/scripts/ab/record.mjs --task t1 --cond A --pass pass \
  --agent agent_xxx --since <prepare 的 start> \
  --tool-tokens <Agent 返回的 subagent_tokens,可选>

# 5. 换条件,重复
node test/scripts/ab/condition.mjs B
node test/scripts/ab/prepare.mjs t1 B
# ...派发、验收、record

# 6. 汇总
node test/scripts/ab/summarize.mjs
```

8 个任务建议按 A/B 交替顺序跑,消解时间漂移;同一 task+cond 重跑要
`prepare --force` 和 `record --replace`。

## 任务覆盖

t1–t5 从零写算法;**t6 修 bug**(给了带 padStart 方向错误的实现);**t7 复用已有代码写测试**(验收器会把坏实现替换进 work 目录,用例拦不住即 FAIL);**t8 边界密集解析**(注释/分节/引号/坏行)。三类新场景测的是 ponytail 在"改现有代码"与"最小验收自检"下的行为,不只从零造轮子。

## 指标

- `outputTokens`:子代理总输出(客户端口径,通常含 think),代表任务总输出成本。
- `output/请求`:诊断用。B 可能单轮更短但多走工具轮次,总输出反而更高。
- `toolTokens`(可选):Agent 工具返回的 `subagent_tokens`,含输入,只做交叉核对,不是 output。
- 默认包含子代理文件里的所有请求(含 subagent/session_title);`sources` 字段留痕。

## 为什么有这些约束

- 第一轮用整行包含 agentId,主会话请求被计入;且 T1–T4 的子代理 rollout 被客户端清理,数据无法重算。
- 第一轮验收器把 `orig.d.e.length` 的 3 误断言成 1,导致两组误报失败;所以先跑 good/bad fixtures 自测。
- 第一轮 T1-B 看到 T1-A 留下的文件只核对不重写;所以每次 `prepare` 清空工作目录。

## 文件

- `tasks.json`:任务/提示词/工作目录/输入文件清单。
- `prompts/`:固定提示词,逐字派发,不要改写。
- `fixtures/good|bad/`:验收器自测用的正确/错误实现。
- `verify.mjs`:验收;`--selftest` 先自测。
- `condition.mjs`:A/B 切换,带原文备份。
- `prepare.mjs`:清目录、复制输入、校验状态、拒绝重复。
- `record.mjs`:精确 sessionId 归属、复制 rollout、拒绝重复。
- `summarize.mjs`:通过率/模型/提示词哈希门槛 + 汇总。
- `selftest.test.mjs`:上述守卫的测试,已接入 `npm test`。
