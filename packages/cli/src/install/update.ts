import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { verifySha256File } from './checksum.js';
import { compareSemver, releaseAssetBaseUrl, resolveAssetName, resolveReleaseTag, versionFromTag, type ReleaseChannel } from './github-release.js';
import { getVersionInfo } from './version.js';

export type UpdateStatus = 'up_to_date' | 'update_available' | 'updated' | 'manual_required' | 'failed';
export type UpdateOutputFormat = 'pretty' | 'json' | 'jsonl';
type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

export interface UpdateOptions {
  check?: boolean;
  targetVersion?: string;
  channel?: ReleaseChannel;
  force?: boolean;
  yes?: boolean;
  repo?: string;
  baseUrl?: string;
  output?: UpdateOutputFormat;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  currentExecutablePath?: string;
  execFile?: ExecFileFn;
}

export interface UpdateReport {
  command: 'update';
  status: UpdateStatus;
  currentVersion: string;
  targetVersion?: string;
  channel: ReleaseChannel;
  platform: NodeJS.Platform;
  arch: string;
  assetName?: string;
  installPath?: string;
  message: string;
  error?: string;
}

const DEFAULT_REPO = 'ugmurthy/adaptiveAgent';
const execFileAsync = promisify(execFileCallback);
const defaultExecFile: ExecFileFn = async (file, args) => {
  const result = await execFileAsync(file, args);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateReport> {
  const env = options.env ?? process.env;
  const currentVersion = getVersionInfo(env).version;
  const channel = options.channel ?? 'stable';
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const repo = options.repo ?? DEFAULT_REPO;

  try {
    const tag = await resolveReleaseTag({ repo, channel, targetVersion: options.targetVersion, fetch: options.fetch });
    const targetVersion = versionFromTag(tag);
    const assetName = resolveAssetName(tag, platform, arch);
    const comparison = compareSemver(currentVersion, targetVersion);
    const installPath = options.currentExecutablePath ?? env.ADAPTIVE_AGENT_EXECUTABLE_PATH ?? process.execPath;

    if (comparison === 0 && !options.force) {
      return { command: 'update', status: 'up_to_date', currentVersion, targetVersion, channel, platform, arch, assetName, installPath, message: `adaptive-agent ${currentVersion} is already up to date.` };
    }

    if (comparison > 0 && !options.targetVersion) {
      return { command: 'update', status: 'failed', currentVersion, targetVersion, channel, platform, arch, assetName, installPath, message: 'Resolved release is older than current version.', error: 'Refusing implicit downgrade.' };
    }

    if (options.check) {
      return { command: 'update', status: 'update_available', currentVersion, targetVersion, channel, platform, arch, assetName, installPath, message: `adaptive-agent ${targetVersion} is available.` };
    }

    if (!isStandaloneAdaptiveAgentPath(installPath, platform)) {
      return { command: 'update', status: 'failed', currentVersion, targetVersion, channel, platform, arch, assetName, installPath, message: 'Unable to determine installed adaptive-agent binary path.', error: `Refusing to replace ${installPath}. Run the installer instead.` };
    }

    const base = releaseAssetBaseUrl(repo, tag, options.baseUrl);
    const tmp = await mkdtemp(join(tmpdir(), 'adaptive-agent-update-'));
    try {
      const archivePath = join(tmp, assetName);
      const checksumsPath = join(tmp, 'checksums.txt');
      await downloadFile(`${base}/${assetName}`, archivePath, options.fetch);
      await downloadFile(`${base}/checksums.txt`, checksumsPath, options.fetch);
      await verifySha256File(archivePath, await readFile(checksumsPath, 'utf8'), assetName);

      const extractDir = join(tmp, 'extract');
      await extractArchive(archivePath, extractDir, platform, options.execFile);
      const extractedBinary = await findExtractedBinary(extractDir, platform);
      await runBinaryVersion(extractedBinary, options.execFile);

      if (platform === 'win32') {
        return {
          command: 'update',
          status: 'manual_required',
          currentVersion,
          targetVersion,
          channel,
          platform,
          arch,
          assetName,
          installPath,
          message: `Downloaded and verified ${assetName}. Re-run the PowerShell installer to replace the Windows executable.`,
        };
      }

      const tempInstallPath = join(dirname(installPath), `.adaptive-agent.${process.pid}.tmp`);
      await copyFile(extractedBinary, tempInstallPath);
      await chmod(tempInstallPath, 0o755);
      await rename(tempInstallPath, installPath);
      await runBinaryVersion(installPath, options.execFile);
      return { command: 'update', status: 'updated', currentVersion, targetVersion, channel, platform, arch, assetName, installPath, message: `Updated adaptive-agent to ${targetVersion}.` };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  } catch (error) {
    return { command: 'update', status: 'failed', currentVersion, channel, platform, arch, message: 'Update failed.', error: error instanceof Error ? error.message : String(error) };
  }
}

export function renderUpdateReport(report: UpdateReport, output: UpdateOutputFormat = 'pretty'): string {
  if (output === 'json') return JSON.stringify(report, null, 2);
  if (output === 'jsonl') return JSON.stringify(report);
  const lines = [`adaptive-agent update: ${report.status}`, report.message];
  if (report.currentVersion) lines.push(`current: ${report.currentVersion}`);
  if (report.targetVersion) lines.push(`target: ${report.targetVersion}`);
  if (report.assetName) lines.push(`asset: ${report.assetName}`);
  if (report.installPath) lines.push(`install: ${report.installPath}`);
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join('\n');
}

export function updateExitCode(report: UpdateReport, check = false): number {
  if (check && report.status === 'update_available') return 10;
  if (check && report.status === 'up_to_date') return 11;
  if (report.status === 'updated' || report.status === 'up_to_date') return 0;
  if (report.status === 'manual_required') return 12;
  return 1;
}

async function downloadFile(url: string, path: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed for ${url}: HTTP ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function extractArchive(archivePath: string, extractDir: string, platform: NodeJS.Platform, execImpl: ExecFileFn = defaultExecFile): Promise<void> {
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  if (platform === 'win32') {
    await execImpl('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path ${quotePowerShell(archivePath)} -DestinationPath ${quotePowerShell(extractDir)} -Force`]);
    return;
  }
  await execImpl('tar', ['-xzf', archivePath, '-C', extractDir]);
}

async function findExtractedBinary(root: string, platform: NodeJS.Platform): Promise<string> {
  const target = platform === 'win32' ? 'adaptive-agent.exe' : 'adaptive-agent';
  const matches = await walk(root, target);
  if (!matches[0]) throw new Error(`Extracted archive did not contain ${target}`);
  return matches[0];
}

async function walk(root: string, fileName: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const matches: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) matches.push(...await walk(path, fileName));
    else if (entry.isFile() && entry.name === fileName) matches.push(path);
  }
  return matches;
}

async function runBinaryVersion(binary: string, execImpl: ExecFileFn = defaultExecFile): Promise<void> {
  await execImpl(binary, ['--version']);
}

function isStandaloneAdaptiveAgentPath(path: string, platform: NodeJS.Platform): boolean {
  const name = basename(path).toLowerCase();
  return platform === 'win32' ? name === 'adaptive-agent.exe' : name === 'adaptive-agent';
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
