#!/usr/bin/env node
/**
 * 注解库体检(纪律段第 6 条指定的写后校验;防死链反复,2026-11-10 建立):
 *   - 死链:键必须精确命中 index.json 的文件路径,否则 details.mjs 永不显示该注解;
 *   - 长度:注解文本 ≤50 字。
 * 死链时按后缀在索引里找候选(优先源 code-index/ 而非 npm/ 镜像)提示改法。
 * 纯函数 deadKeys 数据无关,供 test/annotationCheck.test.mjs 用;CLI 读本地 data/。
 * 用法:node annotationCheck.mjs(退出码 0=健康,1=有死链/超长)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnownAnnotations, DATA_DIR } from './config.mjs';

/** 给定注解表与索引文件路径列表,返回 { dead: [{key, suggest}], over: [{key, len}] }。 */
export function deadKeys(ann, indexFiles = []) {
  const set = new Set(indexFiles);
  const bySuffix = new Map();
  for (const f of indexFiles) {
    const segs = f.split('/');
    for (let i = 1; i < segs.length; i++) {
      const suf = segs.slice(i).join('/');
      if (!bySuffix.has(suf)) bySuffix.set(suf, []);
      bySuffix.get(suf).push(f);
    }
  }
  const dead = [];
  const over = [];
  for (const [k, v] of Object.entries(ann)) {
    if (set.has(k)) {
      if (typeof v === 'string' && v.length > 50) over.push({ key: k, len: v.length });
      continue;
    }
    const segs = k.split('/');
    let cands = null;
    for (let i = 1; i < segs.length; i++) {
      const suf = segs.slice(i).join('/');
      if (bySuffix.has(suf)) { cands = bySuffix.get(suf); break; }
    }
    if (!cands) cands = [];
    const preferSrc = cands.filter((c) => !c.includes('/npm/'));
    dead.push({ key: k, suggest: (preferSrc.length ? preferSrc : cands).slice(0, 3) });
  }
  return { dead, over };
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directRun) {
  const files = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'index.json'), 'utf8')).files.map((f) => f.p);
  const ann = loadKnownAnnotations();
  const { dead, over } = deadKeys(ann, files);
  if (!dead.length && !over.length) {
    console.log(`[ok] 注解库健康:${Object.keys(ann).length} 条全部命中索引且 ≤50 字`);
    process.exit(0);
  }
  if (dead.length) {
    console.error(`[err] 死链 ${dead.length} 条(键命中不了索引,details.mjs 永不显示;若属索引陈旧先重跑 build.mjs):`);
    for (const d of dead) {
      console.error('  - ' + d.key);
      for (const s of d.suggest) console.error('      候选: ' + s);
    }
  }
  for (const o of over) console.error(`[err] 超 50 字:${o.key}(${o.len} 字)`);
  process.exit(1);
}