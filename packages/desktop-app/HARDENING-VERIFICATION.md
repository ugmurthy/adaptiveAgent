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
