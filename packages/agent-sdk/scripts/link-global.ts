#!/usr/bin/env bun

import { chmod, lstat, mkdir, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'adaptive-agent.js');
const globalBinDir = process.env.BUN_INSTALL
  ? resolve(process.env.BUN_INSTALL, 'bin')
  : resolve(homedir(), '.bun', 'bin');
const commands = ['adaptive-agent'] as const;

await chmod(cliPath, 0o755);
await mkdir(globalBinDir, { recursive: true });

for (const command of commands) {
  const linkPath = resolve(globalBinDir, command);
  await replaceSymlink(linkPath, cliPath);
  console.log(`${command} -> ${cliPath}`);
}

console.log(`\nLinked adaptive-agent into ${globalBinDir}`);
console.log(`Target: ${cliPath}`);
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
