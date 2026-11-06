# Changelog

All notable changes to Lucidly are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **A clear sign when the Lucidly server stops.** The status pill turns red ("Server stopped") and a bar under the top bar says the page no longer updates and since when. Live timers and animations stop, and keep-awake "only while working" lets go. Start `lucidly` again and the page reconnects by itself, and the warning goes.
- **The session list refreshes itself while it's open**, so a session started in the meantime shows up straight away. Only the transcripts that changed are read again.
- **A light / dark theme switch**, at the right end of the top bar: System (the default, following the operating system), Light or Dark. The choice is remembered.

### Fixed

- **Files changed by shell commands are now edits**, not plain commands: `sed -i`, redirections and heredocs, `tee`, `cp`/`mv`/`rm`, PowerShell's `Set-Content` and the like, and scripts that write files. They read "Edit app.js, README.md (by command)" (or Delete, Rename, Move), count with the edits, appear in the Files view and keep their command line, which shows where a diff would be.

### Changed

- **The Files view's History lists the newest change first.**
- **The Files view no longer flags recovered failures in red.** A file only shows the failed edits nothing has made up for. Recovered ones are left to their own rows, where they read "failed → recovered" in grey, here and in the other views.
- **`lucidly` no longer guesses which session to open.** It opens the folder's session when there's no doubt (the only one, or the only one in progress) and otherwise starts on the session list.

## [0.2.0] - 2026-11-05

### Added

- **Zoom for the Simple view**, from 50% to 200%: a stepped slider in the toolbar, Ctrl+scroll over the view, or `-` and `=` (`0`, or a click on the percentage, resets it). Bigger for comfortable reading and high-resolution screens; smaller for an overview of more tasks and longer chains, with step labels hidden below 75% and task titles kept readable. The setting is remembered.

### Fixed

- **Expand all / Collapse all now work with every filter.** Choosing a filter no longer opens all of its tasks: it narrows the list and keeps what is open or closed. The button's label follows what is on screen.
- **The session list no longer hangs on "Loading…"** when the Lucidly server is slow, stopped or returns an error: it says what happened and offers a Retry.

### Changed

- A slightly larger keep-awake icon.
- The README starts with a quick start: `npx @vale-dinap/lucidly`.

## [0.1.0] - 2026-11-05

First public release.

[0.2.0]: https://github.com/vale-dinap/lucidly/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/vale-dinap/lucidly/releases/tag/v0.1.0
