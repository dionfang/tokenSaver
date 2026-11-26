#!/usr/bin/env node
/**
 * 卸载部署:移除 init.mjs 装到各处的钩子与注入段,逐步在命令行回显状态。
 *   node uninit.mjs
 *
 * 做这些事(每完成一步输出一行 [ok]/[skip]):
 *   1) 读取部署清单(data/code-index.config.json 的 roots + 工具仓自身)
 *   2) 移除用户级钩子:ZCode ~/.zcode/cli/config.json、Cursor ~/.cursor/hooks.json(+转发器)、
 *      Qoder ~/.qoder-cn/settings.json(+转发器,国际版 ~/.qoder)。文件只剩本模块骨架则整删;
 *      含其他配置(如 ZCode 的 plugins)只摘钩子条目,文件保留;
 *      同时移除 init 播种的虚拟供应商条目(ZCode tokenSaverModel 与 Qoder tokensaver-auto,真实供应商不动)
 *   3) 防御性清理各项目工作区钩子残留(.zcode/.cursor/.qoder 里本模块的条目与转发器)
 *   4) 还原各项目 AGENTS.md:剥掉纪律段(<!-- code-index -->)与输出纪律段(<!-- output-diet -->;兼容剥旧 ponytail 段);
 *      剥完只剩空白 → 整文件删除;有用户内容 → 保留其余原文
 *   5) 清理运行时痕迹(data/.prefetch-last.json)
 *
 * 不动:data/(索引、节约账、read-guard 记录)、code-index/ 本体、CODE_MAP.md、.gitignore、
 *       用户自己的 skills 与其他工具的钩子、用户级环境变量 OLLAMA_MAX_LOADED_MODELS
 *       (init 设=5,良性 Ollama 驻留调优、可能用户自设,保留不回退)。重新部署:node init.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DATA_DIR, findGitRoot } from './config.mjs';
import {
  isCodeIndexHookRef,
  isOurZcodeHook,
  dropHookGroups,
  cleanCursorWorkspaceHooks,
  cleanQoderWorkspaceHooks,
  cleanZcodeWorkspaceHooks,
  USER_FORWARDER_FILES,
  uninstallMemorix,
  removeMemorixMcp,
  removeQoderMemorixMcp,
  removeCursorMemorixMcp,
} from './init.mjs';
import { resolveZcodeV2Dir } from './virtualProvider.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PONYTAIL_MARK = '<!-- ponytail -->';
const say = (msg) => process.stdout.write(msg + '\n');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function rmIfExists(file) {
  try {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch { return false; }
}

function rmdirIfEmpty(dir) {
  try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* 非空,留着 */ }
}

// ---------- 步骤 2:用户级钩子 ----------

/** 用户级转发器清理清单:自 init.mjs 的 USER_FORWARDER_FILES 单源派生(2026-11-10 纪律段第 10 条),
 *  禁止手抄——deploySync 门禁校验「安装⊆登记、卸载≡登记」,两边漂移都会被拦。 */
export const CURSOR_FORWARDERS = [...USER_FORWARDER_FILES.cursor.current, ...USER_FORWARDER_FILES.cursor.legacy];
export const QODER_FORWARDERS = [...USER_FORWARDER_FILES.qoder.current, ...USER_FORWARDER_FILES.qoder.legacy];

export function uninstallZcodeUserHooks({ home = os.homedir() } = {}) {
  const file = path.join(home, '.zcode', 'cli', 'config.json');
  const cfg = readJson(file);
  if (!cfg) return { host: 'ZCode', file, touched: false, note: '未安装(无配置文件)' };
  if (!cfg.hooks || typeof cfg.hooks !== 'object') return { host: 'ZCode', file, touched: false, note: '无 hooks 键' };
  const events = cfg.hooks.events && typeof cfg.hooks.events === 'object' ? cfg.hooks.events : {};
  let groups = 0;
  for (const key of Object.keys(events)) {
    if (!Array.isArray(events[key])) continue;
    const before = events[key].length;
    events[key] = dropHookGroups(events[key], isOurZcodeHook);
    groups += before - events[key].length;
    if (!events[key].length) delete events[key];
  }
  const skeletonOnly = Object.keys(cfg).every(k => k === 'hooks')
    && Object.keys(cfg.hooks).every(k => k === 'enabled' || k === 'events')
    && Object.keys(events).length === 0;
  if (skeletonOnly) {
    rmIfExists(file);
    return { host: 'ZCode', file, touched: groups > 0, groups, fileDeleted: true };
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return { host: 'ZCode', file, touched: groups > 0, groups, fileDeleted: false };
}

export function uninstallCursorUserHooks({ home = os.homedir() } = {}) {
  const hooksDir = path.join(home, '.cursor', 'hooks');
  const file = path.join(home, '.cursor', 'hooks.json');
  const cfg = readJson(file);
  let groups = 0;
  let fileDeleted = false;
  if (cfg && typeof cfg === 'object' && cfg.hooks && typeof cfg.hooks === 'object') {
    for (const key of Object.keys(cfg.hooks)) {
      if (!Array.isArray(cfg.hooks[key])) continue;
      const before = cfg.hooks[key].length;
      cfg.hooks[key] = cfg.hooks[key].filter(h => !isCodeIndexHookRef(h?.command));
      groups += before - cfg.hooks[key].length;
      if (!cfg.hooks[key].length) delete cfg.hooks[key];
    }
    const skeletonOnly = Object.keys(cfg).every(k => k === 'version' || k === 'hooks') && Object.keys(cfg.hooks).length === 0;
    if (skeletonOnly) { rmIfExists(file); fileDeleted = true; }
    else fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  let forwarders = 0;
  for (const f of CURSOR_FORWARDERS) if (rmIfExists(path.join(hooksDir, f))) forwarders++;
  rmdirIfEmpty(hooksDir);
  return { host: 'Cursor', file, touched: groups > 0 || forwarders > 0 || fileDeleted, groups, forwarders, fileDeleted };
}

export function uninstallQoderUserHooks({ home = os.homedir() } = {}) {
  const cn = path.join(home, '.qoder-cn');
  const intl = path.join(home, '.qoder');
  const userDir = fs.existsSync(intl) && !fs.existsSync(cn) ? intl : cn;
  const hooksDir = path.join(userDir, 'hooks');
  const file = path.join(userDir, 'settings.json');
  const cfg = readJson(file);
  let groups = 0;
  let fileDeleted = false;
  if (cfg && typeof cfg === 'object' && cfg.hooks && typeof cfg.hooks === 'object') {
    for (const key of Object.keys(cfg.hooks)) {
      if (!Array.isArray(cfg.hooks[key])) continue;
      const before = cfg.hooks[key].length;
      cfg.hooks[key] = dropHookGroups(cfg.hooks[key], (h) => isCodeIndexHookRef(h?.command));
      groups += before - cfg.hooks[key].length;
      if (!cfg.hooks[key].length) delete cfg.hooks[key];
    }
    const skeletonOnly = Object.keys(cfg).every(k => k === 'hooks') && Object.keys(cfg.hooks).length === 0;
    if (skeletonOnly) { rmIfExists(file); fileDeleted = true; }
    else fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  let forwarders = 0;
  for (const f of QODER_FORWARDERS) if (rmIfExists(path.join(hooksDir, f))) forwarders++;
  rmdirIfEmpty(hooksDir);
  rmdirIfEmpty(userDir);
  return { host: 'Qoder', file, touched: groups > 0 || forwarders > 0 || fileDeleted, groups, forwarders, fileDeleted };
}

// ---------- 步骤 4:AGENTS.md ----------

/** 剥掉纪律段:<!-- code-index --> 标记锚(与 init wireAgents 同构:标题文字可变——
 *  旧版锚定固定标题「## 代码检索纪律」,用户改过标题且未被新版 init 重写的旧部署会剥不掉残留),
 *  至下一个注入段标记或任意层级标题。
 *  S3-F1(2026-11-14 夜审,与已修 P2-15 同族):段后既无标记也无标题时,旧逻辑吞到文末,
 *  连段后无标题的用户纯文本一起删。收窄:段体以编号条目行结尾——尾部非编号行保留不删;
 *  段内无编号行(未知形态)维持旧行为(无法判定边界,保守不动)。 */
export function stripDisciplineSection(content) {
  const sectionRe = /<!-- code-index[^>]*-->[^\r\n]*\r?\n[^\r\n]*[\s\S]*?(?=\r?\n<!-- (?:code-index|ponytail|output-diet)[^>]* -->|\r?\n#{2,6} |$)/;
  const m = content.match(sectionRe);
  if (!m) return null;
  let cut = m[0];
  const rest = content.slice(m.index + m[0].length);
  const bounded = /\r?\n<!-- (?:code-index|ponytail|output-diet)[^>]* -->|\r?\n#{2,6} /.test('\n' + rest);
  if (!bounded) {
    const lines = cut.split(/\r?\n/);
    let last = -1;
    lines.forEach((l, i) => { if (/^\d+\.\s/.test(l)) last = i; });
    if (last >= 0 && last < lines.length - 1) cut = lines.slice(0, last + 1).join('\n');
  }
  return content.slice(0, m.index) + content.slice(m.index + cut.length);
}

/** 剥掉输出纪律段:优先按 init 写入的精确模板块移除(段后用户内容保留);
 *  模板被改过无法识别时,退化路径切到段后的下一个二级标题(段后用户内容保留),
 *  仅当段后无任何二级标题才切到文末(2026-11-10 二次审计 P2-15:旧退化路径 slice(0,idx) 会
 *  连纪律段之后的用户内容一起删掉,与 stripPonytailSection 同类问题同修)。 */
export function stripDietSection(content) {
  const m = content.match(/<!-- output-diet[^>]* -->/);
  if (!m) return { content, changed: false };
  const idx = m.index;
  let body = '';
  try {
    body = fs.readFileSync(path.join(here, 'output-diet.md'), 'utf8').trim();
  } catch { /* 模板不在,走退化路径 */ }
  if (body) {
    const block = `${m[0]}\n${body}\n`;
    const bIdx = content.indexOf(block);
    if (bIdx >= 0) return { content: content.slice(0, bIdx) + content.slice(bIdx + block.length), changed: true };
  }
  const nextHeading = content.indexOf('\n## ', idx + m[0].length);
  const end = nextHeading >= 0 ? nextHeading + 1 : content.length;
  return { content: content.slice(0, idx) + content.slice(end), changed: true };
}

/** 剥掉 ponytail 段(2026-11-03:模板文件已删,不再按精确块匹配):
 *  按写入形态切——标记 + 固定标题起,到下一个二级以上标题或文末,段后用户内容保留;
 *  形态不符(标记存在但找不到该标题)才退化为从标记切到文末(无法区分模板与段后内容)。
 *  旧实现的文件缺失退化路径会误删段后用户内容,此处一并修掉。 */
export function stripPonytailSection(content) {
  const idx = content.indexOf(PONYTAIL_MARK);
  if (idx < 0) return { content, changed: false };
  const headingStart = content.indexOf('## Ponytail 模式', idx);
  if (headingStart < 0) return { content: content.slice(0, idx), changed: true };
  const headingEnd = content.indexOf('\n', headingStart);
  const after = headingEnd >= 0 ? content.slice(headingEnd + 1) : '';
  const m = after.match(/\r?\n#{2,6} /);
  const end = m ? headingEnd + 1 + m.index : content.length;
  return { content: content.slice(0, idx) + content.slice(end), changed: true };
}

/**
 * 还原单个 AGENTS.md。返回:
 *   absent(无文件) / no-injection(无注入内容) / clean(剥离并保留原文) / deleted(只剩注入内容,整删)
 */
export function stripAgentsFile(agentsPath) {
  if (!fs.existsSync(agentsPath)) return 'absent';
  const orig = fs.readFileSync(agentsPath, 'utf8');
  let content = orig;
  const stripped = stripDisciplineSection(content);
  if (stripped !== null) content = stripped;
  const diet = stripDietSection(content);
  content = diet.content;
  const pony = stripPonytailSection(content);
  content = pony.content;
  if (!pony.changed && !diet.changed && stripped === null) return 'no-injection';
  content = content.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').trimEnd();
  if (!content.trim()) {
    rmIfExists(agentsPath);
    return 'deleted';
  }
  if (content !== orig) fs.writeFileSync(agentsPath, content.endsWith('\n') ? content : content + '\n');
  return 'clean';
}

// ---------- 主流程 ----------

function collectRoots() {
  const roots = [];
  const repoRoot = findGitRoot(here) || findGitRoot(process.cwd());
  if (repoRoot) roots.push(repoRoot);
  const cfg = readJson(path.join(DATA_DIR, 'code-index.config.json'));
  for (const r of (cfg && Array.isArray(cfg.roots) ? cfg.roots : [])) {
    const p = path.resolve(r);
    if (!roots.includes(p)) roots.push(p);
  }
  return roots;
}

/** 移除 init 播种的虚拟供应商条目(ZCode=tokenSaverModel,连同 providerOrder/modelRules 引用;
 *  Qoder=tokensaver-auto,providers 键下条目),真实供应商与其他配置不动。 */
export function removeVirtualProviderEntry({ home = os.homedir(), providerId = 'tokenSaverModel', qoder = false, zcodeV2Dir = null } = {}) {
  let file;
  if (qoder) {
    const dir = fs.existsSync(path.join(home, '.qoder-cn')) ? '.qoder-cn' : '.qoder';
    file = path.join(home, dir, 'settings.json');
  } else {
    // 路径自适应(2026-11-08):迁移数据路径后虚拟条目在新 v2 目录,恒读默认 ~/.zcode/v2 清不掉。
    // 定序与快照同源:zcodeV2Dir 显式传入 > home 显式非默认主目录(测试旧拼接)> resolveZcodeV2Dir 探测。
    const v2 = zcodeV2Dir
      || (home && home !== os.homedir() ? path.join(home, '.zcode', 'v2') : resolveZcodeV2Dir().dir);
    file = path.join(v2, 'provider_config.json');
  }
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (!raw) return { removed: false, note: qoder ? '无 Qoder settings.json' : '无 provider_config' };
  let pc;
  try { pc = JSON.parse(raw); } catch { return { removed: false, note: '宿主配置非合法 JSON,不动' }; }
  if (qoder) {
    if (!pc || typeof pc !== 'object' || !pc.providers || typeof pc.providers !== 'object' || !pc.providers[providerId]) return { removed: false, note: '无该条目' };
    fs.copyFileSync(file, file + '.bak-tokensaver');
    delete pc.providers[providerId];
    fs.writeFileSync(file, JSON.stringify(pc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    return { removed: true, file };
  }
  const rules = pc?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules) || !rules.some((r) => r?.providerId === providerId)) return { removed: false, note: '无该条目' };
  fs.copyFileSync(file, file + '.bak-tokensaver');
  pc.config.providerConfigRules.providerRules = rules.filter((r) => r?.providerId !== providerId);
  if (Array.isArray(pc.config.providerOrder)) pc.config.providerOrder = pc.config.providerOrder.filter((id) => id !== providerId);
  const modelRules = pc.config.modelConfigRules?.providerModelRules;
  if (Array.isArray(modelRules)) pc.config.modelConfigRules.providerModelRules = modelRules.filter((x) => x?.providerId !== providerId);
  fs.writeFileSync(file, JSON.stringify(pc, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
  return { removed: true, file };
}

function main() {
  say('==== TokenSaver 卸载部署 ====');

  say('[1/5] 读取部署清单(data/code-index.config.json)');
  const roots = collectRoots();
  if (!roots.length) say('  [warn] 未找到任何已部署项目(无 roots、无 git 根)');
  else say(`  [ok] ${roots.length} 个项目:${roots.map(r => path.basename(r)).join(', ')}`);

  say('[2/5] 移除用户级钩子(无 workspace 信任门控的那份)');
  const zk = uninstallZcodeUserHooks();
  say(`  [ok] ZCode:${zk.touched ? `移除 ${zk.groups} 组钩子` : '无本模块钩子'}${zk.fileDeleted ? ',空壳配置已删除' : ''}(${zk.file})`);
  const vp = removeVirtualProviderEntry();
  say(`  [ok] ZCode:${vp.removed ? '已移除虚拟供应商条目 tokenSaverModel' : `虚拟供应商条目:${vp.note}`}`);
  const cu = uninstallCursorUserHooks();
  say(`  [ok] Cursor:${cu.touched ? `移除 ${cu.groups} 组钩子、${cu.forwarders} 个转发器` : '无本模块钩子'}${cu.fileDeleted ? ',空壳配置已删除' : ''}(${cu.file})`);
  const qd = uninstallQoderUserHooks();
  say(`  [ok] Qoder:${qd.touched ? `移除 ${qd.groups} 组钩子、${qd.forwarders} 个转发器` : '无本模块钩子'}${qd.fileDeleted ? ',空壳配置已删除' : ''}(${qd.file})`);
  const vq = removeVirtualProviderEntry({ providerId: 'tokensaver-auto', qoder: true });
  say(`  [ok] Qoder:${vq.removed ? '已移除虚拟供应商条目 tokensaver-auto' : `虚拟供应商条目:${vq.note}`}`);

  say('[3/5] 清理各项目工作区钩子残留');
  for (const r of roots) {
    const name = path.basename(r);
    if (!fs.existsSync(r)) { say(`  [skip] [${name}] 目录不存在`); continue; }
    cleanZcodeWorkspaceHooks(r);
    cleanCursorWorkspaceHooks(r);
    cleanQoderWorkspaceHooks(r);
  }

  say('[4/5] 还原各项目 AGENTS.md(剥除注入段,保留用户内容)');
  for (const r of roots) {
    const name = path.basename(r);
    const agentsPath = path.join(r, 'AGENTS.md');
    const st = stripAgentsFile(agentsPath);
    if (st === 'absent') say(`  [skip] [${name}] 无 AGENTS.md`);
    else if (st === 'no-injection') say(`  [skip] [${name}] 无注入内容`);
    else if (st === 'deleted') say(`  [ok] [${name}] 文件仅含注入内容,已整文件删除`);
    else say(`  [ok] [${name}] 已剥除纪律段与输出纪律段(含旧 ponytail),用户内容保留`);
  }

  say('[5/5] 清理运行时痕迹');
  const pf = path.join(DATA_DIR, '.prefetch-last.json');
  if (rmIfExists(pf)) say('  [ok] data/.prefetch-last.json 已删除');
  else say('  [skip] 无预取状态');

  const mx = uninstallMemorix();
  const mxMcp = removeMemorixMcp();
  const qxMcp = removeQoderMemorixMcp();
  const cxMcp = removeCursorMemorixMcp();
  say(`  [${mx.removedPkg || mx.removedCfg ? 'ok' : 'skip'}] Memorix:${mx.removedPkg ? '已删本地包(code-index/vendor/memorix)' : '未装/卸载跳过'}${mx.removedCfg ? ',config.toml 已删' : ''}${mxMcp.removed ? ',ZCode MCP 注册已摘' : ''}${qxMcp.removed ? ',Qoder MCP 注册已摘' : ''}${cxMcp.removed ? ',Cursor MCP 注册已摘' : ''};数据目录 ~/.memorix/ 保留(手动可删);全局 npm 环境不动(自装的全局 memorix 不代卸)`);

  say('============ 卸载完成 ============');
  say('未动:data/(索引、节约账、read-guard 记录)、code-index/ 本体、CODE_MAP.md、.gitignore、用户自己的 skills 与其他工具的钩子');
  say('保留:用户级环境变量 OLLAMA_MAX_LOADED_MODELS(init 设=5,良性 Ollama 驻留调优、可能用户自设,不回退)');
  say('需要彻底清数据请手动删除 data/;重新部署:node init.mjs');
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main();
