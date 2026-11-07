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

const ok = (msg) => console.log(msg);

/** 虚拟档位名(客户端唯一可选的模型名)。 */
export const AUTO_MODEL = 'auto';

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

/** 目标显示名:rate 有效(有限正数)⇒ auto×0.189;无效 ⇒ 纯 auto(名字刷新退回锚名)。 */
export function autoDisplayName(rate) {
  return Number.isFinite(Number(rate)) && Number(rate) > 0 ? `${AUTO_MODEL}×${Number(rate).toFixed(3)}` : AUTO_MODEL;
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
export function virtualProviderStaleness({ home = os.homedir(), providerId = 'tokenSaverModel' } = {}) {
  const file = path.join(home, '.zcode', 'v2', 'provider_config.json');
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
export function ensureVirtualProviderEntry({ home = os.homedir(), providerId = 'tokenSaverModel', baseUrl = 'http://127.0.0.1:8117/apps/anthropic', qoder = false, autoName = null } = {}) {
  const target = autoName != null && isAutoModelName(autoName) ? autoName : null; // null=保持现状;非 auto 系名字拒绝(锚不可漂移)
  let file;
  if (qoder) {
    // Qoder:用户级 settings.json 的 providers 键(2026-11-02 用户实测确认可写)
    const dir = fs.existsSync(path.join(home, '.qoder-cn')) ? '.qoder-cn' : '.qoder';
    file = path.join(home, dir, 'settings.json');
  } else {
    file = path.join(home, '.zcode', 'v2', 'provider_config.json');
  }
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (!raw) return { seeded: false, note: '未播种(无宿主配置,裸机部署属正常)' };
  let pc;
  try { pc = JSON.parse(raw); } catch { return { seeded: false, note: '未播种(宿主配置非合法 JSON,不动)' }; }

  const autoEntry = (providerName, name) => qoder
    ? { baseUrl, apiKey: 'tokensaver-placeholder', type: 'openai-compatible', protocol: 'anthropic', authType: 'api-key', model: name, models: [{ model: name, displayName: 'TokenSaver auto', contextWindow: 200000, maxOutputTokens: 8192 }], displayName: providerName }
    : { providerId, providerName, config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'tokensaver-placeholder' }, api: { type: 'anthropic-messages', baseUrl }, personalModelIds: [name], modelOrder: [name] } };

  if (qoder) {
    // Qoder 形态:providers.{id} 对象;条目 id 用固定名(可读)
    pc.providers = pc.providers && typeof pc.providers === 'object' ? pc.providers : {};
    if (pc.providers[providerId]) {
      const e = pc.providers[providerId];
      const listed = (Array.isArray(e.models) ? e.models : []).map((m) => (typeof m === 'string' ? m : m?.model)).filter(Boolean);
      const extra = listed.filter((m) => !isAutoModelName(m));
      // 定影语义(2026-11-07):现有 auto 系名保持(target=null);仅显式 autoName(SessionStart)可改名
      const keepName = listed.find(isAutoModelName) || AUTO_MODEL;
      const writeName = target || keepName;
      const baseOk = String(e.baseUrl || '').replace(/\/+$/, '') === baseUrl;
      const nameOk = listed.length === 1 && listed.some(isAutoModelName) && (target == null || listed[0] === target);
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
 * 动态显示名刷新(2026-11-07):把两端用户级配置的虚拟条目名幂等刷成 autoDisplayName(rate)
 * (如 auto×0.189)。fail-open:任何异常不抛、不影响调用方;手工维护条目与纯 auto(无有效费率)不动。
 * 返回 {zcode, qoder} 两端的 ensure 结果摘要。
 */
export function refreshAutoModelName({ home = os.homedir(), rate = null } = {}) {
  const autoName = autoDisplayName(rate);
  if (autoName === AUTO_MODEL) return { zcode: { skipped: '无有效费率,名字保持纯 auto' }, qoder: { skipped: '无有效费率,名字保持纯 auto' } };
  const out = {};
  for (const qoder of [false, true]) {
    try {
      // Qoder 端条目 id 与 ZCode 不同(2026-11-02 播种定名 tokensaver-auto)——不传会按默认
      // 'tokenSaverModel' 在 Qoder settings.json 里误播种一条脏条目(实测踩过)
      const r = ensureVirtualProviderEntry({
        home, qoder,
        providerId: qoder ? 'tokensaver-auto' : 'tokenSaverModel',
        autoName,
        baseUrl: qoder ? 'http://127.0.0.1:8117/apps/qoder' : 'http://127.0.0.1:8117/apps/anthropic',
      });
      out[qoder ? 'qoder' : 'zcode'] = r;
    } catch (e) {
      out[qoder ? 'qoder' : 'zcode'] = { error: String(e && e.message ? e.message : e) };
    }
  }
  return out;
}