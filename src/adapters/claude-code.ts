/**
 * Claude Code adapter. Understands:
 *  - session transcripts (~/.claude/projects/<cwd>/<session>.jsonl, one record per content block)
 *  - `claude -p --output-format stream-json` output (same message shapes, plus init/result records)
 */
import type { DiffHunk, Adapter, LucidlyEvent, PlanItem, PlanStatus } from '../core/events.ts';
import { KnownFiles, PLANNING_TOOLS, commandEdit, summarizeTool } from './claude-tools.ts';
import { commandParts } from './shell-writes.ts';

type Rec = Record<string, any>;

const REJECTED = /doesn't want to (?:proceed|take this action)|user rejected|tool use was rejected|permission to use .* (?:was )?denied/i;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content
    .map((b: Rec) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : typeof b === 'string' ? b : ''))
    .filter(Boolean)
    .join('\n');
}

const TAG = /<\/?[a-z][a-z_-]*(?:\s[^>]*)?\/?>/g;

/** Turn a raw user message into prompt text, or null when it is harness noise. */
export function cleanPrompt(s: string): string | null {
  let t = s
    .replace(/<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>/g, '')
    .trim();
  if (/^<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr|task-notification)>/.test(t)) return null;
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
    return `${cmd[1].trim()} ${args}`.trim();
  }
  const bash = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
  if (bash) return `! ${bash[1].trim()}`;
  if (/<pasted_content[\s>]/.test(t)) {
    const own = t.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, ' ').replace(TAG, '').trim();
    if (own) return own;
    const inner = /<pasted_content[^>]*>([\s\S]*?)(?:<\/pasted_content>|$)/.exec(t)?.[1] ?? '';
    const line = inner.split('\n').find((l) => l.trim() && !/^-{3,}$/.test(l.trim()));
    return line ? `[pasted] ${line.trim()}` : '[pasted content]';
  }
  t = t.replace(TAG, '').trim();
  return t || null;
}

/** Prompt text for the detail view: harness markup removed, pasted content kept. */
export function displayPrompt(s: string): string {
  const cmd = /<command-name>[\s\S]*?<\/command-name>/.test(s) ? cleanPrompt(s) : null;
  if (cmd) return cmd;
  return s
    .replace(/<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>[\s\S]*?<\/\1>/g, '')
    .replace(/<pasted_content[^>]*>/g, '──── pasted ────\n')
    .replace(/<\/pasted_content>/g, '\n────────────────')
    .replace(TAG, '')
    .trim();
}

/** Harness notifications injected as user messages (background task finished...). */
export function harnessNotice(s: string): string | null {
  const m = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/.exec(s);
  if (!m) return null;
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(m[1])?.[1]?.trim();
  const status = /<status>([\s\S]*?)<\/status>/.exec(m[1])?.[1]?.trim();
  return summary ?? `Background task ${status ?? 'update'}`;
}

function mapStatus(s: unknown): PlanStatus {
  return s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
}

function toHunks(sp: Rec[]): DiffHunk[] | undefined {
  const out: DiffHunk[] = [];
  for (const h of sp) {
    if (!h || !Array.isArray(h.lines)) continue;
    out.push({
      oldStart: Number(h.oldStart) || 0,
      oldLines: Number(h.oldLines) || 0,
      newStart: Number(h.newStart) || 0,
      newLines: Number(h.newLines) || 0,
      lines: h.lines.map(String),
    });
  }
  return out.length ? out : undefined;
}

export class ClaudeCodeAdapter implements Adapter {
  readonly name = 'claude-code';
  private seen = new Set<string>();
  private metaSent = false;
  private cwdSent = false;
  /** TaskCreate callId → subject, and task id → subject. */
  private taskCalls = new Map<string, string>();
  private taskIds = new Map<string, string>();
  private planCalls = new Set<string>();
  /** Background subagent calls still running, by tool_use id. */
  private bgCalls = new Set<string>();
  /** Message ids whose usage was already counted (a message spans several records). */
  private counted = new Set<string>();
  /** Usage of the latest message, held until its content blocks have been emitted. */
  private pendingUsage: { id: string; ev: LucidlyEvent } | null = null;
  /** The working folder as of the latest record, and the files seen so far: for shell edits. */
  private cwd?: string;
  private known = new KnownFiles();

  /** @param scope set for subagent transcripts: the callId of the spawning Agent call. */
  private readonly scope?: string;
  constructor(scope?: string) {
    this.scope = scope;
  }

  push(input: unknown): LucidlyEvent[] {
    const rec = input as Rec;
    if (!rec || typeof rec !== 'object') return [];
    if (rec.uuid) {
      if (this.seen.has(rec.uuid)) return [];
      this.seen.add(rec.uuid);
    }
    const out: LucidlyEvent[] = [];
    if (this.pendingUsage && (rec.type !== 'assistant' || rec.message?.id !== this.pendingUsage.id)) out.push(...this.flush());
    const ts: string | undefined = rec.timestamp;
    if (typeof rec.cwd === 'string' && rec.cwd) this.cwd = rec.cwd;
    const emit = (e: LucidlyEvent) => {
      if (this.scope) e.scope = this.scope;
      if (!e.ts && ts) e.ts = ts;
      out.push(e);
    };

    // The first records (queue operations, snapshots) often carry a session id but no cwd:
    // announce the run once, and the working folder as soon as a record has it.
    if (!this.scope && !this.metaSent && (rec.cwd || rec.sessionId || rec.session_id)) {
      this.metaSent = true;
      this.cwdSent = !!rec.cwd;
      emit({ type: 'run.meta', agent: 'Claude Code', cwd: rec.cwd, sessionId: rec.sessionId ?? rec.session_id });
    } else if (!this.scope && !this.cwdSent && rec.cwd) {
      this.cwdSent = true;
      emit({ type: 'run.meta', cwd: rec.cwd });
    }

    switch (rec.type) {
      case 'ai-title':
      case 'summary':
        if (!this.scope && (rec.aiTitle || rec.summary)) emit({ type: 'run.meta', title: rec.aiTitle ?? rec.summary });
        break;
      case 'user':
        if (!rec.isSidechain || this.scope) this.onUser(rec, emit);
        break;
      case 'queue-operation':
        // Background work finishing is queued for the agent as a task notification.
        if (!this.scope && typeof rec.content === 'string') this.onQueued(rec.content, emit);
        break;
      case 'assistant':
        if (!rec.isSidechain || this.scope) {
          this.onAssistant(rec, emit);
          this.noteUsage(rec);
        }
        break;
      case 'system':
        this.onSystem(rec, emit);
        break;
      case 'result':
        // stream-json end of a run
        if (rec.is_error) emit({ type: 'notice', level: 'error', text: `Run ended with an error (${rec.subtype ?? 'error'})`, raw: rec.result });
        emit({ type: 'turn.end' });
        break;
    }
    return out;
  }

  /** Emits the held usage event. Sources call this at the end of each batch of lines. */
  flush(): LucidlyEvent[] {
    const p = this.pendingUsage;
    this.pendingUsage = null;
    return p ? [p.ev] : [];
  }

  private noteUsage(rec: Rec): void {
    const m = rec.message;
    const u = m?.usage;
    if (!u || !m.model || m.model === '<synthetic>' || rec.isApiErrorMessage) return;
    const id: string = m.id ?? rec.uuid;
    if (!id || this.counted.has(id)) return;
    this.counted.add(id);
    const ev: LucidlyEvent = {
      type: 'usage',
      model: String(m.model),
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
    };
    if (this.scope) ev.scope = this.scope;
    if (rec.timestamp) ev.ts = rec.timestamp;
    this.pendingUsage = { id, ev };
  }

  private onUser(rec: Rec, emit: (e: LucidlyEvent) => void): void {
    if (rec.isMeta) return;
    // The summary itself is not a prompt; the compact_boundary record already marks the event.
    if (rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return;
    const content = rec.message?.content;
    const blocks: Rec[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const texts: string[] = [];
    // Claude Code attaches the edit's real diff (with file line numbers) to the record.
    const results = blocks.filter((b) => b.type === 'tool_result').length;
    const sp = rec.toolUseResult?.structuredPatch;
    const patch = results === 1 && Array.isArray(sp) && sp.length ? toHunks(sp) : undefined;
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const id: string = b.tool_use_id;
        const output = blockText(b.content);
        if (this.taskCalls.has(id)) {
          const m = /#?(\d+)/.exec(output);
          if (m) this.taskIds.set(m[1], this.taskCalls.get(id)!);
        }
        if (this.planCalls.has(id)) continue;
        const tr = rec.toolUseResult;
        const fo = tr?.usage?.output_tokens;
        if (results === 1 && tr?.agentId && typeof fo === 'number') {
          // The subagent's own transcript may hold a placeholder for its last response's output.
          emit({ type: 'usage', scope: id, final: true, model: String(tr.resolvedModel ?? ''), input: 0, output: fo, cacheRead: 0, cacheWrite: 0 });
        }
        const rejected = !!b.is_error && REJECTED.test(output);
        if (!b.is_error && (tr?.isAsync || tr?.status === 'async_launched')) {
          this.bgCalls.add(id);
          emit({ type: 'tool.end', callId: id, ok: true, output, background: true });
          continue;
        }
        emit({ type: 'tool.end', callId: id, ok: !b.is_error, rejected, output, ...(patch && !b.is_error ? { patch } : {}) });
      } else if (b.type === 'text') {
        texts.push(b.text);
      } else if (b.type === 'image') {
        texts.push('[image]');
      }
    }
    if (texts.length === 0) return;
    const raw = texts.join('\n');
    if (/^\s*\[Request interrupted by user/.test(raw)) {
      emit({ type: 'turn.end', interrupted: true });
      return;
    }
    const notice = harnessNotice(raw);
    if (notice) this.onQueued(raw, emit);
    if (notice) {
      emit({ type: 'notice', level: 'info', text: notice, raw });
      return;
    }
    const text = cleanPrompt(raw);
    if (text) emit({ type: 'user.prompt', text, raw: displayPrompt(raw) || text });
  }

  /** A task notification for a background subagent we saw start: it finished (or failed). */
  private onQueued(text: string, emit: (e: LucidlyEvent) => void): void {
    const m = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/.exec(text);
    if (!m) return;
    const id = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/.exec(m[1])?.[1]?.trim();
    if (!id || !this.bgCalls.has(id)) return;
    const status = /<status>([\s\S]*?)<\/status>/.exec(m[1])?.[1]?.trim() ?? '';
    if (status === 'running') return;
    this.bgCalls.delete(id);
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(m[1])?.[1]?.trim();
    const result = /<result>([\s\S]*?)<\/result>/.exec(m[1])?.[1]?.trim();
    const ok = status === 'completed';
    emit({ type: 'tool.end', callId: id, ok, output: [summary, result].filter(Boolean).join('\n\n') || `Background agent ${status}` });
  }

  private onAssistant(rec: Rec, emit: (e: LucidlyEvent) => void): void {
    const content = rec.message?.content;
    if (!Array.isArray(content)) return;
    if (rec.isApiErrorMessage || rec.message?.model === '<synthetic>') {
      // Harness-generated, not the model speaking (API errors, connection failures).
      const text = blockText(content).trim();
      if (text && text !== 'No response requested.') emit({ type: 'notice', level: 'error', text, blocking: !!rec.isApiErrorMessage });
      return;
    }
    for (const b of content as Rec[]) {
      if (b.type === 'text') {
        const t = String(b.text ?? '');
        if (t.trim() && t.trim() !== 'No response requested.') emit({ type: 'agent.text', text: t });
      } else if (b.type === 'thinking') {
        if (b.thinking?.trim()) emit({ type: 'agent.thinking', text: b.thinking });
      } else if (b.type === 'tool_use') {
        this.onToolUse(b, emit);
      }
    }
  }

  private onToolUse(b: Rec, emit: (e: LucidlyEvent) => void): void {
    const name: string = b.name;
    const input: Rec = b.input ?? {};
    if (PLANNING_TOOLS.has(name)) {
      this.planCalls.add(b.id);
      const raw = JSON.stringify(input, null, 2);
      if (name === 'TodoWrite' && Array.isArray(input.todos)) {
        const items: PlanItem[] = input.todos.map((t: Rec) => ({
          id: t.id ? String(t.id) : undefined,
          title: String(t.content ?? t.subject ?? ''),
          status: mapStatus(t.status),
        }));
        emit({ type: 'plan.set', source: 'TodoWrite', replace: true, items, raw });
      } else if (name === 'TaskCreate') {
        const title = String(input.subject ?? input.description ?? 'Task');
        this.taskCalls.set(b.id, title);
        emit({ type: 'plan.set', source: 'Tasks', replace: false, items: [{ title, status: 'pending' }], raw });
      } else if (name === 'TaskUpdate') {
        const id = String(input.taskId ?? input.id ?? '');
        const title = this.taskIds.get(id);
        if (input.status === 'deleted') emit({ type: 'plan.update', title, deleted: true, raw });
        else emit({ type: 'plan.update', title, status: input.status ? mapStatus(input.status) : undefined, raw });
      } else if (name === 'ExitPlanMode' && typeof input.plan === 'string') {
        // A plan-mode plan is prose; let the engine extract steps from it like any text plan.
        emit({ type: 'agent.text', text: input.plan });
      }
      return;
    }
    let s = summarizeTool(name, input);
    if (s.kind === 'command') s = commandEdit(name, input, s, this.cwd, this.known) ?? s;
    const parts = name === 'Bash' && typeof input.command === 'string' ? commandParts(input.command) : undefined;
    for (const f of s.files ?? []) this.known.add(f);
    emit({
      type: 'tool.start',
      callId: b.id,
      tool: name,
      kind: s.kind,
      label: s.label,
      detail: s.detail,
      command: s.command,
      files: s.files,
      spawnsAgent: s.spawnsAgent,
      ...(s.via ? { via: s.via } : {}),
      ...(parts ? { parts } : {}),
      raw: s.raw,
    });
  }

  private onSystem(rec: Rec, emit: (e: LucidlyEvent) => void): void {
    const sub: string = rec.subtype ?? '';
    const content = typeof rec.content === 'string' ? rec.content : '';
    // (stream-json's `init` record is covered by the generic first-record run.meta in push())
    if (sub === 'turn_duration') {
      emit({ type: 'turn.end' });
    } else if (sub === 'compact_boundary') {
      emit({ type: 'notice', level: 'info', text: 'Context compacted' });
    } else if (sub.startsWith('model_refusal') || sub === 'refusal') {
      const why = rec.apiRefusalExplanation ? `: ${rec.apiRefusalExplanation}` : '';
      emit({ type: 'notice', level: 'error', text: `Request refused by the model${why}`, blocking: true });
    } else if (sub === 'api_error') {
      emit({ type: 'notice', level: 'error', text: content || 'API error', raw: JSON.stringify(rec.error ?? rec, null, 2) });
    } else if (sub === 'informational' && content) {
      const limit = /usage limit|rate limit|limit reached/i.test(content);
      emit({ type: 'notice', level: limit ? 'warning' : 'info', text: content, blocking: limit });
    }
  }
}
