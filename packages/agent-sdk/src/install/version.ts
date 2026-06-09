import { BUILD_INFO } from './build-info.generated.js';

export interface VersionInfo {
  name: 'adaptive-agent';
  version: string;
  commit?: string;
  target: string;
  buildTimestamp?: string;
  repository: string;
}

const DEFAULT_VERSION = '0.1.0';
const DEFAULT_REPOSITORY = 'https://github.com/ugmurthy/adaptiveAgent';

export function getVersionInfo(env: NodeJS.ProcessEnv = process.env): VersionInfo {
  const version = env.ADAPTIVE_AGENT_VERSION || BUILD_INFO.version || DEFAULT_VERSION;
  const commit = env.ADAPTIVE_AGENT_COMMIT || BUILD_INFO.commit || undefined;
  const target = env.ADAPTIVE_AGENT_TARGET || BUILD_INFO.target || `${process.platform}-${process.arch}`;
  return {
    name: 'adaptive-agent',
    version,
    commit,
    target,
    buildTimestamp: env.ADAPTIVE_AGENT_BUILD_TIMESTAMP || BUILD_INFO.buildTimestamp || undefined,
    repository: env.ADAPTIVE_AGENT_REPOSITORY || BUILD_INFO.repository || DEFAULT_REPOSITORY,
  };
}

export function renderVersion(info: VersionInfo = getVersionInfo()): string {
  const version = info.commit && !info.version.includes('+') ? `${info.version}+${info.commit}` : info.version;
  const lines = [`${info.name} ${version}`];
  if (info.commit) lines.push(`commit: ${info.commit}`);
  lines.push(`target: ${info.target}`);
  if (info.buildTimestamp) lines.push(`built: ${info.buildTimestamp}`);
  lines.push(`repository: ${info.repository}`);
  return lines.join('\n');
}
