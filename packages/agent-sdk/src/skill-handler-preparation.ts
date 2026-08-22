import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  loadSkillFromDirectory,
  type SkillHandlerModuleRequest,
} from '@adaptive-agent/core';

import { adaptiveAgentHome, pathExists } from './sdk-utils.js';

const CACHE_FORMAT_VERSION = 1;
const PREPARER_VERSION = 1;
const EXCLUDED_SKILL_DIRECTORIES = new Set(['.git', 'node_modules']);
const LOCK_FILE_NAMES = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
const execFileAsync = promisify(execFile);

export type SkillHandlerMode = 'bundle' | 'package';

export interface PrepareSkillHandlerOptions {
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
}

export interface PreparedSkillHandler {
  skillDir: string;
  skillName: string;
  sourcePath: string;
  modulePath: string;
  mode: SkillHandlerMode;
  fingerprint: string;
  cacheHit: boolean;
}

interface PreparedHandlerManifest {
  formatVersion: number;
  fingerprint: string;
  mode: 'bundle';
  entry: string;
  sourcePath: string;
  platform: string;
  architecture: string;
  bunVersion: string;
}

export async function prepareSkillHandlerModule(
  request: SkillHandlerModuleRequest,
  options: PrepareSkillHandlerOptions = {},
): Promise<PreparedSkillHandler> {
  const skillDir = await realpath(request.skillDir);
  const sourcePath = await realpath(request.handlerPath);
  const mode = await readHandlerMode(skillDir);
  const bunVersion = await resolveBunVersion(mode);
  const fingerprint = await fingerprintSkillHandler(skillDir, sourcePath, mode, bunVersion);

  if (mode === 'package') {
    return {
      skillDir,
      skillName: request.skillName,
      sourcePath,
      modulePath: sourcePath,
      mode,
      fingerprint,
      cacheHit: false,
    };
  }

  const env = options.env ?? process.env;
  const cacheRoot = resolve(options.cacheRoot ?? join(adaptiveAgentHome(env), 'cache', 'skill-handlers'));
  const artifactDir = join(cacheRoot, fingerprint);
  const manifestPath = join(artifactDir, 'manifest.json');
  const cached = options.force ? undefined : await readValidManifest(manifestPath, fingerprint);
  if (cached) {
    return preparedResult(request.skillName, skillDir, sourcePath, fingerprint, artifactDir, cached, true);
  }

  await mkdir(cacheRoot, { recursive: true });
  const temporaryDir = join(cacheRoot, `.prepare-${process.pid}-${randomUUID()}`);
  await mkdir(temporaryDir, { recursive: true });

  try {
    const result = await buildHandler(sourcePath, temporaryDir);
    if (!result.success) {
      const details = result.logs.map((log) => String(log)).filter(Boolean).join('\n');
      throw new Error(
        `Unable to bundle handler '${sourcePath}'. Ensure every imported package is installed in the skill or an enclosing project, or set adaptiveAgent.handlerMode to "package" in the skill package.json for dependencies that must remain external.${details ? `\n${details}` : ''}`,
      );
    }

    const entry = 'handler.js';
    await access(join(temporaryDir, entry));
    const manifest: PreparedHandlerManifest = {
      formatVersion: CACHE_FORMAT_VERSION,
      fingerprint,
      mode: 'bundle',
      entry,
      sourcePath,
      platform: process.platform,
      architecture: process.arch,
      bunVersion,
    };
    await writeFile(join(temporaryDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    try {
      await rename(temporaryDir, artifactDir);
    } catch (firstError) {
      const winner = options.force ? undefined : await readValidManifest(manifestPath, fingerprint);
      if (winner) {
        await rm(temporaryDir, { recursive: true, force: true });
        return preparedResult(request.skillName, skillDir, sourcePath, fingerprint, artifactDir, winner, true);
      }
      await rm(artifactDir, { recursive: true, force: true });
      try {
        await rename(temporaryDir, artifactDir);
      } catch (secondError) {
        const replacement = await readValidManifest(manifestPath, fingerprint);
        if (!replacement) throw secondError ?? firstError;
        await rm(temporaryDir, { recursive: true, force: true });
        return preparedResult(request.skillName, skillDir, sourcePath, fingerprint, artifactDir, replacement, true);
      }
    }

    return preparedResult(request.skillName, skillDir, sourcePath, fingerprint, artifactDir, manifest, false);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareSkillDirectory(
  skillDirectory: string,
  options: PrepareSkillHandlerOptions = {},
): Promise<PreparedSkillHandler> {
  const skillDir = resolve(skillDirectory);
  let prepared: PreparedSkillHandler | undefined;
  const skill = await loadSkillFromDirectory(skillDir, {
    resolveHandlerModule: async (request) => {
      prepared = await prepareSkillHandlerModule(request, options);
      return prepared.modulePath;
    },
  });
  if (!skill.handler || !prepared) {
    throw new Error(`Skill '${skill.name}' at ${skillDir} does not declare a handler.`);
  }
  return prepared;
}

async function readHandlerMode(skillDir: string): Promise<SkillHandlerMode> {
  const packagePath = join(skillDir, 'package.json');
  if (!(await pathExists(packagePath))) return 'bundle';
  let value: unknown;
  try {
    value = JSON.parse(await readFile(packagePath, 'utf-8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read skill package.json at ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const adaptiveAgent = value && typeof value === 'object'
    ? (value as { adaptiveAgent?: unknown }).adaptiveAgent
    : undefined;
  const mode = adaptiveAgent && typeof adaptiveAgent === 'object'
    ? (adaptiveAgent as { handlerMode?: unknown }).handlerMode
    : undefined;
  if (mode === undefined || mode === 'bundle') return 'bundle';
  if (mode === 'package') return 'package';
  throw new Error(`Skill package.json at ${packagePath} has invalid adaptiveAgent.handlerMode; expected "bundle" or "package".`);
}

async function fingerprintSkillHandler(
  skillDir: string,
  sourcePath: string,
  mode: SkillHandlerMode,
  bunVersion: string,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    cacheFormatVersion: CACHE_FORMAT_VERSION,
    preparerVersion: PREPARER_VERSION,
    mode,
    sourcePath: relative(skillDir, sourcePath),
    platform: process.platform,
    architecture: process.arch,
    bunVersion,
  }));

  const skillEntries = await collectFingerprintEntries(skillDir);
  const dependencyEntries = await findDependencyManifestPaths(skillDir);
  const paths = [...new Set([...skillEntries, ...dependencyEntries])].sort();
  for (const path of paths) {
    const stat = await lstat(path);
    hash.update(`\0${relative(skillDir, path)}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else if (stat.isFile()) hash.update(await readFile(path));
  }
  return hash.digest('hex');
}

async function resolveBunVersion(mode: SkillHandlerMode): Promise<string> {
  if (process.versions.bun) return process.versions.bun;
  if (mode === 'package') return process.version;
  try {
    const { stdout } = await execFileAsync('bun', ['--version']);
    return stdout.trim();
  } catch {
    throw new Error('Preparing bundled skill handlers requires Bun. Install Bun or use the AdaptiveAgent binary CLI.');
  }
}

async function buildHandler(sourcePath: string, outdir: string): Promise<{ success: boolean; logs: unknown[] }> {
  if (typeof Bun !== 'undefined') {
    return Bun.build({
      entrypoints: [sourcePath],
      outdir,
      naming: 'handler.js',
      target: 'bun',
      format: 'esm',
      minify: false,
      sourcemap: 'none',
    });
  }
  try {
    const { stderr } = await execFileAsync('bun', [
      'build',
      sourcePath,
      `--outdir=${outdir}`,
      '--entry-naming=handler.js',
      '--target=bun',
      '--format=esm',
      '--sourcemap=none',
    ]);
    return { success: true, logs: stderr.trim() ? [stderr.trim()] : [] };
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error
      ? String((error as { stderr?: unknown }).stderr ?? '')
      : '';
    return { success: false, logs: stderr ? [stderr] : [error] };
  }
}

async function collectFingerprintEntries(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_SKILL_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFingerprintEntries(root, path));
    else if (entry.isFile() || entry.isSymbolicLink()) result.push(path);
  }
  return result;
}

async function findDependencyManifestPaths(skillDir: string): Promise<string[]> {
  const paths: string[] = [];
  let directory = skillDir;
  while (true) {
    const packagePath = join(directory, 'package.json');
    if (await pathExists(packagePath)) {
      paths.push(packagePath);
      let foundLock = false;
      for (const lockName of LOCK_FILE_NAMES) {
        const lockPath = join(directory, lockName);
        if (await pathExists(lockPath)) {
          paths.push(lockPath);
          foundLock = true;
        }
      }
      if (foundLock) return paths;
    }
    const parent = dirname(directory);
    if (parent === directory) return paths;
    directory = parent;
  }
}

async function readValidManifest(
  manifestPath: string,
  fingerprint: string,
): Promise<PreparedHandlerManifest | undefined> {
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Partial<PreparedHandlerManifest>;
    if (
      manifest.formatVersion !== CACHE_FORMAT_VERSION
      || manifest.fingerprint !== fingerprint
      || manifest.mode !== 'bundle'
      || manifest.entry !== 'handler.js'
    ) return undefined;
    await access(join(dirname(manifestPath), manifest.entry));
    return manifest as PreparedHandlerManifest;
  } catch {
    return undefined;
  }
}

function preparedResult(
  skillName: string,
  skillDir: string,
  sourcePath: string,
  fingerprint: string,
  artifactDir: string,
  manifest: PreparedHandlerManifest,
  cacheHit: boolean,
): PreparedSkillHandler {
  return {
    skillDir,
    skillName,
    sourcePath,
    modulePath: join(artifactDir, manifest.entry),
    mode: 'bundle',
    fingerprint,
    cacheHit,
  };
}
