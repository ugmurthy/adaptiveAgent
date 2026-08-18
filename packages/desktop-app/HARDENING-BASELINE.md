# Desktop hardening baseline

Captured on 2026-08-18 before Hardening Phase 1.

## Build identity

- Branch: `desktop-app-hardening`
- Commit: `95a177879dcd9574c93fda5a3fced298bee05413`
- Local debug binary SHA-256: `26f594c145a49132c65551a199ed9f2dfaa9c0ef1d98cebfb5bccd7e5bce1266`
- Host: macOS 15.6, arm64
- Fixture source: `src-tauri/tests/fixtures/hardening/`

The debug binary identifies the baseline only. A signed or distributable packaged build was not
produced during characterization.

## Automated results

| Package | Command | Baseline result |
| --- | --- | --- |
| Desktop native | `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Pass |
| Desktop native | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Pass, 72 tests |
| Desktop native | `cargo check --manifest-path src-tauri/Cargo.toml` | Pass |
| Desktop renderer | `bun run test` | Pass, 32 tests |
| Desktop renderer | `bun run typecheck` | Pass |
| Desktop renderer | `bun run web:build` | Pass |
| Desktop bridge | `bun run test` | 1 existing failure, 39 pass |
| Agent SDK | `bun run test` | 17 existing failures, 156 pass, 1 skipped |

The desktop-bridge failure is `translates only immutable files contained by the managed attachment
root`; its synthetic managed file fails the current immutable-file validation. The Agent SDK
failures are environment-sensitive: tests read the developer's `~/.adaptiveAgent/agent.settings.json`
and Vitest cannot load `bun:sqlite`. They are baseline failures, not accepted release exceptions.
Build commands after a failing `bun run test` were not reached by shell `&&`.

## Characterization matrix

| Hotspot | Classification | Baseline evidence |
| --- | --- | --- |
| Delayed workbench refresh under sustained events | Statically verified contract violation | `App.svelte` can start overlapping refreshes and discards valid older responses by generation. |
| Task/chat/recovery persistence failure | Risk requiring targeted native test | Atomic DB tests exist, but completion publication after injected failure is not covered. |
| Initialization vs settings reload vs shutdown | Statically verified contract violation | The global lifecycle guard spans sidecar/catalog RPC and some event publication. |
| Sidecar shutdown response and clean exit | Risk requiring targeted native test | Response-first routing has a unit test; process shutdown and waiter release need integration coverage. |
| Persisted timestamp forms | Reproduced defect | Studio, rail, and inspector use three incompatible parsing paths; invalid values can leak into display. |
| Large/deep workspace | Statically verified contract violation | Artifact discovery is recursive and has no depth or result bound. |
| Historical artifacts after settings change | Reproduced defect | Listing and preview resolve only against the current workspace despite persisted run provenance. |
| Duplicate basenames and symlink escape | Partial contract | Duplicate basenames are rejected; canonical confinement exists; bounded traversal and historical roots are uncovered. |
| Inspector resize teardown | Statically verified contract violation | Window pointer listeners are removed only by `pointerup`, not component teardown. |

## Visible workflow contracts

| Workflow | Expected transition and DOM outcome |
| --- | --- |
| Loading | `starting -> ready/error`; loading copy is replaced by the Studio grid or an actionable alert. |
| Initializing | Per-agent `starting -> ready/error`; only that profile's card/workspace reports its failure. |
| Saving | Save control is disabled while pending, then re-enabled with persisted state or an actionable error. |
| Run completion | Active occupancy is released, durable output or error is rendered, and history converges without another event. |
| Shutdown | Child close frees only its window; parent close with active work shows confirmation; wait/terminate reaches process exit. |

## Fixture policy

`src-tauri/tests/fixtures/hardening/` contains source fixtures rather than developer application
data. Tests must create a fresh temporary database or workspace from these files. The pre-Studio
and current SQL snapshots are never migrated in place; copy them before opening through the
application migrator.

## Manual evidence gaps

- No packaged GUI workflow was exercised during baseline capture.
- Native Windows and Linux workflows were unavailable on this macOS host.
- No signed release identifier or tester matrix exists until Hardening Phase 5.
