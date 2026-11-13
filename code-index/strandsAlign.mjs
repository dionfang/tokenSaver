/**
 * Strands-Decider 指针头适配层(纯 Node,零 Python 运行时)。
 *
 * 分词与 offsets:`tokenizers` npm(HuggingFace 官方 Rust binding,与 Python transformers
 * 依赖的 tokenizers 同一 Rust crate)原生返回 Encoding.offsets——与官方 strands_decider
 * prompting.py 的字符口径完全同源,不做任何自造对齐。transformers.js 不暴露
 * offset_mapping(实测 0 处 offset_mapping 代码),故不用它做分词。
 *
 * 协议(官方 prompting.py 复刻):
 *   state    = "<state>\n{state}\n</state>\n"          (addSpecialTokens=true,官方 fit_window 同口径)
 *   question = '<question type="choice">\nSelect exactly one option.\n{instr}\n<options>\n'
 *              + "1. {key} — {desc}\n2. ..." + '\n</options>\n</question>\n<answer>' (addSpecialTokens=false)
 *   option_pos[k] = 与 option 行字符 span 重叠的最后一个 token(官方 option_token_index)
 *   answer_pos    = 全序列最后一个 token
 *   logits / temperature_by_kind.choice → softmax
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/** Strands 官方 choice 温度(hobson-v19 config.json decider.temperature_by_kind.choice)。 */
export const STRANDS_CHOICE_TEMPERATURE = 0.734189596436441;

/** 渲染 Strands choice question(官方 prompting.render_question 的 choice 分支复刻)。 */
export function renderStrandsChoice({ state, instructions, options }) {
  const opts = (options || []).map((o) => ({ key: String(o.key || o.name || ''), desc: String(o.description ?? o.desc ?? '') }));
  if (opts.length < 2) throw new Error('strands choice 需 ≥2 个选项');
  const lines = [];
  const spans = [];
  let cursor = 0;
  opts.forEach((o, i) => {
    const desc = o.desc.replace(/\s+/g, ' ').trim();
    const line = `${i + 1}. ${o.key}` + (desc ? ` — ${desc}` : '');
    lines.push(line);
    spans.push([cursor, cursor + line.length]);
    cursor += line.length + 1;
  });
  const prefix = '<question type="choice">\nSelect exactly one option.\n' + String(instructions || '') + '\n<options>\n';
  const block = lines.join('\n');
  const qtext = prefix + block + '\n</options>\n</question>\n<answer>';
  const statePrefix = '<state>\n' + String(state || '') + '\n</state>\n';
  return {
    text: statePrefix + qtext,
    spans: spans.map(([s, e]) => [statePrefix.length + prefix.length + s, statePrefix.length + prefix.length + e]),
    keys: opts.map((o) => o.key),
  };
}

/** 与字符 span [a,b) 重叠的最后一个 token 索引(官方 prompting.option_token_index 同口径)。 */
export function lastTokenInSpan(offsets, a, b) {
  let last = -1;
  let prev = 0;
  for (let i = 0; i < offsets.length; i++) {
    const hi = offsets[i][1];
    if (hi > prev && hi > a && prev < b) last = i;
    prev = hi;
    if (prev >= b && last >= 0) break;
  }
  if (last < 0) throw new Error(`strands option span [${a},${b}) 无存活 token(截断越界)`);
  return last;
}

/**
 * 从模型目录构建 strands 分词器(Rust binding;tokenizers npm 由 package.json 提供)。
 * 与 transformers.js 分词结果一致(同 tokenizer.json 同算法),但 Rust binding 额外返回 offsets。
 */
export function loadStrandsTokenizer(modelDir) {
  const tokPath = path.join(modelDir, 'tokenizer.json');
  if (!fs.existsSync(tokPath)) throw new Error(`缺 tokenizer.json: ${modelDir}`);
  const { Tokenizer } = require_('tokenizers');
  const tok = Tokenizer.fromFile(tokPath);
  tok.disablePadding();
  tok.disableTruncation();
  return {
    /**
     * 官方 fit_window 同口径:state 加 special、question 不加;拼接后按 offsets 定位。
     * 返回 {ids, optionPos, answerPos, maxLenCheck}。
     */
    async encodePrompt(rq, maxLength = 4096) {
      // lastIndexOf(2026-11-10 二次审计 P1-9):state 段是裸上下文,可能自带 '<question' 字样,
      // indexOf 会切在 state 内部导致 state/question 编码错位、optionPos 全偏;question 起始标签
      // 恒在 state 之后,取最后一段出现位置才是真分界。
      const stateText = rq.text.slice(0, rq.text.lastIndexOf('<question')) // state 段原文
      const questionText = rq.text.slice(stateText.length);
      const [stateEnc, questionEnc] = await Promise.all([
        tok.encode(stateText, null, { addSpecialTokens: true }),
        tok.encode(questionText, null, { addSpecialTokens: false }),
      ]);
      const sIds = stateEnc.getIds();
      const qIds = questionEnc.getIds();
      const qOffsets = questionEnc.getOffsets();
      if (sIds.length + qIds.length > maxLength) throw new Error(`prompt ${sIds.length + qIds.length} tokens 超窗口 ${maxLength}`);
      const ids = [...sIds, ...qIds];
      // option span 是全 prompt 字符坐标;question 的 offsets 以 questionText 为原点 → 偏移 state 字符数
      const stateChars = Array.from(stateText).length;
      const optionPos = rq.spans.map(([a, b]) => lastTokenInSpan(qOffsets, a - stateChars, b - stateChars) + sIds.length);
      return { ids, optionPos, answerPos: ids.length - 1 };
    },
  };
}
