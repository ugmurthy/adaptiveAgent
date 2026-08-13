# Desktop Agent Studio release checklist

Use this checklist for every Desktop Agent Studio release candidate. Automated checks are
required before packaging. Native checks must be completed on each target operating system;
passing them on one platform does not qualify another platform.

## Automated checks

Run from the repository root:

```sh
source "$HOME/.cargo/env"
cargo test --manifest-path packages/desktop-app/src-tauri/Cargo.toml --lib
cargo check --manifest-path packages/desktop-app/src-tauri/Cargo.toml

cd packages/desktop-app
bun run typecheck
bun run test
bun run web:build

cd ../desktop-bridge
bun run test
bun run build

cd ../agent-sdk
bun run test
bun run build
```

The suites cover:

- catalog discovery, invalid profiles, and duplicate IDs;
- workbench migration, provenance backfill, and history preservation;
- three-run capacity isolated per agent;
- command, event, attachment, and history ownership by `agentId`;
- deterministic native-window reuse, close-state exclusion, and limit parsing;
- immutable runtime generation routing after profile edits;
- builder dry-run, validation, confirmation, overwrite protection, and save;
- exact JSON export and archive/restore without history deletion;
- existing workbench, chat, artifact, inspection, and shutdown behavior.

## Native matrix

Record the packaged build identifier and tester for each completed column.

| Scenario | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Agent avatar creates a native workspace window | [ ] | [ ] | [ ] |
| Reopening an agent restores, focuses, and reuses its window | [ ] | [ ] | [ ] |
| Window position remains visible after monitor removal | [ ] | [ ] | [ ] |
| Closing a child preserves its active runs | [ ] | [ ] | [ ] |
| Closing the parent follows the active-run quit flow | [ ] | [ ] | [ ] |
| Quitting with closed child windows handles active runs | [ ] | [ ] | [ ] |
| Three different agents execute concurrently | [ ] | [ ] | [ ] |
| A fourth run is rejected only for the saturated agent | [ ] | [ ] | [ ] |
| `ADAPTIVE_AGENT_MAX_WINDOWS` accepts a positive integer | [ ] | [ ] | [ ] |
| Invalid window-limit values fall back to 3 with a diagnostic | [ ] | [ ] | [ ] |
| Native JSON export dialog writes the exact profile | [ ] | [ ] | [ ] |
| Archive disables new work but retains history and artifacts | [ ] | [ ] | [ ] |
| Restore re-enables work without changing prior history | [ ] | [ ] | [ ] |

Also test moving a child between monitors with different scaling, minimizing it before
reopening from the Studio, and closing/reopening it while another agent is running.

## Rollout and rollback

Release cuts are the rollout boundary; do not mix partially compatible protocol or database
versions within one packaged application. Promote in this order:

1. Multi-agent catalog, persistence migration, and same-window internal validation.
2. Agent-scoped runtimes and native specialist windows.
3. Builder, export, archive, and restore.
4. Full production rollout after the native matrix is complete.

Use the distribution channel's cohort or promotion control, not an application environment
variable, to control rollout. The final application intentionally has no runtime feature flag
that can expose a partially migrated schema: migrations are forward-only and the renderer,
Rust host, and sidecar protocol ship as one unit. Halt further rollout by withdrawing the
package. Withdrawal does not downgrade installations that already upgraded; forward-fix those
installations. Downgrade only by restoring a verified pre-upgrade application-data backup
together with the previous package.

Before broad rollout, retain a backup from the previous package and test upgrade against a
copy containing pre-Agent-Studio history. Verify that provenance backfill identifies every
historical run whose profile still exists and that unmatched active generations become
interrupted without deleting results.
