/**
 * L1 规则分类器(model-routing.md #9 Step①):prompt → T1-T8 任务类型。
 * 主消费方=本地代理改写决策(modelRouteProxy.mjs decideTarget,主会话每 turn);
 * 次消费方=[model-routing] 注入建议行 + 路由日志(data/usage/routing-log.jsonl)+ MCP routing_decision。
 * 客户端侧不做主循环切换(#6 否决)——切换全部发生在代理内(角色子代理形态已废弃 2026-11-01)。
 * 语义三类(2026-11-06 三档定稿,旧 T1-T8 按路由后果折叠):multi=多点改组(旧 T4/T5,建议档 R2)、
 * routine=例行工作(旧 T2/T3/T6/T7)、light=询问杂务(旧 T1/T8)——旧八类里六个共享同一路由后果,
 * 细分只制造歧义(黄金集最大类一致率仅 0.6)。规则顺序即决策树(第 0 步显式指令 /review→routine、
 * /plan→multi,其后 multi→报错→编辑→审查→方案→测试→杂务→提问),命中即返回;
 * 全落空=uncertain(sticky 不切换)。旧类型值经 normalizeType 兼容读(日志/黄金集/向量库历史数据)。
 *
 * 信号提取四层(2026-11-03 词表强化):
 *   ① 引用剥离 stripCitations:代码围栏/行内码/成对引号内文字不参与匹配;
 *   ② 否定过滤 negatedBefore:"不要重构/没报错/don't refactor"不当作正向信号(只认紧邻前缀否定,
 *      单字否定只认 不/没/未/无——"区别/级别"这类以"别"结尾的普通词不误伤);
 *   ③ 形态信号 ERROR_SHAPE_RE:堆栈帧(at x:12:3)/异常类名/常见 errno 等"贴报错"形态,不依赖中文词;
 *   ④ 多命中加权:同类信号命中越多置信越高(封顶 0.95),单命中维持原值——代理 0.7 升档门槛的
 *      边界行为不变(单命中 T3/T5/T6/T7/T8 仍恰为 0.7)。
 * 规则名(R-T*)保持稳定:calibrateSignals.RULE_CLAIM 按名字统计规则精确率,改名=统计漂移(unclaimed)。
 * 纯函数,text/dataDir 可注入以便测试密闭;调用方 try/catch 兜底,分类失败不影响注入。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './config.mjs';

const self = fileURLToPath(import.meta.url);

// ---------- 信号词表(中英双语;命中与否决定类型,命中个数决定置信) ----------

/** 范围词:与重构动词双条件构成 T4 最强信号。 */
const SCOPE_WORDS = ['所有', '全部', '每个', '统一', '整体', '批量', '全站', '全项目', '整个', '全局', '跨模块', '多个文件', '全量', '一套', '一整套', '每一处', '每处', '逐个', '逐文件', '各处', '全部文件', '所有文件', '全都', '通通', '统统', '一并', 'all ', 'every ', 'entire ', 'whole ', 'project-wide', 'across the project', 'every single'];
/** 重构/迁移动词(T4)。 */
const REFACTOR_VERBS = ['重构', '迁移', '改造', '抽离', '拆分', '重写', '梳理', '治理', '翻新', '整改', '批量替换', '全局替换', '整合', '合并', '抽取', '提取', '抽象', '封装', '下沉', '规整', '组件化', '模块化', '去重', '复用', '搬移', '换库', '换框架', '改写', '重做', 'refactor', 'migrate', 'rewrite', 'restructure', 'overhaul', 'port to', 'consolidate', 'deduplicate', 'extract out', 'modularize', 'decouple', 'unify'];
/** 改动动词(T3;单点实现/修复/补齐)。注意:不收"更新/写"等与 T8 撞车的泛词。 */
const EDIT_VERBS = ['添加', '新增', '增加', '修改', '改成', '改为', '替换', '删除', '去掉', '去除', '换成', '调整', '接入', '联调', '补上', '加个', '加上', '支持一下', '实现一下', '实现', '修复', '修复一下', '开发', '编写', '写一个', '写个', '补充', '扩展', '完善', '修改一下', '修改下', '修一下', '修复下', '改一下', '改下', '加一下', '补充一下', '完善一下', '实现下', '优化', '优化一下', '新建', '调试', '调一下', '配置一下', '设置一下', '封装一下', '搞定', '写一下', '写下', '整一个', '搭一个', '弄一下', '搞一下', '调优', '挂载', '拉起', '定义为', 'implement', 'add support for', 'fix', 'create', 'debug', 'remove', 'delete'];
/** 报错/异常信号(T2;初诊入口)。 */
const ERROR_SIGNS = ['报错', '不生效', '没反应', '无响应', '异常', '崩了', '崩溃', '白屏', '挂了', '起不来', '卡死', '卡住了', '启动失败', '构建失败', '编译失败', '安装失败', '加载失败', '上传失败', '保存失败', '连不上', '断连', '调用失败', '请求失败', '接口报错', '跑不起来', '失败', 'failed', 'fail', '出错', '出错了', '报了个错', '错误信息', '错误码', '失效', '失灵', '无法启动', '无法运行', '无法访问', '无法加载', '无法保存', '用不了', '打不开', '进不去', '闪退', '卡顿', '响应慢', '反应迟钝', '超时', 'timeout', '找不到', 'not found', '不见了', '数据没了', '丢失', '错误', '不对', '不对劲', '不正常', '出毛病', '没生效', '不工作', '异常退出', 'Uncaught', 'Unhandled', 'Fatal', 'Segmentation fault', 'core dumped', 'OOM', 'out of memory', '内存溢出', '死锁', '空指针', '越界', 'not working', 'broken', 'stuck', 'crashed', 'hang', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'Exception', 'Traceback', 'stack trace', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'];
/** 审查/评审信号(T6;"找问题"语义,区别于动手改)。 */
const REVIEW_SIGNS = ['review', '审查', '评审', '检查代码', '代码检查', '找问题', '有没有问题', '什么问题', '隐患', '缺陷', '漏洞', '安全漏洞', '找bug', '找 bug', '挑错', '把关', '潜在问题', '风险点', '安全审查', 'code review', '复查', '复核', '审计', '检视', '巡检', '排查', '诊断', '再看一遍', '重新审视', '走查', '对照检查', '安全审计', 'audit', 'security audit', '查一下', '查下', '检查下', '核对', '看看有没有', '看下有没有'];
/** 方案/规划信号(T5;深权衡语义)。 */
const PLAN_SIGNS = ['方案', '选型', '可行性', '排期', '规划', '技术设计', '架构设计', '怎么设计', '如何设计', '设计方案', '出个计划', '出方案', '方案对比', '技术选型', '需求拆解', '任务拆解', '里程碑', 'roadmap', '调研一下', '计划', '计划一下', '设计一下', '整体设计', '详细设计', '概要设计', '系统设计', '方案设计', '怎么做', '从零搭建', '从零搭', '实施计划', '推进计划', '落地步骤', '盘一下', '想想', '思考一下', 'proposal', 'blueprint', 'design', 'architecture', 'how should', 'approach'];
/** 测试信号(T7)。 */
const TEST_SIGNS = ['测试', '写测试', '单测', '单元测试', '测试用例', '测试代码', '覆盖率', '回归测试', '跑测试', '测试不过', '修复测试', '集成测试', '冒烟测试', '自动化测试', '测试脚本', '压测', '自测', '性能测试', '接口测试', '端到端测试', '端到端', '对拍', '基准测试', '验证', '验证一下', '测一下', '测试一下', 'e2e', 'test case', 'unit test', 'end-to-end', 'benchmark'];
/** 测试类里本身就表示"动手写/跑"的短语(验证式问句不算)。 */
const TEST_WRITING_PHRASES = ['写测试', '写一个测试', '写个测试', '编写测试', '单测', '单元测试', '测试用例', '测试代码', '覆盖率', '回归测试', '跑测试', '修复测试', '集成测试', '冒烟测试', '自动化测试', '测试脚本', '压测', '自测', '性能测试', '接口测试', '端到端测试', '端到端', '对拍', '基准测试', '验证一下', '测一下', '测试一下', 'e2e', 'test case', 'unit test', 'end-to-end', 'benchmark'];
/** 文档/chore 信号(T8)。 */
const CHORE_SIGNS = ['提交代码', 'commit', 'readme', 'changelog', '更新文档', '写文档', '翻译', '国际化', 'i18n', '格式化', '代码格式化', '升级依赖', '依赖升级', 'npm install', 'pnpm add', '提交信息', 'commit message', '发版', '发布版本', '发布说明', '更新说明', '写注释', '加注释', '补注释', '更新注释', '打tag', '打 tag', 'license', 'release notes', '提交', 'push', 'pull', '提个 pr', '提pr', '开个 pr', 'gitignore'];
/** 纯提问信号(T1)。 */
const QUESTION_SIGNS = ['是什么', '什么意思', '为什么', '是因为', '怎么用', '如何使用', '有什么区别', '区别是什么', '在哪', '在哪里', '介绍一下', '讲解', '说明一下', '会不会', '能不能', '是否支持', '有哪些', '举个例子', '解释一下', '啥意思', '意思是', '为什么会', '怎么实现', '如何实现', '怎么写', '如何写', '怎么解决', '如何解决', '怎么办', '怎么弄', '如何处理', '如何做', '怎么处理', '怎么搞', '是不是', '可否', '能否', '需要吗', '要不要', '行不行', '行吗', '可以吗', '有用吗', '好不好', '靠谱吗', '告诉我', '讲讲', '讲下', '说下', '说说', '是吗', '对吗', '支持吗', '区别', 'what is', 'how to', 'how do', 'how does', 'how is', 'difference', 'explain', 'why is', 'why does', 'what does', 'can i', 'should i', 'is it possible', 'how can', 'how about', 'what about'];

/** 词表导出(l1Optimize 学倍率/测试用;决策树内部仍用上面的私有常量,口径一致)。 */
export const L1_LEXICON = {
  scope: SCOPE_WORDS,
  refactor: REFACTOR_VERBS,
  edit: EDIT_VERBS,
  error: ERROR_SIGNS,
  review: REVIEW_SIGNS,
  plan: PLAN_SIGNS,
  test: TEST_SIGNS,
  chore: CHORE_SIGNS,
  question: QUESTION_SIGNS,
};

/** 语义三类值域(2026-11-06 三档定稿):multi=多点改组、routine=例行工作、light=询问杂务。 */
export const L1_TYPES = ['multi', 'routine', 'light'];
/** 旧 T1-T8 → 新三类(历史日志/黄金集旧标签/向量库旧 label 的兼容读;只读归一,不回写历史)。 */
export const LEGACY_TYPE_MAP = { T1: 'light', T2: 'routine', T3: 'routine', T4: 'multi', T5: 'multi', T6: 'routine', T7: 'routine', T8: 'light' };
/** 类型归一:旧八类值折叠为新三类;新值/未知值原样返回。 */
export function normalizeType(t) { return LEGACY_TYPE_MAP[t] || t; }

/** 疑问/征询形态(2026-11-06 multi 标签翻案判据):有疑问结构(疑问词)+ 无祈使前缀
 *  + 无实改组锚(范围×重构 / 清剿式修复/结构性移除合成证据 / 强方案名词)⇒ 这条话是"问"不是"做"。
 *  消费方=autoExemplars.reviewGolden 的 multi 一票否决(行为票会把会话级工作强度漏进单轮标签)。
 *  纯函数;与决策树共享词表与合成证据,口径一致。 */
export function isInquiryShape(text) {
  const low = stripCitations(text).toLowerCase();
  const verify = hitsOf(low, VERIFY_WORDS);
  if (!verify.length) return false;
  if (hitsOf(low, IMPERATIVE_WORDS).length) return false;
  if (T4_FIXALL_RE.test(low) || T4_REMOVE_RE.test(low)) return false;
  const scope = hitsOf(low, SCOPE_WORDS);
  const refactor = hitsOf(low, REFACTOR_VERBS);
  if (scope.length && refactor.length) return false;
  const strongPlan = hitsOf(low, PLAN_SIGNS).filter((w) => !PLAN_TASKLESS.has(w));
  if (strongPlan.length) return false;
  return true;
}

/** 报错"形态"信号:堆栈帧/异常类名/errno/panic——粘贴报错文本时常不含中文信号词。 */
const ERROR_SHAPE_RE = /\b(TypeError|ReferenceError|SyntaxError|RangeError|NullPointerException|ParseException)\b|\bTraceback \(most recent call last\)|\bat .+:\d+:\d+|\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EACCES|EPERM|EPIPE)\b|\bError:\s|\bpanic:\s|\bException in thread/;

/** T4 合成证据(2026-11-06 T4 专项):词表子串覆盖不了的两类多点改组形态——
 *  ①清剿式修复:对成批问题的一次性清剿(修复所有X/逐条修复);②结构性移除:取消/删除某个模式/层/模块级机制。
 *  两者本意即"多点结构改动",命中以合成词并入 refactor 通道(权重同单词);疑问形态由 T4 分支守卫拦。 */
const T4_FIXALL_RE = /(?:修复|整改|解决)[^。{}]{0,6}(?:所有|全部)|(?:所有|全部|这些|以下)[^。{}]{0,10}(?:问题|错误|隐患|缺陷|报错)[^。{}]{0,10}(?:修复|整改|解决)|(?:逐条|逐个)[^。]{0,4}(?:修复|整改|解决)/;
const T4_REMOVE_RE = /(?:取消|移除|删除|下线|废除|砍掉|剥除|摘除)[^。]{0,12}(?:模式|层|模块|机制|架构|分支|链路)|(?:模式|层|模块|机制|架构|分支|链路)[^。]{0,6}(?:彻底)?(?:取消|移除|废除|下线|砍掉)/;

/** 元提问标记(2026-11-01):讨论"路由/分类/词表/判定"本身的 prompt,词法上含"测试/重构"但并非实现任务。
 *  只认强标记(不把"代理"这类工作常见词算进来,避免把正常任务误杀);配合疑问结构才判元提问。 */
export const META_MARKERS = ['路由', '分类器', '分类规则', '词表', '信号词', 'sticky', '置信', 'modelrouting', 'routing', 'routing-log', 'routing-shadow', '模型路由', '路由规则', '分档', '难度档'];
/** 疑问/征询结构:出现即视为"在问",不是"在做"。 */
const VERIFY_WORDS = ['吗', '呢', '是否', '是不是', '能不能', '会不会', '怎么样', '怎么', '怎样', '如何', '为什么', '什么', '多少', '要不要', '需不需要', '可否', '能否', '行不行', '行吗', '可以吗', '对吗', '是吗'];
/** 祈使前缀:有它说明用户确实在下任务,T4 等动作类判定不受疑问词压制。 */
const IMPERATIVE_WORDS = ['帮我', '帮忙', '请', '麻烦', '给我', '替我', '你帮我'];
/** 动作动词:区分"写测试"与"测试某现象"。 */
const ACTION_VERBS = ['写', '编写', '补', '跑', '执行', '生成', '增加', '加', '修复', '改', '覆盖', '实现', '重构', '迁移', '删除', '替换', '合并', '跑一下', '执行一下', '搭'];

// ---------- 否定过滤:紧邻前缀是否定 ⇒ 该命中不作数 ----------

/** 中文否定:单字 不/没/未/无(不收"别/非"——"区别/级别"这类同字结尾的普通词会误伤)+
 *  紧邻否定 无需/先不/暂不/不再/不要/没有/不需/不用/不必/不需要(2026-11-03 补:原实现漏判"不要X/没有X/
 *  不需要X"——窗口≤3字锚尾,双字否定以第二字结尾,旧正则只认以否定字结尾的形态)。 */
const NEG_ZH_RE = /(?:无需|先不|暂不|不再|不要|没有|不需|不用|不必|不需要|[不没未无])$/;
/** 英文否定要求词边界(防 cannot 的 not 子串误匹配)。 */
const NEG_EN_RE = /(?:^|\s)(?:don'?t|do not|no need|without|avoid|never|not)\s*$/i;

/** 命中位置紧前方(≤3 字中文窗 / ≤14 字符英文窗)是否为否定前缀。 */
function negatedBefore(lowText, idx) {
  if (NEG_ZH_RE.test(lowText.slice(Math.max(0, idx - 3), idx))) return true;
  return NEG_EN_RE.test(lowText.slice(Math.max(0, idx - 14), idx));
}

/** 否定感知命中:每个词只计首次出现;紧邻否定前缀的命中丢弃("没报错"不再是报错)。
 *  导出给 tierClassify 复用(难度定档与 L1 同口径,防"不要重构"误升档花钱)。 */
export function hitsOf(low, words) {
  const out = [];
  for (const w of words) {
    const i = low.indexOf(String(w).toLowerCase());
    if (i < 0) continue;
    if (negatedBefore(low, i)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** 多命中加权:base + 每多 1 个命中加 step,至多 extra 步,封顶 0.95;保留两位小数。 */
function confOf(base, n, { step = 0.05, extra = 2, cap = 0.95 } = {}) {
  const c = base + Math.max(0, Math.min(n - 1, extra)) * step;
  return Math.round(Math.min(c, cap) * 100) / 100;
}

/**
 * 引用内容不参与路由信号匹配(#9 引用误触发防线)。
 * 实测复现:澄清式提问里引用了含"重构/迁移/批量"字样的他人文本,被误判 T4 并进入代理改写路径。
 * 只剥成对符号(代码围栏/行内码/中文引号/ASCII 双引号),不剥单引号——英文缩写 don't/it's 会跨词误删。
 */
export function stripCitations(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, ' ');
}

/** 主入口:返回 {type,confidence,rule,signals} 或 null(uncertain)。prompt 为空/过短返回 null。
 *  先按词级倍率档案(l1-weights.json,默认 disabled)做类别激活门控,再按校准档案缩放置信度。
 *  词级倍率只影响"该类别是否被激活"(Σ权重≥threshold),不影响命中数→置信度的换算。 */
export function classifyPrompt(prompt) {
  return applyCalibration(classifyRules(prompt, { weights: loadL1Weights() }), loadCalibration());
}

/** 词级倍率档案(l1Optimize.mjs 产出,2026-11-04):{enabled, threshold, weights:{array:{word:倍率}}}。
 *  与校准档案同模式:mtime 缓存 + enabled 门控;缺档/未启用一律 null = 纯词表工作。 */
let _l1wCache = new Map();
export function loadL1Weights(file = path.join(DATA_DIR, 'routing', 'l1-weights.json')) {
  try {
    const st = fs.statSync(file);
    const hit = _l1wCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = raw && raw.enabled === true && raw.weights && typeof raw.weights === 'object'
      ? { threshold: Number(raw.threshold) > 0 ? Number(raw.threshold) : 1, weights: raw.weights }
      : null;
    _l1wCache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch { return null; }
}

/** 类别激活判定:命中词权重之和 ≥ threshold(默认 1=任意一个词全权命中)。无档案时退化为"有命中"。 */
function act(hits, arrName, weights) {
  if (!hits.length) return false;
  const map = weights && weights.weights && weights.weights[arrName];
  if (!map) return true;
  let sum = 0;
  for (const w of hits) sum += Number(map[w]) > 0 ? Number(map[w]) : 1;
  return sum >= (weights.threshold || 1);
}

/** 未校准未加权的原始规则判定:calibrateSignals 用它统计规则精确率,l1Optimize 以它为拟合基线。 */
export function classifyPromptRaw(prompt) {
  return classifyRules(prompt);
}

/** 规则判定主体。opts.weights 非 null 时,各类别激活走词级加权门控(见 act);为 null 时纯词表。 */
export function classifyRules(prompt, opts = {}) {
  const { weights = null } = opts || {};
  const text = String(prompt || '');
  if (text.trim().length < 6) return null;
  const scan = stripCitations(text);
  if (scan.trim().length < 6) return null;
  const low = scan.toLowerCase();
  const scope = hitsOf(low, SCOPE_WORDS);
  const refactor = hitsOf(low, REFACTOR_VERBS);
  // T4 合成证据(2026-11-06 专项):清剿式修复/结构性移除形态 → 等价一条重构证据
  const refSynthetic = [];
  if (T4_FIXALL_RE.test(low)) refSynthetic.push('清剿式修复');
  if (T4_REMOVE_RE.test(low)) refSynthetic.push('结构性移除');
  const refAny = refactor.concat(refSynthetic);
  const edit = hitsOf(low, EDIT_VERBS);
  const error = hitsOf(low, ERROR_SIGNS);
  const errShape = ERROR_SHAPE_RE.test(scan); // 形态信号算一个报错证据(与词表命中合并计数)
  const review = hitsOf(low, REVIEW_SIGNS);
  const plan = hitsOf(low, PLAN_SIGNS);
  const test = hitsOf(low, TEST_SIGNS);
  const chore = hitsOf(low, CHORE_SIGNS);
  const question = hitsOf(low, QUESTION_SIGNS);
  const verify = hitsOf(low, VERIFY_WORDS);
  const imperative = hitsOf(low, IMPERATIVE_WORDS);
  const meta = hitsOf(low, META_MARKERS);

  // 元提问硬负样本:讨论路由/分类本身 + 疑问结构 → 不判类(sticky),否则会被词法误判成 T4/T7
  if (meta.length && verify.length) return null;

  // 第 0 步:显式指令(#5 决策树)——/review→T6、/plan→T5,指令形态高精度,置信给满
  if (/^\s*\/\s*review\b/i.test(scan)) return { type: 'routine', confidence: 0.9, rule: 'R-routine审查信号', signals: ['/review'] };
  if (/^\s*\/\s*plan\b/i.test(scan)) return { type: 'multi', confidence: 0.9, rule: 'R-multi方案信号', signals: ['/plan'] };

  // T4:范围词+重构/迁移动词(双条件,最强信号);2026-11-06 T4 专项扩两条入口——
  //   ①合成证据单独命中(清剿式修复/结构性移除);②重构动词+祈使前缀("帮我重构X",无范围词也是多点改组)。
  // "…是否可行/怎么做"这类征询不是执行任务(疑问词且无祈使 → null;元提问门控在其上,不受影响)。
  const t4Scope = act(scope, 'scope', weights) && act(refAny, 'refactor', weights);
  const t4Hit = refSynthetic.length > 0 || t4Scope || (refAny.length > 0 && imperative.length > 0);
  if (t4Hit) {
    if (verify.length && !imperative.length) return null;
    return {
      type: 'multi', confidence: confOf(0.8, Math.max(scope.length, refAny.length)),
      rule: t4Scope ? 'R-multi范围+重构' : 'R-multi重构+祈使',
      signals: [...scope.slice(0, 2), ...refAny.slice(0, 2)],
    };
  }
  // T2:报错/异常信号(词表或堆栈形态);"没报错/不报错"已被否定过滤排除
  if (act(error, 'error', weights) || errShape) {
    return {
      type: 'routine', confidence: confOf(0.8, error.length + (errShape ? 1 : 0)), rule: 'R-routine报错信号',
      signals: error.slice(0, 3),
    };
  }
  // T3:改动动词,且不是提问/报错上下文;"修复测试/写个测试"让位给 T7
  const testWriting = hitsOf(low, TEST_WRITING_PHRASES);
  if (act(edit, 'edit', weights) && !act(question, 'question', weights) && !testWriting.length) {
    return {
      type: 'routine', confidence: confOf(0.7, edit.length, { step: 0.04, cap: 0.78 }), rule: 'R-routine编辑动词',
      signals: edit.slice(0, 3),
    };
  }
  // T6:审查信号,且无改动动词(否则是"改完帮我查"→实现为主)
  if (act(review, 'review', weights) && !act(edit, 'edit', weights)) {
    return {
      type: 'routine', confidence: confOf(0.7, review.length), rule: 'R-routine审查信号',
      signals: review.slice(0, 3),
    };
  }
  // T5:方案/规划
  // multi(旧 T5):方案/规划=深权衡的重活。疑问守卫只拦"纯征询"('这个怎么做'这类空想词,无实方案名词);
  // 有实方案名词('出一版详细设计,怎么做才稳妥')即任务,不拦。
  const PLAN_TASKLESS = new Set(['怎么做', '如何做', '想想', '思考一下', '盘一下']);
  if (act(plan, 'plan', weights)) {
    const strongPlan = plan.filter((w) => !PLAN_TASKLESS.has(w));
    if (verify.length && !imperative.length && !strongPlan.length) return null;
    return {
      type: 'multi', confidence: confOf(0.7, plan.length), rule: 'R-multi方案信号',
      signals: plan.slice(0, 3),
    };
  }
  // T7:测试——"写/跑测试"或"测试某对象"算;但"测试…是否/吗"这类验证式问句不算
  if (act(test, 'test', weights)) {
    if (testWriting.length || !verify.length) {
      const action = hitsOf(low, ACTION_VERBS);
      const signals = [...new Set([...test.slice(0, 2), ...(testWriting.length ? testWriting.slice(0, 1) : action.slice(0, 1))])];
      return { type: 'routine', confidence: testWriting.length ? 0.75 : 0.7, rule: 'R-routine测试信号', signals };
    }
  }
  // T8:文档/chore
  if (act(chore, 'chore', weights)) {
    return {
      type: 'light', confidence: confOf(0.7, chore.length), rule: 'R-light杂务信号',
      signals: chore.slice(0, 3),
    };
  }
  // T1:纯提问
  if (act(question, 'question', weights)) {
    return {
      type: 'light', confidence: confOf(0.7, question.length), rule: 'R-light提问信号',
      signals: question.slice(0, 3),
    };
  }
  return null; // uncertain → sticky 保持,不注入建议
}

// ---------- 置信度自校准(结果形态驱动,2026-11-01) ----------
// 档案由 calibrateSignals.mjs 从 db.sqlite 的真实 turn 形态统计生成(样本只取人类交互轮次):
// 每条规则的置信度乘以"该规则判对的比例"(向基线收缩、只降不升、样本不足不生效)。
// 于是"用户怎么说话"会自然改变规则权重,无需人工逐条判定;但权重生效要人工 --enable,档案缺失/损坏一律按原规则工作。

let _calibCache = new Map(); // 按路径分别缓存(测试注入临时目录时不能串到真实档案)

/** 读取校准档案(mtime 缓存,失败或档案未人工启用返回 null → 不校准)。 */
export function loadCalibration(file = path.join(DATA_DIR, 'routing', 'calibration.json')) {
  try {
    const st = fs.statSync(file);
    const hit = _calibCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = raw && raw.enabled === true ? raw : null; // 默认关闭:档案必须由人工 --enable 才会被消费(#11 门控)
    _calibCache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch { return null; }
}

/**
 * 按校准档案缩放置信度(纯函数):multiplier ∈ [0.4, 1],只降不升。
 * 缩放后低于调用方阈值(如代理的 0.7)即等于自动"停用"该规则——这就是内驱优化的落点。
 * 档案必须显式 enabled===true(由 --enable 或人工写),否则一字不改。
 */
export function applyCalibration(classification, calib) {
  if (!classification || !calib || calib.enabled !== true) return classification;
  const rule = calib.rules && calib.rules[classification.rule];
  const m = Number(rule && rule.multiplier);
  if (!Number.isFinite(m) || m <= 0 || m > 1) return classification;
  const confidence = Math.round(Math.max(0, Math.min(1, classification.confidence * m)) * 100) / 100;
  return { ...classification, confidence, baseConfidence: classification.confidence, calibration: { n: rule.n, multiplier: m } };
}

/** 路由门控(#11):只有配置显式 enabled===true 才启用。 */
export function routingEnabled(cfg) {
  return !!(cfg && cfg.modelRouting && cfg.modelRouting.enabled === true);
}

/** [model-routing] 注入行(对齐代理主路由):只报告判定,不引导派发。
 *  diff 为独立难度定档(tierClassify.classifyDifficulty 的结果)时,前缀渲染「难度=R3(0.72)」;
 *  opts.tierLive=true 表示代理四档实弹(难度档真的驱动选模),去掉 [影子] 标记;
 *  默认 false=影子口径(仅测试用)。省略 diff 则与旧行完全一致(向后兼容)。 */
export function routingContextLine(c, diff, { tierLive = false } = {}) {
  if (!c || !c.type) return null;
  // multi(多点改组)是"按难度升档",不是钉死 R3:实际落 R2 还是 R3 由 tierClassify 的难度档决定,切换税门控还可能抑制
  const suggest = c.type === 'multi'
    ? '建议:代理本轮按难度升档(难度档为准)并阶段粘住'
    : '模型由本地代理按 turn 路由(sticky)';
  const tierPart = diff && diff.tier
    ? `难度=${diff.tier}(${Number(diff.confidence).toFixed(2)})${tierLive ? '' : '[影子]'} `
    : '';
  return `[model-routing] ${tierPart}type=${c.type}(${Number(c.confidence).toFixed(2)}) rule=${c.rule} signals=[${(c.signals || []).join(',')}] ${suggest}`;
}

/** 影子分类(model-routing.md #9 Step③):L1 uncertain 时派发 modelRoute.mjs 影子子进程
 *  跑级联,结果只写 routing-shadow.jsonl(不影响注入,零延迟)。级联为 L1→L2(L3 远端兜底已取消):
 *  L2 要 modelRouting.l2Shadow=true 才通电(影子子进程加载嵌入模型会与主会话争资源)。
 *  dataDir 与向量判定同源:测试注入临时目录时无向量文件,自然不派发。 */
export function spawnShadow(prompt, { dataDir = DATA_DIR } = {}) {
  try {
    if (String(prompt || '').trim().length < 6) return false; // 空/超短 prompt 必弃权,不白起子进程(实测影子日志里有 promptHead 为空的行)
    if (!fs.existsSync(path.join(dataDir, 'routing', 'exemplars-vectors.json'))) return false;
    const cli = path.join(path.dirname(self), 'modelRoute.mjs');
    const child = spawn(process.execPath, [cli, '--shadow-async', '--prompt', Buffer.from(String(prompt || ''), 'utf8').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch { return false; }
}

/** 路由日志:追加 data/usage/routing-log.jsonl(prompt 只留前 200 字)。失败静默。 */
export function logRouting({ dataDir = DATA_DIR, prompt = '', classification = null } = {}) {
  try {
    const rec = {
      ts: Date.now(),
      promptHead: String(prompt || '').slice(0, 200),
      type: classification?.type ?? null,
      confidence: classification?.confidence ?? 0,
      rule: classification?.rule ?? null,
      signals: classification?.signals ?? [],
    };
    const file = path.join(dataDir, 'usage', 'routing-log.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    // 影子只在 L1 uncertain 时派发(L1 已决策的 prompt 无需级联对比,减半子进程churn)
    if (!classification?.type) spawnShadow(prompt, { dataDir });
    return true;
  } catch { return false; }
}
