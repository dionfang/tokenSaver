#!/usr/bin/env node
/**
 * 部署产物一致性门禁:校验本仓 AGENTS.md 的两个注入段是否等于当前代码库模板。
 *   node deploySync.mjs [--root 仓库根] [--json]
 *   node deploySync.mjs --selftest
 *
 * 规则 10 的执行体:改了 init.mjs 纪律段 / output-diet.md / 段生成逻辑后,先 npm test 全绿,
 * 再跑本门禁;不一致会逐条列出差异,按提示重新运行 `node init.mjs` 全盘部署即可。
 * 比较用「段落多重集」(排序后逐段比),对段落顺序调整和空白差异免疫。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGitRoot, DATA_DIR } from './config.mjs';
import { disciplineBlock, DIET_MARK, dietBlock } from './init.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const DISC_RE = /<!-- code-index[^>]*-->\s*## 代码检索纪律[\s\S]*?(?=\r?\n<!-- (?:ponytail|output-diet)[^>]* -->|\r?\n## |$)/;
const DIET_RE = /<!-- output-diet[^>]* -->[\s\S]*$/;

/** 段落多重集:归行符、按空行切段、去首尾空白、过滤空段。 */
function paras(text) {
  return text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
}

/** 比较 expected 与 actual 段落(多集),返回问题列表;有差异即不同步。 */
export function diffSection(name, expected, actual) {
  const a = paras(expected).sort();
  const b = paras(actual).sort();
  const issues = [];
  const pool = new Map();
  for (const p of a) pool.set(p, (pool.get(p) || 0) + 1);
  for (const p of b) pool.set(p, (pool.get(p) || 0) - 1);
  const missing = [], extra = [];
  for (const [p, n] of pool) {
    if (n > 0) for (let i = 0; i < n; i++) missing.push(p);
    else if (n < 0) for (let i = 0; i < -n; i++) extra.push(p);
  }
  for (const p of missing) issues.push(`${name}:缺少/已改段 ⇒ ${p.slice(0, 120)}`);
  for (const p of extra) issues.push(`${name}:AGENTS.md 多出/旧段 ⇒ ${p.slice(0, 120)}`);
  return issues;
}

/** 校验一段 AGENTS.md 全文;返回 { ok, issues }。 */
export function checkAgents(content, { rel = 'code-index', dataRel = 'data', packed = false } = {}) {
  const issues = [];
  const text = stringify(content);
  const discExpected = disciplineBlock({ rel, dataRel, packed });
  const dietExpected = dietBlock(path.join(here));
  const discActual = text.match(DISC_RE)?.[0];
  const dietActual = text.match(DIET_RE)?.[0];
  if (!discActual) issues.push('缺少检索纪律段(<!-- code-index... -->)');
  else issues.push(...diffSection('检索纪律段', discExpected, discActual));
  if (!dietActual) issues.push(`缺少输出纪律段(${DIET_MARK})`);
  else issues.push(...diffSection('输出纪律段', dietExpected, dietActual));
  if (text.includes('<!-- ponytail -->')) issues.push('残留旧 ponytail 段(init 会自动迁移剥离)');
  return { ok: issues.length === 0, issues };
}

function stringify(content) {
  // 传 Buffer 也接受,统一成字符串,省得调用方各自转
  return typeof content === 'string' ? content : content.toString('utf8');
}

function selftest() {
  const rel = 'code-index', dataRel = 'data';
  const disc = disciplineBlock({ rel, dataRel, packed: false });
  const diet = dietBlock(here);
  const good = `# 项目\n\n${disc}\n${diet}`;
  const base = checkAgents(good, { rel, dataRel });
  if (!base.ok) throw new Error('自检失败:正确样本被判不同步\n' + base.issues.join('\n'));
  // 段落顺序调整 → 仍同步(多集比较)
  const discParas = paras(disc);
  const shuffled = discParas.slice(0, 2).concat([discParas[discParas.length - 1]], discParas.slice(2, -1)).join('\n\n');
  if (!checkAgents(`# 项目\n\n${shuffled}\n${diet}`, { rel, dataRel }).ok) throw new Error('自检失败:段落换序被误判');
  // 删掉一条 → 判不同步且指出缺失段
  const dropped = discParas.filter((_, i) => i !== discParas.length - 1).join('\n\n');
  const r1 = checkAgents(`# 项目\n\n${dropped}\n${diet}`, { rel, dataRel });
  if (r1.ok || !r1.issues.some(x => x.includes('缺少/已改段'))) throw new Error('自检失败:删段未被识别');
  // 改一个字 → 判不同步
  const edited = discParas.map(p => (p.includes('部署产物同步') ? p.replace('部署产物同步', '部署产物同歩') : p)).join('\n\n');
  if (checkAgents(`# 项目\n\n${edited}\n${diet}`, { rel, dataRel }).ok) throw new Error('自检失败:改字未被识别');
  // 输出纪律段被改 → 判不同步
  const dietBad = diet.replace('直接写文件', '直接开始写文件');
  if (checkAgents(`# 项目\n\n${disc}\n${dietBad}`, { rel, dataRel }).ok) throw new Error('自检失败:输出纪律段差异未被识别');
  // 旧 ponytail 残留 → 判不同步
  if (checkAgents(`# 项目\n\n${disc}\n${diet}\n<!-- ponytail -->\n## Ponytail 模式\n\nold\n`, { rel, dataRel }).ok) throw new Error('自检失败:ponytail 残留未被识别');
  console.log('[selftest] deploySync ok');
}

if (argv.includes('--selftest')) {
  selftest();
  process.exit(0);
}

const root = path.resolve(opt('--root', findGitRoot(here) || process.cwd()));
const agentsPath = path.join(root, 'AGENTS.md');
const rel = path.relative(root, here).split(path.sep).join('/') || '.';
const dataRel = path.relative(root, DATA_DIR).split(path.sep).join('/') || '.';
if (!fs.existsSync(agentsPath)) {
  console.error(`[err] 找不到 ${agentsPath}`);
  process.exit(1);
}
const result = checkAgents(fs.readFileSync(agentsPath, 'utf8'), { rel, dataRel });
if (argv.includes('--json')) {
  console.log(JSON.stringify({ root, rel, dataRel, ...result }, null, 1));
} else if (result.ok) {
  console.log(`[ok] ${agentsPath} 的两个注入段与当前代码库模板一致(${rel})`);
} else {
  console.error(`[err] ${agentsPath} 与代码库模板不一致,共 ${result.issues.length} 处:`);
  for (const i of result.issues) console.error('  - ' + i);
  console.error(`\n修复:重新运行 node ${path.join(rel, 'init.mjs').split(path.sep).join('/')}(全盘部署,幂等:重写 hooks 与各仓 AGENTS.md),再跑本门禁`);
}
process.exit(result.ok ? 0 : 1);