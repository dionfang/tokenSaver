# Ponytail 输出端 A/B 测试

验证 ponytail(AGENTS.md 末尾的行为规则)是否降低子代理的输出 tokens。结果**不写入** `data/session-savings.json`;该账只记输入端。

> 本脚手架已泛化,可测任意规则段,见下文「换一套规则复用」。

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

## 换一套规则复用(自定义规则段)

`condition/prepare/record` 都接受 `--mark`,`condition` 额外接受 `--rules <规则文件>`:
A = 无该规则段;B = 备份原文后在末尾追加「标记 + 规则文件内容」(A→B 循环幂等,不会重复追加)。
结果与 rollout 建议用独立的 `--results`/`--runs`,避免与 ponytail 轮次混写;`summarize --title` 换报告标题。

```bash
node test/scripts/ab/condition.mjs B --mark "<!-- output-diet -->" --rules test/scripts/ab/rules/output-diet.md
node test/scripts/ab/prepare.mjs t1 B --mark "<!-- output-diet -->" --results data/ab/results.od.jsonl
node test/scripts/ab/record.mjs --task t1 --cond B --pass pass --agent <id> --since <start> \
  --mark "<!-- output-diet -->" --out data/ab/results.od.jsonl --runs data/ab/runs.od
node test/scripts/ab/summarize.mjs --results data/ab/results.od.jsonl --title "output-diet 汇总"
```

已跑过的一轮(2026-10-30,GLM-5.3,8 任务配对):**output-diet**(规则在 `rules/output-diet.md`,
设计原则与 ponytail 相反——不加流程步骤、不加固定结尾,只压思考冗余/过渡文字/轮次,显式禁止砍实现)。
总 output A 9,973 / B 9,396(−5.8%),配对 t=−0.53 不显著;请求数 21→20。
方向与 ponytail(点估计 +38%/+9.8%)相反。**质量信号**:B 组 1/8 首跑验收失败
(t5 多位数字解析 bug,写完零验证就收工),A 组 0/8——规则 5「验证一次到位」被走样成「不验证」,
后续改规则需把「写完必须跑一次检查」写成硬性。数据:`data/ab/results.od.jsonl`、
`data/ab/summary-output-diet.md`,失败样本 `data/ab/runs.od/t5-B.fail1.*`。

再一轮(2026-10-30,三轮 24 配对):**output-diet-v2**(规则在 `rules/output-diet-v2.md`,
补 v1 教训:改文件用最小 Edit、必跑一次检查、「两步轨迹」写进规则 1)。
三轮 output:A 11,420/7,948/6,516,B 稳定在 7,341/8,404/7,023;合并 **−12.0%(t=−1.53,p≈0.14,不显著)**。
机制:规则把单请求输出钉在 ~350-370(A 在 352~564 漂移,存在随机「话多模式」),
收益全部来自压制话多轮(R1 −35.7%),A 本身简洁时小亏 +6~8%。质量:B 0/24 首跑失败(A 1/24)。
结论:作为输出保险/方差压制有效零质量代价;作为确定性省钱不显著。数据:
`data/ab/results.od2.r{1,2,3}.jsonl`、`data/ab/summary-output-diet-v2.md`。

第三、四代迭代(2026-10-30,结论性,详见 `data/ab/summary-output-diet-v3-v4.md`):
**四个机制发现**——① output 差异 100% 在思考文本(24/24 同向),回复恒 3 字符;
②「话多模式」是会话推进的函数(A 组 out/req 按时间 544→378→326→252→241→274 单调下降),
v2 R1 的 −35.7% 主要是对照组话多期的**时序假象**,按 out/req 校正后规则真实效应只有 −7.9%;
③ **安慰剂对照**(注入等长无关风格规则)比任何纪律臂都贵(同窗 t8:安慰剂 2028 vs v4 1141)——
注入任何规则段都会提高 agent 对工作区其他规则(⚙ 状态句/索引)的关注度;
④ **措辞反噬**:否定式与元层面表述会激活 agent 去权衡指令本身
(v3「四步动作」→先规划后动手;「冲突时以任务为准」→ 真去跑 status.mjs;
「跑一次检查」→ 往交付文件加自检断言;t5 +1101)。**最终推荐 output-diet-v4**
(`rules/output-diet-v4.md`,去否定式、去元层面、验证=一条命令):合并 16 配对 +2.0%(t=0.16),
但**单请求强度 −12%**,同窗对照强度比安慰剂低 25%;24/24 首跑验收 PASS。
**方法论:主指标用 out/req 而非总输出(总输出被轮次与时序污染);跨时段比较必须同窗多臂对照。**
诊断脚本 `node test/scripts/ab/diagnose.mjs --runs data/ab/runs.od4.r1` 输出思考/回复/工具参数/追问/预演/额外命令分解。

最新一代(2026-10-30 第二轮):**output-diet-v6**(同窗 v4 vs v6 配对 8 任务,v6 **−20.9%** 总输出、
强度 −13.0%、思考 −39%,16/16 验收 PASS,机制自洽;方向性证据未过显著线)。
规则文件已**双语化**(中文条目+英文对译,兼容中文理解弱的模型;v4/v6 均已补,历史 v1/v2/v3/v5 存档不动)。
v6 要点:全部肯定式/具体动作——Write 自动建目录不 ls/mkdir、实现严格按题面、
验证=跑题面示例一次即交付、不在交付文件内嵌自检块。详见 `data/ab/summary-output-diet-v6.md`,
数据 `data/ab/results.pair.{v4,v6}.jsonl`。遗留:无示例任务上"跑示例"被解释成额外验证(t4 +581),
待 v7 补一句判据。

**v7(当前推荐,`rules/output-diet-v7.md`)** = v6 + 规则5 补判据"题面没给示例时,运行一次不报错即交付"。
同窗配对 5 任务(v6 输的 t1/t4/t6 + v6 赢的 t3/t8):总 Δ +3.5%(t=0.17,两版不可区分),
但判据句在被针对的任务上明确生效(t6 思考减半 −2267 字符、t3 −1888),v7 唯一大败点 t8 的
+817 全是「AGENTS.md ⚙ 句 vs 任务一行回复」的**冲突权衡**思考(3,312 字符),非判据句所致。
采纳 v7(消确定性浪费,剩下方差由权衡主导)。**新发现:冲突权衡是最大单项随机浪费**(本窗 3/10 派发中招,
1,000–3,300 字符/次);修复杠杆不在输出纪律段,而在 AGENTS.md 自身给格式条款加明确豁免
(给权衡一个判定捷径)。v8 候选:实验验证"豁免句"降权衡成本、防 v3 式反噬。
详见 `data/ab/summary-output-diet-v7.md`,数据 `data/ab/results.pair2.{v6,v7}.jsonl`。

**v8 实测(已淘汰):** v8 = v7 + 规则 6"回复格式以题面明确写的为准;题面没写时沿用工作区规则"。
同窗配对 8 任务 × {v7,v8}(16 派发全 PASS):主指标**冲突权衡字符 v7 3,769 → v8 4,027(+6.8%,不降)**,
总输出 Δ+1.9%(t=0.19,不可区分)。最差个案显示规则 6 把权衡变成了对 AGENTS.md 各条款适用性的
系统核查(单请求 7,430 字符思考)——与 v3 的冲突条款**同构反噬**。定论:冲突权衡的杠杆不在输出
纪律段内(v3/v8 两次尝试均证伪);唯一剩余路径是直接给 AGENTS.md 的 ⚙/检索条款本身加豁免,
属生产变更、需单独决策。**样本量策略(power 分析,v6vs v4 δ=0.38→总输出需≈54 对):臂间
小效应不值得扩总样本,改用低方差机制指标(冲突/思考字符)+n=8 做淘汰,过机制关才投大样本。**
详见 `data/ab/summary-output-diet-v8.md`,数据 `results.pair3.{v7,v8}.jsonl`。
**当前最终推荐臂:output-diet-v7(`rules/output-diet-v7.md`)。**

**v7 vs 无规则基线终验(2026-10-30,同窗 A/B 8 任务,`results.v7ab.jsonl`):**
总输出 A 10,546 → B 9,286(**−11.9%**),6/8 任务更低,配对 t=−1.42(p≈0.09,δ≈0.50→需≈31 对到显著)。
机制指标全同向:强度 282→243(−14%)、思考字符 28,741→22,656(−21.2%)、**冲突权衡 −29%**
(A 臂的 19% 思考花在权衡,规则臂通过明确动作反而减少了权衡)。**质量 B>A 第二次独立复现:
A 臂 1/8 首跑失败(t2 平均数算错),B 臂 8/8 首跑过**——规则 5 的验证条款挡住了计算错误。
含义:"要不要 md"有可测正效应;"哪个 md 更好"(v7 vs v6 δ=0.08)超出软规则分辨上限。
详见 `data/ab/summary-v7ab.md`。

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
