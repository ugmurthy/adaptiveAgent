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
| Agent window create, focus, restore, and reuse | [ ] | [ ] | [ ] |
| Multi-monitor placement and scaling | [ ] | [ ] | [ ] |
| Child close preserves active runs | [ ] | [ ] | [ ] |
| Parent quit handles closed child windows with active runs | [ ] | [ ] | [ ] |
| Three agents execute concurrently | [ ] | [ ] | [ ] |
| Native profile export dialog | [ ] | [ ] | [ ] |
| Large workspace remains responsive | [ ] | [ ] | [ ] |
| Initialization failure remains attributable to one profile | [ ] | [ ] | [ ] |
| Clean shutdown leaves no sidecars | [ ] | [ ] | [ ] |

Also test moving a child between monitors with different scaling, minimizing it before
reopening from the Studio, and closing/reopening it while another agent is running.

## Rollout and rollback

The signed package SHA-256 is the rollout boundary; do not rebuild between cohorts or mix
partially compatible renderer, host, protocol, sidecar, or database versions. Promote the exact
same package in this order:

1. Internal testers using a copied application-data directory.
2. A canary cohort after all package, migration, workflow, and native-matrix gates pass.
3. Broad distribution after canary telemetry shows no identity, persistence, shutdown, or
   renderer regression.

Use the distribution channel's cohort or promotion control, not an application environment
variable, to control rollout. The final application intentionally has no runtime feature flag
that can expose a partially migrated schema: migrations are forward-only and the renderer,
Rust host, and sidecar protocol ship as one unit. Halt further rollout by withdrawing the
package. Stop promotion immediately for identity leakage, migration/data loss, unrecoverable
pending work, orphaned sidecars, or a renderer-blocking failure. Preserve the affected application
data and diagnostics before remediation. Withdrawal does not downgrade installations that already
upgraded; forward-fix those installations as one new compatibility unit. Downgrade only by
atomically restoring a verified pre-upgrade application-data backup together with the exact
previous signed package. Never run the previous package against a forward-migrated database.

Before broad rollout, retain a backup from the previous package and test upgrade against a
copy containing pre-Agent-Studio history. Verify that provenance backfill identifies every
historical run whose profile still exists and that unmatched active generations become
interrupted without deleting results.

For every cohort, record package SHA-256, signing/notarization verification, schema version,
protocol version, cohort, start/end time, owner, gate results, and rollback-backup location. Keep
the previous signed package and its matching backup until broad-rollout observation is complete.
