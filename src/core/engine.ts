import type {
  LucidlyEvent,
  NoticeEvent,
  PlanItem,
  PlanSetEvent,
  PlanStatus,
  PlanUpdateEvent,
  ToolEndEvent,
  ToolStartEvent,
  UsageEvent,
} from './events.ts';
import type { ActionRow, Chunk, ChunkKind, NodeStatus, NodeType, Patch, RunInfo, Snapshot, TokenUsage, ViewNode } from './model.ts';

const MAX_PATCH_LINES = 2000;
const zeroUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 });
import {
  extractPlan,
  firstLine,
  hasDeviationCue,
  hasIntent,
  intentTitle,
  isSubstantivePrompt,
  isHousekeeping,
  isReply,
  endsWithQuestion,
  issueSummary,
  matchStep,
  sentences,
  similarity,
  stripMarkdown,
  tokens,
  truncate,
  type ExtractedPlan,
} from './text.ts';

const MAX_CHUNK = 256 * 1024;
const MAX_CONTEXT_ITEMS = 12;

interface GoalCtx {
  id: string;
  /** Plan step ids, in order. */
  plan: string[];
  planSource: 'none' | 'text' | 'tool';
  /** The last turn of this goal was interrupted by the user. */
  interrupted?: boolean;
  /** planId/normalized title → step id (tool plans). */
  planKeys: Map<string, string>;
  /** Steps of a text plan not yet acted upon. */
  tentative: string[] | null;
  tentativeChunk: number | null;
  current: string | null;
  /** Node receiving activities: the current step, or a subtask under it. */
  unit: string | null;
  /** A unit created by narration that has not acted yet (may turn out to be the outcome). */
  pending: string | null;
  lastTextChunk: number | null;
  actionsSinceText: number;
  /** First narration since the last action; becomes the goal intent if action follows. */
  intentCandidate: string | null;
}

interface UnitCtx {
  failStreak: number;
  /** Failed activities not yet followed by a success. */
  pendingFails?: string[];
  lastFail?: { tool: string; label: string };
  openBlocker?: string;
}

interface CallRef {
  node: string;
  unit: string;
  tool: string;
  label: string;
}

/**
 * Folds normalized events into a view model. Pure in-memory logic, no I/O,
 * so the same engine serves live tailing, replays and tests.
 */
export class Engine {
  readonly nodes = new Map<string, ViewNode>();
  readonly chunks: Chunk[] = [];
  readonly run: RunInfo = { status: 'idle', goals: [], eventCount: 0 };

  private nodeChunks = new Map<string, number[]>();
  private dirty = new Set<string>();
  private runDirty = false;
  private seq = 0;
  /** The main agent's last words asked the user something. */
  private agentAsked = false;
  private goalCtx = new Map<string, GoalCtx>();
  private units = new Map<string, UnitCtx>();
  private calls = new Map<string, CallRef>();
  private scopes = new Map<string, string>();
  private orphans = new Map<string, LucidlyEvent[]>();

  apply(ev: LucidlyEvent): void {
    if (ev.scope && !this.scopes.has(ev.scope)) {
      // Subagent output that arrived before its spawning call: hold it until the call shows up.
      const list = this.orphans.get(ev.scope) ?? [];
      list.push(ev);
      this.orphans.set(ev.scope, list);
      return;
    }
    this.run.eventCount++;
    // Max, not last: subagent transcripts are read after the main one and carry older times.
    if (ev.ts && (!this.run.updatedAt || ev.ts > this.run.updatedAt)) this.run.updatedAt = ev.ts;
    this.runDirty = true;
    switch (ev.type) {
      case 'run.meta':
        if (ev.title) this.run.title = ev.title;
        if (ev.cwd) this.run.cwd = ev.cwd;
        if (ev.agent) this.run.agent = ev.agent;
        if (ev.sessionId) this.run.sessionId = ev.sessionId;
        break;
      case 'user.prompt':
        this.onPrompt(ev.text, ev.ts, ev.scope, ev.raw);
        break;
      case 'agent.text':
        this.onText(ev.text, ev.ts, ev.scope);
        break;
      case 'agent.thinking': {
        const target = ev.scope ? this.scopes.get(ev.scope) : this.focusNode();
        if (target) this.addChunk(target, 'thinking', ev.text, ev.ts);
        break;
      }
      case 'plan.set':
        this.onPlanSet(ev);
        break;
      case 'plan.update':
        this.onPlanUpdate(ev);
        break;
      case 'tool.start':
        this.onToolStart(ev);
        break;
      case 'tool.end':
        this.onToolEnd(ev);
        break;
      case 'notice':
        this.onNotice(ev);
        break;
      case 'turn.end':
        if (!ev.scope) this.onTurnEnd(ev.ts, ev.interrupted);
        break;
      case 'usage':
        this.onUsage(ev);
        break;
    }
    this.syncRunPointers();
  }

  applyAll(events: LucidlyEvent[]): void {
    for (const e of events) this.apply(e);
  }

  private runCopy(): RunInfo {
    const u = this.run.usage;
    return {
      ...this.run,
      goals: [...this.run.goals],
      usage: u && { ...u, byModel: structuredClone(u.byModel), perMinute: u.perMinute.map((p) => [p[0], p[1]] as [number, number]) },
    };
  }

  /** Full state. Does not consume pending changes: flush takePatch() first when broadcasting. */
  snapshot(): Snapshot {
    return { run: this.runCopy(), nodes: Object.fromEntries(this.nodes) };
  }

  /** Changes since the last snapshot/patch, or null when nothing changed. */
  takePatch(): Patch | null {
    if (this.dirty.size === 0 && !this.runDirty) return null;
    const nodes: Record<string, ViewNode | null> = {};
    for (const id of this.dirty) nodes[id] = this.nodes.get(id) ?? null;
    this.dirty.clear();
    this.runDirty = false;
    return { run: this.runCopy(), nodes };
  }

  /**
   * Raw chunks for a node and everything under it, in arrival order.
   * With `own`, only the node's chunks plus those of its direct notes and user replies
   * (used for goals, whose full subtree can be the entire transcript).
   */
  raw(nodeId: string, own = false): Chunk[] {
    const ids: number[] = [];
    const visit = (id: string, depth: number) => {
      ids.push(...(this.nodeChunks.get(id) ?? []));
      for (const c of this.nodes.get(id)?.children ?? []) {
        if (!own) visit(c, depth + 1);
        else if (depth === 0) {
          const n = this.nodes.get(c);
          if (n && (n.type === 'note' || n.kind === 'user')) visit(c, depth + 1);
        }
      }
    };
    visit(nodeId, 0);
    return ids.sort((a, b) => a - b).map((i) => this.chunks[i]);
  }

  /** Every action of the run in execution order, with where it happened. */
  actions(cap = 4000): ActionRow[] {
    const rows: ActionRow[] = [];
    for (const n of this.nodes.values()) {
      const isAgent = n.type === 'subtask' && n.origin === 'subagent';
      if (!(n.type === 'activity' && n.kind !== 'user') && !isAgent) continue;
      const toolChunk = (this.nodeChunks.get(n.id) ?? []).map((i) => this.chunks[i]).find((c) => c.kind === 'tool');
      const text = toolChunk?.text ?? '';
      const input = text.length > cap ? text.slice(0, cap) + '\n…' : text;
      const row: ActionRow = {
        id: n.id,
        kind: n.kind ?? 'other',
        tool: n.tool,
        title: n.title,
        status: n.status,
        retry: n.retry,
        recovered: n.recovered,
        issue: n.issue,
        startedAt: n.startedAt,
        endedAt: n.endedAt,
        input,
      };
      if (n.diff) row.diff = n.diff;
      if (n.files?.length && (n.kind === 'edit' || n.kind === 'write')) row.files = n.files;
      if (n.via) row.via = n.via;
      if ((n.kind === 'command' || n.via === 'command') && text) {
        row.command = text.replace(/^(?:\$|PS>)\s?/, '');
        if (n.detail) row.short = n.detail.replace(/^\$\s?/, '');
      }
      let p = n.parent ? this.nodes.get(n.parent) : undefined;
      while (p) {
        if (p.type === 'subtask' && p.origin === 'subagent' && !row.subagent) {
          row.subagent = p.title.replace(/^Subagent:\s*/, '');
          row.subagentId = p.id;
        }
        if (p.type === 'step' && !row.stepId) {
          row.stepId = p.id;
          row.step = p.title;
        }
        if (p.type === 'goal') {
          row.goalId = p.id;
          row.goal = p.title;
        }
        p = p.parent ? this.nodes.get(p.parent) : undefined;
      }
      rows.push(row);
    }
    // Creation order is execution order within one transcript, but subagent transcripts are
    // read after the main one when loading a session: order by time, not by arrival.
    // Subagent transcripts are read after the main one: order by time, not by arrival.
    let last = '';
    const keyed = rows.map((r, i) => ({ r, i, t: (last = r.startedAt ?? last) }));
    keyed.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.i - y.i));
    return keyed.map((k) => k.r);
  }

  // ───────────────────────────── node helpers

  private newNode(type: NodeType, parent: string | null, title: string, extra: Partial<ViewNode> = {}): ViewNode {
    const id = `n${++this.seq}`;
    const node: ViewNode = { id, type, parent, children: [], title, status: 'pending', ...extra };
    this.nodes.set(id, node);
    this.dirty.add(id);
    if (parent) {
      const p = this.nodes.get(parent);
      if (p) {
        p.children.push(id);
        this.dirty.add(parent);
      }
    }
    return node;
  }

  private touch(id: string): ViewNode | undefined {
    const n = this.nodes.get(id);
    if (n) this.dirty.add(id);
    return n;
  }

  private setStatus(id: string, status: NodeStatus, ts?: string): void {
    const n = this.touch(id);
    if (!n || n.status === status) return;
    if (status === 'active' && !n.startedAt) n.startedAt = ts;
    // Reopened (a follow-up reply, a step picked up again): it ends again later.
    if (status === 'active') delete n.endedAt;
    if ((status === 'done' || status === 'failed' || status === 'resolved') && !n.endedAt) n.endedAt = ts;
    n.status = status;
  }

  private removeNode(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const c of [...n.children]) this.removeNode(c);
    if (n.parent) {
      const p = this.touch(n.parent);
      if (p) p.children = p.children.filter((c) => c !== id);
    }
    this.nodes.delete(id);
    this.dirty.add(id);
    for (const g of this.goalCtx.values()) {
      g.plan = g.plan.filter((s) => s !== id);
      if (g.current === id) g.current = null;
      if (g.unit === id) g.unit = g.current;
      if (g.pending === id) g.pending = null;
    }
  }

  private addChunk(node: string, kind: ChunkKind, text: string, ts?: string, label?: string, failed?: boolean): number {
    const id = this.chunks.length;
    const t = text.length > MAX_CHUNK ? text.slice(0, MAX_CHUNK) + `\n… [truncated ${text.length - MAX_CHUNK} chars]` : text;
    this.chunks.push({ id, node, kind, text: t, ts, label, failed });
    const list = this.nodeChunks.get(node) ?? [];
    list.push(id);
    this.nodeChunks.set(node, list);
    return id;
  }

  private moveChunk(chunkId: number, to: string, kind?: ChunkKind): void {
    const c = this.chunks[chunkId];
    if (!c) return;
    const from = this.nodeChunks.get(c.node);
    if (from) this.nodeChunks.set(c.node, from.filter((x) => x !== chunkId));
    c.node = to;
    if (kind) c.kind = kind;
    const list = this.nodeChunks.get(to) ?? [];
    list.push(chunkId);
    this.nodeChunks.set(to, list);
  }

  /** Adds a response's tokens to the run, its model, and every goal/step/subtask it happened in. */
  /** Per subagent scope: last recorded output, the true final one, and the correction applied. */
  private outFix = new Map<string, { last: number; final?: number; applied: number; model: string }>();

  private onUsage(ev: UsageEvent): void {
    if (ev.scope) {
      const f = this.outFix.get(ev.scope) ?? { last: 0, applied: 0, model: ev.model };
      this.outFix.set(ev.scope, f);
      if (ev.final) f.final = ev.output;
      else f.last = ev.output;
      if (ev.model && (ev.final || !f.model)) f.model = ev.model;
      // Without a model to file it under, wait for the subagent's own records.
      const want = f.final === undefined || !f.model ? 0 : Math.max(0, f.final - f.last);
      const d = want - f.applied;
      f.applied = want;
      if (ev.final || d) {
        if (d) this.credit({ type: 'usage', scope: ev.scope, model: f.model, input: 0, output: d, cacheRead: 0, cacheWrite: 0 }, false);
        if (ev.final) return;
      }
    }
    this.credit(ev, true);
  }

  private credit(ev: UsageEvent, response: boolean): void {
    const add = (u: TokenUsage) => {
      u.input += ev.input;
      u.output += ev.output;
      u.cacheRead += ev.cacheRead;
      u.cacheWrite += ev.cacheWrite;
      if (response) u.responses++;
    };
    const ru = (this.run.usage ??= { ...zeroUsage(), byModel: {}, perMinute: [] });
    add(ru);
    add((ru.byModel[ev.model] ??= zeroUsage()));
    if (!ev.scope && response) {
      ru.context = ev.input + ev.cacheRead + ev.cacheWrite;
      ru.contextModel = ev.model;
    }
    if (ev.ts) {
      if (!ru.lastAt || ev.ts > ru.lastAt) ru.lastAt = ev.ts;
      const minute = Math.floor(Date.parse(ev.ts) / 60000);
      const fresh = ev.input + ev.cacheWrite + ev.output;
      if (Number.isFinite(minute)) {
        const slot = ru.perMinute.find((p) => p[0] === minute);
        if (slot) slot[1] += fresh;
        else {
          ru.perMinute.push([minute, fresh]);
          ru.perMinute.sort((a, b) => a[0] - b[0]);
          if (ru.perMinute.length > 240) ru.perMinute.splice(0, ru.perMinute.length - 240);
        }
      }
    }
    let id = ev.scope ? this.scopes.get(ev.scope) : this.focusNode();
    while (id) {
      const n = this.nodes.get(id);
      if (!n) break;
      // The main agent's own responses never count toward a subagent, even while the subagent
      // holds the focus (its actions arrive interleaved with the main agent's when watched live).
      const foreign = !ev.scope && n.type === 'subtask' && n.origin === 'subagent';
      if (!foreign && (n.type === 'goal' || n.type === 'step' || n.type === 'subtask')) {
        add((n.usage ??= zeroUsage()));
        if (!n.models?.includes(ev.model)) (n.models ??= []).push(ev.model);
        this.dirty.add(n.id);
      }
      id = n.parent ?? undefined;
    }
  }

  private unitCtx(id: string): UnitCtx {
    let u = this.units.get(id);
    if (!u) {
      u = { failStreak: 0 };
      this.units.set(id, u);
    }
    return u;
  }

  private currentGoal(): GoalCtx | undefined {
    return this.run.currentGoal ? this.goalCtx.get(this.run.currentGoal) : undefined;
  }

  private ensureGoal(ts?: string): GoalCtx {
    return this.currentGoal() ?? this.newGoal(this.run.title ?? 'Session', ts);
  }

  private focusNode(): string | undefined {
    const g = this.currentGoal();
    return g ? (g.unit ?? g.current ?? g.id) : undefined;
  }

  private syncRunPointers(): void {
    const g = this.currentGoal();
    const step = g?.current ?? undefined;
    const unit = g?.unit ?? undefined;
    if (this.run.currentStep !== step || this.run.currentUnit !== unit) {
      this.run.currentStep = step;
      this.run.currentUnit = unit;
    }
  }

  /** Steps (in order) of a goal: planned and inferred. */
  private stepsOf(g: GoalCtx): string[] {
    return (this.nodes.get(g.id)?.children ?? []).filter((c) => this.nodes.get(c)?.type === 'step');
  }

  // ───────────────────────────── goals

  private newGoal(prompt: string, ts?: string): GoalCtx {
    const title = truncate(stripMarkdown(firstLine(prompt, 300)), 110) || 'Task';
    const n = this.newNode('goal', null, title, { status: 'active', startedAt: ts, stats: { actions: 0, errors: 0 } });
    const g: GoalCtx = {
      id: n.id,
      plan: [],
      planSource: 'none',
      planKeys: new Map(),
      tentative: null,
      tentativeChunk: null,
      current: null,
      unit: null,
      pending: null,
      lastTextChunk: null,
      actionsSinceText: 0,
      intentCandidate: null,
    };
    this.goalCtx.set(n.id, g);
    this.run.goals.push(n.id);
    this.run.currentGoal = n.id;
    return g;
  }

  private finishGoal(g: GoalCtx, ts?: string): void {
    if (g.tentative) this.dropTentative(g);
    // A text plan is the agent's own announcement, not a tracked checklist: when the task
    // ends normally after work on it, steps never told apart were done along with the others.
    const worked = g.planSource === 'text' && !g.interrupted && g.plan.some((id) => this.nodes.get(id)?.status !== 'pending');
    for (const id of this.stepsOf(g)) {
      const s = this.nodes.get(id)!;
      if (s.status === 'active') this.setStatus(id, 'done', ts);
      else if (worked && s.status === 'pending' && s.origin === 'plan' && g.plan.includes(id)) {
        this.touch(id)!.untracked = true;
        this.setStatus(id, 'done', ts);
      }
    }
    if (g.unit && this.nodes.get(g.unit)?.type === 'subtask' && this.nodes.get(g.unit)?.status === 'active') {
      this.setStatus(g.unit, 'done', ts);
    }
    this.setStatus(g.id, 'done', ts);
  }

  private onPrompt(text: string, ts?: string, scope?: string, raw?: string): void {
    if (scope) {
      const n = this.scopes.get(scope);
      if (n) this.addChunk(n, 'prompt', raw ?? text, ts, 'Task given to subagent');
      return;
    }
    // A message sent while the agent is still in its turn is an interjection, not a new task.
    const midTurn = this.run.status === 'working';
    // /compact, /model...: no turn follows them, so the session (and its task) stays as it was.
    const housekeeping = isHousekeeping(text);
    if (!housekeeping) this.run.status = 'working';
    const cur = this.currentGoal();
    // After the turn, a short message continues the task only if it answers the agent
    // ("yes", "go ahead", or anything after a question); "all done, pushed" is a new card.
    if (!cur || (!midTurn && !isReply(text, this.agentAsked))) {
      if (cur) this.finishGoal(cur, ts);
      const g = this.newGoal(text, ts);
      this.addChunk(g.id, 'prompt', raw ?? text, ts, 'Prompt');
      return;
    }
    if (!midTurn && !housekeeping) return this.startRound(cur, text, ts, raw);
    // Sent while the agent works (or a housekeeping command): a note in the current step.
    if (!housekeeping) this.setStatus(cur.id, 'active', ts);
    const target = cur.unit ?? cur.current ?? cur.id;
    const n = this.newNode('activity', target, `You: ${truncate(text, 80)}`, { kind: 'user', status: 'done', startedAt: ts });
    this.addChunk(n.id, 'prompt', raw ?? text, ts, 'User reply');
    cur.lastTextChunk = null;
  }

  /**
   * A reply that continues a task after its turn ended starts a new round of it. The reply sits
   * on the task itself, after the steps so far (and before a plan's steps still to come), keeping
   * how the round before it ended; the work that follows goes into a step of its own.
   */
  private startRound(g: GoalCtx, text: string, ts?: string, raw?: string): void {
    const goal = this.touch(g.id)!;
    const round = {
      ...(goal.outcome ? { outcome: goal.outcome } : {}),
      ...(g.interrupted ? { interrupted: true } : {}),
      ...(this.agentAsked ? { asked: true } : {}),
    };
    this.closeSubtask(g, ts);
    // The next action picks the next unfinished plan step, or starts a new step (see onToolStart).
    g.current = null;
    g.unit = null;
    g.pending = null;
    g.lastTextChunk = null;
    g.interrupted = false;
    const n = this.newNode('activity', g.id, `You: ${truncate(text, 80)}`, { kind: 'user', status: 'done', startedAt: ts, round });
    const rest = goal.children.filter((c) => c !== n.id);
    let at = rest.length;
    while (at > 0) {
      const c = this.nodes.get(rest[at - 1]);
      if (!(c?.type === 'step' && (c.status === 'pending' || c.tentative))) break;
      at--;
    }
    rest.splice(at, 0, n.id);
    goal.children = rest;
    this.addChunk(n.id, 'prompt', raw ?? text, ts, 'User reply');
    delete goal.outcome;
    this.setStatus(g.id, 'active', ts);
  }

  // ───────────────────────────── narration

  private onText(text: string, ts?: string, scope?: string): void {
    if (!text.trim()) return;
    if (!scope) this.agentAsked = endsWithQuestion(text);
    if (scope) {
      const n = this.scopes.get(scope);
      if (n) {
        this.addChunk(n, 'text', text, ts);
        const node = this.touch(n)!;
        node.detail = intentTitle(text, 120);
      }
      return;
    }
    const g = this.ensureGoal(ts);
    const goal = this.nodes.get(g.id)!;
    this.setStatus(g.id, 'active', ts);
    this.run.status = 'working';

    // A plan?
    if (g.planSource !== 'tool') {
      const started = g.plan.some((id) => this.nodes.get(id)?.status !== 'pending');
      const plan = extractPlan(text, started);
      if (plan) {
        this.setTextPlan(g, plan, text, ts);
        return;
      }
    }

    if (!goal.intent && g.intentCandidate === null) g.intentCandidate = text;

    // Consecutive narration with no action in between: same unit.
    if (g.pending) {
      const p = this.touch(g.pending)!;
      g.lastTextChunk = this.addChunk(g.pending, 'text', text, ts);
      g.actionsSinceText = 0;
      if (!hasIntent(p.title) && hasIntent(text) && p.origin !== 'plan') p.title = intentTitle(text);
      return;
    }

    const unitFailing = g.unit ? this.unitCtx(g.unit).failStreak > 0 : false;
    const hasPlan = g.plan.length > 0 || (g.tentative?.length ?? 0) > 0;

    if (hasPlan && !g.tentative) {
      const infos = g.plan.map((id) => {
        const n = this.nodes.get(id)!;
        return { title: n.title, done: n.status === 'done' };
      });
      const curIdx = g.current ? g.plan.indexOf(g.current) : -1;
      const idx = g.planSource === 'text' ? matchStep(text, infos, curIdx) : -1;
      if (idx >= 0) {
        const target = g.plan[idx];
        if (target !== g.current) this.activateStep(g, target, ts);
        else this.closeSubtask(g, ts);
        g.lastTextChunk = this.addChunk(target, 'text', text, ts);
        g.actionsSinceText = 0;
        return;
      }
      if (!g.current) {
        const next = g.plan.find((id) => this.nodes.get(id)?.status !== 'done');
        if (next) {
          this.activateStep(g, next, ts);
          g.lastTextChunk = this.addChunk(next, 'text', text, ts);
          g.actionsSinceText = 0;
          return;
        }
      }
    }

    if (g.current && (unitFailing || (hasPlan && hasDeviationCue(text)))) {
      // Unplanned work arising inside the current step.
      if (!(unitFailing && this.nodes.get(g.unit!)?.type === 'subtask')) {
        const sub = this.newNode('subtask', g.current, intentTitle(text), {
          origin: 'unplanned',
          status: 'active',
          startedAt: ts,
          stats: { actions: 0, errors: 0 },
          context: { files: [], commands: [], tools: [] },
        });
        if (g.unit && g.unit !== g.current) this.closeSubtask(g, ts);
        g.unit = sub.id;
        g.pending = sub.id;
      }
      g.lastTextChunk = this.addChunk(g.unit!, 'text', text, ts);
      g.actionsSinceText = 0;
      return;
    }

    if (hasPlan) {
      // Plan exists, narration is part of the current step.
      this.closeSubtask(g, ts);
      const target = g.current ?? g.id;
      g.lastTextChunk = this.addChunk(target, 'text', text, ts);
      g.actionsSinceText = 0;
      return;
    }

    // No plan: every narration that leads to action becomes a new inferred step.
    const step = this.newNode('step', g.id, intentTitle(text), {
      origin: 'inferred',
      stats: { actions: 0, errors: 0 },
      context: { files: [], commands: [], tools: [] },
    });
    this.activateStep(g, step.id, ts);
    g.pending = step.id;
    g.lastTextChunk = this.addChunk(step.id, 'text', text, ts);
    g.actionsSinceText = 0;
  }

  private closeSubtask(g: GoalCtx, ts?: string): void {
    if (g.unit && g.unit !== g.current) {
      const u = this.nodes.get(g.unit);
      if (u?.type === 'subtask' && u.status === 'active') this.setStatus(u.id, 'done', ts);
    }
    g.unit = g.current;
  }

  private activateStep(g: GoalCtx, id: string, ts?: string): void {
    const prev = g.current;
    this.closeSubtask(g, ts);
    if (prev && prev !== id) {
      const ti = g.plan.indexOf(id);
      if (ti >= 0 && g.planSource !== 'tool') {
        for (let i = 0; i < ti; i++) {
          const s = this.nodes.get(g.plan[i])!;
          if (s.status === 'pending' || s.status === 'active') this.setStatus(s.id, 'done', ts);
        }
      }
      const p = this.nodes.get(prev);
      if (p && p.status === 'active' && (g.planSource !== 'tool' || !g.plan.includes(prev))) this.setStatus(prev, 'done', ts);
    }
    this.setStatus(id, 'active', ts);
    g.current = id;
    g.unit = id;
    g.pending = null;
  }

  // ───────────────────────────── plans

  private planStep(g: GoalCtx, title: string, extra: Partial<ViewNode> = {}): ViewNode {
    return this.newNode('step', g.id, title, {
      origin: 'plan',
      stats: { actions: 0, errors: 0 },
      context: { files: [], commands: [], tools: [] },
      ...extra,
    });
  }

  private setTextPlan(g: GoalCtx, plan: ExtractedPlan, text: string, ts?: string): void {
    if (g.tentative) this.dropTentative(g);
    const goal = this.nodes.get(g.id)!;
    if (!goal.intent) g.intentCandidate = plan.intro || text;
    g.tentativeChunk = this.addChunk(g.id, 'plan', text, ts, 'Plan');
    g.tentative = plan.items.map((t) => this.planStep(g, t, { tentative: true }).id);
    g.lastTextChunk = g.tentativeChunk;
    g.actionsSinceText = 0;
    if (g.pending) {
      // A narration-only unit right before the plan: fold it away.
      const p = this.nodes.get(g.pending);
      if (p && p.children.length === 0) {
        for (const c of [...(this.nodeChunks.get(p.id) ?? [])]) this.moveChunk(c, g.id);
        this.removeNode(p.id);
      }
      g.pending = null;
    }
  }

  private dropTentative(g: GoalCtx): void {
    for (const id of g.tentative ?? []) this.removeNode(id);
    g.tentative = null;
    g.tentativeChunk = null;
  }

  private confirmTentative(g: GoalCtx, ts?: string): void {
    const ids = g.tentative!;
    g.tentative = null;
    g.tentativeChunk = null;
    for (const id of g.plan) {
      const n = this.nodes.get(id);
      if (n && n.status === 'pending' && n.children.length === 0) this.removeNode(id);
      else if (n && n.status === 'active') this.setStatus(id, 'done', ts);
    }
    for (const id of ids) {
      const n = this.touch(id);
      if (n) delete n.tentative;
    }
    g.plan = ids;
    g.planSource = 'text';
    this.activateStep(g, ids[0], ts);
  }

  private planKey(item: { id?: string; title?: string }): string {
    return item.id ? `id:${item.id}` : `t:${(item.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
  }

  private adoptToolPlan(g: GoalCtx): void {
    if (g.tentative) this.dropTentative(g);
    if (g.planSource === 'tool') return;
    for (const id of g.plan) {
      const n = this.nodes.get(id);
      if (n && n.status === 'pending' && n.children.length === 0) this.removeNode(id);
    }
    g.plan = [];
    g.planSource = 'tool';
  }

  private applyPlanStatus(g: GoalCtx, id: string, status: PlanStatus | undefined, ts?: string): void {
    if (!status) return;
    if (status === 'in_progress') {
      if (g.current !== id) {
        this.closeSubtask(g, ts);
        this.setStatus(id, 'active', ts);
        g.current = id;
        g.unit = id;
        g.pending = null;
      }
    } else {
      this.setStatus(id, status === 'completed' ? 'done' : 'pending', ts);
    }
  }

  private onPlanSet(ev: PlanSetEvent): void {
    const g = this.ensureGoal(ev.ts);
    this.adoptToolPlan(g);
    this.run.status = 'working';
    if (ev.raw) this.addChunk(g.id, 'plan', ev.raw, ev.ts, `Plan (${ev.source})`);
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const item of ev.items) {
      const key = this.planKey(item);
      seen.add(key);
      let id = g.planKeys.get(key);
      if (!id || !this.nodes.get(id)) {
        id = this.planStep(g, truncate(stripMarkdown(item.title), 110)).id;
        g.planKeys.set(key, id);
        if (item.id) g.planKeys.set(this.planKey({ title: item.title }), id);
      } else {
        const n = this.touch(id)!;
        n.title = truncate(stripMarkdown(item.title), 110);
      }
      ordered.push(id);
    }
    if (ev.replace) {
      for (const [key, id] of g.planKeys) {
        if (seen.has(key) || ordered.includes(id)) continue;
        const n = this.nodes.get(id);
        if (n && n.status === 'pending' && n.children.length === 0) this.removeNode(id);
        g.planKeys.delete(key);
      }
      const kept = g.plan.filter((id) => !ordered.includes(id) && this.nodes.has(id));
      g.plan = [...kept, ...ordered];
    } else {
      for (const id of ordered) if (!g.plan.includes(id)) g.plan.push(id);
    }
    ev.items.forEach((item: PlanItem, i: number) => this.applyPlanStatus(g, ordered[i], item.status, ev.ts));
  }

  private onPlanUpdate(ev: PlanUpdateEvent): void {
    const g = this.currentGoal();
    if (!g) return;
    const id = g.planKeys.get(this.planKey({ id: ev.id })) ?? (ev.title ? g.planKeys.get(this.planKey({ title: ev.title })) : undefined);
    if (!id || !this.nodes.has(id)) return;
    if (ev.deleted) {
      const n = this.nodes.get(id)!;
      if (n.children.length === 0) this.removeNode(id);
      return;
    }
    if (ev.title) this.touch(id)!.title = truncate(stripMarkdown(ev.title), 110);
    this.applyPlanStatus(g, id, ev.status, ev.ts);
  }

  // ───────────────────────────── actions

  /**
   * A success marks earlier failures as recovered: those in the same unit, and in the units
   * it sits in (a fix subtask recovers the step's failed test). Not downwards: a step's
   * success says nothing about a subagent's failure.
   */
  private recover(unitId: string): void {
    let id: string | null = unitId;
    while (id) {
      const n = this.nodes.get(id);
      if (!n || n.type === 'goal') break;
      const uc = this.units.get(id);
      for (const a of uc?.pendingFails ?? []) {
        const act = this.nodes.get(a);
        if (!act || act.recovered) continue;
        act.recovered = true;
        this.dirty.add(a);
        const owner = act.parent;
        if (owner) this.bump(owner, 'recovered');
      }
      if (uc) uc.pendingFails = [];
      id = n.parent;
    }
  }

  private bump(fromId: string, field: 'actions' | 'errors' | 'recovered'): void {
    let id: string | null = fromId;
    while (id) {
      const n = this.nodes.get(id);
      if (!n) break;
      if (n.stats) {
        n.stats[field] = (n.stats[field] ?? 0) + 1;
        this.dirty.add(id);
      }
      id = n.parent;
    }
  }

  private addContext(fromId: string, ev: ToolStartEvent): void {
    let id: string | null = fromId;
    while (id) {
      const n = this.nodes.get(id);
      if (!n || n.type === 'goal') break;
      if (n.context) {
        const push = (arr: string[], v: string) => {
          if (!arr.includes(v)) {
            arr.push(v);
            if (arr.length > MAX_CONTEXT_ITEMS) arr.shift();
          }
        };
        for (const f of ev.files ?? []) push(n.context.files, f);
        if (ev.kind === 'command') push(n.context.commands, truncate(ev.command ?? ev.label, 60));
        push(n.context.tools, ev.tool);
        this.dirty.add(id);
      }
      if (n.type === 'step') break;
      id = n.parent;
    }
  }

  private onToolStart(ev: ToolStartEvent): void {
    let unit: string;
    if (ev.scope) {
      const s = this.scopes.get(ev.scope);
      if (!s) return;
      unit = s;
    } else {
      const g = this.ensureGoal(ev.ts);
      this.run.status = ev.kind === 'ask' ? 'waiting' : 'working';
      if (g.tentative) this.confirmTentative(g, ev.ts);
      if (!g.unit) {
        const next = g.plan.find((id) => this.nodes.get(id)?.status !== 'done');
        if (next) this.activateStep(g, next, ev.ts);
        else {
          const step = this.newNode('step', g.id, ev.label, {
            origin: 'inferred',
            stats: { actions: 0, errors: 0 },
            context: { files: [], commands: [], tools: [] },
          });
          this.activateStep(g, step.id, ev.ts);
        }
      }
      unit = g.unit!;
      g.pending = null;
      g.actionsSinceText++;
      const goal = this.nodes.get(g.id)!;
      if (!goal.intent && g.intentCandidate) {
        const intent = intentTitle(g.intentCandidate, 160);
        // "Do this in three steps" says nothing the goal title doesn't.
        if (!/^(?:do|tackle|handle|approach|break) (?:this|it)\b/i.test(intent) && intent.split(/\s+/).length >= 3) {
          goal.intent = intent;
          this.touch(g.id);
        }
      }
      g.intentCandidate = null;
    }

    const uc = this.unitCtx(unit);
    const retry =
      !!uc.lastFail && uc.lastFail.tool === ev.tool && similarity(tokens(uc.lastFail.label), tokens(ev.label)) >= 0.5;
    const node = ev.spawnsAgent
      ? this.newNode('subtask', unit, ev.label, {
          origin: 'subagent',
          kind: 'agent',
          tool: ev.tool,
          detail: ev.detail,
          status: 'active',
          startedAt: ev.ts,
          stats: { actions: 0, errors: 0 },
          context: { files: [], commands: [], tools: [] },
        })
      : this.newNode('activity', unit, ev.label, {
          kind: ev.kind,
          tool: ev.tool,
          detail: ev.detail,
          files: ev.files,
          ...(ev.via ? { via: ev.via } : {}),
          status: 'active',
          startedAt: ev.ts,
        });
    if (retry) node.retry = true;
    if (ev.spawnsAgent) this.scopes.set(ev.callId, node.id);
    this.calls.set(ev.callId, { node: node.id, unit, tool: ev.tool, label: ev.label });
    const chunk = this.addChunk(node.id, 'tool', ev.raw ?? ev.detail ?? ev.label, ev.ts, ev.label);
    if (ev.parts?.length && ev.parts.every((p) => p.text.length <= MAX_CHUNK)) this.chunks[chunk].parts = ev.parts;
    this.bump(unit, 'actions');
    this.addContext(unit, ev);
    const held = ev.spawnsAgent ? this.orphans.get(ev.callId) : undefined;
    if (held) {
      this.orphans.delete(ev.callId);
      for (const h of held) this.apply(h);
    }
  }

  private onToolEnd(ev: ToolEndEvent): void {
    const c = this.calls.get(ev.callId);
    if (!c) return;
    const node = this.nodes.get(c.node);
    if (!node) return;
    if (ev.background) {
      // Launched, not finished: keep it running, and keep the launch message.
      this.addChunk(c.node, 'result', ev.output ?? '', ev.ts, 'Started in the background', false);
      return;
    }
    // A background call reports once; repeats (a resumed agent stopping again) only add output.
    if (node.status === 'done' || node.status === 'failed') {
      if (ev.output) this.addChunk(c.node, 'result', ev.output, ev.ts, 'Update', !ev.ok);
      return;
    }
    if (!ev.scope) {
      const wasAsk = node.kind === 'ask';
      if (wasAsk || this.run.status === 'waiting') this.run.status = 'working';
    }
    this.setStatus(c.node, ev.ok ? 'done' : 'failed', ev.ts);
    const rc = this.addChunk(c.node, 'result', ev.output ?? '', ev.ts, ev.ok ? 'Result' : 'Error', !ev.ok);
    if (ev.patch?.length) {
      // Keep the diff bounded: huge rewrites are summarised by their counts.
      let budget = MAX_PATCH_LINES;
      const hunks = [];
      let add = 0;
      let del = 0;
      for (const h of ev.patch) {
        for (const l of h.lines) {
          if (l.startsWith('+')) add++;
          else if (l.startsWith('-')) del++;
        }
        if (budget > 0) hunks.push(h.lines.length > budget ? { ...h, lines: [...h.lines.slice(0, budget), ' …'] } : h);
        budget -= h.lines.length;
      }
      this.chunks[rc].patch = hunks;
      node.diff = { add, del };
    }
    const uc = this.unitCtx(c.unit);
    if (!ev.ok) {
      node.issue = ev.rejected ? 'Rejected by user' : issueSummary(ev.output ?? '');
      uc.failStreak++;
      uc.lastFail = { tool: c.tool, label: c.label };
      (uc.pendingFails ??= []).push(c.node);
      this.bump(c.unit, 'errors');
      if (ev.rejected) {
        this.blocker(c.unit, `Rejected: ${c.label}`, ev.ts, ev.output ?? 'The action was rejected.');
      } else if (uc.failStreak >= 2 && !uc.openBlocker) {
        this.blocker(c.unit, node.issue, ev.ts, ev.output ?? '', `${uc.failStreak} failed attempts`);
      } else if (uc.openBlocker) {
        const b = this.touch(uc.openBlocker);
        if (b) b.detail = `${uc.failStreak} failed attempts`;
      }
    } else {
      uc.failStreak = 0;
      this.recover(c.unit);
      if (uc.openBlocker) {
        this.setStatus(uc.openBlocker, 'resolved', ev.ts);
        uc.openBlocker = undefined;
      }
    }
  }

  private blocker(parent: string, title: string, ts: string | undefined, text: string, detail?: string): void {
    const b = this.newNode('blocker', parent, truncate(title, 120), { status: 'open', startedAt: ts, detail });
    this.addChunk(b.id, 'notice', text, ts, 'Blocker');
    this.unitCtx(parent).openBlocker = b.id;
  }

  private onNotice(ev: NoticeEvent): void {
    let target: string;
    if (ev.scope) {
      const s = this.scopes.get(ev.scope);
      if (!s) return;
      target = s;
    } else {
      const g = this.ensureGoal(ev.ts);
      target = g.unit ?? g.current ?? g.id;
    }
    if (ev.blocking) {
      this.blocker(target, ev.text, ev.ts, ev.raw ?? ev.text);
      return;
    }
    const n = this.newNode('note', target, truncate(ev.text, 140), { level: ev.level, status: 'done', startedAt: ev.ts });
    this.addChunk(n.id, 'notice', ev.raw ?? ev.text, ev.ts, 'Notice');
  }

  private onTurnEnd(ts?: string, interrupted?: boolean): void {
    this.run.status = 'waiting';
    const g = this.currentGoal();
    if (!g) return;
    g.interrupted = !!interrupted;
    const goal = this.touch(g.id)!;

    // The last words after the last action are the outcome, not a step.
    if (g.tentative) {
      const chunk = g.tentativeChunk;
      this.dropTentative(g);
      if (chunk !== null) {
        this.moveChunk(chunk, g.id, 'outcome');
        goal.outcome = outcomeText(this.chunks[chunk].text);
      }
    } else if (g.pending) {
      const p = this.nodes.get(g.pending)!;
      if (p.children.length === 0) {
        const chunkIds = [...(this.nodeChunks.get(p.id) ?? [])];
        const text = chunkIds.map((c) => this.chunks[c].text).join('\n\n');
        for (const c of chunkIds) this.moveChunk(c, g.id, this.chunks[c].kind === 'text' ? 'outcome' : undefined);
        const wasCurrent = g.current === p.id;
        const parent = p.parent;
        this.removeNode(p.id);
        if (wasCurrent) {
          const steps = this.stepsOf(g);
          g.current = steps.length ? steps[steps.length - 1] : null;
        }
        g.unit = g.current;
        if (parent && parent !== g.id && this.nodes.get(parent)?.type === 'step') g.unit = g.current;
        goal.outcome = outcomeText(text);
      }
      g.pending = null;
    } else if (g.lastTextChunk !== null && g.actionsSinceText === 0) {
      this.moveChunk(g.lastTextChunk, g.id, 'outcome');
      goal.outcome = outcomeText(this.chunks[g.lastTextChunk].text);
    }
    g.lastTextChunk = null;
    g.intentCandidate = null;

    if (interrupted) {
      const target = g.unit ?? g.current ?? g.id;
      const n = this.newNode('note', target, 'Interrupted by user', { level: 'warning', status: 'done', startedAt: ts });
      this.addChunk(n.id, 'notice', 'Interrupted by user', ts, 'Notice');
    }

    this.closeSubtask(g, ts);
    if (g.current && g.planSource !== 'tool') {
      const isLastPlanned = g.plan.length > 0 && g.plan[g.plan.length - 1] === g.current;
      if (g.plan.length === 0 || isLastPlanned || !g.plan.includes(g.current)) this.setStatus(g.current, 'done', ts);
    }
    // The agent finished its turn: the task is done, unless it was cut short. A follow-up
    // reply reopens it (see onPrompt).
    this.setStatus(g.id, interrupted ? 'waiting' : 'done', ts);
  }
}

function outcomeText(text: string): string {
  const ss = sentences(text);
  return truncate(ss.slice(0, 2).join(' ') || stripMarkdown(text), 240);
}
