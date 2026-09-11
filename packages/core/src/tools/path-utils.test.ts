import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PathOutsideRootError, resolvePathWithinRoot, resolvePathWithinRoots } from './path-utils.js';

describe('path utils', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('expands a home-relative path before resolving it against the workspace root', async () => {
    const tempDir = await mkdtemp(join(homedir(), '.adaptive-agent-path-test-'));
    tempDirectories.push(tempDir);
    const workspaceRoot = await realpath(tempDir);
    const filePath = join(workspaceRoot, 'ContentView.swift');
    await writeFile(filePath, 'struct ContentView {}');
    const requestedPath = `~/${relative(homedir(), filePath)}`;

    expect(resolvePathWithinRoot(workspaceRoot, requestedPath)).toBe(filePath);
    await expect(resolvePathWithinRoots([workspaceRoot], requestedPath)).resolves.toBe(filePath);
  });

  it('still rejects a home-relative path outside the workspace root', async () => {
    const tempDir = await mkdtemp(join(homedir(), '.adaptive-agent-path-test-'));
    tempDirectories.push(tempDir);
    const workspaceRoot = await realpath(tempDir);

    expect(() => resolvePathWithinRoot(workspaceRoot, '~')).toThrow(PathOutsideRootError);
    await expect(resolvePathWithinRoots([workspaceRoot], '~')).rejects.toThrow(PathOutsideRootError);
  });
});
