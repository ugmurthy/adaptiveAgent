# Adaptive-Agent Install Capability Specification

## Purpose

This document specifies the first-release install capability for the user-facing
`adaptive-agent` CLI in `packages/agent-sdk`.

The goal is to give Linux, macOS, and Windows users a simple install and
first-run flow:

```bash
curl -fsSL https://adaptive-agent.dev/install.sh | sh
adaptive-agent init
adaptive-agent doctor
adaptive-agent update
```

Windows:

```powershell
irm https://adaptive-agent.dev/install.ps1 | iex
adaptive-agent init
adaptive-agent doctor
adaptive-agent update
```

## Scope And Package Boundary

- Implement CLI commands and install support in `packages/agent-sdk`.
- Do not move release, GitHub, PATH, template, first-run setup, or installer
  logic into `@adaptive-agent/core`.
- `@adaptive-agent/core` must remain focused on runtime semantics.
- `adaptive-agent init`, `adaptive-agent doctor`, and `adaptive-agent update`
  are CLI-facing workflows owned by Agent SDK.

## Version Model

Use semver GitHub release tags as the source of version ordering:

```text
v0.1.0
v0.1.1
v0.2.0-preview.1
```

Do not use a short git commit hash as the primary version. A short commit hash
is useful as build metadata, but it cannot safely drive update ordering.

`adaptive-agent --version` must print a stable first line:

```text
adaptive-agent 0.1.0+a1b2c3d4
commit: a1b2c3d4
target: darwin-arm64
```

The first line is intended for scripts. Additional lines may include build
timestamp, release channel, or source repository when available.

## Release Assets

GitHub Releases are the binary host. Each release must publish:

```text
adaptive-agent-v0.1.0-darwin-arm64.tar.gz
adaptive-agent-v0.1.0-darwin-x64.tar.gz
adaptive-agent-v0.1.0-linux-arm64.tar.gz
adaptive-agent-v0.1.0-linux-x64.tar.gz
adaptive-agent-v0.1.0-windows-x64.zip
checksums.txt
```

Optional future assets:

```text
checksums.txt.sig
templates.tar.gz
```

Initial release templates and base skills should be embedded in the binary so
`adaptive-agent init` works offline and always matches the installed CLI
version. Remote template packs can be added later as an explicit option.

## Build Requirements

Compile `packages/agent-sdk/src/adaptive-agent.ts` into standalone binaries
using Bun.

Each produced binary must pass these smoke tests:

```bash
adaptive-agent --version
adaptive-agent --help
adaptive-agent init --dry-run
adaptive-agent doctor --output json
```

Do not include `adaptive-agent-gaia-eval` in the default end-user installer.
Include `adaptive-agent-tui` only if it is separately tested on macOS, Linux,
and Windows terminals.

## Installer Scripts

Create installer scripts:

```text
scripts/install.sh
scripts/install.ps1
```

The scripts must:

1. Detect OS and CPU architecture.
2. Resolve install version from `ADAPTIVE_AGENT_VERSION`; otherwise use the
   latest GitHub Release.
3. Download the matching release archive plus `checksums.txt`.
4. Verify the archive SHA-256 checksum before extracting.
5. Install to a user-local bin directory.
6. Print PATH instructions when the install directory is not already on PATH.
7. Run `adaptive-agent --version` after installation.

Default install locations:

```text
macOS/Linux: ~/.local/bin/adaptive-agent
Windows: %LOCALAPPDATA%\AdaptiveAgent\bin\adaptive-agent.exe
```

Rules:

- Do not require `sudo` by default.
- Fail closed on checksum mismatch.
- Do not mutate user config files.
- Do not create `agent.settings.json` or agent configs from the installer.
  First-run config is handled by `adaptive-agent init`.

## CLI Commands

Add these commands to `packages/agent-sdk/src/adaptive-agent.ts`:

```bash
adaptive-agent init [options]
adaptive-agent doctor [options]
adaptive-agent update [options]
adaptive-agent --version
```

All three commands support:

```text
--output pretty|json|jsonl
```

Default output is `pretty`.

## `adaptive-agent init`

### Purpose

Create first-run configuration under `~/.adaptiveAgent` so a user can run the
CLI without hand-authoring JSON.

### Options

```text
--provider openrouter|ollama|mistral|mesh
--model <name>
--api-key-env <name>
--workspace <path>
--force
--dry-run
--output pretty|json|jsonl
```

### Default Paths

```text
~/.adaptiveAgent/agent.settings.json
~/.adaptiveAgent/agents/default-agent.json
~/.adaptiveAgent/skills/
```

### Default Settings Template

```json
{
  "version": 1,
  "agents": {
    "dirs": ["~/.adaptiveAgent/agents"]
  },
  "skills": {
    "dirs": ["~/.adaptiveAgent/skills"]
  },
  "runtime": {
    "mode": "memory"
  }
}
```

### Default Agent Template

Use `openrouter` by default unless `--provider` is supplied.

For API-key providers, use `apiKeyEnv`; never write a raw API key value to disk.
For `ollama`, omit `apiKeyEnv`.

Default template:

```json
{
  "id": "default-agent",
  "name": "Default Agent",
  "invocationModes": ["chat", "run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "openai/gpt-4.1-mini",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "workspaceRoot": "$HOME",
  "systemInstructions": "You are a helpful local agent.",
  "tools": [
    "read_file",
    "list_directory",
    "write_file",
    "shell_exec",
    "web_search",
    "read_web_page"
  ],
  "delegates": [],
  "defaults": {
    "maxSteps": 30,
    "capture": "summary"
  }
}
```

### Base Skills

Create a minimal base skill set under:

```text
~/.adaptiveAgent/skills/
```

The initial base skills should be simple Markdown skill directories or files
that are useful for first-run behavior and safe to install globally for the
user. Store their source in the repo, for example:

```text
packages/agent-sdk/templates/init/skills/
```

Embed these templates into the built CLI so `init` does not need network access.

### Rules

- Create missing files and directories by default.
- Refuse to overwrite existing files unless `--force` is provided.
- `--dry-run` must print planned writes without touching disk.
- Validate generated settings and agent config before exiting.
- Keep all default user files under `~/.adaptiveAgent`.
- Do not make model calls or provider API calls.

### Output Model

```ts
type InitActionStatus = 'created' | 'exists' | 'would_create' | 'overwritten' | 'failed';

interface InitAction {
  path: string;
  kind: 'file' | 'directory';
  status: InitActionStatus;
  message: string;
}

interface InitReport {
  command: 'init';
  homeDir: string;
  dryRun: boolean;
  force: boolean;
  actions: InitAction[];
  settingsPath: string;
  defaultAgentPath: string;
  skillsDir: string;
}
```

### Exit Codes

```text
0 success
1 file conflict or validation failure
2 invalid usage
3 internal error
```

## `adaptive-agent doctor`

### Purpose

Verify the CLI installation and local configuration without model calls by
default.

### Options

```text
--cwd <path>
--agent <path-or-name>
--settings <path>
--runtime memory|postgres
--provider openrouter|ollama|mistral|mesh
--model <name>
--network
--provider-check
--strict
--output pretty|json|jsonl
```

`--provider-check` implies `--network`.

### Required Checks

```text
cli.version
cli.executable
platform.supported
config.settingsLookup
config.agentLookup
config.agentValidation
config.workspaceRoot
config.agentSearchDirs
provider.config
provider.apiKey
runtime.mode
runtime.postgresEnv
runtime.postgresConnection
network.github
provider.reachability
```

### Check Behavior

- `network.github` is `skip` unless `--network` or `--provider-check` is used.
- `provider.reachability` is `skip` unless `--provider-check` is used.
- `runtime.postgresConnection` is `skip` unless runtime resolves to `postgres`.
- Missing API key is `fail` only when the resolved provider requires one.
- For `ollama`, missing API key is not a failure.
- Config lookup and validation should reuse existing Agent SDK config resolution
  where possible.
- The command may load and validate `agent.json`, but must not start a run by
  default.

### Output Model

```ts
type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface DoctorReport {
  command: 'doctor';
  version: string;
  commit?: string;
  platform: NodeJS.Platform;
  arch: string;
  cwd: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
}
```

For `pretty` output, group checks under short headings such as Version, Install,
Config, Provider, Runtime, and Network.

For `json` output, emit exactly one `DoctorReport`.

For `jsonl` output, emit each `DoctorCheck` as one line and emit a final summary
record.

### Exit Codes

```text
0 no failures, and no warnings under --strict
1 failed checks, or warnings under --strict
2 invalid usage
3 internal error
```

## `adaptive-agent update`

### Purpose

Update the installed standalone binary from GitHub Releases.

### Options

```text
--check
--version <version>
--channel stable|preview
--force
--yes
--repo <owner/repo>
--base-url <url>
--output pretty|json|jsonl
```

Defaults:

```text
--channel stable
```

`--repo` and `--base-url` are intended for development and testing.

### Release Resolution

Asset names are selected by platform and architecture:

```text
darwin arm64 -> adaptive-agent-v{version}-darwin-arm64.tar.gz
darwin x64   -> adaptive-agent-v{version}-darwin-x64.tar.gz
linux arm64  -> adaptive-agent-v{version}-linux-arm64.tar.gz
linux x64    -> adaptive-agent-v{version}-linux-x64.tar.gz
win32 x64    -> adaptive-agent-v{version}-windows-x64.zip
```

Unsupported OS/arch combinations must fail with a clear message.

### Required Flow

1. Read current version and build metadata.
2. Determine the current executable path.
3. Resolve the target GitHub Release.
4. Compare semver versions.
5. If current version equals target and `--force` is not used, return
   `up_to_date`.
6. Download the selected archive and `checksums.txt`.
7. Verify SHA-256 for the selected archive.
8. Extract the binary to a temp directory.
9. Run the extracted binary with `--version`.
10. Replace the installed binary.
11. Run the installed binary with `--version`.

### Replacement Rules

macOS/Linux:

- Write the new binary to a temp path in the same directory as the existing
  binary.
- `chmod 755` the temp binary.
- Atomically rename it over the old binary.

Windows:

- Do not assume the running `.exe` can replace itself.
- For v0.1, either:
  - spawn a detached PowerShell helper that waits for the current process to
    exit and then replaces the binary, or
  - print a clear installer command and return a controlled failure/status.

### Safety Rules

- Never replace a binary without checksum verification.
- Never update from an unsupported OS/arch.
- Never downgrade unless `--version` is explicit.
- Do not require admin privileges.
- Do not mutate agent config, settings, API keys, or runtime stores.
- Do not make model/provider API calls.

### Output Model

```ts
type UpdateStatus = 'up_to_date' | 'update_available' | 'updated' | 'failed';

interface UpdateReport {
  command: 'update';
  status: UpdateStatus;
  currentVersion: string;
  targetVersion?: string;
  channel: 'stable' | 'preview';
  platform: NodeJS.Platform;
  arch: string;
  assetName?: string;
  installPath?: string;
  message: string;
  error?: string;
}
```

### Exit Codes

```text
0 success or already up to date
1 update failed
2 invalid usage
10 update available with --check
11 no update available with --check
```

## Suggested Implementation Structure

Keep implementation small and testable by extracting command helpers from
`adaptive-agent.ts` where useful:

```text
packages/agent-sdk/src/install/version.ts
packages/agent-sdk/src/install/init.ts
packages/agent-sdk/src/install/doctor.ts
packages/agent-sdk/src/install/update.ts
packages/agent-sdk/src/install/github-release.ts
packages/agent-sdk/src/install/checksum.ts
packages/agent-sdk/src/install/templates.ts
```

This structure is only a recommendation. Preserve existing local patterns if a
different layout fits the package better.

## Testing Requirements

Add focused unit tests for:

```text
version rendering
asset-name resolution per OS/arch
unsupported OS/arch handling
checksum verification success/failure
semver comparison
init dry-run
init refuses overwrite
init force overwrite
init generated config validation
doctor JSON shape
doctor skips network by default
doctor strict warnings fail
update --check available
update --check up-to-date
update checksum mismatch failure
```

Use mocked GitHub, network, filesystem, and process execution operations for
unit tests.

Add CI smoke tests that run the compiled binary on each supported OS:

```bash
adaptive-agent --version
adaptive-agent --help
adaptive-agent init --dry-run
adaptive-agent doctor --output json
```

## Non-Goals For First Release

- npm global install as the primary user path.
- Homebrew, Scoop, WinGet, deb, or rpm packaging.
- Remote templates as the default `init` source.
- Writing raw provider API keys into config files.
- Updating or installing `adaptive-agent-tui` unless terminal compatibility has
  been tested on all supported platforms.
- Installing eval-only tools such as `adaptive-agent-gaia-eval` for end users.
