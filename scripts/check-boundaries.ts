#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

// Production edges. Test-only gateway hosts are listed separately below.
const dependencies: Record<string, readonly string[]> = {
  core: [],
  'agent-sdk': ['core', 'gateway-client'],
  cli: ['agent-sdk', 'core'],
  'desktop-bridge': ['agent-sdk', 'core', 'gateway-client', 'cli'],
  'desktop-app': [],
  'gateway-protocol': [],
  'gateway-client': ['gateway-protocol', 'core'],
  'capability-gateway': ['gateway-protocol', 'core'],
  'trace-session': ['agent-sdk'],
  'trace-workbench': ['trace-session'],
};
const gatewayHostTests = new Set(['agent-sdk', 'cli', 'desktop-bridge']);
const ignored = new Set(['node_modules', 'dist', 'target', 'binaries', '.git', '.amp']);
const isTest = (path: string) => /\.(test|spec|bun)\.[cm]?[jt]sx?$/.test(path);

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name) || entry.isSymbolicLink()) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Check active workspaces, developer scripts and examples without building them. */
export function checkBoundaries(root: string): string[] {
  root = resolve(root);
  const issues: string[] = [];
  const manifests = new Map<string, Manifest>();
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    const path = join(root, 'packages', entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    manifests.set(entry.name, manifest);
    if (!(entry.name in dependencies)) issues.push(`${relative(root, path)}: workspace needs an explicit boundary policy`);
  }
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
  const byName = new Map([...manifests].map(([key, value]) => [value.name, key]));
  const allowed = (owner: string, target: string, test: boolean) => owner === 'tooling'
    || dependencies[owner]?.includes(target)
    || (test && gatewayHostTests.has(owner) && target === 'capability-gateway');

  for (const [owner, manifest] of manifests) {
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies'] as const) {
      for (const name of Object.keys(manifest[section] ?? {})) {
        if (!name.startsWith('@adaptive-agent/')) continue;
        const target = byName.get(name);
        if (!target || !allowed(owner, target, section === 'devDependencies')) {
          issues.push(`packages/${owner}/package.json: forbidden ${section} dependency ${name}`);
        }
      }
    }
  }

  for (const path of ['packages', 'scripts', 'examples'].flatMap((dir) => files(join(root, dir)))) {
    if (!/\.(?:[cm]?[jt]sx?|svelte)$/.test(path) || path.endsWith('.d.ts')) continue;
    const local = relative(root, path).split('\\').join('/');
    const owner = local.startsWith('packages/') ? local.split('/')[1] : 'tooling';
    const manifest = manifests.get(owner) ?? rootManifest;
    const test = isTest(local);
    const report = (node: ts.Node, source: ts.SourceFile, message: string) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      issues.push(`${local}:${line}: ${message}`);
    };
    const text = readFileSync(path, 'utf8');
    // Keep original line numbers when parsing Svelte script blocks.
    const sources = path.endsWith('.svelte')
      ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) =>
        '\n'.repeat(text.slice(0, match.index! + match[0].indexOf('>') + 1).split('\n').length - 1) + match[1])
      : [text];
    for (const code of sources) {
      const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const inspect = (node: ts.Node, specifier: string) => {
        if (specifier.startsWith('.') || specifier.startsWith('/')) {
          const targetPath = relative(root, resolve(dirname(path), specifier)).split('\\').join('/');
          const targetOwner = targetPath.startsWith('packages/') ? targetPath.split('/')[1] : 'tooling';
          if (targetOwner !== owner) report(node, source, `cross-boundary path ${specifier}; use a declared public package entrypoint`);
          if (!test && isTest(targetPath)) report(node, source, 'production code must not import a test module');
          return;
        }
        if (!specifier.startsWith('@adaptive-agent/')) return;
        const parts = specifier.split('/');
        const name = parts.slice(0, 2).join('/');
        const target = byName.get(name);
        if (!target) return report(node, source, `unknown workspace ${name}`);
        const entry = parts.length === 2 ? '.' : `./${parts.slice(2).join('/')}`;
        if (!Object.hasOwn(manifests.get(target)!.exports ?? {}, entry)) {
          report(node, source, `private or undeclared entrypoint ${specifier}`);
        }
        if (owner !== target && !allowed(owner, target, test)) report(node, source, `forbidden dependency ${owner} -> ${target}`);
        const declared = manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name] ?? manifest.optionalDependencies?.[name]
          ?? ((test || owner === 'tooling') ? manifest.devDependencies?.[name] : undefined);
        if (owner !== target && !declared) report(node, source, `${name} must be declared as a ${test || owner === 'tooling' ? 'tooling/test' : 'production'} dependency`);
        if (owner === 'trace-session' && target === 'agent-sdk' && entry !== './runtime-settings') {
          report(node, source, 'trace may consume only agent-sdk/runtime-settings');
        }
        if (owner === 'trace-workbench' && target === 'trace-session' && entry !== '.') {
          report(node, source, 'workbench must use the headless trace entrypoint');
        }
        if (owner === 'gateway-client' && target === 'core' && entry !== './types') {
          report(node, source, 'gateway-client may consume only core/types');
        }
      };
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
          inspect(node, node.moduleSpecifier.text);
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
          inspect(node, node.argument.literal.text);
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
          inspect(node, node.arguments[0].text);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
          inspect(node, node.moduleReference.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  return issues.sort();
}

if (import.meta.main) {
  const issues = checkBoundaries(process.argv[2] ?? resolve(import.meta.dirname, '..'));
  if (issues.length) {
    console.error(issues.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Workspace boundaries passed (manifests, source imports, scripts and examples).');
  }
}
