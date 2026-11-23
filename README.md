# TokenSaver
客户端下载 [https://gitcode.com/dionfang/TokenSaver/releases/download/v2.0.0/TokenSaver-Setup-0.2.23.exe](url)
## 中文项目简介

### 项目简介

TokenSaver 是跑在本机的 Agent 提效工具,有两大核心功能模块。

**模块一:省耗记账(Token Ledger)**——为代码库建语义检索索引,Agent 定位代码只读需要的区间;过长的整文件读取会被守卫改写为语义最相关区间,选不出才拒绝;每轮节约按 token 精确入账,会话状态句实时展示今日与累计。**Cursor、ZCode、Qoder 三端通用**。

**模块二:动态模型路由(AutoTier)**——本地代理即自定义模型端点,客户端多出一个虚拟模型档位 `auto`;选中它的会话由代理按 prompt 难度四档定档(R1-R4,以 R3=1x 为基准),贵模型只在必要时使用;自进化闭环持续降本。**仅 ZCode 与 Qoder 支持,且只对以 Anthropic Messages 协议接入的自定义模型生效**。

适合在本地代码库上用 Agent 开发。默认推荐**桌面客户端(托盘守护程序)**安装,无需命令行;纯命令行只是不装守护程序时的备选。一个 TokenSaver 可以用 `--roots` 索引多个目录。代码、分块和向量写在本机 `data/`,不进入 git。

配置分两层:模型部署参数改 `code-index/config.mjs`;项目配置在 `data/code-index.config.json`(init 自动生成,含 `modelRouting` 路由段)。字段说明见下文「配置」与 [`部署使用说明.txt`](code-index/部署使用说明.txt)。
![微信图片_20261105220119.png](https://raw.gitcode.com/user-images/assets/11189521/7fabff6c-6f9b-44a9-943b-fbc69d24b447/微信图片_20261105220119.png '微信图片_20261105220119.png')
### 工作方式

#### 省耗记账(要点)

- 混合检索:BM25 词法 + 向量余弦;需要更准再加 `--rerank`;嵌入拉起失败自动降为纯 BM25。嵌入默认 local(transformers.js),可选 `--model-in ollama`;判定模型跟同路径本地化,默认启用、零远程调用(ollama=tev1:0.8b,local=常驻 ONNX)。
- 读取守卫:整文件 Read 超过 `readMaxLines`(默认 500)的 1.25 倍即改写为语义区间,选不出才拒绝并给出替代方案;Grep 无 `head_limit` 补 100;同一目标 5 分钟内重试一次放行。**护栏面与索引面统一(2026-11-07)**:只对 `exts` 白名单内的文本类型拦截与记账,白名单外(图片/二进制/未收录类型)直接放行不计入节约口径(图片走宿主视觉通道,真实成本是视觉 token)。Cursor 的 preToolUse 用字面 matcher。
- 索引保鲜:git 仓库按 HEAD 判断过期;非 git 目录默认 24 小时重建。
- 入账:节约量按 qwen tokenizer 精确计数,只记拦截入口一次(下限口径,真实节约随后续轮数复利);状态句实时展示今日/累计。**口径声明(2026-11-18)**:① 预取(prefetch)注入只登记免读候选,同会话后续读取守卫拦截同文件才转正入账一次(守卫让位不双计,压缩侧按预取实际注入量),未证实的候选 7 天过期不计;② 会话放大依赖宿主 usage 数据源:ZCode(db)/Qoder(qoder-usage)覆盖放大,**Cursor 无 usage 喂入,只计入口一次、不计会话放大**(显式口径,非缺陷);③ 检索原文分母按命中块行区间并集去重(重叠行不重复计);④ output 侧节约/路由降档成本/本地替代远程不在本账本口径内。
- 模型清理:切换模型后发起会话,会话开始即卸掉"切换前拉起"的驻留模型(只卸本工具拉起的,你自己 pull 的聊天模型不碰);宿主关闭后由脱离父进程的看护统一卸载 Ollama 驻留、停掉 transformers.js 常驻进程(不留 keep_alive 驻留尾巴)。手动清:`node cleanup.mjs --all`。

#### 动态模型路由(要点)

- 会话选 `auto` 虚拟模型即启用;每轮按难度定档 R1-R4,R1 为 sticky 基准,宽限/阶段粘住/切换税门控压低换档频率;短确认/短指令等续接轮沿用阶段档不拆阶段(maxPhaseTurns 有界)。
- 定档链:词法底档(L1 语义三类 + 品牌三档表 + 轻量后缀降档)→ 恒本地的判定模型双臂救回(词法 R1 过置信门升 R2、R2 强信号升 R3);R4 恒不由自动升档进入,唯一入口=显式点名旗舰模型。费率以 R3=1x 为基准(R1≈0.05x / R2≈0.5x / R4≈3.6x),长期实测综合费率 ≈0.15x。
- 上游 429/配额墙同轮滑链或降档;门控连续拦截满 3 次疲劳放行,拦截时注入一次压缩建议。
- 自进化闭环:真实流量自动生长黄金集,每 6h 学习信号权重与门槛,折外过门控自动晋升 live,观察窗成本恶化自动回滚。
- 生效条件、接入要求与配置字段见下文「配置」的 modelRouting 段与 `部署使用说明.txt` 的配置说明。

### 环境

- Node.js ≥ 18,以及 git。
- local:模型在 `code-index/hf-cache`(三个本地模型——嵌入/精排 transformers.js、决策 Strands ONNX,约 1.5GB)。该目录超过 git 单文件上限,不入库;缺失时首次使用才下载。复制部署时请整目录带走。
  内存需求:纯 CPU 运行,无显卡要求;三模型常驻内存合计约 2-3GB(权重约 1.5GB + ONNX 运行时),嵌入线程默认限 `min(4, max(2, 物理核数/4))`(`embedCpuThreads`),慢机也不占满核。
- ollama:本机先安装并自行启动 Ollama,再手工 pull。Ollama 模型不随目录复制。
  显存需求:`gpu=auto`(默认)按**总显存 ≥6GB** 判定走 GPU(给系统/其他程序留余量),三模型常驻显存 **≈4.5GB**(`OLLAMA_KEEP_ALIVE=24h` 恒占,空闲不驱逐);总显存不足 6GB 或无独立显卡时自动改用 CPU 跑——功能不变,嵌入吞吐显著变慢。
  版本推荐:**钉 Ollama 0.40.15**——实测嵌入批量 ~0.83s/块;0.40.16 退化至 1.17-1.42s/块(约 1.5 倍慢),0.40.7 居中且波动大;三个版本的 /v1/systemone 决策端点均兼容。升级前先按同口径复测嵌入吞吐(batch 32、腾显存、90s 双采样)。


```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
ollama pull tev1:0.8b
```

模型名若在 `code-index/config.mjs` 里改过,pull 改为改后的名字。

### 使用

`init` 会安装依赖、写配置、接线 hook,并在后台建索引、预热。用 `node status.mjs` 确认就绪。参数名写错、缺少取值,或 `--model-in` / `--hooks` 取值非法时,报错退出且不改配置。`--roots=路径` 与 `--model-in=local` 这种写法也可以。

#### 客户端安装(托盘守护程序,推荐)

安装包随 Release 发布:在线包 ≈225MB(三 CPU 权重装后向导自动在线下载,带镜像回退)与完整离线包 ≈1.48GB(权重随包,离线环境用)。双击安装即可;未完成首次配置时双击只开安装向导,完成后双击直接进托盘。

首次配置走安装向导五步:运行模式选择(cpu/gpu)→ 环境自检(缺项自动安装:权重在线下载/ollama pull,带真百分比进度)→ 数据上传(可选;参与公共决策包互惠的唯一同意入口)→ 接线(自动完成 `init`:目录登记、三端钩子、路由开关)→ 完成(同会话无缝转入托盘)。

之后由托盘守护程序负责日常运行:四组状态灯 + 面板自检反映索引与三个本地模型状态;「更新公共决策包」一键先上传本地已签向量再下载公共决策包;应用升级走托盘菜单「检查应用更新」(差量下载 + sha512 完整性门)。全程无需命令行。

两类数据落点:①向量索引数据(分块/向量/配置/记账账本)在 `%LOCALAPPDATA%\TokenSaver\data`;②模型文件在 `%USERPROFILE%\.tokensaver\hf-cache`(cpu 模式的三权重,由安装器/向导下载),gpu 模式的模型由 Ollama 自管(默认 `%USERPROFILE%\.ollama\models`)。

![default.jpg](https://raw.gitcode.com/user-images/assets/11189521/99072fb5-0580-4656-a221-c58602df62ec/default.jpg 'default.jpg')

#### 纯命令行工具(不安装托管守护程序)

数据写在本仓库 `data/`,不写进被索引的项目。

两类数据落点:①向量索引数据(分块/向量/配置/记账账本)在仓库根的 `data/`;②模型文件——`--model-in local`(默认)在 `code-index/hf-cache`(三模型约 1.5GB,不入库,缺失时首次使用自动下载),`--model-in ollama` 由 Ollama 自管(默认 `%USERPROFILE%\.ollama\models`,不随目录复制)。

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<项目目录1>,<项目目录2>"
node status.mjs
node search.mjs 关键词 --k 5
```

以后在 `data/code-index.config.json` 的 `roots` 里改路径,再跑一次不带参数的 `node init.mjs`,即可把新目录编进索引,并给那些 git 仓挂钩子。

#### 复制到目标项目

复制的是 `code-index/` 这一个目录,可放在项目任意位置,建议 `scripts/code-index`。必须带上 `hf-cache`。不要带 `node_modules`,不要带 `data/`。

数据写在与该目录平级的 `data/`(建议路径下即 `scripts/data`)。若 `code-index` 本身就是 git 根,则写在其下的 `data/`。可用环境变量 `CODE_INDEX_DATA_DIR` 改位置。

```bash
cd 目标项目/scripts/code-index
node init.mjs
node status.mjs
```

只复制了 `code-index/` 时,同目录的 [`部署使用说明.txt`](code-index/部署使用说明.txt) 是同一份说明。

### 初始化参数

```bash
node init.mjs [--roots "<路径1>[,<路径2>...]"] [--set-roots "<路径1>[,<路径2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder] [--routing-on]
```

`--roots`:逗号分隔的扫描目录,写入 `data/code-index.config.json`。正斜杠、反斜杠都可以。

- 不传且还没有配置:用工具仓 git 根。
- 不传且已有配置:按文件里的 `roots` 自愈(仍存在的保留,失踪的按兄弟目录猜一次),不把工具仓自己塞进名单;然后给这些 git 仓挂钩子并后台建索引。
- 传入:与已有 `roots` 合并(纳入,不去掉旧的)。不存在的路径跳过。要删目录,用 `--set-roots` 整表替换(传空=清空),或改 JSON 后重跑不带参数的 `init`。

`--set-roots`:逗号分隔目录**整表替换**(与 `--roots` 的合并语义相反;可重复传,传空=清空)。

`--hooks`:`all` | `cursor` | `zcode` | `qoder`。只写选中工具的会话 hook,不改其他工具已有文件。不传时的识别规则见「项目简介」的两模块兼容范围:省耗记账三端都装,动态模型路由只装 ZCode 与 Qoder。

`--model-in`:`ollama` 或 `local`,写入 `modelIn`,不改模型名。新建配置时不传则为 `local`。已有配置时不传则保持原路径。

`--routing-on`:显式开启路由记账闭环(写入 `modelRouting.enabled=true`;向导完成步携带)。已有配置人工改的 false 原样保留。

### 配置

模型部署只改 `code-index/config.mjs`。`data` 里 JSON 的同名项无效。

| 项 | 默认 |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto`(还可设 `cpu`、`gpu`;注意:num_gpu 只对嵌入/精排生效,决策模型(ollama 路径)忽略该选项、由 Ollama 自动放置) |
| `OLLAMA_KEEP_ALIVE` | `24h`(2026-11-14 起,模型常驻不因空闲消失;显存恒占≈4.5GB) |
| `OLLAMA_NUM_CTX` | `4096` |

项目配置在与 `code-index/` 平级的 `data/code-index.config.json`。未写的键用 `config.mjs` 的默认值。

| 键 | 说明 |
|---|---|
| `roots` | 扫描目录。优先级:`--roots` > 环境变量 `CODE_INDEX_ROOTS` > 本文件 |
| `modelIn` | `ollama` 或 `local`。优先级:`--model-in` > 本文件 > `local` |
| `skipDirs` | 跳过的目录名。写了就整表替换,不是追加。默认已跳过依赖、构建产物和编辑器目录。新生成的配置还会加上 `code-index`、`.cursor`、`.zcode`、`.qoder` |
| `exts` | 收录的扩展名,不带点 |
| `jsonWhitelist` | 允许收录的 json 文件名。默认 `package.json`、`pages.json`、`manifest.json`、`tsconfig.json` |
| `maxFileBytes` | 单文件上限。默认 `819200` |
| `readMaxLines` | 全量 Read 行数上限,默认 `500`。设得很大等于关掉拦截 |
| `chunk` | `targetLines` 70,`maxLines` 120,`overlapLines` 10,`minTail` 15 |
| `staleNonGitMs` | 非 git 目录多久重建一次,毫秒。默认 `86400000` |
| `embedCpuThreads` | 本地(transformers.js)嵌入的 CPU 线程上限。默认 `min(4, max(2, 物理核数/4))`;`0`=全核 |
| `warmMinIntervalMs` | 模型被驱逐/缺位后两次自愈补拉的最小间隔,毫秒。默认 `60000`(最小 1000) |
| `knownAnnotations` | `"项目名/相对路径"` → 一句职责 |

#### modelRouting(动态模型路由配置)

`data/code-index.config.json` 的 `modelRouting` 段由 init 自动生成骨架(`enabled` 默认 `true`——2026-11-20 裁定A,新装默认开路由记账/样本生长闭环;人工改 false 原样保留),**已有配置不覆盖**;与上面两层口径不同,这一段只认 `data/code-index.config.json`。常用配置项:

| 键 | 说明 |
|---|---|
| `enabled` | 总开关(默认 `true`,2026-11-20 裁定A);控制三件事:每轮 `[model-routing]` 定档行注入、L1 分类(classifyPrompt)、routing-log 落盘——关闭=三者全停,auto 流量无论开关都照常路由(2026-11-11 S6-F9 口径对齐 model-routing.md §5) |
| `brandPriority` | 四档链档内品牌调用优先序(默认 glm,deepseek,qwen,minimax,kimi,grok,claude,gpt,gemini),不影响档位归属 |
| `modelTiers` | 品牌三档默认表(2026-11-06 v4,v4.1 调档):`{normal:[deepseek,glm,qwen,minimax]→R2, mid:[kimi,grok,gemini]→R3, high:[claude,gpt]→R4}`,未识别品牌按 normal 兜底;pro/max 不特殊,档位语义与品牌等级一一对应 |
| `lightSuffixes` | 轻量版本后缀表(默认 flash,preview,coding,code,coder,turbo,mini,air,nano,event,haiku,luna,lite,base,sol,sonnet):命中即在品牌默认档上降一档(R1 封底,flash 恒 R1) |
| `providerPriority` | 同名模型挂多供应商时的同名取序,配额尽自动滑下一供应商 |
| `providerOrder` | 宿主 UI 供应商拖动序(快照自动采集,无需手配):同名供应商未进 `providerPriority` 时按它取序,冷却/配额尽按 UI 序逐个滑动;配置同键可覆盖快照序(Qoder 端无拖动序,按设置文件键序采集) |
| `retryOnRateLimit` / `maxRetries` | 运行时 429/5xx/网络失败同轮换模型重选(默认 true / 2) |
| `maxPhaseTurns` | 升档阶段最多持续的人类轮数(默认 4),到顶回 R1 基准 |
| `switchGuard` | 切换税门控 `{enabled 默认 true, maxContextTokens 默认 200000}`;只拦升档;同会话被拦满 3 次疲劳放行,拦截时注入一次压缩建议 |
| ~~l2~~ | **已回收(2026-11-14 用户裁定)**:L2 影子/实弹融合票**恒开**(代码常量,配置键不再读取);阈值(minSim 0.55/minConf 0.6/live 0.3)属标定域走代码默认,不暴露给用户配置面 |
| ~~l2Live~~ | 同上:旧键不再读取,实弹 L2 融合票恒开(词法 R1+kNN 投 multi→救回 R2;R2+kNN 投 R3→救回 R3,只救回不压制) |
| `decisionModel` | 四票合议代签的判定模型(v4 2026-11-09 本地化收口:判定**恒本地**——ollama=`models.decision`(tev1:0.8b)/ local=`models.localDecision`(Strands ONNX q4f16 常驻),跟 `modelIn` 同路径;旧键 `enabled/model/providers/chunkSize/rRef` 已废弃不读)。定档双臂与代签门槛全部走**模型判定档案** `profiles`(键=判定后端名,默认表:tev1→arm1 minConf 0.6/window all-r1、代签 0.4/0.85;strands→0.5/ambiguous、0.4/0.85;arm2 r3MinConf 0.85;未建档模型回退 FALLBACK(0.75/ambiguous/0.6/0.9;2026-11-10 S2-F4 后 arm1 **恒影子 live=false**,只记影子账不改判))。臂1 按档案窗口咨询词法 R1 轮(tev1=全部 R1、strands=置信≤0.5 的 R1),法官投到 R1 以上任何档都只按 R2 救回(一步一档封顶,R3 留给臂2;R4 恒不救);臂2 在词法定档 R2 时现查,法官投 R3 且过 r3MinConf ⇒ 救回 R3;判定失败/投他档维持原档(fail-open),影子留痕 `data/usage/r-ref-shadow.jsonl`。判定模型拉不起=决策票弃权,不拖垮检索/路由 |
| 双轴标签 | 黄金集每条同时记两个正交轴:`semanticType`(语义形态 multi/routine/light,由 L1/L2/决策三票合议——"这话要求的是不是多点改组")与 `intensityType`(行为强度 heavy/normal/light,由行为票——"这轮实际干了多重的活")。此前两者塞进同一标签比较,multi 一致率被压到 0.2;拆开后各轴各评(`node code-index/modelRoute.mjs --score-golden-dual`)。两轴真值均为机器合议弱真值,无外部人工锚点 |
| `manualSwitch` | 人工改档真值通道(2026-11-19 裁定)`{enabled 默认 true, live 默认 false, upConf 0.8, downConf 0.5, lateralConf 0.3, agreeMin 0.8}`:只采人工改档动作(同 session 相邻轮的齿轮/模型名变化,不采静态默认选档),升档高权/降档低权;**影子先行**——默认 live=false 只采集+审计三方一致率(人工 vs 难度裸解析 vs 结果),live=true 才把人工档写进黄金证据作档位真值的人工锚点(台账 `data/routing/manual-switch.jsonl`);难度裸解析只作对照绝不作真值(防循环红线) |
| `tierOptimize` | 自进化闭环 `{enabled, minIntervalMs, folds, minN, priorN, grow, fitCost, dry, allowBoost}`:enabled=true 后每 6h 学习信号权重与门槛,折外过门控自动晋升 live,观察窗成本恶化自动回滚 |
| `blendNotice` | auto 综合费率行注入开关 `{enabled 默认 true}`:仅路由宿主注入"最近会话实际费 ÷ R3 基准费(R3=1x)"倍率行;关=只停注入,记账照常 |
| ~~r3Lexical~~ | **已回收**:R3 词法通道与 P2 提前一拍**恒开**(代码常量,enabled/eagerEscalate 不可配);词表本体在 tierClassify.mjs |

生效范围与边界:仅 ZCode/Qoder 两端参与;auto 只调度自定义模型中以 Anthropic Messages 协议接入的模型;模型分档按名字自动判定(2026-11-06 v4 品牌三档+轻量降档,v4.1 调档:普通品牌 deepseek/glm/qwen/minimax→R2、中档 kimi/grok/gemini→R3、高档 claude/gpt→R4,轻量后缀(flash/preview/turbo/mini/haiku/sonnet/sol 等)在默认档上降一档、flash 恒 R1,未识别品牌按普通档兜底;两表都在 `modelRouting.modelTiers` / `lightSuffixes`,可改配置重排全链)。接入步骤与配置字段见 [`部署使用说明.txt`](code-index/部署使用说明.txt) 的配置说明。

### 仓库模块

运行时脚本只在 `code-index/` 维护。npm 发布渠道已弃(2026-11-17),不再提供 npm 安装。

| 目录 | 用途 |
|---|---|
| [`code-index/`](code-index/) | 运行时。直接部署、在本仓运行,或复制到目标项目的就是这一份 |

### 许可

MIT。

## 英文项目简介

### Overview

TokenSaver is a local agent productivity tool with two core feature modules.

**Module 1: Token Ledger (省耗记账)** — builds a semantic search index over the codebase so the agent reads only the spans it needs; over-long full-file reads are rewritten to the closest semantic range, denied only when nothing fits; every turn's savings are accounted in tokens and shown live in the session status line. **Works on all three clients: Cursor, ZCode, and Qoder.**

**Module 2: Dynamic Model Routing (AutoTier)** — the local proxy doubles as a custom-model endpoint and the client gains a virtual model tier `auto`; sessions that select it are dispatched across four difficulty tiers (R1-R4, with R3 = 1x as base), so expensive models run only when needed; a self-evolution loop keeps reducing cost. **ZCode and Qoder only, and only for custom models wired in via the Anthropic Messages protocol.**

Built for agent-based development on local repositories. The **desktop client (tray guardian)** is the recommended install — no command line needed; the pure CLI is the fallback for when you prefer not to install the guardian. One TokenSaver can index several directories with `--roots`. Chunks and vectors stay in a local `data/` directory and are not committed to git.

Configuration has two layers: model deployment parameters in `code-index/config.mjs`; project settings in `data/code-index.config.json` (scaffolded by init, including the `modelRouting` section). See "Configuration" below and `部署使用说明.txt` for the full field reference.

### How it works

#### Token Ledger (key points)

- Hybrid search: BM25 lexical + vector cosine; add `--rerank` for tighter ranking; falls back to BM25-only if the embedding model fails to start. Embedding defaults to local (transformers.js), optionally `--model-in ollama`; the decision model follows the same path locally — always on, zero remote calls (ollama = tev1:0.8b, local = resident ONNX).
- Read guard: a full-file Read past 1.25 × `readMaxLines` (default 500) is rewritten to a semantic range, denied only when no range fits, with alternatives offered; Grep without `head_limit` is capped at 100; one retry of the same target within five minutes is allowed. **Guard scope equals index scope (2026-11-07)**: only file types inside the `exts` whitelist are intercepted and accounted; anything outside (images/binaries/unlisted types) passes through without entering the savings ledger (images go through the host vision channel — real cost is vision tokens). Cursor's preToolUse uses literal matchers.
- Index freshness: git repositories go stale by HEAD; non-git directories rebuild every 24 hours by default.
- Accounting: savings are counted precisely with the qwen tokenizer, recorded once at the interception point (a lower bound; real savings compound over later turns); the status line shows today/cumulative live. **Scope notes (2026-11-18)**: (1) prefetch injection only registers an avoided-read candidate; it is booked once when the read guard later intercepts the same file in the same session (the guard yields to avoid double counting; compressed side = tokens actually injected by prefetch); unproven candidates expire after 7 days and are never booked; (2) per-session amplification depends on host usage feeds: ZCode (db) and Qoder (qoder-usage) are covered, **Cursor has no usage feed and is booked entry-once only, without session amplification** (explicit scope, not a defect); (3) the search original-token denominator deduplicates hit spans by line-range union (overlap lines counted once); (4) output-side savings, routing downshift cost and local-replaces-remote are outside this ledger's scope.
- Model cleanup: starting a session after a model switch unloads the leftovers the previous models had pulled up (only models this tool loaded — chat models you pulled yourself are never touched); after the host closes, a detached watcher unloads every Ollama-resident model and stops the transformers.js resident process, so no keep_alive tail is left behind. Manual cleanup: `node cleanup.mjs --all`.

#### Dynamic model routing (key points)

- Selecting the `auto` virtual model enables it; each turn is tiered R1-R4, with R1 as the sticky base and grace / phase stickiness / a switch-tax gate damping tier changes. Short continuation turns (brief acknowledgments / short instructions) keep the current phase tier instead of splitting a new phase (bounded by maxPhaseTurns).
- Tiering chain: a lexical base tier (L1 semantic classes + brand three-grade table + lightweight-suffix demotion) is rescued by the always-local judge model in two arms (lexical R1 passing the confidence gate goes to R2, a strong R2 signal goes to R3); R4 is never reached by auto-escalation — the only entry is explicitly naming a flagship model. Rates use R3 = 1x as base (R1≈0.05x / R2≈0.5x / R4≈3.6x), with the long-run blended rate measured at ≈0.15x.
- Upstream 429 / quota walls trigger a same-turn chain slide or downgrade; the gate releases by fatigue after 3 consecutive blocks and injects a one-shot compression suggestion while blocking.
- Self-evolution loop: real traffic grows the golden set automatically; every 6h signal weights and thresholds are learned, out-of-fold gate passing auto-promotes to live, and cost regressions inside the observation window auto-roll back.
- Scope, wiring requirements, and the config keys: see the `modelRouting` subsection under "Configuration" below and the configuration section of `部署使用说明.txt`.

### Requirements

- Node.js ≥ 18, and git.
- local: models live in `code-index/hf-cache` (three local models — embedding / reranker via transformers.js, decision via resident Strands ONNX, about 1.5GB). That directory exceeds git's per-file limit and is not in the repository. Missing models are downloaded on first use. When you copy the tool, take the whole directory with you.
  Memory: CPU-only, no GPU required; the three resident models together take about 2-3GB of RAM (~1.5GB weights + ONNX runtime). Embedding threads are capped at `min(4, max(2, cores/4))` by default (`embedCpuThreads`), so slow machines keep some cores free.
- ollama: install and start Ollama yourself, then pull the models by hand. Ollama model weights are not copied with this directory.
  VRAM: with the default `gpu=auto`, the GPU path is taken when **total VRAM ≥ 6GB** (headroom left for the system and other programs), and the three resident models occupy **≈4.5GB** (`OLLAMA_KEEP_ALIVE=24h`, steady, not evicted when idle). Below 6GB or without a discrete GPU, Ollama falls back to CPU — everything still works, but embedding throughput drops markedly.
   Version pin: **Ollama 0.40.15** — measured embedding throughput ~0.83s/chunk; 0.40.16 regressed to 1.17-1.42s/chunk (~1.5x slower), 0.40.7 sits in between with high variance; /v1/systemone decision endpoint is compatible on all three. Re-benchmark with the same protocol (batch 32, free VRAM, 90s double-sampling) before upgrading.


```bash
ollama pull qwen3-embedding:0.6b
ollama pull sam860/qwen3-reranker:0.6b-F16
ollama pull tev1:0.8b
```

If the model names were changed in `code-index/config.mjs`, pull those names instead.

### Usage

`init` installs dependencies, writes config, attaches hooks, and builds and warms the index in the background. Confirm it is ready with `node status.mjs`. A bad flag name, a missing value, or an illegal `--model-in` / `--hooks` value exits with an error and does not change config. `--roots=path` and `--model-in=local` are also accepted.

#### Client install (tray guardian, recommended)

The installer ships with the Release: the online package ≈225MB (three CPU weights are downloaded by the wizard right after install, with mirror fallback) and the full offline package ≈1.48GB (weights bundled, for offline machines). Double-click to install; before first-time setup is finished, double-clicking opens the installer wizard only, and afterwards it opens straight into the tray.

First-time setup runs the five-step wizard: run mode (cpu/gpu) → environment self-check (missing items auto-install: online weight download / ollama pull, with real progress) → data upload (optional; the only consent entry for the decision-pack reciprocity) → wiring (runs `init` automatically: root registration, hooks for all three clients, routing switch) → finish (seamlessly hands over to the tray in the same session).

Afterwards the tray guardian handles day-to-day operation: four status lamps + panel self-check reflect the index and the three local models; "update decision pack" uploads locally signed vectors first, then downloads the public pack; app upgrades go through the tray menu "check for app updates" (differential download + sha512 integrity gate). No command line needed.

Two kinds of data live in fixed locations: (1) vector-index data (chunks / vectors / config / ledgers) in `%LOCALAPPDATA%\TokenSaver\data`; (2) model files in `%USERPROFILE%\.tokensaver\hf-cache` (the three CPU-mode weights, downloaded by the installer/wizard), while gpu-mode models are managed by Ollama itself (default `%USERPROFILE%\.ollama\models`).

![default.jpg](https://raw.gitcode.com/user-images/assets/11189521/99072fb5-0580-4656-a221-c58602df62ec/default.jpg 'default.jpg')

#### Pure CLI (no guardian install)

Data is written to this repo's `data/`, not into the projects being indexed.

Two kinds of data live in fixed locations: (1) vector-index data (chunks / vectors / config / ledgers) in the repo-root `data/`; (2) model files — with `--model-in local` (default) in `code-index/hf-cache` (three models, ~1.5GB, not in git, downloaded on first use), with `--model-in ollama` managed by Ollama itself (default `%USERPROFILE%\.ollama\models`, not copied with the directory).

```bash
git clone https://gitcode.com/dionfang/TokenSaver.git
cd TokenSaver/code-index
node init.mjs --roots "<project-dir-1>,<project-dir-2>"
node status.mjs
node search.mjs keywords --k 5
```

Later, edit `roots` in `data/code-index.config.json` and run `node init.mjs` with no arguments. New directories are indexed, and hooks are attached to those git repositories.

#### Copy into a target project

Copy the `code-index/` directory only. It can sit anywhere in the project; `scripts/code-index` is the suggested path. You must include `hf-cache`. Do not include `node_modules` or `data/`.

Data is written to a `data/` directory beside it (`scripts/data` on the suggested path). If `code-index` is itself the git root, data is written to `data/` inside it. Override the location with `CODE_INDEX_DATA_DIR`.

```bash
cd target-project/scripts/code-index
node init.mjs
node status.mjs
```

If you copied only `code-index/`, [`部署使用说明.txt`](code-index/部署使用说明.txt) in that same directory is the same guide.

### init options

```bash
node init.mjs [--roots "<path1>[,<path2>...]"] [--set-roots "<path1>[,<path2>...]"] [--model-in ollama|local] [--hooks all|cursor|zcode|qoder] [--routing-on]
```

`--roots`: comma-separated directories to scan, written to `data/code-index.config.json`. Forward slashes and backslashes both work.

- Omitted, and no config yet: use the git root of the tool repo.
- Omitted, and config already exists: heal `roots` from the file (keep paths that still exist; guess a missing one once from a sibling directory). Do not add the tool repo itself. Then attach hooks to those git repositories and build the index in the background.
- Passed: merge into the existing `roots` (add, do not drop old entries). Skip paths that do not exist. To remove a directory, replace the whole list with `--set-roots` (empty value clears it), or edit the JSON and run `init` with no arguments.

`--set-roots`: comma-separated directories that **replace the whole list** (opposite of `--roots`, which merges; repeatable; an empty value clears it).

`--hooks`: `all` | `cursor` | `zcode` | `qoder`. Only the selected tool's session hooks are written. Files for the other tools are left as they are. When the flag is omitted, detection follows the two-module compatibility scope under "Overview": the Token Ledger installs on all three clients, dynamic model routing on ZCode and Qoder only.

`--model-in`: `ollama` or `local`. It writes `modelIn` and does not change model names. Omitted on a new config, the path is `local`. Omitted when a config already exists, the current path is kept.

`--routing-on`: explicitly enable the routing-accounting loop (writes `modelRouting.enabled=true`; carried by the wizard's finish step). A manual `false` in an existing config is preserved.

### Configuration

Change model deployment only in `code-index/config.mjs`. The same keys in the data JSON have no effect.

| Key | Default |
|---|---|
| `models.embedding` | `qwen3-embedding:0.6b` |
| `models.reranker` | `sam860/qwen3-reranker:0.6b-F16` |
| `models.localEmbedding` | `Xenova/jina-embeddings-v2-base-zh` |
| `models.localReranker` | `Xenova/bge-reranker-base` |
| `ollamaBase` | `http://localhost:11434` |
| `gpu` | `auto` (also `cpu` or `gpu`; note: num_gpu only applies to embedding/reranker — the decision model (ollama path) silently ignores it and is placed automatically by Ollama) |
| `OLLAMA_KEEP_ALIVE` | `24h` (since 2026-11-14, models stay resident and no longer vanish when idle; steady VRAM footprint ≈4.5GB) |
| `OLLAMA_NUM_CTX` | `4096` |

Project settings live in `data/code-index.config.json`, beside `code-index/`. Keys you omit use the defaults in `config.mjs`.

| Key | Meaning |
|---|---|
| `roots` | Directories to scan. Precedence: `--roots` > `CODE_INDEX_ROOTS` > this file |
| `modelIn` | `ollama` or `local`. Precedence: `--model-in` > this file > `local` |
| `skipDirs` | Directory names to skip. A value replaces the whole list; it does not append. The default already skips dependency, build, and editor directories. A newly generated config also adds `code-index`, `.cursor`, `.zcode`, and `.qoder` |
| `exts` | Extensions to index, without the leading dot |
| `jsonWhitelist` | JSON filenames allowed into the index. Default: `package.json`, `pages.json`, `manifest.json`, `tsconfig.json` |
| `maxFileBytes` | Per-file size cap. Default `819200` |
| `readMaxLines` | Line cap for a full-file Read. Default `500`. A very large value turns the guard off |
| `chunk` | `targetLines` 70, `maxLines` 120, `overlapLines` 10, `minTail` 15 |
| `staleNonGitMs` | How often a non-git directory is rebuilt, in milliseconds. Default `86400000` |
| `embedCpuThreads` | CPU thread cap for local (transformers.js) embedding. Default `min(4, max(2, cores/4))`; `0` = all cores |
| `warmMinIntervalMs` | Minimum interval between self-healing re-pulls after a model is evicted, in milliseconds. Default `60000` (floor 1000) |
| `knownAnnotations` | `"project/relative-path"` → one sentence on what the file does |

#### modelRouting (dynamic model routing config)

The `modelRouting` section of `data/code-index.config.json` is scaffolded by init (`enabled` defaults to `true` — ruling A, 2026-11-20: fresh installs start with routing accounting / sample growth on; a manual false is preserved), and **an existing config is never overwritten**; unlike the two layers above, this section is read only from `data/code-index.config.json`. Common keys:

| Key | Meaning |
|---|---|
| `enabled` | Master switch (default `true` since ruling A, 2026-11-20); gates three things — the per-turn `[model-routing]` tier line, L1 classification (classifyPrompt), and routing-log persistence — all stop when off. Auto traffic is routed the same way regardless (S6-F9, 2026-11-11; aligned with model-routing.md §5) |
| `brandPriority` | Within-tier brand call order of the four-tier chains (default glm,deepseek,qwen,minimax,kimi,grok,claude,gpt,gemini); does not affect tier assignment |
| `modelTiers` | Brand three-grade default table (2026-11-06 v4, adjusted in v4.1): `{normal:[deepseek,glm,qwen,minimax]→R2, mid:[kimi,grok,gemini]→R3, high:[claude,gpt]→R4}`; unrecognized brands fall back to normal. pro/max is not special — tier semantics map one-to-one onto brand grades |
| `lightSuffixes` | Lightweight-version suffixes (default flash,preview,coding,code,coder,turbo,mini,air,nano,event,haiku,luna,lite,base,sol,sonnet): a hit demotes one tier from the brand default (floor R1; flash is always R1) |
| `providerPriority` | Same-name ordering when one model is hosted by several providers; an exhausted quota slides to the next one |
| `providerOrder` | Host UI provider drag order (auto-captured into the snapshot, no manual setup): same-name providers not listed in `providerPriority` follow it, and cooling/quota exhaustion slides through them in UI order; a config key of the same name overrides the snapshot order (Qoder has no drag order; its settings-file key order is captured instead) |
| `retryOnRateLimit` / `maxRetries` | Same-turn model re-selection on runtime 429/5xx/network failure (default true / 2) |
| `maxPhaseTurns` | How many human turns an upgrade phase may last (default 4), then back to the R1 base |
| `switchGuard` | Switch-tax gate `{enabled default true, maxContextTokens default 200000}`; upgrades only; releases by fatigue after 3 consecutive blocks and injects a one-shot compression suggestion while blocking |
| ~~l2~~ | **Recycled (2026-11-14)**: L2 shadow/live fusion votes are **always on** (code constants, config keys no longer read); thresholds (minSim 0.55/minConf 0.6/live 0.3) are calibration-domain defaults, not user-exposed |
| ~~l2Live~~ | Same as above: legacy key no longer read; live L2 fusion vote always on (lexical R1 + kNN multi → rescue R2; R2 + R3 vote → rescue R3, rescue-only) |
| `decisionModel` | The judge model for four-vote auto-signing (localized v4, 2026-11-09: judging is **always local** with zero remote calls — ollama = `models.decision` (tev1:0.8b) / local = `models.localDecision` (resident Strands ONNX q4f16), on the same path as `modelIn`; legacy keys `enabled/model/providers/chunkSize/rRef` are no longer read). Both routing arms and signing thresholds follow the **per-model decision profiles** `profiles` (key = judge backend name; default table: tev1 → arm1 minConf 0.6 / window all-r1, signing 0.4/0.85; strands → 0.5/ambiguous, signing 0.4/0.85; arm2 r3MinConf 0.85; unmatched models fall back to FALLBACK (0.75/ambiguous/0.6/0.9; since S2-F4 on 2026-11-10, arm1 is **shadow-only with live=false** — shadow-logged, never rescues live)). Arm 1 consults lexical-R1 turns per the profile window (tev1 = all R1, strands = confidence ≤0.5), and any judge vote above R1 is always capped at an R2 rescue (one step only — R3 belongs to arm 2, R4 never); arm 2 consults on lexical R2 and rescues to R3 when the judge votes R3 above r3MinConf; judge failure / other votes keep the original tier (fail-open), shadow-logged to `data/usage/r-ref-shadow.jsonl`. If the judge cannot start, decision votes abstain — search and routing are unaffected |
| Dual-axis labels | Every golden-set row carries two orthogonal axes: `semanticType` (multi/routine/light — the L1/L2/decision consensus, "does this ask for a multi-point restructure?") and `intensityType` (heavy/normal/light — the behavior vote, "how heavy was the work actually done?"). Mixing both into one label had pushed multi accuracy to 0.2; split, each axis is scored on its own (`node code-index/modelRoute.mjs --score-golden-dual`). Both axes are machine-consensus weak truth — no external human anchor |
| `manualSwitch` | Human-switch truth channel (decided 2026-11-19) `{enabled default true, live default false, upConf 0.8, downConf 0.5, lateralConf 0.3, agreeMin 0.8}`: only human switch actions are collected (gear/model-name changes between adjacent turns of the same session — static default selections are not), upgrades weighted high and downgrades low; **shadow-first** — with the default live=false it only collects and audits the three-way agreement (human vs raw difficulty parse vs outcome), and live=true writes the human tier into golden evidence as the human anchor for tier truth (ledger `data/routing/manual-switch.jsonl`); the raw difficulty parse is a contrast only, never truth (anti-feedback red line) |
| `tierOptimize` | Self-evolution loop `{enabled, minIntervalMs, folds, minN, priorN, grow, fitCost, dry, allowBoost}`: with enabled=true, every 6h it learns signal weights and thresholds from the golden set, auto-promotes a candidate that passes the out-of-fold gate, and auto-rolls back if cost worsens inside the observation window |
| `blendNotice` | Injection switch for the auto blended-rate line `{enabled default true}`; routing hosts only — injects the "latest session's actual spend ÷ R3-equivalent spend (R3 = 1x base)" multiplier; off = stops the line, accounting continues |
| ~~r3Lexical~~ | **Recycled**: the lexical R3 channel and P2 one-strike speedup are **always on** (code constants, not configurable); the word list itself lives in tierClassify.mjs |

Scope and boundaries: only ZCode/Qoder take part; auto dispatches only custom models wired via the Anthropic Messages protocol; model tiering is derived from the name (brand three grades + lightweight demotion, 2026-11-06 v4, adjusted in v4.1: normal brands deepseek/glm/qwen/minimax→R2, mid-grade kimi/grok/gemini→R3, high-grade claude/gpt→R4; lightweight suffixes (flash/preview/turbo/mini/haiku/sonnet/sol etc.) demote one tier from the brand default and flash is always R1; unrecognized brands fall back to the normal grade. Both tables live in `modelRouting.modelTiers` / `lightSuffixes` and re-derive the whole chain from config). Wiring steps and config keys live in [`部署使用说明.txt`](code-index/部署使用说明.txt), configuration section.

### Repository layout

Runtime scripts are maintained only in `code-index/`. The npm publish channel was retired (2026-11-17); npm installation is no longer offered.

| Directory | Role |
|---|---|
| [`code-index/`](code-index/) | Runtime. This is what you deploy directly, run in this repo, or copy into a target project |

### License

MIT.
