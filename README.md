# Lucidly

*See what your AI agent is doing, at a glance.*

## Purpose

AI agents are increasingly capable of working on long, multi-step tasks on their own. While they work, most of them report their progress as a continuous stream of text: plans, tool calls, file reads, command outputs, reasoning, errors and retries. That stream is complete, but it is hard to follow. To find out what the agent is doing right now, what it has already finished, or where it got stuck, the user has to read through a fast-moving wall of text and often scroll back through a long history to find the relevant part.

Lucidly turns that stream into a clean, live visual picture of the agent's progress. It is designed to answer a few simple questions instantly: where the agent started, where it is heading, which step it is on now, what it is working with, and whether anything has come up along the way. The raw text is never lost; it is simply organized behind the visual view, so the user can open any step and read exactly what the agent produced for it.

## How it works

Lucidly sits alongside the agent and listens to the text it streams while working. It does not replace the agent's own interface and does not interfere with it. As output arrives, Lucidly parses it, recognizes meaningful events (a plan being laid out, a step starting or finishing, a file being edited, a command being run, an error, a blocker), and updates the visual representation in real time.

When the agent announces its plan at the start of a task, that plan becomes the backbone of the view: a clear path from a starting point to an end point, with each planned step placed along it. As the agent moves through the work, the current step is highlighted, completed steps are marked as done, and remaining steps stay visible so the user always knows how far there is to go.

Real work rarely goes exactly to plan. When something unexpected happens, such as a failing test, a missing dependency, a retry or a new subtask the agent decides to take on, Lucidly adds it to the view on the fly, attached to the step where it arose. Blockers are made visually distinct so they stand out immediately.

Every item in the view, whether a planned step, a subtask or a blocker, is linked to the chunk of output that belongs to it. Expanding an item reveals the underlying text for that step only. Because everything is stored as it arrives, the user can return to any earlier step at any time without scrolling through the full history.

## Main features

**Live progress view.** A visual path from start to finish that updates as the agent works, showing completed, current and upcoming steps.

**Plan-aware structure.** The agent's announced plan is used to build the overall shape of the task, so progress is shown against a known goal rather than as an endless log.

**On-the-fly subtasks and blockers.** Unplanned work, errors and obstacles appear where they occur, clearly marked, so problems are noticed as soon as they happen.

**Context at a glance.** Each step shows what the agent is working with, such as the files, tools or commands involved, in a short, readable form.

**Expandable detail.** Any item can be opened to show the original text the agent produced for it, preserving full transparency without cluttering the main view.

**Persistent history.** All steps and their output are kept, so the user can review any part of a run without hunting through a scrollback buffer.

**Agent-agnostic design.** Lucidly works by reading agent output, not by depending on a specific agent's internals. Support for different agents and frameworks is meant to be added through lightweight adapters that teach Lucidly how to recognize each one's output.

## Intended use

Lucidly is aimed primarily at developers who work with AI agents, whether to get tasks done or to build and debug agents themselves. For them it offers a faster way to follow a run, spot where something went wrong, and jump straight to the relevant output.

Because the interface is meant to be simple and intuitive, it should also be useful to less technical users who rely on agents and want reassurance about what is happening without reading technical logs.

The first target for development and testing is Claude Code, whose detailed streaming output makes it a natural fit. The underlying principle, capturing the output and turning it into a visual representation of progress, applies equally to any agentic AI tool, and broad compatibility is a core goal.

## Getting started

Requires Node.js 22.18 or newer (it runs the TypeScript sources directly; there is no build step).

```sh
npm install          # dev tools only (TypeScript for type checking); no runtime dependencies
npm start            # same as: node src/cli.ts
npm link             # optional: puts a `lucidly` command on your PATH
```

Run `lucidly` (or `npm start`) from a project folder. It opens the latest Claude Code session of that folder in your browser and follows it live while you keep working in Claude Code as usual.

```sh
lucidly                         # latest session of the current folder
lucidly 89a0789f                # a specific session (id or id prefix, or a .jsonl path)
lucidly list [--all]            # recent sessions (this folder, or all projects)
lucidly outline <session>       # text outline in the terminal
lucidly commands <session>      # every shell command that ran, with failures and their errors
lucidly actions <session> --errors --kind command,edit   # every action, filtered
claude -p "…" --output-format stream-json | lucidly   # follow a headless run
my-agent | lucidly              # any agent that prints plain text
lucidly --load run.lucidly.json # reopen a saved run
```

Options: `--port <n>` (default 4545), `--no-open`, `--cwd <dir>`, `--text`/`--json` to force the piped format. For `actions`/`commands`: `--errors`, `--kind <k,…>`, `--grep <text>`, `--goals <n>` (last n tasks), and `--full` (complete multi-line commands, ready to copy).

In the browser:
- The **token meter** in the top bar is always visible: input and output tokens so far, the main agent's current context size, and the live rate per minute. Click it (or press `T`) for the breakdown: fresh input, cache writes and reads, output, a table per model, and tokens per minute over the last hour. Counts come from the transcripts, subagents included.
- The **overview** counts tasks, steps, actions and *failed* actions (with how many failures were recovered), and draws the whole run as a strip of thin bars, one per action, in time order. File edits are amber and a little taller, with a pointed top when zoomed in enough to see it (*file edit* in the legend). Shell commands are green, and reads, searches and the rest are short teal bars. Violet marks a subagent's launch. Blue is running, pale red is a failure that was recovered, and solid red is one that is still failed. While the agent is working, the overview card and the current task's card glow softly, and a pulsing blue mark holds the live end of the strip. The current task's steps that haven't started yet follow in grey. Click a bar to jump to that action. Subagents get their own track under the main one, like layers in a video editor. Each subagent is one box from its launch to its last action, on the same time-ordered axis, so you can see what ran in parallel with what. Overlapping subagents stack on separate rows (up to four for the part in view; a busier burst shares the last row and shows a *+N* count), a running one pulses with a dashed border, and one with failures has a red border. The main track leaves gaps where only subagents were working. Zoom in to widen the boxes and read their names. Select a subagent (its violet bar on the strip, its tile in the path, or anything it did) and its own **timeline** opens below the strip, showing its model, actions, duration, tokens and failures, with one bar per action. Its span is marked on the main strip. Click a bar to open that action. The timeline closes as soon as you select something outside the subagent, or with ×, which goes back to the step that called it. On long runs, zoom the strip like a video editor's timeline: scroll over it to zoom around the cursor (Shift+scroll pans), or use the navigator below it, a mini map of the whole run, where you drag the window to pan, drag its edges to zoom, click to jump, and double-click to fit. The `−` `+` *Fit* buttons do the same.
- A failure counts as **recovered** when a later action in the same step or subtask, or in a fix nested inside it, succeeds. Otherwise it counts as **failed**: the agent moved on or the session ended without getting past it. This is a heuristic based on the order of actions, not on what the error was.
- **Simple** (the default view) keeps only the essentials. Tasks sit on a vertical line, oldest at the top, each a round node with its status (done, running, interrupted) and one line of facts. A Q&A exchange is a small speech-bubble node with the start of the answer. Click a task to unfold its steps to the right as a chain, from your request to the goal. Each step is a node whose shape says what it mostly did: a pointed tile for file edits, a rounded rectangle for commands, a circle for reads and searches, a hexagon for subagents, a speech bubble for a question to you. Its colour matches the timeline once done; the running step glows blue, a failed one is red, steps not started yet are dashed. Only the running task is open by default, and it folds closed when the next one starts. A long chain scrolls sideways with the request pinned on the left, and follows the running step by itself until you scroll it yourself (scroll back to the end to resume). New nodes pop in and finished steps flash once. Click any node for its details on the right. Search dims what doesn't match, and *Hide Q&A* hides the questions answered without any work, as in the detailed view.
- **Detailed** lists each task as a card with a progress bar (one segment per step). Steps are expandable: folded, a step is one line with its flags (errors, subtasks, subagents, *Blocked*); open, it shows the models that worked on it and their tokens, the files and commands involved, its subtasks and blockers, and its latest actions. Subagents show their model too (for example *Haiku 5.5*). Each task ends at its goal while in progress, and at its result once done. The current step opens by itself. Filter by *Failed* (failures nothing has succeeded after yet, and open blockers), *Recovered* (trouble along the way that got fixed, flagged ↺) or *Subagents*, hide Q&A exchanges, search steps, files and commands (`/`), or *Expand all* (`E`).
- Click any item to see **its own output** on the right. Narration reads as formatted text (markdown: headings, tables, nested and task lists, quotes, links, and code blocks with highlighting), and every action is a row you can expand to see its input and result. File edits show as a diff, like on GitHub: hunks with old and new line numbers, context lines, and the changed words highlighted. Shell commands are syntax-highlighted, including Python run inline (`python -c`, `python - <<EOF`), as are Python and shell files in diffs and writes.
- **File edits** (a mode next to *All*, *Failed*, *Recovered*) lists every file the agent changed, with the number of edits, lines removed and added, when it was last touched, and a sparkline of where in the run its edits happened. Sort by recency, by number of edits, or by path. Open a file for its history, oldest edit first, with the task and step behind each change. Click an edit for its diff in the side panel, or use *Show all diffs* to read the whole history inline. Files outside the project (scratch files, notes) are folded away at the bottom. Switch from *By file* to *History* for every edit in time order, oldest first, so the same file appears once per change. Dividers show the task each group of edits belonged to, and *Show all diffs* reads the whole history inline. Only changes made through the agent's edit and write tools are listed: files changed by shell commands (`sed -i`, scripts, redirections) are not.
- The overview also shows the **tokens** used so far (fresh input plus output) and the current rate. Click it for the breakdown.
- If Lucidly's own code changed after its server started, a **Restart Lucidly to update** notice appears in the top bar, because the page may expect data the running server doesn't produce yet.
- Switch views with the buttons at the left of the toolbar under the timeline (it stays on screen while you scroll), or `V` to cycle through *Simple*, *Detailed* and **Actions**. Actions is a flat, chronological list of everything the agent did: commands, edits, reads, searches, subagent calls. Filter by kind, show only *Failed* actions or only *Recovered* ones (each failure is tagged *failed* or *recovered*), search (`/`), or limit to one task. Each failure shows its actual error line. Select a row to see its full input and output, and *Show in path* to jump back to the step it belongs to. *Copy commands* copies the listed shell commands, with failed ones marked.
- The **pin** in the overview's top-right corner (or `P`) keeps the overview on screen too while you scroll. It is pinned by default: scrolled down, it tightens into a compact card (about half the height) that still shows everything: the stats on one line, the timeline, the subagents on a single row (parallel ones are counted on a *+N* marker), the navigator and the legend. It unfolds again back at the top, and what you were reading stays put during the transition. Unpin it to let it scroll away; Lucidly remembers the choice. The arrows button at the right of the toolbar (or `E`) expands or collapses everything.
- **Keep awake** (the cup next to the status in the top bar) stops the device from sleeping, like a no-sleep page. Turn it on, and optionally choose *Only while the agent is working*: the device stays awake while a turn runs and may sleep once the work is done and the session is idle (or has had no news for 30 minutes). The cup steams while it is holding the device awake. It uses the browser's Screen Wake Lock, so it works while the Lucidly tab is visible: a hidden or minimised tab lets the device sleep, and it takes effect again when you come back.
- A session opens at the top, on the overview and its timeline, with the side panel closed until you select something. Whenever you're not at the end of the list, a round **arrow button** floats at the bottom right, with a count of actions that arrived since you scrolled away. Click it (or press `F` or `End`) to jump to the end and follow the agent, keeping the current step in view. If the side panel is closed it stays closed: the list just scrolls along. Scrolling or clicking pauses following. **Open session** (the folder button on the left, the run's title, or `O`) lists the Claude Code sessions of this project or of all projects.
- The download button, next to *Open session* on the left, saves a **snapshot** of the run as a `.lucidly.json` file, and *Open a saved snapshot…* in the session list reopens one. You don't need this for Claude Code sessions, which reopen straight from their transcripts. It's for keeping a run after its transcript is cleaned up, sharing it with someone who doesn't have the transcript, and runs streamed from other agents through stdin, which have no transcript to reopen.

Lucidly only reads. It binds to `127.0.0.1` and never sends anything to the agent.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works inside.

## Development

```sh
npm test             # unit + integration tests (node:test)
npm run typecheck    # tsc --noEmit
```

## What Lucidly is not

Lucidly is a viewer, not a controller. It does not send commands to the agent, approve or block actions, or change how the agent behaves. All interaction with the agent continues to happen through whatever application or harness the user already uses. This keeps Lucidly simple, safe to run alongside any agent, and focused on one job: making the agent's work easy to see and understand.

## License

Lucidly is licensed under the [Apache License 2.0](LICENSE).
