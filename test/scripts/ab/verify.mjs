#!/usr/bin/env node
/**
 * A/B 任务验收器。用法:
 *   node verify.mjs <task> <workdir>   打印 PASS / FAIL ...，exit 0/1
 *   node verify.mjs --selftest         用 fixtures/good 与 fixtures/bad 自测每个验收器
 *
 * --selftest 是硬约束:验收脚本自己也会有 bug(T4 曾把数组长度 3 误断言成 1)，
 * 任何 A/B 运行前必须先让它通过，否则会把 pass 判成 fail 或反过来。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORK_INPUT = '你好 世界\ntest abc\n\nx\na\tb c';

function run(args, input) {
  const r = spawnSync(process.execPath, args, { input, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim().slice(0, 300) };
}

function fail(msg) {
  return { ok: false, msg: `FAIL ${msg}` };
}

async function load(file) {
  return import(pathToFileURL(file).href);
}

/** 跑一个任务的验收。返回 {ok,msg};不退出进程，便于 --selftest 复用。 */
export async function verifyTask(task, work) {
  try {
    if (task === 't1') {
      const chars = [...WORK_INPUT.replace(/\n/g, '')].length;
      const words = WORK_INPUT.split(/\s+/).filter(Boolean).length;
      const lines = WORK_INPUT.split('\n').length;
      const r = run([path.join(work, 'wordcount.mjs')], WORK_INPUT);
      if (r.code !== 0) return fail(`exit ${r.code}: ${r.err}`);
      if (r.out !== `${chars} ${words} ${lines}`) {
        return fail(`expected "${chars} ${words} ${lines}", got "${r.out}"`);
      }
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't2') {
      const csv = fs.readFileSync(path.join(work, 'data.csv'), 'utf8');
      const nums = csv.split('\n').slice(1).filter(Boolean).map(Number);
      const mean = (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
      const max = Math.max(...nums).toFixed(2);
      const r = run([path.join(work, 'stats.mjs'), path.join(work, 'data.csv')]);
      if (r.code !== 0) return fail(`exit ${r.code}: ${r.err}`);
      if (r.out !== `${mean} ${max}`) return fail(`expected "${mean} ${max}", got "${r.out}"`);
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't3') {
      const m = await load(path.join(work, 'fib.mjs'));
      const fib = m.fib || m.default?.fib;
      if (!fib) return fail('找不到 fib 导出');
      const ref = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
      ref.forEach((v, n) => assert.equal(fib(n), v, `fib(${n})`));
      assert.equal(fib(40), 102334155, 'fib(40)');
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't4') {
      const m = await load(path.join(work, 'clone.mjs'));
      const dc = m.deepClone || m.default?.deepClone;
      if (!dc) return fail('找不到 deepClone 导出');
      const orig = { a: 1, b: [2, { c: 3 }], d: { e: [4, null, true] } };
      const cl = dc(orig);
      assert.deepStrictEqual(cl, orig);
      cl.b[1].c = 99;
      cl.d.e.push(5);
      assert.equal(orig.b[1].c, 3, '原对象嵌套值未被改动');
      assert.equal(orig.d.e.length, 3, '原对象数组未被改动');
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't5') {
      const m = await load(path.join(work, 'rle.mjs'));
      const enc = m.encode || m.default?.encode;
      const dec = m.decode || m.default?.decode;
      if (!enc || !dec) return fail('找不到 encode/decode 导出');
      assert.equal(enc('aaabcc'), 'a3b1c2');
      assert.equal(enc(''), '');
      assert.equal(dec('a10b2'), 'aaaaaaaaaabb');
      for (const s of ['a', 'ab', 'zzzz', 'abbccc']) assert.equal(dec(enc(s)), s, `roundtrip ${s}`);
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't6') {
      const m = await load(path.join(work, 'fmt.mjs'));
      const pad = m.pad || m.default?.pad;
      if (!pad) return fail('找不到 pad 导出');
      assert.equal(pad('ab', 5), 'ab   ', '右侧补齐');
      assert.equal(pad('abcdef', 4), 'abcd', '超长截断');
      assert.equal(pad('abc', 3), 'abc', '恰好等长');
      assert.equal(pad('', 2), '  ', '空串补齐');
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't7') {
      // 用例必须跑得过原实现,且把坏实现替换进来时用例必须能挂(边界覆盖探针)
      const testFile = path.join(work, 'util.test.mjs');
      if (!fs.existsSync(testFile)) return fail('util.test.mjs 不存在');
      const goodRun = run([ '--test', testFile ]);
      if (goodRun.code !== 0) return fail(`用例跑不过原实现: ${goodRun.err}`);
      const badImpl = path.join(here, 'fixtures', 'bad', 't7', 'escapeHtml.bad.mjs');
      if (!fs.existsSync(badImpl)) return fail('缺探针坏实现 fixture');
      const target = path.join(work, 'escapeHtml.mjs');
      const backup = fs.readFileSync(target, 'utf8');
      let badCaught = false;
      try {
        fs.copyFileSync(badImpl, target);
        badCaught = run([ '--test', testFile ]).code !== 0;
      } finally {
        fs.writeFileSync(target, backup);
      }
      if (!badCaught) return fail('用例拦不住坏实现,边界覆盖不足');
      return { ok: true, msg: 'PASS' };
    }

    if (task === 't8') {
      const m = await load(path.join(work, 'parseIni.mjs'));
      const p = m.parseIni || m.default?.parseIni;
      if (!p) return fail('找不到 parseIni 导出');
      const text = [
        '; top comment',
        'top = 1',
        '[db]',
        'host = localhost',
        'dsn = "a b"',
        'bad line no equals',
        '# hash comment',
      ].join('\n');
      const out = p(text);
      assert.equal(out.top, '1', '节外键');
      assert.equal(out.db.host, 'localhost', '节内键');
      assert.equal(out.db.dsn, 'a b', '去引号');
      assert.equal(Object.keys(out).length, 2, '只应有 top 与 db');
      assert.deepEqual(p(''), {}, '空文本');
      return { ok: true, msg: 'PASS' };
    }

    return fail(`unknown task ${task}`);
  } catch (e) {
    return fail(e.message);
  }
}

async function selftest() {
  const tasks = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8')).tasks;
  let bad = 0;
  for (const t of tasks) {
    const good = await verifyTask(t.id, path.join(here, 'fixtures', 'good', t.id));
    const wrong = await verifyTask(t.id, path.join(here, 'fixtures', 'bad', t.id));
    if (!good.ok) {
      bad++;
      console.log(`[selftest] ${t.id} 正确实现应通过却失败: ${good.msg}`);
    } else if (wrong.ok) {
      bad++;
      console.log(`[selftest] ${t.id} 错误实现应失败却通过`);
    } else {
      console.log(`[selftest] ${t.id} ok`);
    }
  }
  if (bad) {
    console.error(`[selftest] ${bad} 个验收器不可靠，禁止开始 A/B`);
    process.exit(1);
  }
  console.log(`[selftest] ${tasks.length} 个验收器可用`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const [task, work] = argv;
  if (!task || !work) {
    console.error('node verify.mjs <task> <workdir>\nnode verify.mjs --selftest');
    process.exit(1);
  }
  const r = await verifyTask(task, path.resolve(work));
  console.log(r.ok ? 'PASS' : r.msg);
  process.exit(r.ok ? 0 : 1);
}

const directRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directRun) main();
