# Desktop hardening verification

## Hardening Phase 2

### Native command inventory

The following operations can wait on sidecars, filesystem traversal, file writes, or lifecycle
initialization and now cross an asynchronous Tauri command boundary with blocking work isolated:

- desktop bootstrap and settings reload/save;
- task and chat submission;
- stop, recovery planning, recovery dispatch, and steering;
- run trace overview;
- attachment cleanup;
- artifact listing, basename resolution, and preview;
- profile export dialog and file write;
- wait and terminate quit coordination.

Artifact discovery has deterministic lexical ordering, a maximum depth of 16, a maximum of 2,000
results, and a two-second deadline. It does not follow directory symlinks or scan `.git`,
`node_modules`, or `target`.

### Native interaction record

- macOS arm64: automated Rust command-contract, bounds, confinement, export-write, sidecar routing,
  timeout, and shutdown tests completed.
- Packaged save-dialog interaction: not exercised in this non-interactive executor.
- Windows and Linux packaged dialog/window checks: unavailable on this host.

These GUI gaps remain release blockers for the Hardening Phase 5 native matrix; they are not
represented as automated passes.

## Hardening Phase 3

- `timestamp.ts` is the single normalization and display contract for ISO strings, numbers,
  epoch-millisecond strings, blanks, and invalid values.
- Agent Studio, workbench history, and run inspector use that contract. Mounted Svelte tests cover
  blank and malformed persisted values.
- Artifact list and preview requests may carry a run ID. Native resolution then uses that run's
  persisted `workspace_root` and `shell_cwd`, canonicalizes paths, rejects escapes and ambiguous
  basenames, and never substitutes the current agent workspace.
- Durable run results remain the primary artifact source when trace data is empty or unavailable;
  trace results are additive and resolved only against files actually discovered in the run's
  workspace.
- General JSON syntax failures include line and column diagnostics; typographic delimiter guidance
  remains targeted, while smart punctuation inside valid strings remains accepted.
- Forward migration tests copy the pre-upgrade database before opening it and verify the source
  fixture remains at its original migration version.

## Hardening Phase 4

- App refresh, trace selection, artifact resolution, and recovery requests reject late completion
  after disposal or supersession.
- Desktop event callbacks, store subscriptions, the clock interval, and in-progress inspector
  pointer-drag listeners have explicit component ownership and teardown.
- Agent-window bootstrap and asynchronous artifact/result rendering do not publish into disposed
  components.
- Mounted component regressions verify normal unsubscription and the race where subscription setup
  finishes after the owning component has already unmounted.

## Hardening Phase 5

- The complete automated gate and native macOS Tauri release build passed.
- The `.app` contains arm64 host, agent-runtime, and trace-session executables, and Tauri produced
  `AdaptiveAgent_0.1.0_aarch64.dmg`.
- `HARDENING-RELEASE-CANDIDATE.md` records source and artifact hashes, automated coverage, signing
  status, the exact native matrix, packaged-workflow gaps, and release blockers.
- `RELEASE-CHECKLIST.md` defines atomic same-package cohort promotion and forward-only rollback;
  it prohibits opening a forward-migrated database with an older package.
