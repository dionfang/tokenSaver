/**
 * 动态模型路由 MCP stdio server(model-routing.md #10):JSON-RPC 2.0 over stdio(换行分隔)。
 * 工具:routing_decision(prompt→级联分类建议)/model_health(查/标/清冷却)/usage_report(用量聚合)。
 * 独立进程,不改任何既有代码;注册由人工在 ZCode 配置 mcp.servers 添加(见 model-routing.md #10)。
 * 协议冒烟:echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node modelRouteMcp.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { classifyRoute, l2EmbedFn, tierOfModel, tierClassifyOptions } from './modelRoute.mjs';
import { readHealth, markHealth, clearHealth } from './modelRoute.mjs';
import { blendedRate, loadModelPrices } from './costProfile.mjs';

const SERVER_INFO = { name: 'model-route-mcp', version: '1.0.0' };

function usageReport({ dataDir = DATA_DIR } = {}) {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const au = read(path.join(dataDir, 'usage', 'agent-usage.jsonl'));
  const byTool = {};
  for (const r of au) {
    const t = byTool[r.tool] = byTool[r.tool] || { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, credits: 0 };
    t.records += 1;
    t.inputTokens += r.inputTokens || 0;
    t.outputTokens += r.outputTokens || 0;
    t.cacheReadTokens += r.cacheReadTokens || 0;
    t.credits += r.credits || 0;
  }
  const rl = read(path.join(dataDir, 'usage', 'routing-log.jsonl'));
  const types = {};
  for (const r of rl) types[r.type ?? 'uncertain'] = (types[r.type ?? 'uncertain'] || 0) + 1;
  // 代理账本按档位聚合(2026-11-06 v4):复用 blendedRate 单一价格口径(rowCost 按 model-prices.json
  // 四档表计价,tier 缺失按 tierOfModel 推档);费率表缺失时 rate/cost 为 null,byTier 仍按档计数。
  let proxyUsage = null;
  try {
    const prices = loadModelPrices({ dataDir });
    const tcls = tierClassifyOptions(null, dataDir);
    const r = blendedRate({ rows: read(path.join(dataDir, 'usage', 'proxy-usage.jsonl')), priceTable: prices, tierOf: (m) => tierOfModel(m, tcls) });
    proxyUsage = { reqs: r.reqs, failed: r.failed, rate: r.rate, actualCost: r.actualCost, baseCost: r.baseCost, byTier: r.byTier };
  } catch { /* 档位聚合失败不影响其余报表段 */ }
  return { agentUsage: byTool, routingLog: { records: rl.length, typeDistribution: types }, proxyUsageByTier: proxyUsage };
}

const TOOLS = [
  {
    name: 'routing_decision',
    description: '动态模型路由:对用户 prompt 做任务类型分类(L1 规则→L2 向量;L2 需 modelRouting.l2Shadow=true 才通电,默认跳过;L3 已于 2026-11-03 取消,语义兜底由四档分档承担),返回类型与置信度。主路由由本地代理(modelRouteProxy.mjs)按 turn 改写 model,本工具供查询与审计(role 两档制与角色子代理形态均已废弃)。',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: '用户 prompt 原文' } }, required: ['prompt'] },
  },
  {
    name: 'model_health',
    description: '查询/标记/清除模型冷却状态(配额或限流后滑动降级用)。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'mark', 'clear'] },
        modelKey: { type: 'string', description: 'providerId/modelId' },
        reason: { type: 'string' },
        ttlMinutes: { type: 'number' },
      },
    },
  },
  {
    name: 'usage_report',
    description: '用量与路由报表:agent-usage 按工具聚合 + routing-log 类型分布 + 代理账本按档位聚合(proxyUsageByTier:各档 reqs/tokens 与综合费率,价格口径=model-prices.json)。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === 'routing_decision') {
    if (!args.prompt) return { error: '缺少 prompt' };
    // L2 需要 embedFn 才会跑(默认关:见 modelRoute.l2Shadow);不传则级联为 L1→(跳过 L2)→L3
    return await classifyRoute(args.prompt, { embedFn: await l2EmbedFn() });
  }
  if (name === 'model_health') {
    const action = args.action || 'list';
    if (action === 'list') return readHealth().models || {};
    if (action === 'mark') {
      if (!args.modelKey) return { error: '缺少 modelKey' };
      return { marked: markHealth({ modelKey: args.modelKey, reason: args.reason || '', ttlMs: (args.ttlMinutes || 30) * 60000 }) };
    }
    if (action === 'clear') {
      if (!args.modelKey) return { error: '缺少 modelKey' };
      return { cleared: clearHealth({ modelKey: args.modelKey }) };
    }
    return { error: `未知 action: ${action}` };
  }
  if (name === 'usage_report') return usageReport();
  return { error: `未知工具: ${name}` };
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return null;
  if (msg.method === 'initialize') {
    return { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (msg.method === 'tools/list') {
    return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    let result;
    try { result = await callTool(name, args || {}); } catch (e) { result = { error: e.message }; }
    return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
  }
  if (msg.id !== undefined) {
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } };
  }
  return null; // 通知不回
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buffer += c;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).then((out) => {
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }).catch(() => { /* 单条失败不影响服务 */ });
  }
});
process.stdin.on('end', () => process.exit(0));
