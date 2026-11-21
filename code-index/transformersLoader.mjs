/**
 * transformers 统一加载器(20261120 测试机修复):托盘(Electron)拉起的子进程里
 * 裸 specifier `import('@huggingface/transformers')` 偶发 Cannot find module,
 * 而同一目录手动 node 的 CJS/ESM 解析均 OK ⇒ 子进程裸 ESM 解析条件差异(node 版本/env 继承)。
 * 稳健口径:用 createRequire(本模块 URL=code-index 目录)做 CJS resolve 拿**绝对入口**再 import,
 * 绕开裸 specifier 解析;resolve 失败回退裸 import(不回归)。CJS 入口为 bundled cjs,
 * named-export 可能不被 lexer 识别 ⇒ 命名缺失时回退 default(exports 对象)。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const req = createRequire(import.meta.url);

export async function loadTransformers() {
  let mod;
  try {
    mod = await import(pathToFileURL(req.resolve('@huggingface/transformers')).href);
  } catch {
    mod = await import('@huggingface/transformers');
  }
  if (mod && mod.env === undefined && mod.default && mod.default.env !== undefined) return mod.default;
  return mod;
}