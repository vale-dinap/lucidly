/**
 * Normalized, agent-agnostic events. Adapters produce these; the engine consumes them.
 * This is the stable contract between "how an agent talks" and "how Lucidly draws it".
 */

export type ActivityKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'command'
  | 'search'
  | 'web'
  | 'agent'
  | 'ask'
  | 'user'
  | 'other';

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  /** Stable id from the agent's planning tool, when it provides one. */
  id?: string;
  title: string;
  status: PlanStatus;
}

interface EventBase {
  /** ISO timestamp, when known. */
  ts?: string;
  /** Nesting scope: the callId of the subagent call this event belongs to. */
  scope?: string;
  /** Original text backing this event, shown in expandable detail. */
  raw?: string;
}

export interface RunMetaEvent extends EventBase {
  type: 'run.meta';
  title?: string;
  cwd?: string;
  agent?: string;
  sessionId?: string;
}

export interface UserPromptEvent extends EventBase {
  type: 'user.prompt';
  text: string;
}

export interface AgentTextEvent extends EventBase {
  type: 'agent.text';
  text: string;
}

export interface AgentThinkingEvent extends EventBase {
  type: 'agent.thinking';
  text: string;
}

export interface PlanSetEvent extends EventBase {
  type: 'plan.set';
  /** Which tool or mechanism produced the plan, e.g. "TodoWrite". */
  source: string;
  items: PlanItem[];
  /** true: items are the whole plan (replace). false: items are appended. */
  replace: boolean;
}

export interface PlanUpdateEvent extends EventBase {
  type: 'plan.update';
  id?: string;
  title?: string;
  status?: PlanStatus;
  deleted?: boolean;
}

export interface ToolStartEvent extends EventBase {
  type: 'tool.start';
  callId: string;
  tool: string;
  kind: ActivityKind;
  /** Short human label, e.g. "Edit engine.ts" or "$ npm test". */
  label: string;
  /** Optional longer detail (full command, query...). */
  detail?: string;
  /** The command line, for command activities. */
  command?: string;
  /** Files touched, for "context at a glance". */
  files?: string[];
  /** true when this call spawns a subagent whose events use scope = callId. */
  spawnsAgent?: boolean;
  /** 'command': a file change made by a shell command (kind 'edit'), not by an edit tool. */
  via?: 'command';
}

/** One hunk of a unified diff, with real file line numbers. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Diff lines: " context", "-removed", "+added". */
  lines: string[];
}

export interface ToolEndEvent extends EventBase {
  type: 'tool.end';
  callId: string;
  ok: boolean;
  /** The user (or a policy) refused the action. */
  rejected?: boolean;
  output?: string;
  /** For file edits, when the agent reports it: the change as diff hunks. */
  patch?: DiffHunk[];
  /**
   * The call only started work that goes on in the background (a background subagent):
   * the action stays running until a later tool.end for the same call.
   */
  background?: boolean;
}

export interface NoticeEvent extends EventBase {
  type: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
  /** Stops the agent from progressing (refusal, usage limit...): shown as a blocker. */
  blocking?: boolean;
}

export interface TurnEndEvent extends EventBase {
  type: 'turn.end';
  /** The turn was interrupted rather than finished. */
  interrupted?: boolean;
}

/** Tokens one model response used. Adapters emit it once per response. */
export interface UsageEvent extends EventBase {
  type: 'usage';
  /** Model id as the agent reports it, e.g. "claude-haiku-5-5". */
  model: string;
  /** Fresh (uncached) input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Not a new response: the true output count of the scope's last response, from a summary
   * the agent wrote afterwards (Claude Code's subagent transcripts sometimes keep only the
   * streaming placeholder). The engine credits the difference, whichever arrives first.
   */
  final?: boolean;
}

export type LucidlyEvent =
  | RunMetaEvent
  | UserPromptEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | PlanSetEvent
  | PlanUpdateEvent
  | ToolStartEvent
  | ToolEndEvent
  | NoticeEvent
  | TurnEndEvent
  | UsageEvent;

/** An adapter turns one agent's raw output into events. */
export interface Adapter {
  readonly name: string;
  push(input: unknown): LucidlyEvent[];
  flush(): LucidlyEvent[];
}
