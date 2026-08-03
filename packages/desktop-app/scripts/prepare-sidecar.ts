import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const triple = process.argv[2] ?? process.env.TAURI_TARGET_TRIPLE ?? await hostTriple();
const target = bunTarget(triple);
const extension = triple.includes('windows') ? '.exe' : '';
await mkdir(resolve(packageRoot, 'src-tauri', 'binaries'), { recursive: true });
for (const [name, entry] of [
  ['agent-runtime', resolve(packageRoot, '..', 'desktop-bridge', 'src', 'main.ts')],
  ['trace-session-sidecar', resolve(packageRoot, '..', 'trace-session', 'src', 'trace-sidecar.ts')],
] as const) {
  const output = resolve(packageRoot, 'src-tauri', 'binaries', `${name}-${triple}${extension}`);
  const processResult = Bun.spawn(['bun', 'build', entry, '--compile', `--target=${target}`, `--outfile=${output}`], { stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await processResult.exited;
  if (exitCode !== 0) process.exit(exitCode);
  console.log(`Prepared ${name} sidecar for ${triple}`);
}

async function hostTriple(): Promise<string> {
  const result = Bun.spawnSync(['rustc', '--print', 'host-tuple']);
  if (result.exitCode !== 0) throw new Error('Rust is required to determine the native target. Set TAURI_TARGET_TRIPLE explicitly in CI.');
  return result.stdout.toString().trim();
}

function bunTarget(value: string): string {
  const targets: Record<string, string> = {
    'aarch64-apple-darwin': 'bun-darwin-arm64',
    'x86_64-apple-darwin': 'bun-darwin-x64',
    'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
    'x86_64-unknown-linux-gnu': 'bun-linux-x64',
    'x86_64-pc-windows-msvc': 'bun-windows-x64',
  };
  const target = targets[value];
  if (!target) throw new Error(`Unsupported desktop target: ${value}`);
  return target;
}
