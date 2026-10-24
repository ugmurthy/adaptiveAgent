export type ReleaseChannel = 'stable' | 'preview';
export type SupportedPlatform = 'darwin' | 'linux' | 'win32';
export type SupportedArch = 'arm64' | 'x64';

export interface GitHubReleaseSummary {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
}

export function normalizeVersionTag(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

export function versionFromTag(tag: string): string {
  return tag.replace(/^v/, '');
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease === b.prerelease) return 0;
  return (a.prerelease ?? '') > (b.prerelease ?? '') ? 1 : -1;
}

export function resolveAssetName(versionOrTag: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const tag = normalizeVersionTag(versionOrTag);
  if (platform === 'darwin' && arch === 'arm64') return `adaptive-agent-${tag}-darwin-arm64.tar.gz`;
  if (platform === 'darwin' && arch === 'x64') return `adaptive-agent-${tag}-darwin-x64.tar.gz`;
  if (platform === 'linux' && arch === 'arm64') return `adaptive-agent-${tag}-linux-arm64.tar.gz`;
  if (platform === 'linux' && arch === 'x64') return `adaptive-agent-${tag}-linux-x64.tar.gz`;
  if (platform === 'win32' && arch === 'x64') return `adaptive-agent-${tag}-windows-x64.zip`;
  throw new Error(`Unsupported OS/arch combination: ${platform}-${arch}`);
}

export async function resolveReleaseTag(options: {
  repo: string;
  channel: ReleaseChannel;
  targetVersion?: string;
  fetch?: typeof fetch;
}): Promise<string> {
  if (options.targetVersion) return normalizeVersionTag(options.targetVersion);
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`https://api.github.com/repos/${options.repo}/releases`, {
    headers: { 'User-Agent': 'adaptive-agent-updater' },
  });
  if (!response.ok) throw new Error(`GitHub releases request failed with HTTP ${response.status}`);
  const releases = await response.json() as GitHubReleaseSummary[];
  const release = releases.find((candidate) => !candidate.draft && (options.channel === 'preview' ? true : !candidate.prerelease));
  if (!release?.tag_name) throw new Error(`No ${options.channel} GitHub Release found for ${options.repo}`);
  return release.tag_name;
}

export function releaseAssetBaseUrl(repo: string, tag: string, baseUrl?: string): string {
  if (!baseUrl) return `https://github.com/${repo}/releases/download/${tag}`;
  const trimmed = baseUrl.replace(/\/$/, '');
  return trimmed.includes('{tag}') ? trimmed.replaceAll('{tag}', tag) : trimmed;
}

function parseSemver(value: string): { major: number; minor: number; patch: number; prerelease?: string } {
  const clean = versionFromTag(value).split('+')[0]!;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(clean);
  if (!match) throw new Error(`Invalid semver version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}
