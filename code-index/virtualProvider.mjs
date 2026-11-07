/**
 * 虚拟供应商条目(动态模型路由入口)的清单逻辑,独立成模块:
 * init 播种/自动同步 与 snapshot-refresh 钩子的自动同步 共用同一份实现(避免两处口径漂移)。
 *
 * **auto 档位制(2026-11-02 用户终裁,取代镜像清单制)**:客户端只维护**一个模型档位 `auto`**,
 * 不再镜像真实供应商的模型清单;"实际调用什么模型"完全由决策层决定(代理 decideTarget:
 * sticky 基准=R1 档链头解析,升档=难度定档 R2-R4 按 resolveTier 级联)。
 * 理由:镜像清单制要求"清单内皆可路由"的持续保鲜(实测已两次漂移:glm-5.2 陈旧、Kimi 模板形态),
 * 而 auto 制下客户端清单恒为 ["auto"],从根上消灭"选中即不可路由"整类问题;
 * 真实模型清单继续由各端 hooks/CLI 维护在 data/routing/proxy-upstreams.json(转发路由表)。
 * 迁移:条目清单若仍是旧镜像形态,自动收敛为 ["auto"];tokenSaverMirror='manual' 退出通道保留。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.mjs'; // v2Dir 配置的读取来源(config 不反向依赖本模块,无循环)

const ok = (msg) => console.log(msg);

/** 虚拟档位名(客户端唯一可选的模型名)。 */
export const AUTO_MODEL = 'auto';

// ---------- ZCode v2 数据目录解析(2026-11-07):用户可在 ZCode 设置里改数据存储路径,----------
// ---------- 恒读 ~/.zcode/v2 会在自定义路径部署上全军覆没(快照 0 条+播种跳过,实弹故障)。----------

/** ZCode 独有文件指纹(2026-11-07 按真实迁移样本 D:/hello/.zcode/v2 修正):
 *  setting.json 不随迁移走(留在旧位置)——目录指纹=ZCode 独有数据文件:
 *  provider_config.json(schemaVersion+config) / credentials.json(zcodejwttoken/oauth: 键形态) / onboarding-record.json(deviceMid)。 */
const ZCODE_V2_MARKERS = ['provider_config.json', 'credentials.json', 'onboarding-record.json', 'bot-config.v3.json'];
/** 慢路径排除目录(系统/噪声;AppData 保留——用户可能把数据自定义进去)。 */
const SEARCH_SKIP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'node_modules', '.git', 'recovery']);
const SEARCH_MAX_DEPTH = 6;

function zcodeConfigLooksZcode(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.schemaVersion != null && j.config) return true; // provider_config.json 形态
    if (Array.isArray(j.entries) && j.deviceMid) return true; // onboarding-record.json 形态
    if (typeof j === 'object' && j && Object.keys(j).some((k) => /^(oauth:|zcodejwttoken|bot:)/.test(k))) return true; // credentials.json 形态
    if (j.version != null && j.bots) return true; // bot-config.v3.json 形态
    return false;
  } catch { return false; }
}

function zcodeV2LooksLike(dir) {
  try {
    return fs.readdirSync(dir).some((f) => {
      if (f === 'provider_config.json' || f === 'credentials.json' || f === 'onboarding-record.json' || f === 'bot-config.v3.json') return zcodeConfigLooksZcode(path.join(dir, f));
      return false;
    });
  } catch { return false; }
}

/** 递归搜 v2 形态目录(目录含 setting.json[ZCode 指纹]或 provider_config.json);返回命中数组(含 mtime,最新优先)。 */
export function searchV2Dirs(searchRoots) {
  const hits = [];
  const skip = (name) => SEARCH_SKIP.has(name.toLowerCase());
  const walk = (dir, depth) => {
    if (depth > SEARCH_MAX_DEPTH || hits.length > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || skip(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.name === 'v2' || zcodeV2LooksLike(abs)) {
        try {
          const st = fs.statSync(abs);
          if (zcodeV2LooksLike(abs)) hits.push({ dir: abs, mtimeMs: st.mtimeMs });
        } catch { /* 不可读跳过 */ }
      }
      walk(abs, depth + 1);
    }
  };
  for (const r of searchRoots) walk(r, 0);
  return hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function listDrives() {
  const out = [];
  for (let c = 67; c <= 90; c += 1) { // D..Z(C 盘由 ~ 兜底)
    const d = `${String.fromCharCode(c)}:\\`;
    try { if (fs.existsSync(d)) out.push(d); } catch { /* 不可读跳过 */ }
  }
  return out;
}

/**
 * 解析 ZCode v2 数据目录(2026-11-07 用户定案 v2Dir 显式配置制):用户可在 ZCode 设置里改数据存储路径,
 * **迁移是复制不是移动**——旧 ~/.zcode/v2 文件原样保留只是不再更新,恒读默认路径/靠"目录存活"探测
 * 都会命中陈旧位置(实弹故障:快照 0 条+播种跳过)。三级定序:
 *   ① data/code-index.config.json 根级 **v2Dir**(非空即最高优先,用户手工填的正确路径——迁移后改这里+重启 ZCode);
 *   ② env ZCODE_V2_DIR 显式指定;
 *   ③ 默认 ~/.zcode/v2 快验(provider_config.json / credentials.json / onboarding-record.json 任一存在);
 *   ④ 慢路径全盘特征搜(D..Z 盘,限深 6,排除系统目录,ZCode 指纹校验,多命中 mtime 最新)——v2Dir 未配时的自动兜底。
 * 返回 {dir, source};搜不到回落 {dir: ~/.zcode/v2, source: 'default'}(消费方按目录缺失自行跳过)。
 * dataDir 用于读 data/code-index.config.json(v2Dir 的来源);缺省用内置 DATA_DIR。
 * **zcode-home.json 缓存机制已废弃**(2026-11-07 用户拍板):"目录存活"无法区分陈旧复制,缓存只会
 * 把错误路径钉死;显式 v2Dir 配置 + 兜底搜索取代它。
 */
export function resolveZcodeV2Dir({ dataDir = DATA_DIR, force = false, env = process.env } = {}) {
  const fallback = path.join(os.homedir(), '.zcode', 'v2');
  const looksAlive = (dir) => ['provider_config.json', 'credentials.json', 'onboarding-record.json'].some((f) => fs.existsSync(path.join(dir, f)));
  // ① data 配置 v2Dir(用户手工填的正确路径,最高优先)
  let cfgV2 = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'code-index.config.json'), 'utf8'));
    const v = String(cfg.v2Dir || '').trim();
    if (v) cfgV2 = path.resolve(v);
  } catch { /* 配置缺失/坏 → 无 v2Dir */ }
  if (cfgV2) {
    if (looksAlive(cfgV2)) return { dir: cfgV2, source: 'config' };
    // 配了但目录不存活:不静默吞——回落探测但打印告警(用户填错路径要让 TA 看见)
    console.error(`[zcode-v2] code-index.config.json 的 v2Dir="${cfgV2}" 不存在或缺少 ZCode 数据文件,回落自动探测`);
  }
  // ② 显式 env
  const envDir = env.ZCODE_V2_DIR && String(env.ZCODE_V2_DIR).trim();
  if (envDir) return { dir: path.resolve(envDir), source: 'env' };
  // ③ 默认快验
  if (looksAlive(fallback)) return { dir: fallback, source: 'default' };
  // ④ 全盘特征搜(慢;home 树最后一搏:~/.zcode 下除 v2 外是否有 v2 形态目录)
  const homeAlt = path.join(os.homedir(), '.zcode');
  try {
    const alt = fs.readdirSync(homeAlt, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(homeAlt, e.name)).find((d) => d !== fallback && zcodeV2LooksLike(d));
    if (alt) return { dir: alt, source: 'home-alt' };
  } catch { /* 不可读跳过 */ }
  const hits = searchV2Dirs(listDrives());
  if (hits.length) return { dir: hits[0].dir, source: 'search' };
  // ⑤ 回落默认(消费方按目录缺失自行跳过)
  return { dir: fallback, source: 'default' };
}

/**
 * 动态显示名(2026-11-07 用户定案):模型名可带综合费率后缀 "auto×0.189"——客户端选择器直接显示
 * 当前倍率。解析规则(用户指定):**剔除 × 符号及其后面的字符,再去空格,再与 auto 比较**。
 * 校验锚点一律走 isAutoModelName,不得再用 === AUTO_MODEL 精确比较(带后缀的动态名会被误判)。
 */
export function isAutoModelName(name) {
  return String(name || '').split('×')[0].trim().toLowerCase() === AUTO_MODEL;
}

/** 规范化:isAutoModelName 为真 ⇒ 返回纯 'auto'(下游严格匹配/账本口径保持连续);否则原样返回。 */
export function normalizeAutoModel(name) {
  const n = String(name || '');
  return isAutoModelName(n) ? AUTO_MODEL : n;
}

/** ZCode 端虚拟供应商条目的模型清单(单 auto 档;autoName 可带倍率后缀)。 */
export function virtualModelList(autoName = AUTO_MODEL) { return [autoName]; }

/**
 * 镜像清单口径(保留供陈旧度迁移判定):真实自定义供应商的模型并集,先见先序去重;
 * 排除 baseUrl 指向代理的条目(入口/自身,防自指)与无 baseUrl 的条目(不可路由)。
 * personalModelIds 为空时回落 modelOrder(模板供应商形态)。
 */
export function mirroredModelUnion(rules) {
  const models = [];
  for (const r of rules || []) {
    const base = r?.config?.api?.baseUrl || '';
    if (!base || base.includes('127.0.0.1')) continue;
    const listed = r?.config?.personalModelIds || [];
    const source = listed.length ? listed : (r?.config?.modelOrder || []);
    for (const m of source) if (!models.includes(m)) models.push(m);
  }
  return models;
}

/**
 * 虚拟条目陈旧度(纯只读比对,绝不写盘):auto 制下唯一合法清单=["auto"];
 * 返回 {present, isAuto(已是 auto 档), extra(旧镜像残留), stale}。
 */
export function virtualProviderStaleness({ home = os.homedir(), providerId = 'tokenSaverModel', zcodeV2Dir = null } = {}) {
  const file = zcodeConfigFile({ home, zcodeV2Dir });
  let pc;
  try { pc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { present: false, extra: [], stale: false, note: '无 provider_config,无法比对' }; }
  const rules = pc?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return { present: false, extra: [], stale: false, note: '无 providerRules,无法比对' };
  const entry = rules.find((r) => r?.providerId === providerId);
  if (!entry) return { present: false, extra: [], stale: false, note: '条目不存在(尚未播种)' };
  const listed = entry.config?.personalModelIds || [];
  const extra = listed.filter((m) => !isAutoModelName(m));
  return { present: true, isAuto: listed.some(isAutoModelName) && !extra.length, listed: listed.length, extra, stale: extra.length > 0 || !listed.some(isAutoModelName) };
}

/**
 * 虚拟供应商条目播种(auto 档位制):在 provider 配置文件幂等播种虚拟条目——
 * baseUrl 指向本地代理,模型清单恒为单 auto 档(客户端只选它,真实模型由决策层定)。
 * autoName(2026-11-07 定影语义):**只在会话开启刷新时传入**(auto.mjs SessionStart 是唯一
 * 有资格改名的点);**缺省 = 保持配置现状**——幂等只要求"清单恰好一个 auto 系名字"
 * (isAutoModelName),名字是什么(纯 auto / auto×0.189)一律不动。曾尝试"所有写入方从
 * 倍率账本反算目标名",错在账本是最新会话口径(rate 随会话切换漂移/归 null),会话中期的
 * snapshot-refresh 会把会话开启定好的名字静默刷掉——幂等锚应是配置自身,不是账本。
 * 条目是旧镜像形态 → 收敛为当前清单里的 auto 系名(无则纯 auto);写前备份。
 */
/**
 * ZCode 端 v2 配置文件定位(2026-11-07 路径自适应,Qoder 逻辑零接触):
 *   ① zcodeV2Dir 显式传入 → 直用;② home 显式传入且 ≠ 默认主目录(测试/旧调用)→ 旧拼接;
 *   ③ home 缺省/等于默认主目录(生产)→ resolveZcodeV2Dir 探测(env→缓存→默认快验→全盘特征搜→回落)。
 */
function zcodeConfigFile({ home = os.homedir(), zcodeV2Dir = null } = {}) {
  const v2 = zcodeV2Dir
    || (home && home !== os.homedir() ? path.join(home, '.zcode', 'v2') : resolveZcodeV2Dir().dir);
  return path.join(v2, 'provider_config.json');
}

export function ensureVirtualProviderEntry({ home = os.homedir(), providerId = 'tokenSaverModel', baseUrl = 'http://127.0.0.1:8117/apps/anthropic', qoder = false, autoName = null, zcodeV2Dir = null } = {}) {
  const target = autoName != null && isAutoModelName(autoName) ? autoName : null; // null=保持现状;非 auto 系名字拒绝(锚不可漂移)
  let file;
  if (qoder) {
    // Qoder:用户级 settings.json 的 providers 键(2026-11-02 用户实测确认可写)
    const dir = fs.existsSync(path.join(home, '.qoder-cn')) ? '.qoder-cn' : '.qoder';
    file = path.join(home, dir, 'settings.json');
  } else {
    file = zcodeConfigFile({ home, zcodeV2Dir });
  }
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (!raw) return { seeded: false, note: '未播种(无宿主配置,裸机部署属正常)' };
  let pc;
  try { pc = JSON.parse(raw); } catch { return { seeded: false, note: '未播种(宿主配置非合法 JSON,不动)' }; }

  const autoEntry = (providerName, name) => qoder
    // Qoder 端 id 恒为纯 auto(会话绑定锚;带×的 id 会令客户端绑定失效,2026-11-07 实证),
    // 倍率只进 displayName——选择器渲染 displayName 不渲染 id,可见性不受影响。
    // ZCode 无 per-model displayName 字段,倍率必须留在 id 里。
    ? { baseUrl, apiKey: 'tokensaver-placeholder', type: 'openai-compatible', protocol: 'anthropic', authType: 'api-key', model: AUTO_MODEL, models: [{ model: AUTO_MODEL, displayName: `TokenSaver ${name}`, contextWindow: 200000, maxOutputTokens: 8192 }], displayName: providerName }
    : { providerId, providerName, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'tokensaver-placeholder' }, api: { type: 'anthropic-messages', baseUrl }, personalModelIds: [name], modelOrder: [name] } };

  if (qoder) {
    // Qoder 形态:providers.{id} 对象;条目 id 用固定名(可读)
    pc.providers = pc.providers && typeof pc.providers === 'object' ? pc.providers : {};
    if (pc.providers[providerId]) {
      const e = pc.providers[providerId];
      const listed = (Array.isArray(e.models) ? e.models : []).map((m) => (typeof m === 'string' ? m : m?.model)).filter(Boolean);
      const extra = listed.filter((m) => !isAutoModelName(m));
      // 定影语义(2026-11-07,Qoder 修正):id 锚定纯 auto 永不改;显式 autoName(SessionStart)只刷 displayName
      const keepName = listed.find(isAutoModelName) || AUTO_MODEL;
      const writeName = target || keepName;
      const baseOk = String(e.baseUrl || '').replace(/\/+$/, '') === baseUrl;
      const shown = Array.isArray(e.models) && e.models[0] && typeof e.models[0] === 'object' ? String(e.models[0].displayName || '') : '';
      const nameOk = listed.length === 1 && listed[0] === AUTO_MODEL && (target == null || shown === `TokenSaver ${target}`);
      if (nameOk && baseOk) return { seeded: false, note: '条目已存在(auto 档),无需改动' };
      if (e.tokenSaverMirror === 'manual') return { seeded: false, note: '条目已存在且标记手工维护,不改', extra };
      const backup = file + '.bak-tokensaver';
      fs.copyFileSync(file, backup);
      pc.providers[providerId] = { ...autoEntry('TokenSaver', writeName), tokenSaverMirrorAuto: true };
      fs.writeFileSync(file, JSON.stringify(pc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
      ok(`[user] Qoder 虚拟条目 ${providerId} 已刷新(${nameOk ? 'auto 档' : `清单收敛为 ${writeName}`}${baseOk ? '' : ';baseUrl 已切到宿主专属前缀'};已备份 ${path.basename(backup)})`);
      return { seeded: false, refreshed: true, note: nameOk ? 'baseUrl 已对齐' : `清单已刷新为 ${writeName}`, extra };
    }
    const backup = file + '.bak-tokensaver';
    fs.copyFileSync(file, backup);
    pc.providers[providerId] = autoEntry('TokenSaver', target || AUTO_MODEL);
    fs.writeFileSync(file, JSON.stringify(pc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    ok(`[user] 已播种 Qoder 虚拟供应商 ${providerId}:baseUrl→本地代理,单 auto 档;选择它即启用动态路由;已备份 ${path.basename(backup)}`);
    return { seeded: true, models: [target || AUTO_MODEL], backup, file };
  }

  // ZCode 形态
  const rules = pc?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return { seeded: false, note: '未播种(无 providerRules 键,不动)' };
  if (rules.some((r) => r?.providerId === providerId)) {
    const entry = rules.find((r) => r?.providerId === providerId);
    const listed = entry.config?.personalModelIds || [];
    const extra = listed.filter((m) => !isAutoModelName(m));
    // baseUrl 变更(2026-11-04 双端隔离:Qoder 专属前缀 /apps/qoder)同样触发就地刷新;
    // 定影语义(2026-11-07):现有 auto 系名保持(target=null);仅显式 autoName(SessionStart)可改名
    const keepName = listed.find(isAutoModelName) || AUTO_MODEL;
    const writeName = target || keepName;
    const baseOk = String(entry.config?.api?.baseUrl || '').replace(/\/+$/, '') === baseUrl;
    const nameOk = listed.length === 1 && listed.some(isAutoModelName) && (target == null || listed[0] === target);
    if (nameOk && baseOk) return { seeded: false, note: '条目已存在(auto 档),清单恒定', extra };
    // 手工维护退出通道
    if (entry.config?.tokenSaverMirror === 'manual') {
      return { seeded: false, note: '条目已存在且标记为手工维护(tokenSaverMirror=manual),不改清单', extra };
    }
    // 旧镜像形态 → 收敛为 auto 档;baseUrl 变更 → 就地刷新(2026-11-04 双端隔离)
    const backup = file + '.bak-tokensaver';
    fs.copyFileSync(file, backup);
    if (!baseOk && entry.config) entry.config.api = { ...(entry.config.api || { type: 'anthropic-messages' }), baseUrl };
    entry.config.personalModelIds = [writeName];
    if (Array.isArray(entry.config.modelOrder)) entry.config.modelOrder = [writeName];
    const modelRules = pc.config.modelConfigRules?.providerModelRules;
    if (Array.isArray(modelRules)) {
      pc.config.modelConfigRules.providerModelRules = [
        ...modelRules.filter((x) => x?.providerId !== providerId || !isAutoModelName(x?.modelId)),
        { modelId: writeName, config: { enabled: true }, providerId },
      ];
    }
    fs.writeFileSync(file, JSON.stringify(pc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    ok(`[user] 虚拟供应商 ${providerId} 已刷新(${nameOk ? 'auto 档' : `清单收敛为 ${writeName}`};${baseOk ? 'baseUrl 已对齐' : `baseUrl 已切到 ${baseUrl}`};真实清单继续由快照维护;已备份 ${path.basename(backup)})`);
    return { seeded: false, refreshed: true, note: nameOk ? 'baseUrl 已对齐' : `清单已刷新为 ${writeName}`, extra };
  }
  const backup = file + '.bak-tokensaver';
  fs.copyFileSync(file, backup);
  rules.push(autoEntry('TokenSaver', target || AUTO_MODEL));
  const order = pc.config.providerOrder;
  if (Array.isArray(order) && !order.includes(providerId)) order.push(providerId);
  const modelRules = pc.config.modelConfigRules?.providerModelRules;
  if (Array.isArray(modelRules)) modelRules.push({ modelId: target || AUTO_MODEL, config: { enabled: true }, providerId });
  fs.writeFileSync(file, JSON.stringify(pc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  ok(`[user] 已播种虚拟供应商 ${providerId}:baseUrl→本地代理,单 auto 档(真实模型由决策层定);选择它即启用动态路由;已备份 ${path.basename(backup)}`);
  return { seeded: true, models: [target || AUTO_MODEL], backup, file };
}

/**
 * 全期倍率写根级字段(2026-11-07 用户定案,**取代动态模型名**):auto 档 model 名**恒为纯 'auto'、
 * 永不携带倍率后缀**——名字变更会导致客户端已选模型失效、每会话都要重新选模型(实弹痛点)。
 * 倍率改为写两端宿主配置文件的**根级字段** `tokenSaverAutoRate`(数字,数据层记录,不改任何虚拟条目字段)。
 * 只在会话开启时调用(auto.mjs SessionStart 唯一挂载点);幂等:值相同不写盘;fail-open。
 * 返回 {zcode, qoder} 两端结果摘要。
 */
export function writeAutoRateField({ home = os.homedir(), rate = null, zcodeV2Dir = null, dataDir = null } = {}) {
  const out = {};
  if (!(Number.isFinite(Number(rate)) && Number(rate) > 0)) {
    return { zcode: { skipped: '无有效费率' }, qoder: { skipped: '无有效费率' } };
  }
  const rateNum = Number(rate.toFixed(4));
  for (const qoder of [false, true]) {
    const tag = qoder ? 'qoder' : 'zcode';
    try {
      let file;
      if (qoder) {
        const dir = fs.existsSync(path.join(home, '.qoder-cn')) ? '.qoder-cn' : '.qoder';
        file = path.join(home, dir, 'settings.json');
      } else {
        // ZCode 端路径自适应(2026-11-07 补齐):与 ensure/snapshot 同判据——用户改过数据存储路径时
        // 走 resolveZcodeV2Dir 探测,不再写死 ~/.zcode/v2(实测漏接点:倍率字段曾写错位置)
        const v2Dir = zcodeV2Dir || (home !== os.homedir() ? path.join(home, '.zcode', 'v2') : resolveZcodeV2Dir({ dataDir }).dir);
        file = path.join(v2Dir, 'provider_config.json');
      }
      if (!fs.existsSync(file)) { out[tag] = { skipped: '宿主配置不存在' }; continue; }
      const pc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pc.tokenSaverAutoRate === rateNum) { out[tag] = { skipped: '值未变,不写盘' }; continue; }
      const backup = file + '.bak-tokensaver';
      try { fs.copyFileSync(file, backup); } catch { /* 备份失败仍写 */ }
      pc.tokenSaverAutoRate = rateNum;
      fs.writeFileSync(file, JSON.stringify(pc, null, 2) + '\n');
      out[tag] = { updated: true, rate: rateNum, backup };
    } catch (e) {
      out[tag] = { error: String(e && e.message ? e.message : e) };
    }
  }
  return out;
}