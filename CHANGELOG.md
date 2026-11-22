# 更新日志(Changelog)

> 本文件是发布变更日志(面向使用者的摘要;逐文件技术细节见 `agent_reports/fix-logs/` 与夜审台账)。
> 版本号遵循 semver;发布时把对应版本段落贴进 GitCode Release 说明。

## 未发布

### 修复

**托盘客户端**
- 安装包与客户端 exe 悬停不再弹出「文件说明」文案(2026-11-22 用户裁定):package.json 删除 description(安装器/卸载器 NSIS 直引该字段即自动空),壳 exe 的 description||productName 兜底由 dist 双形态包装器在构建后用同款 rcedit 清写为空并回读把关;`npm run dist`/`dist:offline` 命令不变,已发布版本不受影响

## v2.0.0(2026-11-22)

自 v1.0.0(2026-11-05)以来的全部变更。本次为重大版本:新增 Electron 托盘客户端完整发布线(安装向导/应用自更新/公共决策包互惠),路由与判定健壮性大规模加固。

### 新增

**托盘客户端(全新)**
- Electron 托盘壳:四组状态灯(索引/嵌入/精排/决策)+ 双通道轮询 + 悬浮状态提示;面板纯监控,不含上传/同意开关
- 在线安装向导:五步全自动(模式选择→环境自检→数据上传→接线→完成);环境自检缺项自动安装(权重在线下载/CMD 滚动进度/ollama pull),二次配置以 config 为真源重建
- 双形态发布包:`npm run dist`=在线包(≈215MB,权重装后在线下载,含镜像回退)/`npm run dist:offline`=完整包(≈1.48GB,三权重随包);NSIS 安装器
- 启动分流:未完成向导双击只跑向导,已完成直接托盘;向导完成后同会话无缝转托盘

**应用自更新**
- 托盘菜单「检查应用更新」唯一入口;差量下载(blockmap v2 Range 重组,实测省 99.6%)+ sha512 完整性门 fail-closed + 防降级回滚
- 下载完成弹窗确认→可见安装向导;开机自激活(已下载未装的新版,启动自检后自动装)

**公共决策包互惠**
- 一键更新公共决策包:basepack 验签选包/磁盘预检/sha 硬门下载/导入器编排,面板进度条实时跟进
- 本地向量上传闭环(契约 v1.2):只取 ensemble 已签条目/accepted+rejected 双游标断点不重传/分片+gzip+AES-GCM+RSA-OAEP sha256 信封
- 互惠顺序:先上传本地已签向量成功才下载公共包;初始安装无本地向量不阻断下载;同意唯一入口=向导数据上传步

**安全与签名**
- PINS 双钥窗口(dev-2026Q4 + 生产 base-2026Q4),生产私钥签单验签;旧 dev-only 客户端拒验

**嵌入与推理**
- 纯 wasm 嵌入后路:onnx 原生会话崩溃隔离探针(静默死⇒wasm 回退、带错死⇒报错定罪),零原生 .node,根治测试机嵌入静默死亡
- 权重就绪改字节级门(半截文件不再过存在性门);onnx-weights.json 字节表单源
- Ollama 并发驻留上限客户端化:gpu 就绪即代写用户级 `OLLAMA_MAX_LOADED_MODELS=5`(防聊天模型挤走嵌入模型)
- Ollama runner 异常自动重启:server.log 连判两轮 `llm server error` 即 taskkill 重启+warm 回拉,`ollamaAutoRestart:false` 可关

**路由与记账**
- 新装默认 `modelRouting.enabled=true`(init `--routing-on` 旗标);人工改 false 原样保留
- manualSwitch 人工改档通道:采集/审计/影子 live 门(升档 0.8 降档 0.5),would* 恒不作真值防循环
- V4.1 档位与费率换挡 + L1 语义三类定稿(multi/routine/light)
- 路径自适应 v2Dir 配置制 + 动态显示名刷新
- 子代理检索源端盖章(sessionFromEnv);prefetch 免读证实转正入账
- auto 刷名偏差死区 0.05:6h grow 同拍刷名与当前倍率偏差 <0.05 不刷,不再一天多次重写 provider_config 令 ZCode 列表重载
- autoExemplars `--grow-now`/`--sync-now` 手动触发;样本库单配 capPerLabel/totalCap 独立生效(0=不限)

**工具与体验**
- ZCode 钩子闪窗根治:GUI 子系统中继 hook-relay.exe(全链零闪,Job Object 级联杀)+ SessionStart 合并入口
- 嵌入进度可见:状态句「向量索引嵌入中 X/Y(pct%)」+ 面板进度条实时跟进(embed-progress.json 每批落盘,不假满不闪回)
- 嵌入默认限速:`embedCpuThreads`(默认≈核数/4,约 25% CPU)+ `--cpu-threads`/`--pace` 调档,嵌入不再拉满用户电脑
- proxy 看护:托盘 60s proxyWatchdog 空载荷保活,代理进程死亡不再无人拉起
- 注解库体检门禁 annotationCheck(死链检测+候选改法+长度校验);bugfix-sop.md 修复作业规程;CODE_MAP 架构知识地图与依赖图谱生成器
- 状态句失败形态也带今日累计/总计节约数字

### 修复

**路由与代理**
- pickUpstream 决策钉住 miss 后跨账户越权(H4 红线):模型不在入口清单只回入口供应商,绝不兜底无关账户
- 同轮重选全败后阶段被回写成「刚失败且已冷却的模型」(下轮 sticky 直发坏模型)
- 2xx + 错误信封三层失效:网关伪成功正确进入 unknown 冷却+同轮滑档,错误信封不再透传
- 上游 200 + 非法 JSON 静默透传:非流式响应整包判型,垃圾体改 502+冷却
- 坏 config.json 连坐杀死整个代理进程(判定层 soft 模式 fail-open,CLI 仍硬报错)
- 检索节约原文分母重叠行重复计致高估(按文件行区间并集去重)

**判定与代签**
- 未建档模型 FALLBACK 恒影子(live=false),不再实弹救回;systemone 不可用标记改 10 分钟 TTL 自愈
- 断路器探活自愈:常驻决策模型缺失时自动重拉再复探,决策票不再无限期弃权
- judgeBatch 每请求超时+分片并发+退避重试(修整批 30s 超时致决策票整轮跳闸)
- 标定器字段前转修复(l1 列不再整批丢失);tripBreaker 参数误传抛错替代静默写生产;决策档案层序修正(当前模型权威)
- 向量库混维根治:CLI `--build-vectors` 不再绕过模型绑定,dim 锚定目标模型实测维度+逐条自检
- judgeBatch 二次 id 重映射删除;词法快照前移 l2Override 缝;errStreak 疲劳对称

**嵌入与索引**
- embed 单实例锁改 wx 原子化,消灭与 `--build-vectors` 的双跑竞态;临时文件按 pid 分名
- 索引新鲜度纳入工作区脏度;会话启动预热前置(常驻冷加载不再被 build 顶后)
- 死 pid 锁冷却期接管;导入器首装空本地层两连崩(空库守卫+mkdir recursive)
- fresh 安装零状态:buildCandidates 缺 usage/routing-log 由抛 ENOENT 改 fail-open(测试机首点「立即同步」炸面板)
- bm25 降级零记账门控(分母并集去重同口径)

**数据保护**
- 弱标签导出修复为真并集(E3 池缩水场景根治);routing-log 对齐全 miss 时拒绝写盘防清空
- 实验数据护栏新增 2 种绕过形态拦截(变量整体承载/祖先目录删除);read-nudge 记账补文本白名单与 NUL 嗅探
- session-savings 账本纵深防御:原子写+读账自愈+每日备份+修复 CLI
- 节流时钟回拨负龄放行(不再永久卡死);keep_alive 阈值双写归一

**托盘安装与更新链**
- 重装「无法关闭」弹窗根治:detached node 子进程占安装目录致卸载器 RMDir 失败,改静默强杀宏(ts-kill-children.ps1 三层查杀)+NSIS customCheckAppRunning
- hook-relay.exe 随包(此前被 `!bin/**` 排包规则挡掉,机上钩子全失效;面板「修复钩子」可现场自愈)
- 权重在线下载跟随 3xx 重定向(HF/镜像 resolve 必 302 到 CDN,旧实现三权重下载全灭)
- 权重补下载永远补不齐:完成路径硬依赖 item.sha256,全在线清单不预置 sha 致真下载完成即 TypeError 重试全败(改 finalizeIfComplete 单源)
- 弱网大文件下载加固:>16MB stall 30s→120s+换源清 .part 防跨服务器 Range 错位+失败点名具体文件
- 向导在线下载与托盘自动补权重并发写同一 .part 互删断点:向导开跑前先取消托盘自动任务并等在途清零
- 接线失败后上一步→下一步死锁(进 INIT_RUN 清 initLog 重新自动接线);busy 禁用门改步骤级(下载中回退 MODE 页面切换死锁)
- 覆盖安装数据落点分裂(packed 布局落用户目录,「重开向导回初始态」根治)
- 装完 Node 点重新自检仍红(envProbe 死缓存+进程 PATH 启动快照双层 stale)
- 无 Node 机器启动双错误框死胡同(packed 规范路径静态兜底,自检展示安装指引而非拒绝)
- 安装路径含空格/中文时 ollamaPull 判定恒 false(CLI 静默 no-op);pull 120s 无进度 abort 防挂死
- 向导内联按钮全失效(window.act 挂载);接线只接最后一个目录(逐目录多次 spawn 整表覆盖);自检双 probe 并发竞态+重新自检静默吞
- 自检全绿后旧 [fail] 红字残留;面板嵌入比例向下取整(99.96% 四舍五入伪 100% 绿满条与黄灯自相矛盾)
- embed 族超时 1h→6h(慢机 CPU 限线程嵌入全量 >1.2h 被准点树杀成来回点好几轮)
- 更新检查键 localData 修复(0.2.2–0.2.5 更新检查整链瘫痪无法自升,须手动装 0.2.6+)
- 「已是最新版」误弹窗(面板绿文案即够);点「立即安装」向导拉起失败(旧 setTimeout 随主进程退出被吞,改同步拉起再退出)

**托盘上传(M5)**
- HTTP 500 回执被按状态码丢弃:服务端 code6 随 500 下发,现先解析 body.code 再归类
- 全局 QPS 瞬时限流(code5+retryAfterSec)被当永久配额中止整轮:改重试≤3 次,永久配额(retryAfterSec=null)仍不重试

**夜审 20261120 批量修复轮(75 发现→33 fixed)**
- 注入过滤三形态+tier-evidence 再生自检;decisionProfiles 守卫+突变红;judgeMs 只计已判分片
- soft config 全家(坏 JSON 隔离子进程 exit 0)/read-guard 管道+短名归化/NUL 三路嗅探/allowLocalModels 统一 true
- 判定类测试进程级隔离(后台嵌入不再打红密闭测试);顶层评测脚本 NO_LEDGER+backup-then-write 写盘纪律

## v1.0.0(2026-11-05)

- 首个发布版本:省耗记账(Token Ledger)+ 动态模型路由(AutoTier),含自进化闭环
