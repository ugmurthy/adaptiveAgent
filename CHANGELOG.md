# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] (streaming branch)

### Added
- Streaming support for Mistral adapter
- Streaming support for OpenAI and OpenRouter adapters
- Streaming support for Mesh adapter (phase 1)

## [0.1.25] - 2024

### Fixed
- Fixed e2b missing from SDK

## [0.1.24] - 2024

### Fixed
- Allow idempotent init success

## [0.1.23] - 2024

### Added
- Uninstall command

## [0.1.22] - 2024

### Fixed
- Core optimization improvements
- Init command now includes bundled agents and skills

### Changed
- Merged agent-sdk-refactor branch

### Documentation
- Added mermaid diagram explaining agent-sdk architecture

## [0.1.21] - 2024

### Fixed
- Markdown rendering of catalog and outputs (fixed version clash issue)

## [0.1.2] - 2024

### Added
- `create-agent` command
- `catalog` command
- `doctor` command - checks for provider reachability and database connections
- Serper as additional web-search provider (more reliable than duckduckgo)

### Documentation
- Added install instructions

## [0.1.1] - 2024

### Fixed
- TUI improvements (work in progress, not part of release)

## [0.1.0] - Initial Release

Initial release of the AdaptiveAgent framework.

---

[Unreleased]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.25...HEAD
[0.1.25]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.24...v0.1.25
[0.1.24]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.23...v0.1.24
[0.1.23]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.22...v0.1.23
[0.1.22]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.21...v0.1.22
[0.1.21]: https://github.com/adaptiveagent/adaptiveagent/compare/V0.1.2...v0.1.21
[0.1.2]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.1...V0.1.2
[0.1.1]: https://github.com/adaptiveagent/adaptiveagent/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/adaptiveagent/adaptiveagent/releases/tag/v0.1.0
