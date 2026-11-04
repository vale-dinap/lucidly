# Lucidly architecture

This document records the technical decisions behind Lucidly. The README describes *what* Lucidly is; this describes *how* it is built.

## Pipeline

```
 source            adapter              engine               server            browser
 (bytes/records) → (normalized events) → (run state model) → (snapshot+patch) → (visual path)
                                            ↑
                              event log (RAM) ── save/load ──→ .lucidly.json
```

1. **Sources** deliver raw input: a tailed transcript file, stdin, or a saved file.
2. **Adapters** translate one agent's raw format into agent-agnostic **events**.
3. The **engine** is a reducer: it folds events into a **run state** (goals, steps, subtasks, blockers, activities, raw chunks). It has no I/O.
4. The **server** wires source → adapter → engine for each open session and pushes state to browsers over Server-Sent Events.
5. The **web UI** renders the state and fetches raw text on demand.

## 1. Input: how Lucidly hears the agent

**Claude Code: tail the session transcript.** Claude Code writes every session live to
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (one JSON record per content block),
with subagents in `<session-id>/subagents/agent-<id>.jsonl` plus a `.meta.json` that names the
parent `Agent` tool call. The `.meta.json` is only written when the subagent finishes, so while it runs the subagent file is linked to its call by matching its first prompt against the `prompt` input of the `Agent`/`Task` calls in the main transcript; that keeps subagent work live. Tailing these files is:

- **zero-config and non-invasive**: the user keeps running Claude Code exactly as before, with no wrapper, hooks or flags. This is in line with "a viewer, not a controller";
- **structured**: tool calls, results, errors and turn ends come as typed records, so nothing is scraped from terminal escape codes;
- **resumable**: past sessions can be opened after the fact, because the file is the history.

Records that matter: `user` (prompts, tool results), `assistant` (text, thinking, tool_use),
`system` (`turn_duration` = turn ended, `compact_boundary`, `informational`, refusals),
`ai-title`. All others (`api-request*`, `attachment`, snapshots…) are ignored.

**Other input routes:**
- `claude -p --output-format stream-json | lucidly` uses the same Claude adapter (the record shapes are compatible).
- `any-agent | lucidly` uses the generic **text adapter** (line heuristics).
- `lucidly --load run.lucidly.json` replays a saved run.

Files can be large (tens of MB), so reading is incremental: byte offsets, chunked reads, and partial-line buffering.

## 2. Adapters and the event model

An adapter is a small stateful object:

```ts
interface Adapter {
  name: string;
  push(input: string | object): LucidlyEvent[]; // one record or text chunk in, events out
  flush(): LucidlyEvent[];                       // end of input
}
```

Events (see `src/core/events.ts`) are the stable contract between adapters and the engine:

| event | meaning |
|---|---|
| `run.meta` | title, cwd, agent name |
| `user.prompt` | the user asked something; may open a new goal |
| `agent.text` | narration / intent / summary text |
| `agent.thinking` | reasoning text (kept as raw detail only) |
| `plan.set` | explicit plan from a planning tool (TodoWrite, TaskCreate, ExitPlanMode) |
| `plan.update` | explicit status change of a plan item |
| `tool.start` / `tool.end` | an action and its result (`ok`, output) |
| `notice` | info/warning/error from the harness (compaction, usage limit, refusal, interrupt) |
| `turn.end` | agent stopped and is waiting for the user |
| `usage` | tokens one model response used (model, fresh input, output, cache read/write); emitted once per response, after its content, so it is credited to the step it belongs to. The engine sums it for the run, per model, and per goal/step/subtask (`usage`, `models` on nodes) |

Every event carries `ts`, an optional `scope` (subagent nesting) and `raw`, the original text that will back "expandable detail". Adapters stay small because all interpretation (plans, steps, blockers) happens once, in the engine, and is shared by every agent.

## 3. Engine: building the picture

**Goals.** A substantive user prompt opens a *goal* (start point → end point). Short replies ("yes", "go on") continue the current goal, and so does any message sent while the agent is still working (an interjection is shown in the current step, not as a new task).

**Rule: if the agent has a plan, the plan is the backbone.** Steps are inferred only when there is no plan at all.

**Steps from a plan.** A plan comes from:
- explicit planning tools (exact statuses), or
- a numbered/bulleted list in narration with planning cues ("plan", "I'll", "steps"…). A text plan stays *tentative* until the agent actually acts on it. A list in a final summary is therefore never mistaken for a plan.

Narration is matched to plan steps by keyword similarity and explicit references ("step 3"), favouring forward progress. Matching a later step completes the earlier ones.

**Steps without a plan (fallback only).** Each narration that precedes actions becomes a new *inferred* step, titled from its intent sentence ("Let me run the tests" → "Run the tests"). The first narration also sets the goal's stated *intent*. This is the same append mechanism used for unplanned work.

**Unplanned work.** Under a plan, narration that does not match a step is attached to the current step as a *segment*. It is promoted to a visible **subtask** when it shows deviation cues (fix, retry, missing, instead…) or follows a failure. Subagent calls are always subtasks, and their own activity is nested inside.

**Blockers.** A failed tool call is an *issue* on the activity. It escalates to a **blocker** on repeated failure in the same step, on user rejection of an action, or on harness refusals and limits. A blocker is marked resolved when a later action in the same step succeeds.

**Outcome.** Narration after the last action of a turn is the goal's *outcome* (shown at the end node), not a step.

**Actions list.** Besides the tree, `engine.actions()` flattens every action into execution order, with its task, step, subagent, status, full input (the command line for shell actions) and a failure summary. The failure summary is the telling line rather than "Exit code 1": a traceback's exception, an `error:` line, or the last line, with hints for well-known exit codes. This feeds the UI's Actions view (`GET /api/s/:id/actions`) and the `lucidly actions` / `lucidly commands` CLI, for quick debugging.

**Context at a glance.** Each activity gets a kind (read, edit, command, search, web, agent, ask, other) and a short label. Steps aggregate the files and commands they touched.

## 4. UI: a local web app

`lucidly` starts a small zero-dependency Node server on `localhost` and opens the browser.

Why a local web app:
- it gives rich, clean visuals (a vertical "metro line" path, colours, animation, expandable panels) that a TUI cannot match;
- it runs anywhere Node runs, and Claude Code users already have Node;
- there is no heavyweight shell (Electron); a browser tab sits fine beside any terminal or IDE;
- the same front end can later be embedded in a VS Code webview or a desktop wrapper.

Protocol: `GET /api/s/:id/stream` (SSE) sends a full snapshot, then patches (changed nodes only), throttled. Raw text is never in the stream; `GET /api/s/:id/raw/:nodeId` fetches it when an item is expanded.

## 5. Persistence

State lives in RAM for the session. Because state is *derived from the event log*, saving means writing `{format, version, meta, events}` to a `.lucidly.json` file, and resuming means replaying it. This keeps save files agent-agnostic and lets future engine improvements re-render old runs better.

For Claude Code, the transcript on disk is already a full history. Lucidly can reopen any past session directly, so saving matters mostly for piped/stdin sources or for sharing a snapshot.

## Code map

| path | role |
|---|---|
| `src/core/events.ts` | event contract + `Adapter` interface |
| `src/core/text.ts` | heuristics: intent titles, plan extraction, step matching, deviation cues |
| `src/core/engine.ts` | the reducer: events → nodes, patches, raw chunks |
| `src/core/model.ts` | view model types shared with the UI |
| `src/adapters/claude-code.ts`, `claude-tools.ts` | Claude Code records → events; tool kinds and labels |
| `src/adapters/text.ts` | plain-text heuristics for any agent |
| `src/sources/tail.ts` | incremental, UTF-8-safe file follower |
| `src/sources/claude-sessions.ts` | session discovery, transcript + subagent following |
| `src/sources/stdin.ts` | piped input with format auto-detection |
| `src/server/session.ts` | one open run: event log, engine, subscribers, save/load |
| `src/server/server.ts` | HTTP API, SSE, static files, localhost-only guards |
| `src/cli.ts`, `src/outline.ts` | command line and the text outline |
| `web/` | the browser UI (`app.js`, `style.css`, `index.html`) |

### Adding an adapter

Implement `Adapter` (`push` raw input → `LucidlyEvent[]`, `flush` at end of input). Then wrap it in a `Source`, or add detection to `StreamSource`. Map the agent's actions to `tool.start`/`tool.end` with a `kind` and a short `label`, its prose to `agent.text`, and its turn boundaries to `turn.end`. Planning, steps, subtasks and blockers then come for free from the engine. `src/adapters/text.ts` is a compact example.

### Details worth knowing

- Subagent events can arrive before their spawning call (files are read independently). The engine holds them until the call appears.
- `run.updatedAt` is the maximum timestamp seen, since subagent files are read after the main transcript.
- The raw endpoint accepts `?own=1` (used for goals), which returns only the node's own chunks instead of its whole subtree.
- Harness-generated messages (API errors, task notifications, compaction summaries, IDE context) are filtered or turned into notices in the Claude adapter. They are never treated as prompts or narration.

## Tech choices

- TypeScript on Node ≥ 22.18, run directly via native type stripping (no build step). Code uses erasable syntax only.
- Zero runtime dependencies. `typescript` is a dev dependency used only for `npm run typecheck`.
- Tests: `node:test`.
- Front end: plain ES modules + CSS, no framework, no bundler.

### Recovered vs failed

A failed activity is queued on its unit. The next successful activity in that unit, or in a unit nested inside it (a fix subtask), marks the queued failures `recovered` and bumps `stats.recovered` up the tree. Recovery never flows downwards, so a step's success does not clear a subagent's failure. `actions()` sorts rows by `startedAt`, because subagent transcripts are read after the main one when a session is loaded. `agent-acompact-*` files in `subagents/` are compaction runs, not subagents, and are skipped.

### Subagent output tokens

Claude Code's subagent transcripts sometimes record only the streaming placeholder (3 to 8 tokens) as the output count of a response. The Agent tool's result in the main transcript has the real `usage` of the subagent's last response. The adapter emits it as a `usage` event with `final: true`. The engine keeps, per scope, the last recorded output and the final one, and credits `max(0, final − last)` as a correction. The correction is reconciled on every event, so the result is the same whichever transcript is read first. Earlier responses can still be undercounted when their own records hold placeholders, because nothing reports their true counts.

### Background subagents

An Agent call with `run_in_background` returns at once ("Async agent launched", `toolUseResult.isAsync`). The adapter emits that result as `tool.end` with `background: true`, which the engine records as output while the action stays **running**. Completion arrives later as a `<task-notification>` naming the call's `<tool-use-id>` and a `<status>`. It comes in a `queue-operation` record, or as a user message on other versions. The adapter turns it into the real `tool.end`, so the subagent ends at the right time with the right status. Repeated notifications from a resumed agent only add output.

### Text plan steps done all at once

A plan read from the agent's prose (a numbered list, or bullets after "I'll…") is an announcement, not a tracked checklist. The agent often does all of it in one go, and its narration never names the later steps, so their work lands on the first one. When the task ends normally (a new task starts and the last turn wasn't interrupted), any announced step still waiting is marked done with `untracked: true`. The UI shows it as done *with the others*. Plans from TodoWrite/Tasks keep the agent's explicit statuses.
