#!/usr/bin/env node
/**
 * 账本修复 CLI(2026-11-11 加固):session-savings.json 与 usage/turns.jsonl 对账,缺口自动回补。
 * 读账自愈已内置在每次 readDoc(每进程一次);本 CLI 供断电/异常后手动触发与巡检:
 *   node rebuild-savings.mjs
 */
import { repairSavingsLedger } from './modelStatus.mjs';

try {
  const r = repairSavingsLedger();
  console.log(`[ok] session-savings 对账完成:${r.dayCount} 天,总计 ${r.total} tokens${r.changed ? '(缺口已按 usage/turns.jsonl 回补)' : '(账本完好,未改动)'}`);
} catch (e) {
  console.error(`[err] 修复失败:${e?.message || e}`);
  process.exit(1);
}
