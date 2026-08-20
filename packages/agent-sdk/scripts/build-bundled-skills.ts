import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const skillDir = resolve(packageRoot, 'bundled', 'skills', 'persistent-code-executor');
const result = await Bun.build({
  entrypoints: [resolve(skillDir, 'handler.ts')],
  outdir: skillDir,
  naming: 'handler.js',
  target: 'bun',
  format: 'esm',
  minify: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log('Bundled persistent-code-executor handler');
