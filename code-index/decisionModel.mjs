/**
 * 决策模型接入(decision-model-preview,千问 Token Plan)。
 *
 * 为什么它适合我们的自动代签(2026-11-02 实测):
 *   - 端点:**专属路径** `POST {host}/compatible-mode/v1/systemone`——不是 chat/completions、不是
 *     anthropic messages。此前三次探测全败(404/400 "url error")正是路径用错,不是没开通;
 *   - 鉴权:与现有 Token Plan key 相同(文档要求 `sk-sp-` 前缀 = 个人版;团队版不支持);
 *   - 结构化:直接给 `choice` / `probabilities`(各选项概率,和为 1)/ `confidence`(0..1),
 *     不生成自然语言、无代码围栏 ⇒ 不需要正则解析;
 *   - 批量:一次请求可并行判定 N 条(state 里放 N 项 + questions 里放 N 题)——
 *     实测 3 条 3 题一次请求 54.8ms / 396 input tokens,代签上百条只需 1~2 次请求;
 *   - 置信度可直接做阈值(替代"≥2 票"这种硬规则)。
 *
 * 定位:它是**判定 API,不是可选择的对话模型**——不会出现在模型选择器里,只能由脚本调用。
 * **2026-11-03 用户定档:三投票+一加权**——三票=L1/L2/行为形态;本模型是加权方(autoSignGolden:
 *   开关生效∧断路器未开时按置信加权计票,可影响代签结果,单票永不独签);另有独立复核 CLI
 *   `--review-golden`(对黄金集已签条目只出报告,不改量尺)。
 *   配置开关 `modelRouting.decisionModel.enabled`(默认 false);**断路器**——失败即跳闸
 *     (data/routing/decision-model-breaker.json),之后零网关尝试;恢复=人工 `--probe` 探活成功,
 *     或**下次会话开始自动探活成功**(SessionStart 挂载,仅断路器开着才打网关,2026-11-03)。
 * **模型名与供应商可配(2026-11-03)**:data/code-index.config.json →
 *   `modelRouting.decisionModel.model`(空=内置 decision-model-preview)、
 *   `modelRouting.decisionModel.providers`=[{baseUrl,apiKey,path?}](配了就只走这些;path=专属端点
 *   路径,空=内置 /compatible-mode/v1/systemone;空数组/全空模板条目/未配=自动收集客户端带 key 的供应商)。
 *   换判定模型/换网关只改这两处,不用动代码。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const HOME = os.homedir();
export const DECISION_MODEL = 'decision-model-preview';
export const SYSTEMONE_PATH = '/compatible-mode/v1/systemone';
/** 单请求最多 16 道题(实测:questions 超过 16 直接 ValidationError)。超过就分片。 */
export const MAX_QUESTIONS = 16;
const PROVIDER_CONFIG = path.join(HOME, '.zcode', 'v2', 'provider_config.json');

/** 八个任务类型的判据(与 modelRoute.mjs 的 TYPE_DEFS 同口径,措辞面向判定模型)。 */
export const TYPE_CRITERIA = {
  T1: '纯提问/解释/咨询,不改任何文件',
  T2: '缺陷诊断:排查报错、异常、失效、不生效',
  T3: '局部实现:在单点/少量文件上做具体改动',
  T4: '重构/迁移/批量改造:跨模块或全项目范围的改动',
  T5: '方案与规划:设计、选型、排期、技术方案',
  T6: '代码审查:找问题、找隐患、评审',
  T7: '写测试:单测、测试用例、覆盖率',
  T8: '文档与杂务:提交代码、写文档、升级依赖、格式化',
};

/** 决策模型名:配置 modelRouting.decisionModel.model 非空才认,缺省回内置 DECISION_MODEL。 */
export function resolveDecisionModel(cfg = null) {
  const c = cfg || readCfg(DATA_DIR);
  const m = String((c && c.modelRouting && c.modelRouting.decisionModel && c.modelRouting.decisionModel.model) || '').trim();
  return m || DECISION_MODEL;
}

/**
 * 判定分片大小(2026-11-03 实测定档):配置 modelRouting.decisionModel.chunkSize(1..16)优先。
 * 16 题/请求的批量会把判定置信稀释到阈值以下(黄金集复核 97% 弃权、chunk=1 时一致率 74%)——
 * 默认配置播种为 1(单题/请求,覆盖与置信最佳);要省请求数可按量调大,上限 MAX_QUESTIONS(API 硬限)。
 */
export function decisionChunkSize(cfg = null) {
  const c = cfg || readCfg(DATA_DIR);
  const n = Math.floor(Number(c && c.modelRouting && c.modelRouting.decisionModel && c.modelRouting.decisionModel.chunkSize));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_QUESTIONS) : MAX_QUESTIONS;
}

/**
 * 配置显式供应商(2026-11-03):modelRouting.decisionModel.providers = [{baseUrl, apiKey, path?}]。
 * path=专属端点路径(空=内置 /compatible-mode/v1/systemone);providerId 可选(缺省自动编号 config-N,仅用于日志/去重)。
 * 返回 null = 未配置(空数组/全空模板条目/键缺失)→ 走自动收集;返回数组 = 有真实条目,**只走配置**——
 * 真实条目缺 baseUrl/apiKey 会被丢弃,全被丢弃时得空数组 ⇒ 上游报"没有可用供应商"(显式配置错误不静默回落);
 * 全空模板条目({"baseUrl":"","apiKey":"","path":""})是配置里的占位示例,视同未配置。
 */
export function configProviders(cfg = null) {
  const c = cfg || readCfg(DATA_DIR);
  const list = c && c.modelRouting && c.modelRouting.decisionModel && c.modelRouting.decisionModel.providers;
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  let sawReal = false;
  list.forEach((p, i) => {
    const providerId = String((p && p.providerId) || '').trim();
    const baseUrl = String((p && p.baseUrl) || '').trim().replace(/\/+$/, '');
    const apiKey = String((p && p.apiKey) || '').trim();
    const rawPath = String((p && p.path) || '').trim();
    if (!providerId && !baseUrl && !apiKey && !rawPath) return; // 纯模板占位条目,忽略
    sawReal = true;
    if (!baseUrl || !apiKey) return; // 填了一半 = 配置错误,丢弃(全被丢则上游显式报错)
    out.push({ providerId: providerId || `config-${i + 1}`, baseUrl, apiKey, path: normPath(rawPath) });
  });
  return sawReal ? out : null;
}

/**
 * 候选供应商:优先读配置 `modelRouting.decisionModel.providers`(显式声明即只走所填,换网关/换 key/换专属路径改配置即可);
 * 未配置时**由 Token Plan 网关自己提供**(实测:网关 /compatible-mode/v1/models 清单里就有
 * decision-model-preview,调用走同网关的专属路径)——收集所有带 key 的客户端供应商,逐个尝试专属端点,谁先通用谁。
 */
export function decisionProviders({ config = null, providerConfigPath = PROVIDER_CONFIG, snapshotFile = path.join(DATA_DIR, 'routing', 'proxy-upstreams.json') } = {}) {
  const cfgd = configProviders(config);
  if (cfgd) return cfgd;
  const out = [];
  const seen = new Set();
  const push = (providerId, baseUrl, apiKey) => {
    if (!baseUrl || !apiKey) return;
    if (baseUrl.includes('127.0.0.1')) return; // 本地代理不是判定端点宿主(它自己是被路由的一方,试它=绕一圈打随机上游)
    const k = `${providerId}|${baseUrl}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ providerId, baseUrl: String(baseUrl).replace(/\/+$/, ''), apiKey, path: SYSTEMONE_PATH });
  };
  try {
    const pc = JSON.parse(fs.readFileSync(providerConfigPath, 'utf8'));
    for (const r of pc?.config?.providerConfigRules?.providerRules || []) {
      push(r.providerId, r.config?.api?.baseUrl, r.config?.access?.apiKey);
    }
  } catch { /* 没有 provider_config 就走快照 */ }
  try {
    const sn = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    for (const [id, p] of Object.entries(sn.providers || {})) push(id, p.baseUrl, p.apiKey);
  } catch { /* 无快照 */ }
  return out;
}

/** 专属端点路径归一:空=内置 SYSTEMONE_PATH;补前导斜杠、去尾斜杠。 */
function normPath(p) {
  const s = String(p || '').trim();
  if (!s) return SYSTEMONE_PATH;
  return (s.startsWith('/') ? s : '/' + s).replace(/\/+$/, '') || SYSTEMONE_PATH;
}

/** 端点候选:优先站点根 + 专属路径(路径可按供应商配置,缺省 SYSTEMONE_PATH),再试去掉 anthropic 前缀后的根,再试同前缀。 */
export function endpointCandidates(baseUrl, sysPath = SYSTEMONE_PATH) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  const sp = normPath(sysPath);
  const origin = (() => { try { return new URL(b).origin; } catch { return ''; } })();
  const stripped = b.replace(/\/apps\/anthropic$/, '').replace(/\/compatible-mode\/v1\/(chat\/completions|responses)$/, '');
  const list = [];
  if (origin) list.push(origin + sp);
  if (stripped && stripped + sp !== list[0]) list.push(stripped + sp);
  return list;
}

/** 构造判定请求体:state 放待判内容,questions 放类型化问题(choice:选项=标签)。 */
export function buildBody({ items, criteria = TYPE_CRITERIA, model = DECISION_MODEL, keyPrefix = 'q' } = {}) {
  const questions = {};
  items.forEach((it, i) => {
    questions[`${keyPrefix}${i + 1}`] = {
      type: 'choice',
      instructions: `\`items\` 中 id 为 ${it.id} 的文本属于哪一类任务？`,
      criteria: { ...criteria },
    };
  });
  return { state: { items: items.map((it) => ({ id: it.id, text: it.text })) }, model, questions };
}

/** 解析 answers → [{id, type, confidence, probabilities}]。 */
export function parseAnswers(json, items = []) {
  const answers = (json && json.answers) || {};
  const out = [];
  for (const [k, a] of Object.entries(answers)) {
    const idx = Number(String(k).replace(/^\D+/, '')) - 1;
    const it = items[idx] || {};
    out.push({
      id: it.id ?? idx + 1,
      text: it.text ?? '',
      type: a.choice || null,
      confidence: Number(a.confidence ?? 0),
      probabilities: a.probabilities || {},
      raw: a,
    });
  }
  return out;
}

/**
 * 批量判定:一次请求并行判 N 条。fetchFn 可注入(测试)。
 * 返回 {answers:[...], usage, latencyMs, endpoint, error?}。
 */
/**
 * 批量判定:一次请求并行判 N 条(超过分片大小自动分片,顺序发送;分片=显式参数 > 配置 chunkSize,默认 1)。
 * model(模型名)与 config(整个 loadConfig 形态)可注入;两者缺省都读 data/code-index.config.json
 * 的 modelRouting.decisionModel 段——providers 配了只走配置,model 空回内置 DECISION_MODEL。
 * fetchFn 可注入(测试)。返回 {answers:[...], usage, latencyMs, endpoint, error?}。
 */
export async function judgeBatch({ items, criteria = TYPE_CRITERIA, provider = null, fetchFn = fetch, timeoutMs = 30000, endpoints = null, providers = null, chunkSize = null, model = null, config = null } = {}) {
  if (!items || !items.length) return { answers: [], usage: null };
  const list = providers || (provider ? [provider] : decisionProviders({ config }));
  if (!list.length) return { answers: [], usage: null, error: '没有可用供应商(modelRouting.decisionModel.providers 配 baseUrl+apiKey,或在客户端配置带 key 的 Token Plan 供应商)' };
  const modelName = String(model || '').trim() || resolveDecisionModel(config);
  // 分片:显式参数 > 配置 chunkSize(默认 1,2026-11-03 实测定档:批量稀释置信)→ API 上限 MAX_QUESTIONS
  const effChunk = Number(chunkSize) > 0 ? Math.min(Math.floor(Number(chunkSize)), MAX_QUESTIONS) : decisionChunkSize(config);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  const all = [];
  let usage = null;
  let endpoint = null;
  let lastErr = '';
  try {
    for (let off = 0; off < items.length; off += effChunk) {
      const chunk = items.slice(off, off + effChunk);
      const body = buildBody({ items: chunk, criteria, model: modelName });
      let done = false;
      for (const p of list) {
        const cands = endpoints || endpointCandidates(p.baseUrl, p.path);
        for (const url of cands) {
          let res;
          try {
            res = await fetchFn(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
              body: JSON.stringify(body),
              signal: ctl.signal,
            });
          } catch { continue; }
          const text = await res.text();
          if (!res.ok) { lastErr = `HTTP ${res.status}: ${text.slice(0, 160)}`; continue; }
          let json;
          try { json = JSON.parse(text); } catch { lastErr = '响应非 JSON'; continue; }
          const parsed = parseAnswers(json, chunk);
          // HTTP 200 但解析不出任何答案 = 该网关并不是 systemone 宿主(200 包着错误体/别的形态)
          // ⇒ 不能当成功(2026-11-03 实弹:token-plan 429 后滑到的网关 200+空形态,70 条全静默弃权),
          // 记入 lastErr 继续试下一供应商。
          if (!parsed.length) { lastErr = `HTTP 200 但无可解析答案(${String(text).slice(0, 80)})`; continue; }
          // 把分片内的相对 id 还原成全局 id
          for (const a of parsed) a.id = chunk[a.id - 1] ? chunk[a.id - 1].id : a.id;
          all.push(...parsed);
          if (json.usage) usage = { ...(usage || {}), input_tokens: (usage?.input_tokens || 0) + (json.usage.input_tokens || 0) };
          endpoint = endpoint || url;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) return { answers: all, usage, latencyMs: Date.now() - started, endpoint, error: `分片(${chunk.length} 题)失败:${lastErr}` };
    }
    return { answers: all, usage, latencyMs: Date.now() - started, endpoint };
  } catch (e) {
    return { answers: all, usage, latencyMs: Date.now() - started, error: String(e && e.message ? e.message : e) };
  } finally { clearTimeout(timer); }
}

/** 便捷入口:给一批 prompt 直接判类型。 */
export async function classifyBatch(prompts, { criteria = TYPE_CRITERIA, ...opts } = {}) {
  const items = (prompts || []).map((text, i) => ({ id: i + 1, text: String(text) }));
  const r = await judgeBatch({ items, criteria, ...opts });
  return { ...r, byId: new Map(r.answers.map((a) => [a.id, a])) };
}

// ---------- 断路器(2026-11-03 用户定档):模型不可用自动关闭,零网关重试,人工探活恢复 ----------

/** 断路器状态文件:data/routing/decision-model-breaker.json。open=true 期间所有入口跳过网关。 */
export function breakerPath(dataDir = DATA_DIR) { return path.join(dataDir, 'routing', 'decision-model-breaker.json'); }

/** 断路器开着(返回 {open,at,reason})/没开(返回 null)。 */
export function breakerOpen(dataDir = DATA_DIR) {
  try {
    const j = JSON.parse(fs.readFileSync(breakerPath(dataDir), 'utf8'));
    return j && j.open === true ? j : null;
  } catch { return null; }
}

/** 跳闸:复核失败即写,之后零网关尝试;reason 留痕供人判断。 */
export function tripBreaker(reason, dataDir = DATA_DIR) {
  try {
    fs.mkdirSync(path.dirname(breakerPath(dataDir)), { recursive: true });
    fs.writeFileSync(breakerPath(dataDir), JSON.stringify({ open: true, at: Date.now(), reason: String(reason || '').slice(0, 200) }) + '\n');
    return true;
  } catch { return false; }
}

/** 复位(--probe 探活成功或人工删状态文件);2026-11-03 起会话启动自动探活(auto.mjs)成功同样复位。 */
export function resetBreaker(dataDir = DATA_DIR) {
  try { fs.rmSync(breakerPath(dataDir), { force: true }); return true; } catch { return false; }
}

/** 会话启动自动探活判定(2026-11-03 用户定档):开关开 ∧ 断路器开着才需要探——健康路径零开销、零网关。 */
export function autoProbeDue(dataDir = DATA_DIR) {
  return decisionEnabled(readCfg(dataDir)) && !!breakerOpen(dataDir);
}

/** 配置开关:cfg 为 loadConfig() 结果或含 modelRouting 的对象。 */
export function decisionEnabled(cfg) {
  return !!(cfg && cfg.modelRouting && cfg.modelRouting.decisionModel && cfg.modelRouting.decisionModel.enabled === true);
}

function readCfg(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8')); } catch { return {}; }
}

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

/**
 * 黄金集复核(独立工具,2026-11-03 用户定档:不嵌入代签投票,只作复核):
 * 对 golden-set.jsonl 已签条目批量判定,产出 data/routing/decision-review.md——
 *   每条附 agree 与 reviewScore(四票 agreement × (一致?1:0.5) 的复核折减分,纯诊断);
 * **绝不写黄金集**(量尺写入面只有手工 CLI 与四票代签两处,红线不变)。
 * 开关 modelRouting.decisionModel.enabled ∧ 断路器未开才访问网关;失败跳闸并退出 1。
 * fetchFn 可注入(测试密闭)。
 */
export async function reviewGolden({ dataDir = DATA_DIR, goldenFile = null, limit = 0, decisionMinConf = 0.6, fetchFn = fetch } = {}) {
  if (!decisionEnabled(readCfg(dataDir))) {
    return { skipped: true, reason: 'modelRouting.decisionModel.enabled=false(开关在 data/code-index.config.json)' };
  }
  const breaker = breakerOpen(dataDir);
  if (breaker) {
    return { skipped: true, reason: `断路器开(${breaker.reason || '未知原因'})——不再尝试网关;人工 --probe 探活成功后恢复` };
  }
  const file = goldenFile || path.join(dataDir, 'routing', 'golden-set.jsonl');
  let rows = readJsonl(file).filter((r) => /^T[1-8]$/.test(String(r.humanLabel || '')) && r.prompt);
  if (limit > 0) rows = rows.slice(0, limit);
  if (!rows.length) return { skipped: true, reason: `无可复核的已签条目(${file})` };
  const dr = await classifyBatch(rows.map((r) => String(r.prompt)), { fetchFn });
  if (dr.error) {
    tripBreaker(`黄金集复核失败:${dr.error}`, dataDir);
    return { error: dr.error, tripped: true };
  }
  const byId = dr.byId;
  let agree = 0;
  const entries = rows.map((r, i) => {
    const a = byId.get(i + 1) || null;
    const ok = !!(a && a.type && a.confidence >= decisionMinConf && a.type === r.humanLabel);
    if (ok) agree += 1;
    const baseAgreement = Number.isFinite(Number(r.agreement)) ? Number(r.agreement) : 1;
    return {
      id: r.id, prompt: String(r.prompt).replace(/\s+/g, ' ').slice(0, 90),
      humanLabel: r.humanLabel, dmType: a?.type || null, dmConfidence: a ? Number(a.confidence.toFixed(2)) : null,
      agree: ok, abstain: !a || !a.type || a.confidence < decisionMinConf,
      reviewScore: Math.round(baseAgreement * (ok ? 1 : 0.5) * 100) / 100,
    };
  });
  const report = [
    '# 决策模型黄金集复核(独立工具;只读报告,不改量尺)',
    '',
    `> 复核时间:${new Date().toISOString()}　已签条目:${rows.length}　判定一致:${agree}　复核折减(×0.5):${rows.length - agree}`,
    '> reviewScore = 四票 agreement × (一致 ? 1 : 0.5)——纯诊断分,不影响 humanLabel;分歧条目仅供人工判断词表/代签质量。',
    '> 开关:data/code-index.config.json 的 modelRouting.decisionModel.enabled;失败自动跳闸(零网关重试),--probe 探活恢复。',
    '',
    '| id | prompt(截断) | 量尺 | 决策模型 | conf | 一致 | reviewScore |',
    '|---|---|---|---|---|---|---|',
    ...entries.map((e) => `| ${e.id} | ${e.prompt.replace(/\|/g, '/')} | ${e.humanLabel} | ${e.dmType ?? '(弃权)'} | ${e.dmConfidence ?? '-'} | ${e.abstain ? '-' : (e.agree ? '✓' : '✗')} | ${e.reviewScore} |`),
    '',
  ].join('\n');
  const out = path.join(dataDir, 'routing', 'decision-review.md');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, report);
  } catch { /* 报告写不上不影响结论 */ }
  return { reviewed: rows.length, agree, disagree: rows.length - agree - entries.filter((e) => e.abstain).length, abstain: entries.filter((e) => e.abstain).length, agreementRate: Number((agree / rows.length).toFixed(3)), report: out, entries };
}

/** CLI:node decisionModel.mjs --classify "prompt1" "prompt2" ...
 *      node decisionModel.mjs --review-golden [--golden 文件] [--limit N](黄金集复核,报告制不改量尺)
 *      node decisionModel.mjs --probe(人工探活:成功清断路器,失败跳闸)
 *      node decisionModel.mjs --probe-if-tripped(会话启动自动探活:auto.mjs 后台拉起;开关关/断路器未开=静默跳过)
 */
const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (directRun) {
  const argv = process.argv.slice(2);
  const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
  if (argv.includes('--review-golden')) {
    reviewGolden({ dataDir: DATA_DIR, goldenFile: opt('--golden', null) || null, limit: Number(opt('--limit', 0)) || 0 })
      .then((r) => {
        console.log(JSON.stringify(r, null, 1));
        process.exit(r.error ? 1 : 0);
      });
  } else if (argv.includes('--probe')) {
    // 人工探活:一题判定。成功=复位断路器;失败=跳闸(理由留痕)。开关关闭时不碰网关。
    if (!decisionEnabled(readCfg(DATA_DIR))) {
      console.log(JSON.stringify({ skipped: true, reason: 'modelRouting.decisionModel.enabled=false' }));
      process.exit(0);
    }
    classifyBatch(['健康探活:这是一条用于探活的指令。'], {}).then((r) => {
      if (r.error) { tripBreaker(`探活失败:${r.error}`); console.error('[err]', r.error); process.exit(1); }
      resetBreaker();
      console.log(JSON.stringify({ ok: true, endpoint: r.endpoint, latencyMs: r.latencyMs, breaker: 'reset' }));
    });
  } else if (argv.includes('--probe-if-tripped')) {
    // 会话启动自动探活(auto.mjs SessionStart detached 拉起):仅"开关开 ∧ 断路器开着"才真实打网关。
    // 成功=复位;失败=续跳(更新留痕)。判定与 --probe 同源,只是多了跳过条件。
    if (!autoProbeDue()) { console.log(JSON.stringify({ skipped: true })); process.exit(0); }
    classifyBatch(['健康探活:这是一条用于探活的指令。'], {}).then((r) => {
      if (r.error) { tripBreaker(`探活失败:${r.error}`); console.log(JSON.stringify({ ok: false, error: r.error })); process.exit(1); }
      resetBreaker();
      console.log(JSON.stringify({ ok: true, endpoint: r.endpoint, latencyMs: r.latencyMs, breaker: 'reset' }));
    });
  } else {
    const prompts = argv.filter((a) => !a.startsWith('--'));
    classifyBatch(prompts).then((r) => {
      if (r.error) { console.error('[err]', r.error); process.exit(1); }
      console.log(JSON.stringify({ endpoint: r.endpoint, latencyMs: r.latencyMs, usage: r.usage, answers: r.answers }, null, 1));
    });
  }
}
