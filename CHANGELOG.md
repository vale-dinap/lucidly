# Changelog

All notable changes to Lucidly are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **A clear sign when the Lucidly server stops.** The status pill turns red ("Server stopped") and a bar under the top bar says the page no longer updates and since when. Live timers and animations stop, and keep-awake "only while working" lets go. Start `lucidly` again and the page reconnects by itself, and the warning goes.

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
