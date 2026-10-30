<!-- code-index:v2 -->
## 代码检索纪律(节约 token)

本项目已部署本地语义索引(工具在 `code-index`,项目资产在 `data`):

1. **全局背景**:先读 `data/CODE_MAP.md`(架构速查模板,随使用逐步充实;或自行维护项目架构说明)

2. **无条件先走索引**:定位/阅读/修改代码前先执行至少一次 `cd code-index && node search.mjs <中英文关键词> --k 5`(默认混合检索,**不要加 --rerank**,精排要加载 reranker 会拖慢会话)。即使已有 file:行号也先检索核对;Grep 作补充。确需精排时再手动加 `--rerank`

3. 按返回的 `file:起-止行` 用 Read 精读目标区间(offset/limit);定位阶段禁止未检索就整文件通读 500 行以上的大文件。Cursor/ZCode/Qoder 下超上限的全量 Read 与 Bash 里 cat 整读大文件都会被钩子拦截(拒绝信息自带检索/区间读/grep 替代方案),改走检索+区间读;同一目标 5 分钟内重试一次即放行。**修改类任务改动完成后,对所涉及文件做一次较大范围复查**(捕捉跨中间件/跨函数的副作用)

4. 派单/命令里的路径必须用正斜杠+引号(`cd "code-index"`):git bash 下不带引号的反斜杠路径会被转义吞掉

5. **模型状态提示(原样转达一句)**:会话开始后先运行 `node code-index/status.mjs`,把输出的那一句 ⚙ 原样附在每次回复末尾。该句只含三项:是否启动成功、嵌入模型名与精排模型名、失败时的最可能原因或成功时今日已节约的 tokens 与累计百分比(每天 24:00 清零)。不要加长、不要改写;没有这句输出时不得虚构

6. **知识沉淀**:完成某文件的深挖/修复/排查后,若 `data/code-index.config.json` 的 knownAnnotations 无该文件条目,追加一条(格式:`"项目名/相对路径": "一句话职责+关键机制"`,≤50 字);仅真实读码理解后写入,禁止批量生成;写后校验 JSON 合法

7. **提交后保鲜**:执行 `git commit` 后,运行 `cd code-index && node auto.mjs`(HEAD 没变秒级跳过;有变更时 build 内联约 10s+嵌入转后台)——有 PostToolUse hook 的环境已自动做,重复触发零成本

8. 索引保鲜由会话 hook 自动判定(git 仓库按 HEAD,非 git 目录 24h 回退;嵌入路径或模型变更则重嵌)。手动重建:`cd code-index && node build.mjs && node embed.mjs`。向量过期或切换嵌入模型时运行 `node embed.mjs`(只更新当前路径 data/vectors;维度不一致或 `--force` 时该目录全量),完成后以 `node code-index/status.mjs` 验证。所选嵌入路径(init --model-in ollama|local)拉起失败时检索降级 bm25;显式 `--mode bm25` 可主动选用

9. **文档英文**:`README.md` 与 code-index 的 `部署使用说明.txt` 在中文正文后各有一段英文译文。修改时保留英文段,并按改过的中文改对应英文。禁止删掉英文只留中文。`npm/部署使用说明.txt` 由 sync-npm 从 code-index 那份生成,改源文件后重新同步,不要单独删英文

10. **部署产物同步**:改了 `init.mjs` 的纪律段/输出纪律段/hooks、`output-diet.md` 等部署模板或 AGENTS.md 段规则后,先让测试全绿,再运行 `cd code-index && node deploySync.mjs` 校验一致性;不一致就重新运行 `node init.mjs` 全盘部署(幂等,会重写 hooks 与各仓 AGENTS.md),再跑门禁确认。门禁未过不得声称部署已与代码库一致

<!-- output-diet-v7 -->
## 输出纪律(省话不省工) / Output discipline: less talk, same work

1. 直接写文件,Write 会自动建目录;不先 ls、不先 mkdir。
   Just write the file; Write creates missing directories. Never ls or mkdir first.
2. 一次把整个文件写全;改已有文件只替换要改的行。
   Write the whole file in one pass; when editing, replace only the changed lines.
3. 思考只花在易错处:边界条件、解析规则、状态推演。写法定了就动手,不预演代码,不改口。
   Spend thinking only on risky parts: boundaries, parsing, state. Once the approach is set, act — no code rehearsal, no switching.
4. 实现严格按题面,代码规模与题面要求相称;交付文件只含题面要的导出与实现。
   Implement exactly what the task states, in proportion to it; the deliverable holds only the required exports and logic.
5. 验证 = 用题面给的示例跑一次、核对输出一致;一致即交付,不再跑第二遍、不在文件里内嵌自检块。题面没给示例时,运行一次文件不报错即交付。
   Verify by running the task's own examples once; when they match, deliver — no second run, no self-check blocks in the file. If the task gives no examples, just run the file once: if it doesn't error, deliver.
