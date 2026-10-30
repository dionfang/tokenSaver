#!/usr/bin/env node
/** input-ab 自检:真实格式回执解析、源码模板串不误报、合成 rollout 的反事实重放。 启动:cd code-index && npm test(或 node ../test/input-ab.test.mjs) */
/** 输入端反事实 A/B 的纯函数与自检入口。 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(here, 'scripts/input-ab.mjs')).href);

{
  // 真实回执格式:行与 ( 之间无空格,全角逗号
  const t = 'code-index: D:\\a\\b\\c.txt 共 641 行(~41 KB),超过全量 Read 上限 500 行(宽限至 625 行)。不要整文件 Read。先检索 `node search.mjs <关键词> --k 5`,再按该区间精读。若确实需要全文,5 分钟内对同一文件再发一次同样的全量 Read 即放行。';
  const r = mod.parseReceipt(t);
  assert.equal(r.kind, 'Read');
  assert.equal(r.lines, 641);
  assert.equal(r.kb, 41);
  assert.ok(t.match(/code-index: [\s\S]{0,2000}?即放行。/), '有界截取命中');
  const b = mod.parseReceipt('code-index: Bash 整读 a.txt b.txt 共 5001 行(~243 KB),超过全量读上限 500 行(宽限至 625 行)。替代方案:① 先检索;② head -n N;③ grep。确实需要全量输出时,5 分钟内重发同一命令即放行。');
  assert.equal(b.kind, 'Bash');
  assert.equal(b.kb, 243);
  // read-guard 源码里的模板串不是回执(占位符不是数字)
  assert.equal(mod.parseReceipt('`code-index: ${file} 共 ${lines} 行(~${kb} KB),超过全量 Read 上限 ${cap} 行(宽限至 ${slack} 行)。`'), null, '源码模板串不误报');
}

await mod.selftest();
console.log('[ok] input-ab.test.mjs');
