#!/usr/bin/env node
/**
 * 三端钩子配置状态判定(tray 方案 §5.3.4,2026-11-15):ZCode/Cursor/Qoder 用户级钩子是否接线正确。
 *   node hooksStatus.mjs [--home <dir>]     # stdout JSON;exit 恒 0(只读,托盘解析 stdout)
 * 单一真源铁律:谓词复用 init.mjs 现成 export(isOurZcodeHook/isCodeIndexHookRef),判定=写入逻辑的镜像,
 * 禁止复制正则;数据面只读宿主配置与转发器文件,不 import modelStatus(避免拉起 Ollama 探测,§20.2-P3-3)。
 * 灯口径:🟢 预期事件全到位且指向文件存在 / 🔴 缺事件或缺文件或配置损坏 / ⚪ 宿主未装(配置文件不存在,不判红)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOurZcodeHook, isCodeIndexHookRef, qoderUserDir, USER_FORWARDER_FILES } from './init.mjs';

/** init.mjs 各端装配的预期事件清单(判定=写入镜像;改动 rewrite*UserHooks 时同步此表)。 */
const EXPECTED_EVENTS = {
  zcode: ['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PreToolUse', 'Stop'],
  cursor: ['sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'beforeShellExecution', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse'],
  qoder: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'Stop'],
};

/** 每个事件至少要有这么多条本模块钩子(与 init rewrite* 写入条数一致)。
 *  只要求「有一条」会把少挂一组(如 PostToolUse 只剩 read-nudge)判成绿。 */
const MIN_OURS = {
  zcode: { SessionStart: 1, PostToolUse: 2, PostToolUseFailure: 1, UserPromptSubmit: 2, PreToolUse: 1, Stop: 1 },
  cursor: { sessionStart: 1, beforeSubmitPrompt: 1, preToolUse: 2, beforeShellExecution: 1, postToolUse: 2, postToolUseFailure: 1, afterAgentResponse: 1 },
  qoder: { SessionStart: 3, UserPromptSubmit: 2, PostToolUse: 2, PostToolUseFailure: 1, PreToolUse: 1, Stop: 1 },
};

const readJson = (file) => {
  if (!fs.existsSync(file)) return { missing: true };
  try { return { cfg: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { broken: String(e.message).slice(0, 120) }; }
};

/** 从命令串提取 .mjs 脚本路径(`node C:/x/y.mjs` / `C:\Users\First Last\...` / 引号包裹)。
 *  旧正则 `[^\s"']+` 在用户目录含空格时截断 → brokenRefs 误红。
 *  盘符路径必须带 `[A-Za-z]:` 前缀,禁止裸 `/Users/...` 从 `C:/Users` 中误切。 */
export function scriptRefsIn(cmd) {
  const s = String(cmd || '');
  const out = [];
  for (const m of s.matchAll(/"([^"]+\.mjs)"|'([^']+\.mjs)'/g)) out.push(m[1] || m[2]);
  if (out.length) return [...new Set(out)];
  // Windows 盘符绝对路径(路径段内允许空格)
  for (const m of s.matchAll(/[A-Za-z]:(?:[\\/][^\\/:*?"<>|\r\n]+)*[\\/][^\\/:*?"<>|\r\n]+\.mjs/g)) out.push(m[0]);
  // POSIX 绝对路径(仅空白后的 / 起头,避免吃到 C:/ 的尾巴)
  for (const m of s.matchAll(/(?:^|[\s])(\/(?:[^\/\s:*?"<>|\r\n]+\/)*[^\/\s:*?"<>|\r\n]+\.mjs)/g)) out.push(m[1]);
  // 相对 hooks/foo.mjs(仅当还没有绝对命中;避免空格路径段被二次切成假相对路径)
  if (!out.length) {
    for (const m of s.matchAll(/(?:^|[\s])((?:[\w.-]+[\\/])+[\w.-]+\.mjs)(?=\s|$)/g)) out.push(m[1]);
  }
  return [...new Set(out)];
}

const lamp = (host, configPath, cfgRes, detail) => {
  if (cfgRes.missing) return { host, state: 'absent', form: null, missingEvents: [], brokenRefs: [], forwardersMissing: [], configPath };
  const { missingEvents = [], brokenRefs = [], forwardersMissing = [], form = null } = detail;
  const state = (missingEvents.length || brokenRefs.length || forwardersMissing.length || cfgRes.broken) ? 'red' : 'green';
  return { host, state, form, missingEvents, brokenRefs, forwardersMissing, configPath, ...(cfgRes.broken ? { note: `JSON 解析失败:${cfgRes.broken}` } : {}) };
};

function assessZcode(home) {
  const configPath = path.join(home, '.zcode', 'cli', 'config.json');
  const cfgRes = readJson(configPath);
  if (cfgRes.missing || cfgRes.broken) return lamp('zcode', configPath, cfgRes, {});
  const events = cfgRes.cfg?.hooks?.events && typeof cfgRes.cfg.hooks.events === 'object' ? cfgRes.cfg.hooks.events : {};
  const missingEvents = [], brokenRefs = [];
  let form = 'node';
  for (const ev of EXPECTED_EVENTS.zcode) {
    const groups = Array.isArray(events[ev]) ? events[ev] : [];
    const ours = groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter(isOurZcodeHook);
    const need = MIN_OURS.zcode[ev] ?? 1;
    if (ours.length < need) { missingEvents.push(ev); continue; }
    for (const h of ours) {
      form = h.command === 'node' ? form : 'relay'; // relay 形:command=中继 exe,脚本在 args[0];node 形:直启
      for (const ref of [...(h.command !== 'node' ? [h.command] : []), ...(Array.isArray(h.args) ? h.args.filter((a) => typeof a === 'string' && a.endsWith('.mjs')) : [])]) {
        if (!fs.existsSync(ref)) brokenRefs.push(ref);
      }
    }
  }
  return lamp('zcode', configPath, cfgRes, { missingEvents, brokenRefs, form });
}

/** Cursor/Qoder 共用:判 ours=isCodeIndexHookRef(command)。Cursor 单层(hooks.<event>=[hook]),
 *  Qoder 双层(hooks.<event>=[{hooks:[hook]}],与 init 的 prepend(事件,{hooks:[qoderCmd…]) 对应)→ 两层兼容展开。 */
function assessForwarderHost({ host, configPath, cfgRes, hooksRoot, expected, forwarders }) {
  if (cfgRes.missing || cfgRes.broken) return lamp(host, configPath, cfgRes, {});
  const hooks = cfgRes.cfg?.hooks && typeof cfgRes.cfg.hooks === 'object' ? cfgRes.cfg.hooks : {};
  const missingEvents = [], brokenRefs = [], forwardersMissing = [];
  for (const ev of expected) {
    const entries = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const ours = entries
      .flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : [e]))
      .filter((h) => isCodeIndexHookRef(h?.command));
    const need = MIN_OURS[host]?.[ev] ?? 1;
    if (ours.length < need) { missingEvents.push(ev); continue; }
    for (const h of ours) for (const ref of scriptRefsIn(h.command)) if (!fs.existsSync(ref)) brokenRefs.push(ref);
  }
  for (const f of forwarders) if (!fs.existsSync(path.join(hooksRoot, f))) forwardersMissing.push(f);
  return lamp(host, configPath, cfgRes, { missingEvents, brokenRefs, forwardersMissing, form: 'node' });
}

const assessCursor = (home) => assessForwarderHost({
  host: 'cursor',
  configPath: path.join(home, '.cursor', 'hooks.json'),
  cfgRes: readJson(path.join(home, '.cursor', 'hooks.json')),
  hooksRoot: path.join(home, '.cursor', 'hooks'),
  expected: EXPECTED_EVENTS.cursor,
  forwarders: [...USER_FORWARDER_FILES.cursor.current],
});

const assessQoder = (home) => {
  const userDir = qoderUserDir(home);
  return assessForwarderHost({
    host: 'qoder',
    configPath: path.join(userDir, 'settings.json'),
    cfgRes: readJson(path.join(userDir, 'settings.json')),
    hooksRoot: path.join(userDir, 'hooks'),
    expected: EXPECTED_EVENTS.qoder,
    forwarders: [...USER_FORWARDER_FILES.qoder.current],
  });
};

/** 纯判定(供单测与 CLI):{ zcode, cursor, qoder }。 */
export function assessHooksStatus({ home = os.homedir() } = {}) {
  return { zcode: assessZcode(home), cursor: assessCursor(home), qoder: assessQoder(home) };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) {
  const homeIdx = process.argv.indexOf('--home');
  const home = homeIdx > -1 ? process.argv[homeIdx + 1] : os.homedir();
  console.log(JSON.stringify(assessHooksStatus({ home }), null, 1));
}
