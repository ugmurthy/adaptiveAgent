# Adaptive-Agent Install Capability Specification

## Purpose

This document specifies the first-release install capability for the user-facing
`adaptive-agent` CLI in `packages/agent-sdk`.

The goal is to give Linux, macOS, and Windows users a simple install and
first-run flow:

```bash
curl -fsSL https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh | sh
adaptive-agent init
adaptive-agent doctor
adaptive-agent run "Hello, confirm you are working"
adaptive-agent update
```

Windows:

```powershell
irm https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.ps1 | iex
adaptive-agent init
adaptive-agent doctor
adaptive-agent run "Hello, confirm you are working"
adaptive-agent update
```

A successful first-run flow means the user can install the binary, create
configuration, diagnose missing prerequisites, and run one simple agent request
without editing JSON by hand.

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

During release, the git tag is the source of truth for the released version.
Release automation should derive the CLI version and release asset names from
the tag being published.

`adaptive-agent --version` must print a stable first line:

```text
adaptive-agent 0.1.0+a1b2c3d4
commit: a1b2c3d4
target: darwin-arm64
```

The first line is intended for scripts. Additional lines may include build
timestamp, release channel, or source repository when available.

## Release Assets

GitHub Releases are the binary host. The source repository may also be the
release asset repository; a separate distribution repository is not required for
v0.1. The default base URL for downloads should be the GitHub Releases asset URL
for `https://github.com/ugmurthy/adaptiveAgent`. `--repo` and `--base-url`
remain override mechanisms for development, mirrors, and tests.

Each release must publish:

```text
adaptive-agent-v0.1.0-darwin-arm64.tar.gz
adaptive-agent-v0.1.0-darwin-x64.tar.gz
adaptive-agent-v0.1.0-linux-arm64.tar.gz
adaptive-agent-v0.1.0-linux-x64.tar.gz
adaptive-agent-v0.1.0-windows-x64.zip
install.sh
install.ps1
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

For v0.1, macOS release binaries must pass these smoke tests before publishing:

```bash
adaptive-agent --version
adaptive-agent --help
adaptive-agent init --dry-run
adaptive-agent doctor --output json
```

Linux and Windows binaries may be cross-compiled and published without live OS
smoke tests in v0.1. This limitation must be visible in release notes or CI
status.

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
- Do not mutate shell profile files or PowerShell PATH automatically. When PATH
  changes are needed, print exact copy-paste commands for the detected shell or
  PowerShell user environment.
- Do not create `agent.settings.json` or agent configs from the installer.
  First-run config is handled by `adaptive-agent init`.

### Manual And Trust-Friendly Install

Document alternatives to piping a remote script directly into a shell:

```bash
curl -fsSLO https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh
less install.sh
sh install.sh
```

```powershell
irm https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.ps1 -OutFile install.ps1
Get-Content .\install.ps1
.\install.ps1
```

Also document direct binary installation from GitHub Releases:

1. Download the platform archive and `checksums.txt`.
2. Verify the archive SHA-256 checksum.
3. Extract the `adaptive-agent` binary into a user-local bin directory.
4. Add that directory to PATH if needed.
5. Run `adaptive-agent --version`.

### User-Facing Quickstart Guide

Ship a short copy-paste guide alongside the release. It should be shorter than
this implementation spec and include only the happy path plus the most common
API-key fix:

```bash
curl -fsSL https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.sh | sh
adaptive-agent init
export OPENROUTER_API_KEY=<your-key>
adaptive-agent doctor --provider-check
adaptive-agent run "Hello, confirm you are working"
```

Windows:

```powershell
irm https://github.com/ugmurthy/adaptiveAgent/releases/latest/download/install.ps1 | iex
adaptive-agent init
$env:OPENROUTER_API_KEY = "<your-key>"
adaptive-agent doctor --provider-check
adaptive-agent run "Hello, confirm you are working"
```

If the installer reports that PATH is not configured, the guide should tell the
user to copy and run the exact command printed by the installer.

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

### Config And Workspace Resolution

Use the existing Agent SDK config resolution semantics. The install commands
must not introduce a second workspace flag name.

Settings lookup precedence:

```text
1. --settings when supported by the command
2. ADAPTIVE_AGENT_SETTINGS
3. ADAPTIVE_AGENT_HOME/agent.settings.json
4. ~/.adaptiveAgent/agent.settings.json
```

Working directory and workspace root behavior:

```text
1. --cwd sets the command working directory used for config lookup.
2. Settings `workspace.overrideRoot` overrides the agent workspace root.
3. Agent `workspace.root` or `workspaceRoot` sets the workspace root.
4. If no workspace root is configured, default to the resolved command cwd.
```

Relative workspace paths are resolved from the command cwd. `init` should write
`workspaceRoot: "."` by default, not `$HOME`.

## `adaptive-agent init`

### Purpose

Create first-run configuration under `~/.adaptiveAgent` so a user can run the
CLI without hand-authoring JSON.

### Options

```text
--provider openrouter|ollama|mistral|mesh
--model <name>
--api-key-env <name>
--profile safe|coding
--cwd <path>
--yes
--force
--dry-run
--output pretty|json|jsonl
```

`--cwd` matches the existing CLI option and controls the working directory used
for SDK config lookup and for resolving relative workspace paths. Do not add a
separate `--workspace` option for `init` unless the main CLI also adopts it.

When `adaptive-agent init` runs in a TTY and required choices are not supplied,
it may prompt for provider, model, profile, API key environment variable, and
whether to run `doctor` next. In non-TTY mode it must not prompt. `--yes`
accepts defaults and is intended for scripts.

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

The default `apiKeyEnv` is derived from the provider name and should be shown to
the user during `init` output and prompts:

```text
openrouter -> OPENROUTER_API_KEY
mistral    -> MISTRAL_API_KEY
mesh       -> MESH_API_KEY
ollama     -> none
```

If a known provider environment variable is already set, `init` should mention
that it was detected and use it to guide the default provider choice. It must
not print the secret value.

Default provider/model values:

```text
openrouter -> qwen/qwen3.5-27b
mistral    -> mistral-small-2603
mesh       -> qwen/qwen3.5-27b
ollama     -> detected local model, otherwise llama3.2 with an `ollama pull`
              reminder from `doctor`
```

The default profile is `safe`, which installs read-only tools for first-run.
`coding` is an opt-in profile that may include mutating tools such as
`write_file` and `shell_exec`.

Default template:

```json
{
  "id": "default-agent",
  "name": "Default Agent",
  "invocationModes": ["chat", "run"],
  "defaultInvocationMode": "run",
  "model": {
    "provider": "openrouter",
    "model": "qwen/qwen3.5-27b",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  },
  "workspaceRoot": ".",
  "systemInstructions": "You are a helpful local agent.",
  "tools": [
    "read_file",
    "list_directory",
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
- After successful pretty output, print exact next steps for setting the
  provider environment variable, running `doctor`, and running a first simple
  `adaptive-agent run` command.
- If `--cwd` is omitted, write `workspaceRoot` as `.` so the runtime resolves it
  relative to the command working directory rather than granting access to all
  of `$HOME`.

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
  yes: boolean;
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
- For `ollama`, no detected local model is a `warn` with an exact
  `ollama pull <model>` remedy.
- Config lookup and validation should reuse existing Agent SDK config resolution
  where possible.
- The command may load and validate `agent.json`, but must not start a run by
  default.
- Every `warn` and `fail` check should include an actionable remedy in pretty
  output and in the structured `remedy` field.
- `doctor --network` should check GitHub reachability only. It should not call
  provider APIs unless `--provider-check` is supplied.

### Output Model

```ts
type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip';

interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  remedy?: string;
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

Release downloads should use direct GitHub Release asset URLs by default, not a
custom update service. GitHub API calls may be used for release discovery, but
archive and checksum downloads should resolve to the release assets published in
the configured repository.

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

On Windows v0.1, stop after verifying the extracted binary and return
`manual_required` with exact manual update instructions instead of replacing the
running executable.

### Replacement Rules

macOS/Linux:

- Write the new binary to a temp path in the same directory as the existing
  binary.
- `chmod 755` the temp binary.
- Atomically rename it over the old binary.

Windows:

- Do not assume the running `.exe` can replace itself.
- For v0.1, do not replace the running executable. Download and verify the
  target release, print the exact PowerShell installer command needed to update,
  and return `manual_required`.

### Safety Rules

- Never replace a binary without checksum verification.
- Never update from an unsupported OS/arch.
- Never downgrade unless `--version` is explicit.
- Do not require admin privileges.
- Do not mutate agent config, settings, API keys, or runtime stores.
- Do not make model/provider API calls.

### Output Model

```ts
type UpdateStatus = 'up_to_date' | 'update_available' | 'updated' | 'manual_required' | 'failed';

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
12 manual update required
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

For v0.1, CI must run smoke tests on macOS. Linux and Windows binaries may be
cross-compiled and published without live OS smoke tests, but release notes and
CI status should make that limitation visible.

Add focused unit tests for:

```text
version rendering
asset-name resolution per OS/arch
unsupported OS/arch handling
checksum verification success/failure
semver comparison
init dry-run
init dry-run does not create files or directories
init refuses overwrite
init force overwrite
init --yes non-TTY defaults
init safe and coding profile generation
init provider env var detection without secret logging
init generated default uses `workspaceRoot: "."`
init generated default omits mutating tools
init generated config validation
doctor JSON shape
doctor skips network by default
doctor remedies for warnings and failures
doctor strict warnings fail
installer PATH command rendering
update --check available
update --check up-to-date
update Windows manual_required
update checksum mismatch failure
first-run fake model adapter integration
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

Add a first-run integration test for `adaptive-agent run "Hello, confirm you are
working"` using a fake model adapter. Do not require real provider secrets for
basic binary smoke tests.

## Non-Goals For First Release

- npm global install as the primary user path.
- Homebrew, Scoop, WinGet, deb, or rpm packaging.
- Remote templates as the default `init` source.
- Writing raw provider API keys into config files.
- Updating or installing `adaptive-agent-tui` unless terminal compatibility has
  been tested on all supported platforms.
- Installing eval-only tools such as `adaptive-agent-gaia-eval` for end users.
