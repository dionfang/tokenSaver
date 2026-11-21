#!/usr/bin/env node
/** auto×费率刷名挂载点锚(20261120 用户裁定:SessionStart 迁到 6h 黄金集代签自动拉起)。
 *  源码锚断言(杀两类突变):①刷名重启回 SessionStart;②6h grow 分支丢刷名。只读源码,全密闭。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.resolve(here, '..', '..', 'code-index', rel), 'utf8');

const autoSrc = src('auto.mjs');
const guardSrc = src('prompt-guard.mjs');

// ① SessionStart 不再刷名(旧调用点已摘除:不许 import virtualProvider、不许 refreshAutoModelName 调用)
assert.ok(!/import\('\.\/virtualProvider\.mjs'\)/.test(autoSrc), 'auto.mjs 无 virtualProvider 动态导入(SessionStart 已摘除)');
assert.ok(!/refreshAutoModelName\s*\(\{\s*rate/.test(autoSrc), 'auto.mjs 无刷名调用(仅可留迁移注释)');

// ② 6h grow 分支内必须调用(与黄金集代签自动拉起同拍)
assert.ok(/grown\.state === 'grown'/.test(guardSrc), 'grow 分支存在');
const grownBlock = guardSrc.slice(guardSrc.indexOf("grown.state === 'grown'"));
assert.match(grownBlock, /refreshAutoNameFromBlend/, 'grow 成功分支调用 refreshAutoNameFromBlend');

// ③ 偏差死区(20261121 用户裁定:与当前条目倍率偏差 <0.05 不刷,防一天 4 次列表重载)——临时 home 实弹
{
  const { refreshAutoNameFromBlend } = await import('../../code-index/virtualProvider.mjs');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anr-'));
  fs.mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  // 当前条目 auto×0.150;blend 0.151(偏差 0.001<0.05)→跳过;blend 0.22(偏差 0.07)→刷新
  const pc = { config: { providerConfigRules: { providerRules: [{ providerId: 'tokenSaverModel', providerName: 'TokenSaver', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'tokensaver-placeholder' }, api: { type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8117/apps/zcode' }, personalModelIds: ['auto×0.150'], modelOrder: ['auto×0.150'] } }] } } };
  fs.writeFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify(pc, null, 2));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anr-data-'));
  fs.mkdirSync(path.join(dataDir, 'usage'), { recursive: true });
  const blendAt = (r) => fs.writeFileSync(path.join(dataDir, 'usage', 'auto-blend.json'), JSON.stringify({ globalRate: r }));
  blendAt(0.151);
  const skip = refreshAutoNameFromBlend({ dataDir, home });
  assert.equal(skip.changed, false, '偏差 0.001<0.05 不刷新');
  assert.ok(/0\.05/.test(skip.note || ''), `跳过附死区说明:${skip.note}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8')).config.providerConfigRules.providerRules[0].config.personalModelIds[0], 'auto×0.150', '跳过时条目名不动');
  blendAt(0.22);
  const go = refreshAutoNameFromBlend({ dataDir, home });
  assert.equal(go.changed, true, '偏差 0.07≥0.05 刷新');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8')).config.providerConfigRules.providerRules[0].config.personalModelIds[0], 'auto×0.220', '刷新后条目名跟新倍率');
  // 无当前倍率(纯 auto 条目)→ 不设防照常刷(播种/首刷不受死区拦)
  fs.writeFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'tokenSaverModel', providerName: 'TokenSaver', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'tokensaver-placeholder' }, api: { type: 'anthropic-messages', baseUrl: 'http://127.0.0.1:8117/apps/zcode' }, personalModelIds: ['auto'], modelOrder: ['auto'] } }] } } }, null, 2));
  blendAt(0.151);
  const first = refreshAutoNameFromBlend({ dataDir, home });
  assert.equal(first.changed, true, '纯 auto 条目无当前倍率,不设防照常刷');
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('[ok] autoNameRefresh.test.mjs 全部通过(挂载点锚 + 偏差死区实弹)');