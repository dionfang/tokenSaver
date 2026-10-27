#!/usr/bin/env node
/**
 * Cursor afterAgentResponse: 读取大模型 API 返回的 output_tokens。
 * 节约量 = output_tokens ÷ 0.674 × 0.326,累进 data/session-savings.json。
 * stdout 保持空。失败不阻断会话。
 */
import { addObservedOutputTokens } from './modelStatus.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw) addObservedOutputTokens(JSON.parse(raw));
} catch { /* 没有输出 token 时不记账 */ }
