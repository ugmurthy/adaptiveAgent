#!/usr/bin/env bun

import { chmod, lstat, mkdir, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'adaptive-agent.js');
const tuiCliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'adaptive-agent-tui.js');
const gaiaEvalCliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'evaluate-gaia-jsonl.js');
const globalBinDir = process.env.BUN_INSTALL
  ? resolve(process.env.BUN_INSTALL, 'bin')
  : resolve(homedir(), '.bun', 'bin');
const commands = [
  { command: 'adaptive-agent', targetPath: cliPath },
  { command: 'adaptive-agent-tui', targetPath: tuiCliPath },
  { command: 'adaptive-agent-gaia-eval', targetPath: gaiaEvalCliPath },
] as const;

await chmod(cliPath, 0o755);
await chmod(tuiCliPath, 0o755);
await chmod(gaiaEvalCliPath, 0o755);
await mkdir(globalBinDir, { recursive: true });

for (const { command, targetPath } of commands) {
  const linkPath = resolve(globalBinDir, command);
  await replaceSymlink(linkPath, targetPath);
  console.log(`${command} -> ${targetPath}`);
}

console.log(`\nLinked AdaptiveAgent CLIs into ${globalBinDir}`);
console.log('Ensure this directory is on PATH before invoking it from arbitrary folders.');

async function replaceSymlink(linkPath: string, targetPath: string): Promise<void> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite non-symlink at ${linkPath}`);
    }

    await unlink(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await symlink(targetPath, linkPath);
}
