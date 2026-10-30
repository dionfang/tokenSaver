#!/usr/bin/env node
/**
 * 卸载部署:移除 init.mjs 装到各处的钩子与注入段,逐步在命令行回显状态。
 *   node uninit.mjs
 *
 * 做这些事(每完成一步输出一行 [ok]/[skip]):
 *   1) 读取部署清单(data/code-index.config.json 的 roots + 工具仓自身)
 *   2) 移除用户级钩子:ZCode ~/.zcode/cli/config.json、Cursor ~/.cursor/hooks.json(+转发器)、
 *      Qoder ~/.qoder-cn/settings.json(+转发器,国际版 ~/.qoder)。文件只剩本模块骨架则整删;
 *      含其他配置(如 ZCode 的 plugins)只摘钩子条目,文件保留
 *   3) 防御性清理各项目工作区钩子残留(.zcode/.cursor/.qoder 里本模块的条目与转发器)
 *   4) 还原各项目 AGENTS.md:剥掉纪律段(<!-- code-index -->)与输出纪律段(<!-- output-diet -->;兼容剥旧 ponytail 段);
 *      剥完只剩空白 → 整文件删除;有用户内容 → 保留其余原文
 *   5) 清理运行时痕迹(data/.prefetch-last.json)
 *
 * 不动:data/(索引、节约账、read-guard 记录)、code-index/ 本体、CODE_MAP.md、.gitignore、
 *       用户自己的 skills 与其他工具的钩子。重新部署:node init.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, findGitRoot } from './config.mjs';
import {
  isCodeIndexHookRef,
  isOurZcodeHook,
  dropHookGroups,
  cleanCursorWorkspaceHooks,
  cleanQoderWorkspaceHooks,
  cleanZcodeWorkspaceHooks,
} from './init.mjs';

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

const CURSOR_FORWARDERS = ['warm-code-index.mjs', 'prompt-guard.mjs', 'read-guard.mjs', 'read-nudge.mjs', 'commit-refresh.mjs', 'output-savings.mjs'];
const QODER_FORWARDERS = ['session-start.mjs', 'prompt-guard.mjs', 'commit-refresh.mjs', 'read-guard.mjs', 'read-nudge.mjs', 'output-savings.mjs'];

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

/** 剥掉纪律段:<!-- code-index --> 标记起,至下一个注入段标记或任意层级标题。 */
export function stripDisciplineSection(content) {
  const sectionRe = /<!-- code-index[^>]*-->\s*## 代码检索纪律[\s\S]*?(?=\r?\n<!-- (?:ponytail|output-diet)[^>]* -->|\r?\n#{2,6} |$)/;
  if (!sectionRe.test(content)) return null;
  return content.replace(sectionRe, '');
}

/** 剥掉输出纪律段:优先按 init 写入的精确模板块移除(段后用户内容保留);
 *  模板被改过无法识别时退化为从标记切到文末(与 ponytail 剥离同语义)。 */
export function stripDietSection(content) {
  const m = content.match(/<!-- output-diet[^>]* -->/);
  if (!m) return { content, changed: false };
  const idx = m.index;
  let body = '';
  try {
    body = fs.readFileSync(path.join(here, 'output-diet.md'), 'utf8').trim();
  } catch { /* 模板不在,退化为切到文末 */ }
  if (body) {
    const block = `${m[0]}\n${body}\n`;
    const bIdx = content.indexOf(block);
    if (bIdx >= 0) return { content: content.slice(0, bIdx) + content.slice(bIdx + block.length), changed: true };
  }
  return { content: content.slice(0, idx), changed: true };
}

/** 剥掉 ponytail 段:优先按 init 写入的精确模板块移除(段后用户内容保留);
 *  模板被用户改过无法识别时退化为从标记切到文末(此时无法区分模板与段后内容)。 */
export function stripPonytailSection(content) {
  const idx = content.indexOf(PONYTAIL_MARK);
  if (idx < 0) return { content, changed: false };
  let body = '';
  try {
    body = fs.readFileSync(path.join(here, 'ponytail.md'), 'utf8').trim();
  } catch { /* 模板不在,退化为切到文末 */ }
  if (body) {
    const block = `${PONYTAIL_MARK}\n## Ponytail 模式（懒惰资深开发者规则）\n\n${body}\n`;
    const bIdx = content.indexOf(block);
    if (bIdx >= 0) return { content: content.slice(0, bIdx) + content.slice(bIdx + block.length), changed: true };
  }
  return { content: content.slice(0, idx), changed: true };
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

function main() {
  say('==== TokenSaver 卸载部署 ====');

  say('[1/5] 读取部署清单(data/code-index.config.json)');
  const roots = collectRoots();
  if (!roots.length) say('  [warn] 未找到任何已部署项目(无 roots、无 git 根)');
  else say(`  [ok] ${roots.length} 个项目:${roots.map(r => path.basename(r)).join(', ')}`);

  say('[2/5] 移除用户级钩子(无 workspace 信任门控的那份)');
  const zk = uninstallZcodeUserHooks();
  say(`  [ok] ZCode:${zk.touched ? `移除 ${zk.groups} 组钩子` : '无本模块钩子'}${zk.fileDeleted ? ',空壳配置已删除' : ''}(${zk.file})`);
  const cu = uninstallCursorUserHooks();
  say(`  [ok] Cursor:${cu.touched ? `移除 ${cu.groups} 组钩子、${cu.forwarders} 个转发器` : '无本模块钩子'}${cu.fileDeleted ? ',空壳配置已删除' : ''}(${cu.file})`);
  const qd = uninstallQoderUserHooks();
  say(`  [ok] Qoder:${qd.touched ? `移除 ${qd.groups} 组钩子、${qd.forwarders} 个转发器` : '无本模块钩子'}${qd.fileDeleted ? ',空壳配置已删除' : ''}(${qd.file})`);

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

  say('============ 卸载完成 ============');
  say('未动:data/(索引、节约账、read-guard 记录)、code-index/ 本体、CODE_MAP.md、.gitignore、用户自己的 skills 与其他工具的钩子');
  say('需要彻底清数据请手动删除 data/;重新部署:node init.mjs');
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main();
