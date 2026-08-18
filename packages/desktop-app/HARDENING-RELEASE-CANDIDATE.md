# Desktop hardening release candidate

## Candidate identity

- Source commit: `89ae7e6062f527184eebe3085f4d45d701021463`
- Build date: 2026-08-18
- Builder: automated local executor on macOS 15.6 arm64
- Product version: `0.1.0`
- Package: `AdaptiveAgent_0.1.0_aarch64.dmg`
- Package SHA-256: `dbc87026d8e67fc8bd27f7b576e57e654760f31011ca2b3578e45120d7a80ccf`
- Host executable SHA-256: `916a143612e0de20839495d411bfa015e16153a417b54a7196762e1425b9eef8`
- Agent runtime SHA-256: `5d0d740047b0c09bc3386c58d66a49875d4105391c1ef89cc91df6ac6075bb7e`
- Trace sidecar SHA-256: `39fb6833f0f2499828f2e0d57bad53f5a16ce6ae08c5bf3ca761171e089eb21f`

The `.app` and DMG were produced successfully. The application contains three arm64 Mach-O
executables: the Rust host, agent runtime, and trace sidecar. This local package is linker
ad-hoc-signed, has no Team ID, is not notarized, and fails Gatekeeper assessment. It is suitable
for local validation only and must not be promoted as a distributable release artifact.

## Automated validation

The complete macOS automated gate passed:

- Rust formatting, 75 library tests, and `cargo check`;
- desktop renderer: 4 mounted component tests, 37 Bun tests, Svelte/TypeScript typecheck, and
  production web build;
- desktop bridge: 40 Vitest tests, 3 SQLite/sidecar integration tests, and production build;
- Agent SDK: 173 Vitest tests passed and 1 skipped plus the Bun SQLite suites under an isolated
  home directory;
- native Tauri release compilation, `.app` bundling, and DMG bundling.

The persisted-data fixtures cover ISO, numeric, epoch-string, blank, and malformed timestamps;
pre-Agent-Studio and current workbench databases; and workspace artifact provenance. Migration
tests open a copy and verify that the source database remains unchanged.

## Packaged workflow record

The current executor cannot interact with native windows, dialogs, multi-monitor placement,
provider-backed three-agent runs, or restart/quit prompts. Therefore none of the ten packaged GUI
workflows is represented as passed. The package build and content inspection above are automated
packaging checks, not substitutes for workflow interaction.

Before distribution, run all ten workflows in `DESKTOP-AGENT-STUDIO-IMPLEMENTATION-PLAN.md` with a
copy of realistic application data and record the tester, package SHA-256, result, and evidence.

## Native matrix

`GAP` means not executed, not failed. Every gap requires explicit release-owner acceptance or a
completed test before distribution.

| Scenario | macOS 15.6 arm64 | Windows | Linux |
| --- | --- | --- | --- |
| Agent window create, focus, restore, and reuse | GAP: no GUI executor | GAP: unavailable host | GAP: unavailable host |
| Multi-monitor placement and scaling | GAP: no multi-monitor GUI | GAP: unavailable host | GAP: unavailable host |
| Child close preserves active runs | GAP: no GUI/provider run | GAP: unavailable host | GAP: unavailable host |
| Parent quit handles closed child windows with active runs | GAP: no GUI/provider run | GAP: unavailable host | GAP: unavailable host |
| Three agents execute concurrently | GAP: no configured provider | GAP: unavailable host | GAP: unavailable host |
| Native profile export dialog | GAP: no GUI executor | GAP: unavailable host | GAP: unavailable host |
| Large workspace remains responsive | GAP: no packaged interaction | GAP: unavailable host | GAP: unavailable host |
| Initialization failure remains attributable to one profile | GAP: no packaged interaction | GAP: unavailable host | GAP: unavailable host |
| Clean shutdown leaves no sidecars | GAP: no packaged interaction | GAP: unavailable host | GAP: unavailable host |

## Release disposition

Automated hardening and macOS packaging are green. Distribution remains blocked on:

1. signing and notarizing the macOS artifact;
2. completing or explicitly accepting every native matrix gap;
3. completing the ten packaged workflows with the full realistic payload;
4. producing and validating native Windows and Linux packages.
