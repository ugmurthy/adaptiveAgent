import { lstat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

export type UninstallStatus = 'uninstalled' | 'not_found' | 'would_uninstall' | 'manual_required' | 'failed';
export type UninstallOutputFormat = 'pretty' | 'json' | 'jsonl';

export interface UninstallOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  currentExecutablePath?: string;
}

export interface UninstallReport {
  command: 'uninstall';
  status: UninstallStatus;
  platform: NodeJS.Platform;
  installPath: string;
  message: string;
  configMessage: string;
  error?: string;
}

export async function runUninstall(options: UninstallOptions = {}): Promise<UninstallReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const installPath = options.currentExecutablePath ?? env.ADAPTIVE_AGENT_EXECUTABLE_PATH ?? process.execPath;
  const configMessage = 'User configuration under ~/.adaptiveAgent was not removed.';

  if (!isStandaloneAdaptiveAgentPath(installPath, platform)) {
    return {
      command: 'uninstall',
      status: 'failed',
      platform,
      installPath,
      message: 'Unable to determine installed adaptive-agent binary path.',
      configMessage,
      error: `Refusing to remove ${installPath}. Run the installer-managed adaptive-agent binary, or set ADAPTIVE_AGENT_EXECUTABLE_PATH to the installed CLI path.`,
    };
  }

  try {
    const stat = await lstat(installPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return {
        command: 'uninstall',
        status: 'failed',
        platform,
        installPath,
        message: 'Installed adaptive-agent path is not a file or symlink.',
        configMessage,
        error: `Refusing to remove ${installPath}.`,
      };
    }

    if (options.dryRun) {
      return {
        command: 'uninstall',
        status: 'would_uninstall',
        platform,
        installPath,
        message: `Would remove adaptive-agent CLI at ${installPath}.`,
        configMessage,
      };
    }

    if (platform === 'win32') {
      return {
        command: 'uninstall',
        status: 'manual_required',
        platform,
        installPath,
        message: `Close adaptive-agent and remove ${installPath} manually.`,
        configMessage,
      };
    }

    await unlink(installPath);
    return {
      command: 'uninstall',
      status: 'uninstalled',
      platform,
      installPath,
      message: `Removed adaptive-agent CLI at ${installPath}.`,
      configMessage,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        command: 'uninstall',
        status: 'not_found',
        platform,
        installPath,
        message: `No adaptive-agent CLI found at ${installPath}.`,
        configMessage,
      };
    }

    return {
      command: 'uninstall',
      status: 'failed',
      platform,
      installPath,
      message: 'Uninstall failed.',
      configMessage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function renderUninstallReport(report: UninstallReport, output: UninstallOutputFormat = 'pretty'): string {
  if (output === 'json') return JSON.stringify(report, null, 2);
  if (output === 'jsonl') return JSON.stringify(report);
  const lines = [`adaptive-agent uninstall: ${report.status}`, report.message, report.configMessage, `install: ${report.installPath}`];
  if (report.error) lines.push(`error: ${report.error}`);
  return lines.join('\n');
}

export function uninstallExitCode(report: UninstallReport): number {
  if (report.status === 'uninstalled' || report.status === 'not_found' || report.status === 'would_uninstall') return 0;
  if (report.status === 'manual_required') return 12;
  return 1;
}

function isStandaloneAdaptiveAgentPath(path: string, platform: NodeJS.Platform): boolean {
  const name = basename(path).toLowerCase();
  return platform === 'win32' ? name === 'adaptive-agent.exe' : name === 'adaptive-agent';
}
