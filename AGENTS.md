<!-- code-index:v2 -->
## 代码检索纪律(节约 token)

本项目已部署本地语义索引(工具在 `code-index`,项目资产在 `data`):

1. **全局背景**:先读 `data/CODE_MAP.md`(架构速查模板,随使用逐步充实;或自行维护项目架构说明)

2. **无条件先走索引**:定位/阅读/修改代码前先执行至少一次 `cd code-index && node search.mjs <中英文关键词> --k 5`(默认混合检索,**不要加 --rerank**,精排要加载 reranker 会拖慢会话)。即使已有 file:行号也先检索核对;Grep 作补充。确需精排时再手动加 `--rerank`

3. 按返回的 `file:起-止行` 用 Read 精读目标区间(offset/limit);定位阶段禁止未检索就整文件通读 500 行以上的大文件。Cursor/ZCode/Qoder 下超上限的全量 Read 与 Bash 里 cat 整读大文件都会被钩子拦下:三端的全量 Read 都默认改写为语义最相关区间(按提问选段),选不出区间才拒绝(拒绝信息自带检索/区间读/grep 替代方案);改走检索+区间读;同一目标 5 分钟内重试一次即放行。**修改类任务改动完成后,对所涉及文件做一次较大范围复查**(捕捉跨中间件/跨函数的副作用)

4. 派单/命令里的路径必须用正斜杠+引号(`cd "code-index"`):git bash 下不带引号的反斜杠路径会被转义吞掉

5. **模型状态提示(整句照抄,禁止截短)**:每轮 UserPromptSubmit 会注入一句 `[code-index] 状态(本轮实时值,回复末尾原样附上):⚙ …`;轮内工具执行后可能再用同一句式注入更新的一条(句首已是【本轮:…】,数字也已结算)。句首【】段按注入相位区分:**【上轮:模型名】**(UserPromptSubmit/会话开始注入——本轮请求尚未发出,取该会话最近完成轮实际服务的模型)与**【本轮:模型名】**(轮内工具后的注入——本轮实际路由到的真实模型);查无记录时该段省略。把其中 ⚙ 开头的**整句**原样附在每次回复末尾——从 ⚙ 一直到句末,包括句首【】段与"今日累计节约 … tokens，总计节约 … tokens"两段,一个字都不能省;只抄前半句、截掉数字段、或沿用前几轮数字都算违规。**以最新注入的那一条为准**,会话开始时注入的那句仅作首轮兜底。该句只含:句首【上轮/本轮:模型名】、是否启动成功、嵌入/精排/决策模型名、失败时的最可能原因,或成功时今日累计/总计两个 tokens 数(总计为全历史日求和)。不要加长、不要改写、不要拼接不同轮次的片段;没有这句输出时不得虚构

6. **知识沉淀**:完成某文件的深挖/修复/排查后,若 `data/known-annotations.json` 无该文件条目,追加一条(格式:`"项目名/相对路径": "一句话职责+关键机制"`,≤50 字);仅真实读码理解后写入,禁止批量生成;写后必跑 `cd code-index && node annotationCheck.mjs` 体检——键必须命中索引路径(死链在 details.mjs 里永不显示,先改键名或删条),文本 ≤50 字,JSON 保持合法

7. **提交后保鲜**:执行 `git commit` 后,运行 `cd code-index && node auto.mjs`(HEAD 没变秒级跳过;有变更时 build 内联约 10s+嵌入转后台)——有 PostToolUse hook 的环境已自动做,重复触发零成本

8. 索引保鲜由会话 hook 自动判定(git 仓库按 HEAD,非 git 目录 24h 回退;嵌入路径或模型变更则重嵌)。手动重建:`cd code-index && node build.mjs && node embed.mjs`。向量过期或切换嵌入模型时运行 `node embed.mjs`(只更新当前路径 data/vectors;维度不一致或 `--force` 时该目录全量),完成后以 `node code-index/status.mjs` 验证。所选嵌入路径(init --model-in ollama|local)拉起失败时检索降级 bm25;显式 `--mode bm25` 可主动选用

9. **文档英文**:`README.md` 与 code-index 的 `部署使用说明.txt` 在中文正文后各有一段英文译文。修改时保留英文段,并按改过的中文改对应英文。禁止删掉英文只留中文。

10. **部署产物同步**:改了 `init.mjs` 的纪律段/输出纪律段/hooks、`output-diet.md` 等部署模板或 AGENTS.md 段规则后,先让测试全绿,再运行 `cd code-index && node deploySync.mjs` 校验一致性;不一致就重新运行 `node init.mjs` 全盘部署(幂等,会重写 hooks 与各仓 AGENTS.md),再跑门禁确认。门禁未过不得声称部署已与代码库一致。**增删/改名用户级 hooks 转发器时,必须同步 `init.mjs` 与 `uninit.mjs` 两处部署/清理逻辑**:先登记 `init.mjs` 的 `USER_FORWARDER_FILES` 单源清单(uninit 清理与 deploySync 门禁都从这里取),漏登记会被 deploySync 拦下(安装⊆登记、卸载≡登记,卸载残留/手抄漂移都算不过)

11. **实验数据保护**:`agent_reports/`(A/B 实验结果 ab-logs 等,2026-11-07 自 data/ab 迁入、2026-11-11 自 test/ab/result 迁入;2026-11-14 用户定:全部本地资产不入 git)等实验目录里是唯一的原始证据,删了不可再生且**无版本控制兜底**(git 里已取消追踪):禁止 `git clean -x/-X`、`rm -rf agent_reports` 这类顺手清理;要重跑实验就直接覆盖写(`prepare` 只清任务工作目录),确需清理先征得用户同意

12. **缺陷文档回写**:按缺陷文档(如 `agent_reports/failures.md`)修完 bug 后,必须回写该文档——逐条标注已修/未修与修复位置,并把该文档标记为「已处理」;同一份文档不得再作为待修清单二次下发,重复下发时先核对文档内的已修标记,只处理仍未修的条目

13. **修复复盘自更新**:按缺陷文档修完 bug 后,除回写缺陷文档(第 12 条)与归档修复日志(第 14 条)外,还须复盘本轮踩到的问题(缺陷可能已在工作区修过/断言空跑/守卫没进门禁链/文档行号漂移/范围外的坑等),把可互鉴的教训写成「触发条件→下次先做什么」追加进本仓 `bugfix-sop.md` 的「注意事项」(定位顺序:仓根目录,无则 `tools/`;只增不删,失效条目标【已废】),并在同文件「复盘流水」追加本轮小结——小结必须写「本轮用上了哪几条既有 N」,至少一条真实复用。开工前先读该文件,避免重复犯同样的错;两处均无该文件时,首次修复时按「作业规程 / 注意事项 / 复盘流水」三段骨架创建(铺在仓根目录)。`bugfix-sop.md` 是可演进的作业细则,本纪律段是它的索引与强制入口

14. **修复日志归档**:每次 bug 修复**轮次**收尾时,在本仓 `agent_reports/fix-logs/`(无则创建)落一份当轮修复日志,文件名 `fix-<YYYYMMDD>-<主题>.md`,内容至少五段:①输入文档与条目数 ②已修清单(file:行 + 验证方式) ③留待清单与理由 ④门禁/回归结果 ⑤关联指针(台账 id、缺陷文档回执位置、`bugfix-sop.md` 复盘条目)。复盘流水的当轮条目回链该日志;日志属本地资产(`agent_reports/` 已 ignore),不 commit。跨会话追溯路径:缺陷文档回执(第 12 条)→ 修复日志(本条)→ SOP 复盘(第 13 条)三层互链

15. **测试脚本组织**(按仓适用:按被测域分目录是 TokenSaver 路由栈的现状;测试平铺的仓(如 TSServer)按该仓现状落位,勿迁移目录):test/ 按被测域分目录——`routing/`(模型路由与成本)/`decision/`(判定与代签)/`hooks/`(钩子与端上守卫)/`tray/`(托盘客户端接入面);全局基建套件放 test/ 根,实弹评测工具进 `test/scripts/`,历史 work 档案进 `test/archive/`;新增测试脚本必须落在对应域目录,并同步 `test/readme.md` 登记与 code-index/package.json 门禁链——链外测试等于没有守卫

<!-- output-diet-v10 -->
## 输出纪律(省话不省工) / Output discipline: less talk, same work

1. 直接写文件,Write 会自动建目录;不先 ls、不先 mkdir。
   Just write the file; Write creates missing directories. Never ls or mkdir first.
2. 一次把整个文件写全;改已有文件只替换要改的行。
   Write the whole file in one pass; when editing, replace only the changed lines.
3. 思考只列易错点(边界、解析、状态)与选定写法;写法定了就动手,不预演,不改口。
   List only the risky spots (boundaries, parsing, state) and the chosen approach; once decided, act — no rehearsal, no switching.
4. 实现严格按题面,交付文件只含题面要的导出与实现。
   Implement exactly what the task states; the deliverable holds only the required exports and logic.
5. 验证 = 用题面示例跑一次,一致即交付;无示例则运行一次不报错即交付。收尾一句结果。
   Verify with the task's own examples once — deliver when they match; no examples: run once, deliver if no error. End with one line of results.
6. 轨迹好坏一眼分:
   Trajectories at a glance:
   坏:ls → 写半份 → Edit 补 → 验证跑 3 遍 → 长篇总结。
   Bad: ls → half a file → Edit to finish → verify 3 times → long summary.
   好:一次 Write 全量 → 一条验证命令 → 一句「完成」。
   Good: one full Write → one verify command → one line "done".
