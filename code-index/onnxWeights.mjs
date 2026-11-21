/**
 * onnxWeights.mjs — ONNX 权重期望字节表单源读取器(S14-F3,20261120 夜审)。
 *
 * 此前 embed.mjs WFILES / localRerank.mjs ONNX_BYTES+STRANDS_BYTES / tray weightsOnline WEIGHT_MODELS
 * 三处字面量双写(注释自称单源实为拷贝),上游权重一升需三处两测同步改、漏改=门失配。
 * 现字节表本体在 onnx-weights.json(本模块同目录):
 *   - embed.mjs / localRerank.mjs 经本读取器消费(键=模型 id,strands: 前缀键为 strands 档);
 *   - tray/src/wizard/weightsOnline.mjs 保持字面量(tray 红线零 code-index import,打包期拷贝留待下轮
 *     0.2.x 落地),由 test/hooks/embedProbe.test 做三方一致性对账——改 json 不改 tray 即红。
 * 单源缺失/损坏即抛(fail-loud:字节门静默失效比崩溃更难察觉)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onnx-weights.json');

export function onnxWeightsJson() {
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
