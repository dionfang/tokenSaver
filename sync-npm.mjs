#!/usr/bin/env node
/**
 * 发布前从 code-index/ 生成 npm/ 运行时文件。
 * npm/ 入库的只有 package.json、README.md、.gitignore；其余不要手改。
 * npm pack / npm publish 会走 prepack 自动跑本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(root, 'code-index')
const npmDir = path.join(root, 'npm')
const KEEP = new Set(['package.json', 'README.md', '.gitignore'])
const SKIP_SRC = new Set(['cli.mjs'])

fs.mkdirSync(npmDir, { recursive: true })

const generated = new Set()

function write(name, content) {
  fs.writeFileSync(path.join(npmDir, name), content)
  generated.add(name)
}

function copy(name) {
  fs.copyFileSync(path.join(srcDir, name), path.join(npmDir, name))
  generated.add(name)
}

const srcPkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'package.json'), 'utf8'))
const npmPkgPath = path.join(npmDir, 'package.json')
const npmPkg = JSON.parse(fs.readFileSync(npmPkgPath, 'utf8'))
npmPkg.dependencies = srcPkg.dependencies
npmPkg.engines = srcPkg.engines
fs.writeFileSync(npmPkgPath, JSON.stringify(npmPkg, null, 2) + '\n')

for (const n of fs.readdirSync(srcDir)) {
  if (SKIP_SRC.has(n) || n.endsWith('.test.mjs') || n === 'regress.mjs') continue
  if (n.endsWith('.mjs') || n === 'ponytail.md' || n === 'output-diet.md') copy(n)
}

const deployDoc = fs.readFileSync(path.join(srcDir, '部署使用说明.txt'), 'utf8')
write(
  '部署使用说明.txt',
  `npm 安装(@dionfang/tokensaver)

  npm i -D @dionfang/tokensaver
  npx tokensaver init [--roots "<路径1>[,<路径2>...]"] [--model-in ollama|local]
  npx tokensaver status

以下与 code-index 目录同源:

${deployDoc}`
)

write(
  'cli.mjs',
  `#!/usr/bin/env node
/**
 * npm bin 入口。子命令对应同目录 *.mjs,参数原样转发。
 *   npx tokensaver init [--roots ...] [--model-in ollama|local]
 *   npx tokensaver search 关键词 --rerank --k 5
 *   npx tokensaver status | build | embed | auto | warm | details | sync
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = {
  init: 'init.mjs',
  search: 'search.mjs',
  status: 'status.mjs',
  build: 'build.mjs',
  embed: 'embed.mjs',
  auto: 'auto.mjs',
  warm: 'warm.mjs',
  details: 'details.mjs',
  sync: 'deploySync.mjs',
};

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  console.log(\`tokensaver <命令> [...参数]

命令: \${Object.keys(COMMANDS).join(', ')}
安装后在仓库根执行 npx tokensaver init
模型权重不在本包内:ollama 需本机已 pull;local 首次下载到 hf-cache。\`);
  process.exit(cmd ? 0 : 1);
}
if (cmd.startsWith('-')) {
  console.error(\`[err] 未知参数 \${cmd}。先写命令,例如 tokensaver search 关键词\`);
  process.exit(1);
}
const file = COMMANDS[cmd];
if (!file) {
  console.error(\`[err] 未知命令 \${cmd}。可用: \${Object.keys(COMMANDS).join(', ')}\`);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(here, file), ...argv.slice(1)], {
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  console.error(\`[err] 无法启动 \${file}: \${err.message}\`);
  process.exit(1);
});
`
)

for (const n of fs.readdirSync(npmDir)) {
  if (KEEP.has(n) || generated.has(n) || n === 'node_modules' || n.endsWith('.tgz')) continue
  fs.rmSync(path.join(npmDir, n), { recursive: true, force: true })
}
