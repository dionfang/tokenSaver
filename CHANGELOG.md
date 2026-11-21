# 更新日志(Changelog)

> 本文件是发布变更日志(面向使用者的摘要;逐文件技术细节见 `agent_reports/fix-logs/` 与夜审台账)。
> 版本号遵循 semver;发布时把对应版本段落贴进 GitCode Release 说明。

## Unreleased(下一个版本草案,v1.0.0 2026-11-05 之后)

### 修复

**路由与代理**
- 修复 pickUpstream 决策钉住 miss 后**跨账户越权**(H4 红线):模型不在入口清单时只回入口供应商,绝不兜底到无关账户
- 修复同轮重选全败后阶段被回写成"刚失败且已冷却的模型"(下轮 sticky 直发坏模型)
- 修复 2xx + 错误信封三层失效:网关伪成功现在正确进入 unknown 冷却 + 同轮滑档,错误信封不再透传,成功清零不再抹掉刚记的冷却
- 修复上游 200 + 非法 JSON 被静默透传:非流式响应整包判型,垃圾体改 502 + 冷却
- 修复坏 config.json 连坐杀死整个代理进程(判定层 soft 模式 fail-open,CLI 仍硬报错)

**判定与代签**
- 未建档模型 FALLBACK 恒影子(live=false),不再实弹救回;systemone 不可用标记改 10 分钟 TTL 自愈
- 断路器探活自愈:常驻决策模型缺失时自动重拉再复探,决策票不再无限期弃权
- 标定器字段前转修复(l1 列不再整批丢失)、rrefAudit 证据字段对齐

**嵌入与索引**
- embed 单实例锁改 wx 原子化,消灭与 --build-vectors 的双跑竞态;临时文件按 pid 分名
- **嵌入默认后台限速**:新增 `embedCpuThreads`(默认≈核数/4,约 25% CPU;0=全核),支持 `--cpu-threads`/`--pace` 调档,嵌入不再把用户电脑拉满
- 索引新鲜度纳入工作区脏度;会话启动预热前置(常驻冷加载不再被 build 顶后)

**数据保护**
- 弱标签导出修复为真并集(E3 池缩水场景根治);routing-log 对齐全 miss 时拒绝写盘防清空
- 实验数据护栏新增 2 种绕过形态拦截(变量整体承载/祖先目录删除);read-nudge 记账补文本白名单与 NUL 嗅探
- session-savings 账本纵深防御:原子写 + 读账自愈 + 每日备份 + 修复 CLI

**托盘上传(M5)**
- 修复 HTTP 500 回执被按状态码丢弃:服务端 code6 随 500 下发,现先解析 body.code 再归类,server-error 映射不再失效
- 修复全局 QPS 瞬时限流(code5+retryAfterSec)被当永久配额中止整轮:现与 code9 一样重试≤3 次,永久配额(retryAfterSec=null)仍不重试

**托盘/安装向导**
- 修复「嵌入模型反复下载无法完成」:向导在线下载与托盘自动补权重**并发写同一 .part**(防并发门原是单向,托盘进程刚起时向导不避让自动任务)→ 互删断点/字节交错 → 字节数校验永不过。现向导开跑前先取消托盘自动补下载并等其在途清零(断点保留续传,进度零浪费)

**测试与门禁**
- 门禁链修复 && 缺失、npm 链补齐;新增密闭性自检门禁(gate-enclosure,支持子目录)
- 判定类测试进程级隔离(后台嵌入不再打红密闭测试)
- 四支顶层评测脚本统一 NO_LEDGER + backup-then-write 写盘纪律
- 节流负龄放行 ×6(时钟回拨不再永久卡死);keep_alive 阈值双写归一

### 新增

- **ZCode 钩子闪窗根治**:SessionStart 合并入口(2 闪→1 闪)+ GUI 子系统中继 hook-relay.exe(全链零闪,Job Object 级联杀,编不出自动回退 node 直启)
- **嵌入进度可见**:状态句在嵌入进行中显示 `向量索引嵌入中 X/Y(pct%)`(成功/失败两种形态都带)
- 注解库体检门禁 `annotationCheck`(死链检测+候选改法+长度校验);`bugfix-sop.md` 修复作业规程机制(三仓播种)
- CODE_MAP 架构知识地图、依赖图谱生成器(tools/)与自动归层

### 托盘客户端发布线(0.2.x,2026-11-18~11-21)

- **应用自更新**:托盘菜单「检查应用更新」唯一入口,差量下载(blockmap v2 Range 重组,实测跳差量省 99.6%)+ sha512 完整性门 fail-closed;下载完成弹窗确认→可见安装向导;0.2.6 起修复更新检查键(localData)恢复自升
- **PINS 双钥**:dev-2026Q4 + 生产 base-2026Q4 双钥窗口,生产私钥签单验签通过;旧 dev-only 客户端拒验
- **onnxProbe/wasmEmbed**:onnx 原生会话崩溃隔离探针(静默死⇒wasm 回退、带错死⇒surfaced 定罪)+ 纯 wasm 嵌入后路(零原生 .node),根治测试机嵌入静默死亡
- **manualSwitch 人工改档通道**:采集/审计/影子 live 门(升档 0.8 降档 0.5),would* 恒不作真值防循环
- **proxy 看护兜底**:托盘 60s proxyWatchdog(--ensure 空载荷保活),代理进程死亡不再无人拉起
- **routing-on 裁定 A(2026-11-20)**:新装默认 `modelRouting.enabled=true`(init `--routing-on` 旗标+向导 DONE 携带),人工改 false 原样保留
- **0.2.10/0.2.11 安装链加固**:权重就绪改字节级门(半截文件不再过存在性门)、重装「无法关闭」根治(三层查杀宏 ts-kill-children.ps1)、hook-relay.exe 随包、开机自激活 pending.json(已下载未装的新版启动自检)

### 文档

- AGENTS.md 纪律段扩充至 14 条(新增:缺陷文档回写、修复复盘自更新、修复日志归档)
- test/readme.md 全量登记(39 套件 + 17 支评测脚本);model-routing.md 口径对齐(FALLBACK 影子化、maxLatencyMs)
- 夜间审查台账两轮闭环(20261109/20261111:61 fixed / 5 open 知情)

### 移除

- **npm 发布渠道整体弃用**(2026-11-17 用户拍板):删除 `npm/` 目录与 `sync-npm.mjs`,不再提供 `npm i -D @dionfang/tokensaver` 安装方式。安装统一走源码仓 `node init.mjs` 或复制 `code-index/` 部署。连带清理:README/部署使用说明中英 npm 段、init.test npm 打包校验、depgraph-layers/gen_graph_md 镜像引用、known-annotations sync-npm 条;npm-chain-align.work.mjs 归档 test/archive/。

## v1.0.0(2026-11-05)

- 首个发布版本:省耗记账(Token Ledger)+ 动态模型路由(AutoTier),含自进化闭环

### 补充(2026-11-14 夜审修复,并入 Unreleased)

- **npm 发布链修复**:npm 门禁链 16→41 段对齐(此前修复未提交丢失,一致性对齐脚本入库防再发);npm/README 还原
- **向量库混维根治**:CLI --build-vectors 不再绕过模型绑定;dim 锚定目标模型实测维度+逐条自检;污染向量库已重建
- **判定与代理健壮性**:tripBreaker 参数误传抛错替代静默写生产;prevHuman 支持 blocks 数组消息形态;决策档案层序修正(当前模型权威);uninit 卸载不再吞段后用户文本
- **脚本修复**:ollama-model-eval 导入期崩溃修复(buildBody→buildSystemoneBody);importRoutingLog/extractTierEvidence 原子写

### 补充(2026-11-17 Ollama runner 自愈)

- **新增 Ollama runner 异常自动重启**:server.log 近 5 分钟 ≥2 条 `llm server error` 且期望模型缺驻留,连判两轮且过冷却(默认 30min,`ollamaRestartCooldownMs`)即自动 taskkill 重启 serve(托盘自愈拉回)+ warm 回拉;`ollamaAutoRestart:false` 可关(默认开)
