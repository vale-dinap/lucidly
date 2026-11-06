import type { ActivityKind, CommandPart, DiffHunk } from './events.ts';

/**
 * goal     – one task the user asked for (start point → end point)
 * step     – a planned or inferred stage of a goal
 * subtask  – unplanned work or a subagent, attached to the step where it arose
 * blocker  – an obstacle (repeated failure, rejection, refusal, limit)
 * activity – a single action: read, edit, command, search...
 * note     – a harness notice (compaction, interruption...)
 */
export type NodeType = 'goal' | 'step' | 'subtask' | 'blocker' | 'activity' | 'note';

export type NodeStatus = 'pending' | 'active' | 'waiting' | 'done' | 'failed' | 'open' | 'resolved';

export type Origin = 'plan' | 'inferred' | 'unplanned' | 'subagent';

export interface NodeContext {
  files: string[];
  commands: string[];
  tools: string[];
}

/** Token counts, as reported by the model provider. */
export interface TokenUsage {
  /** Fresh (uncached) input tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Model responses counted. */
  responses: number;
}

export interface RunUsage extends TokenUsage {
  byModel: Record<string, TokenUsage>;
  /** Context size of the main agent's latest response (all input tokens), and its model. */
  context?: number;
  contextModel?: string;
  /** [epoch minute, input + cache write + output tokens] for recent minutes, oldest first. */
  perMinute: [number, number][];
  lastAt?: string;
}

export interface ViewNode {
  id: string;
  type: NodeType;
  parent: string | null;
  children: string[];
  title: string;
  status: NodeStatus;
  origin?: Origin;
  /** A text plan step not yet confirmed by the agent acting on it. */
  tentative?: boolean;
  /**
   * A step announced in a text plan whose work was never told apart from the other steps'
   * (the agent did it all at once): counted as done when its task finished normally.
   */
  untracked?: boolean;
  kind?: ActivityKind;
  tool?: string;
  detail?: string;
  files?: string[];
  /** 'command': a file change made by a shell command, not by an edit tool. */
  via?: 'command';
  /**
   * On a reply that continued a task after its turn ended: it starts a new round of the task, and
   * this is how the round before it ended (its result, interrupted, or with a question).
   */
  round?: { outcome?: string; interrupted?: boolean; asked?: boolean };
  /** On a task whose turn ended with the agent asking you something (its last words a question). */
  asked?: boolean;
  /** ...and the question it ended with (its last sentence). */
  question?: string;
  retry?: boolean;
  /** A failed action that something succeeded after, in the same unit or one nested in it. */
  recovered?: boolean;
  /** Short error summary for a failed activity. */
  issue?: string;
  context?: NodeContext;
  /** errors: failed actions; recovered: those followed by a success in the same step or subtask. */
  stats?: { actions: number; errors: number; recovered?: number };
  /** Goals, steps and subtasks: tokens used inside, and the models that produced them. */
  usage?: TokenUsage;
  models?: string[];
  /** File edits: lines added and removed. */
  diff?: { add: number; del: number };
  /** Goals: stated intent and final outcome. */
  intent?: string;
  outcome?: string;
  level?: 'info' | 'warning' | 'error';
  startedAt?: string;
  endedAt?: string;
}

/** One executed action, flattened for the chronological list / debugging views. */
export interface ActionRow {
  id: string;
  kind: ActivityKind;
  tool?: string;
  title: string;
  status: NodeStatus;
  retry?: boolean;
  recovered?: boolean;
  issue?: string;
  startedAt?: string;
  endedAt?: string;
  /** Full input as recorded (the command line for shell actions), capped. */
  input: string;
  /** Command line without the "$ " prompt, for shell actions. */
  command?: string;
  /** The essential part of the command's first line ("npm test" for "cd x && npm test"). */
  short?: string;
  /** File edits: lines added and removed. */
  diff?: { add: number; del: number };
  /** Files the action touched (edits and writes). */
  files?: string[];
  /** 'command': a file change made by a shell command; `command` then holds its command line. */
  via?: 'command';
  goalId?: string;
  goal?: string;
  stepId?: string;
  step?: string;
  /** Title of the subagent this action ran inside, if any. */
  subagent?: string;
  /** Node id of that subagent (the innermost one, when they nest). */
  subagentId?: string;
}

export type ChunkKind = 'prompt' | 'text' | 'thinking' | 'plan' | 'tool' | 'result' | 'notice' | 'outcome';

export interface Chunk {
  id: number;
  node: string;
  kind: ChunkKind;
  text: string;
  ts?: string;
  label?: string;
  failed?: boolean;
  /** Result chunks of file edits: the change as diff hunks. */
  patch?: DiffHunk[];
  /** Tool chunks of long shell commands: the command in readable parts. */
  parts?: CommandPart[];
}

export type RunStatus = 'idle' | 'working' | 'waiting';

export interface RunInfo {
  title?: string;
  cwd?: string;
  agent?: string;
  sessionId?: string;
  status: RunStatus;
  goals: string[];
  currentGoal?: string;
  currentStep?: string;
  currentUnit?: string;
  updatedAt?: string;
  eventCount: number;
  usage?: RunUsage;
}

export interface Snapshot {
  run: RunInfo;
  nodes: Record<string, ViewNode>;
}

/** Changed nodes only; null marks a deleted node. */
export interface Patch {
  run: RunInfo;
  nodes: Record<string, ViewNode | null>;
}
