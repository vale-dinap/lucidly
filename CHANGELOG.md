# Changelog

All notable changes to Lucidly are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Glance, a view of the run at a glance**, now the default view (next to Simple, which you can still pick; Lucidly remembers your choice), with the token heat button: a large orb for the agent's state (working, your turn, asked you something, in trouble, quiet), and the tasks as a vertical wheel: the one in the spotlight unfolds into its steps as large shapes, the two above and below stay compressed and fade out. Turn the wheel (mouse wheel, `↑` / `↓`, or a click) to look at other tasks; it comes back to the live one by itself. Almost no text: hover for names, click for the side panel, double-click for the Simple view.
- **A clear sign when the Lucidly server stops.** The status pill turns red ("Server stopped") and a bar under the top bar says the page no longer updates and since when. Live timers and animations stop, and keep-awake "only while working" lets go. Start `lucidly` again and the page reconnects by itself, and the warning goes.
- **The session list refreshes itself while it's open**, so a session started in the meantime shows up straight away. Only the transcripts that changed are read again.
- **All projects, grouped by folder.** In the session list's *All projects*, sessions sit in a folding group per project folder, with its name, session count and latest change. This project comes first and open, as do projects with a live session; *Expand all* / *Collapse all* at the top.
- **A light / dark theme switch**, at the right end of the top bar: System (the default, following the operating system), Light or Dark. The choice is remembered.
- **Long shell commands are shown in parts**: their shell lines, the script they run (`node - <<'EOF'`, `python -c "…"`), highlighted as JavaScript or Python, and the content they write to a file (`cat > a.py <<'EOF'`), labelled with the file. *Show the whole command* shows it as recorded. For commands that change files, long lines that wrap continue indented, and dense JavaScript can be laid out for reading with *Reformat for reading* (display only; *Show as written* goes back).

### Fixed

- **A finished turn shows as finished straight away.** Lucidly waited for a record Claude Code doesn't always write (not after a turn started by a background task's notification), so a session could look busy for up to five minutes after it was done. The agent's final message now ends the turn.
- **No more steps that never existed.** A bulleted list whose items all open with a bold label ("**Rows:** …") describes things; it was taken for a plan, adding steps that never ran (shown as to come, then as done with the others).
- **Files changed by shell commands are now edits**, not plain commands: `sed -i`, redirections and heredocs, `tee`, `cp`/`mv`/`rm`, PowerShell's `Set-Content` and the like, and scripts that write files. They read "Edit app.js, README.md (by command)" (or Delete, Rename, Move), count with the edits, appear in the Files view and keep their command line, which shows where a diff would be.

- **A task continued by your reply shows where each round ended.** When you answer after the agent finished ("yes, go with the first"), the chain no longer files your reply inside an earlier step and loses the first result: the end node stays as an intermediate goal (a smaller diamond: done, asked, or interrupted, with that round's result), your reply follows it, then the new steps and the final goal. The Detailed view shows the same.
- **Every message of yours has its own place.** One sent while the agent worked was filed inside a step; it is now a node in the Simple view and a row in the Detailed view, between the steps before and after it. In the details panel your messages are outlined in the accent colour.
- **Copy buttons on every card of the side panel**: messages, the agent's text and results (as Markdown), plans, thinking, commands and their parts, inputs, outputs, errors and diffs (as a unified diff). Long blocks are copied whole, even when only their first lines are shown.
- **A task's request, messages and round ends open its whole conversation.** Click one (in the Simple or Detailed view) and the panel shows the task's conversation, scrolled to that point, which glows a soft yellow.
- **A message after `/compact` is no longer mistaken for one sent mid-turn**, which used to fold it into the previous task.

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
