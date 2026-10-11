import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkBoundaries } from './check-boundaries.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-boundaries-'));
  roots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', JSON.stringify({ devDependencies: { '@adaptive-agent/core': 'workspace:*' } }));
  const manifest = (name: string, deps: string[] = [], dev: string[] = []) => write(`packages/${name}/package.json`, JSON.stringify({
    name: `@adaptive-agent/${name}`,
    exports: { '.': './src/index.ts', './types': './src/types.ts', './runtime-settings': './src/runtime-settings.ts', './cli': './src/cli.ts' },
    dependencies: Object.fromEntries(deps.map((dep) => [`@adaptive-agent/${dep}`, 'workspace:*'])),
    devDependencies: Object.fromEntries(dev.map((dep) => [`@adaptive-agent/${dep}`, 'workspace:*'])),
  }));
  manifest('core');
  manifest('agent-sdk', ['core'], ['capability-gateway']);
  manifest('capability-gateway', ['core']);
  manifest('gateway-client', ['core']);
  manifest('trace-session', ['agent-sdk']);
  manifest('trace-workbench', ['trace-session']);
  manifest('desktop-app');
  return { root, write, manifest };
}

test('accepts public production edges, narrow entrypoints, local internals and explicit test-only hosts', () => {
  const { root, write } = fixture();
  write('packages/agent-sdk/src/index.ts', `import { runtime } from '@adaptive-agent/core'; export * from './internal.js';`);
  write('packages/agent-sdk/src/index.test.ts', `import { host } from '@adaptive-agent/capability-gateway';`);
  write('packages/agent-sdk/src/storage.bun.ts', `const host = await import('@adaptive-agent/capability-gateway');`);
  write('packages/gateway-client/src/index.ts', `import type { ModelRequest } from '@adaptive-agent/core/types';`);
  write('packages/trace-session/src/index.ts', `export { settings } from '@adaptive-agent/agent-sdk/runtime-settings';`);
  write('packages/trace-workbench/src/App.svelte', `<script lang="ts">import type { TraceReport } from '@adaptive-agent/trace-session';</script>`);
  write('examples/demo.ts', `import { runtime } from '@adaptive-agent/core'; // import('not-a-workspace')`);
  expect(checkBoundaries(root)).toEqual([]);
});

test('rejects private paths, reverse dependencies and all literal import forms without flagging strings', () => {
  const { root, write } = fixture();
  write('packages/core/src/bad.ts', `
import type { Config } from '@adaptive-agent/agent-sdk';
export * from '@adaptive-agent/core/src/types.js';
const sdk = await import('../../agent-sdk/src/index.js');
const host = require('@adaptive-agent/capability-gateway');
type Private = import('@adaptive-agent/agent-sdk/private').Private;
import Alias = require('@adaptive-agent/core/src/hidden.js');
const harmless = "import('@adaptive-agent/missing')";
`);
  const errors = checkBoundaries(root).join('\n');
  expect(errors).toContain('forbidden dependency core -> agent-sdk');
  expect(errors).toContain('private or undeclared entrypoint @adaptive-agent/core/src/types.js');
  expect(errors).toContain('cross-boundary path ../../agent-sdk/src/index.js');
  expect(errors).toContain('forbidden dependency core -> capability-gateway');
  expect(errors).toContain('private or undeclared entrypoint @adaptive-agent/agent-sdk/private');
  expect(errors).toContain('private or undeclared entrypoint @adaptive-agent/core/src/hidden.js');
  expect(errors).not.toContain('missing');
});

test('rejects forbidden manifests, missing production declarations and test dependencies leaking into production', () => {
  const { root, write, manifest } = fixture();
  manifest('core', [], ['agent-sdk']);
  manifest('cli');
  manifest('new-workspace');
  write('packages/cli/src/index.ts', `import type { RunResult } from '@adaptive-agent/core';`);
  write('packages/agent-sdk/src/index.ts', `export * from '@adaptive-agent/capability-gateway'; import './index.test.js';`);
  const errors = checkBoundaries(root).join('\n');
  expect(errors).toContain('forbidden devDependencies dependency @adaptive-agent/agent-sdk');
  expect(errors).toContain('workspace needs an explicit boundary policy');
  expect(errors).toContain('@adaptive-agent/core must be declared as a production dependency');
  expect(errors).toContain('forbidden dependency agent-sdk -> capability-gateway');
  expect(errors).toContain('production code must not import a test module');
});

test('enforces headless reporting, narrow runtime contracts, renderer isolation and tooling entrypoints', () => {
  const { root, write } = fixture();
  write('packages/gateway-client/src/index.ts', `import { runtime } from '@adaptive-agent/core';`);
  write('packages/trace-session/src/index.ts', `import { sdk } from '@adaptive-agent/agent-sdk';`);
  write('packages/trace-workbench/src/App.svelte', `<h1>Trace</h1>\n<script lang="ts">import { cli } from '@adaptive-agent/trace-session/cli';</script>`);
  write('packages/desktop-app/src/App.svelte', `<script>import { runtime } from '@adaptive-agent/core';</script>`);
  write('scripts/demo.ts', `import { runtime } from '../packages/core/src/index.js';`);
  const errors = checkBoundaries(root).join('\n');
  expect(errors).toContain('gateway-client may consume only core/types');
  expect(errors).toContain('trace may consume only agent-sdk/runtime-settings');
  expect(errors).toContain('App.svelte:2: workbench must use the headless trace entrypoint');
  expect(errors).toContain('forbidden dependency desktop-app -> core');
  expect(errors).toContain('cross-boundary path ../packages/core/src/index.js');
});
