import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';

const WORKLOADS_BY_INVOCATION_MODE = {
  chat: ['chat'],
  run: ['run', 'swarm', 'orchestration'],
} as const;

interface AgentProfile {
  id: string;
  invocationModes: Array<keyof typeof WORKLOADS_BY_INVOCATION_MODE>;
}

interface RegistryEntry {
  id: string;
  configPath: string;
  version: string;
  contentHash: string;
  allowedWorkloads: string[];
}

const HELP = `Generate a service agent registry from agent profile JSON files.

Usage:
  bun run service:generate-registry [options] <agent-profiles-folder> [output-path]

Arguments:
  agent-profiles-folder  Folder containing agent profile JSON files
  output-path            Registry destination (default: <folder>/agent-registry.json)

Options:
  --absolute             Store absolute profile paths instead of relative paths
  --help, -h             Show this help message`;

async function main(): Promise<void> {
  const arguments_ = Bun.argv.slice(2);
  if (arguments_.includes('--help') || arguments_.includes('-h')) {
    console.log(HELP);
    return;
  }
  const absolutePaths = arguments_.includes('--absolute');
  const positionalArguments = arguments_.filter((argument) => argument !== '--absolute');
  const [profilesArgument, outputArgument] = positionalArguments;
  const unknownOption = positionalArguments.find((argument) => argument.startsWith('--'));
  if (!profilesArgument || positionalArguments.length > 2 || unknownOption) {
    throw new Error('Usage: bun run service:generate-registry [--absolute] <agent-profiles-folder> [output-path]. Use --help for details.');
  }

  const profilesDirectory = resolve(profilesArgument);
  const directoryStats = await stat(profilesDirectory).catch(() => undefined);
  if (!directoryStats?.isDirectory()) {
    throw new Error(`Agent profiles folder does not exist or is not a directory: ${profilesDirectory}`);
  }

  const outputPath = resolve(outputArgument ?? profilesDirectory, outputArgument ? '' : 'agent-registry.json');
  const outputDirectory = dirname(outputPath);
  const existingEntries = await loadExistingEntries(outputPath);
  const entries = await readdir(profilesDirectory, { withFileTypes: true });
  const registryEntries: RegistryEntry[] = [];
  const ids = new Set<string>();

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const profilePath = resolve(profilesDirectory, entry.name);
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.json' || profilePath === outputPath) continue;

    const bytes = await readFile(profilePath);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch (error) {
      throw new Error(`Unable to parse ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!isObject(value) || !('id' in value)) continue;
    const profile = validateProfile(value, profilePath);
    if (ids.has(profile.id)) throw new Error(`Duplicate agent profile ID: ${profile.id}`);
    ids.add(profile.id);

    const allowedWorkloads = [...new Set(profile.invocationModes.flatMap((mode) => WORKLOADS_BY_INVOCATION_MODE[mode]))];
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    registryEntries.push({
      id: profile.id,
      configPath: absolutePaths ? profilePath : relativeConfigPath(outputDirectory, profilePath),
      version: nextProfileVersion(existingEntries.get(profile.id), contentHash),
      contentHash,
      allowedWorkloads,
    });
  }

  if (registryEntries.length === 0) {
    throw new Error(`No agent profiles found in ${profilesDirectory}`);
  }

  registryEntries.sort((left, right) => left.id.localeCompare(right.id) || left.configPath.localeCompare(right.configPath));
  await writeFile(outputPath, `${JSON.stringify({ agents: registryEntries }, null, 2)}\n`);
  console.log(`Generated ${outputPath} with ${registryEntries.length} agent profile(s).`);
}

function validateProfile(value: Record<string, unknown>, path: string): AgentProfile {
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error(`Agent profile ${path} must have a non-empty string id`);
  }
  if (!Array.isArray(value.invocationModes) || value.invocationModes.length === 0) {
    throw new Error(`Agent profile ${path} must have at least one invocation mode`);
  }
  for (const mode of value.invocationModes) {
    if (mode !== 'run' && mode !== 'chat') {
      throw new Error(`Agent profile ${path} has unsupported invocation mode: ${String(mode)}`);
    }
  }
  return value as unknown as AgentProfile;
}

async function loadExistingEntries(path: string): Promise<Map<string, RegistryEntry>> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return new Map();
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse existing registry ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(value) || !Array.isArray(value.agents)) {
    throw new Error(`Existing registry ${path} must contain an agents array`);
  }

  const entries = new Map<string, RegistryEntry>();
  for (const candidate of value.agents) {
    if (!isObject(candidate) || typeof candidate.id !== 'string' || typeof candidate.version !== 'string' || typeof candidate.contentHash !== 'string') {
      throw new Error(`Existing registry ${path} contains an invalid agent entry`);
    }
    entries.set(candidate.id, candidate as unknown as RegistryEntry);
  }
  return entries;
}

function nextProfileVersion(previous: RegistryEntry | undefined, contentHash: string): string {
  if (!previous) return '1';
  if (previous.contentHash === contentHash) return previous.version;
  if (!/^\d+$/.test(previous.version)) {
    throw new Error(`Cannot increment non-numeric profile version ${previous.version} for agent ${previous.id}`);
  }
  return (BigInt(previous.version) + 1n).toString();
}

function relativeConfigPath(fromDirectory: string, profilePath: string): string {
  const path = relative(fromDirectory, profilePath).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

if (import.meta.main) await main();
