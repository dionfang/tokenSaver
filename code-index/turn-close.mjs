#!/usr/bin/env node
/**
 * ZCode/Qoder Stop 钩子:回合末结算 + 真实模型按回合落账(修 tokens 入账滞后)。
 * 载荷给 session_id;--host 由 init 接线时显式传入(zcode/qoder),用于 turns.jsonl 归属。
 * 不注入任何内容:stdout 空、exit 0(结算幂等,与 UserPromptSubmit/轮内状态句的结算互不重复)。
 * 失败一律静默,不阻塞回合收尾。
 */
import { settleTurn } from './turnStatus.mjs';

const argv = process.argv.slice(2);
const i = argv.indexOf('--host');
const host = i >= 0 && typeof argv[i + 1] === 'string' && argv[i + 1].trim() ? argv[i + 1].trim().toLowerCase() : 'zcode';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', async () => {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* 坏载荷只丢归属 */ }
  const sid = String(payload.sessionId || payload.session_id || payload.conversation_id || payload.conversationId || '').trim();
  try {
    settleTurn({ sid, host });
  } catch { /* 结算失败不影响回合收尾 */ }
  process.exit(0);
});