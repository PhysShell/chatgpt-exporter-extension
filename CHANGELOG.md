# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2025-07-14

### Added

- Initial release
- Automatic project discovery via DOM `MutationObserver` — detects projects as they appear in the sidebar without manual interaction
- Auto-click of the "More" / "Továbbiak" sidebar button to reveal all projects
- Bearer token authentication via `/api/auth/session` — no passwords or API keys required
- Full cursor-based pagination for conversation lists (no missed conversations for large accounts)
- Exports conversations from all projects into `Projects/{Project Name}/` subfolders
- Exports non-project conversations into a `Conversations/` folder
- Deduplication — conversations that appear in both project and general lists are only exported once
- Pure JavaScript Markdown conversion — traverses the internal message tree via `current_node` → `parent` chain
- Filenames prefixed with creation date: `2025-06-01_My Conversation.md`
- Duplicate filename handling — appends `_1`, `_2`, etc. when titles collide
- Pure JavaScript ZIP builder (no external libraries) — standard-compliant ZIP with CRC32 checksums
- Export runs in the background — popup can be closed and reopened without interrupting the export
- Live progress bar with percentage
- Estimated time remaining (ETA) display during the download phase
- Visual "done" notification with animated overlay, shimmer progress bar, and gradient header
- Two-note completion sound via Web Audio API (no permissions required)
- "Export Again" button after completion — resets UI for a fresh export

### Technical notes

- Chrome Manifest V3 extension
- Long-lived port (`chrome.tabs.connect`) for real-time popup ↔ content script communication
- Content script state (`isExporting`, `lastResult`, `currentPct`, `currentEta`) persists across popup close/reopen
- Markdown content pre-encoded to `Uint8Array` before ZIP assembly to minimise peak memory usage

---

<!-- next release placeholder

## [1.1.0] — TBD

### Added
### Fixed
### Changed

-->
