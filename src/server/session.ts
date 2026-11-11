/**
 * One open run: a source feeding an engine, the event log (for saving), and live subscribers.
 * State lives in memory; saving writes the event log, loading replays it.
 */
import { Engine } from '../core/engine.ts';
import type { LucidlyEvent } from '../core/events.ts';
import { runSummary, type RunSummary } from '../core/summary.ts';
import type { Source } from '../sources/source.ts';

export const SAVE_FORMAT = 'lucidly-run';
export const SAVE_VERSION = 1;

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  version: number;
  savedAt: string;
  label: string;
  meta: { title?: string; cwd?: string; agent?: string; sessionId?: string };
  events: LucidlyEvent[];
}

export type Send = (event: 'snapshot' | 'patch', data: unknown) => void;

export interface RunInfoSummary {
  id: string;
  key: string;
  label: string;
  title?: string;
  live: boolean;
  status: string;
  eventCount: number;
  updatedAt?: string;
  subscribers: number;
  /** The session file, when the run can be opened again from it (after a server restart). */
  path?: string;
}

const FLUSH_MS = 120;
/** Listeners to a run's summary (session tabs) hear about changes at most this often. */
const CHANGE_MS = 250;

export class RunSession {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly live: boolean;
  readonly engine = new Engine();
  readonly events: LucidlyEvent[] = [];
  private readonly source: Source | null;
  /** Live subscribers, each with the page (client id) it belongs to, when it said. */
  private subs = new Map<Send, string | undefined>();
  private timer: NodeJS.Timeout | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private changeSubs = new Set<() => void>();
  /** When a page last showed or listed this run (for closing runs nobody looks at any more). */
  lastWatched = Date.now();

  constructor(id: string, source: Source | null, opts: { key?: string; label?: string } = {}) {
    this.id = id;
    this.source = source;
    this.key = source?.key ?? opts.key ?? `run:${id}`;
    this.label = opts.label ?? source?.label ?? id;
    this.live = source?.live ?? false;
  }

  async start(): Promise<void> {
    if (this.source) await this.source.start((evs) => this.ingest(evs));
  }

  ingest(evs: LucidlyEvent[]): void {
    if (!evs.length) return;
    for (const e of evs) this.events.push(e);
    this.engine.applyAll(evs);
    if (this.subs.size && !this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    if (this.changeSubs.size && !this.changeTimer)
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null;
        for (const f of this.changeSubs) f();
      }, CHANGE_MS);
  }

  private flush(): void {
    this.timer = null;
    const patch = this.engine.takePatch();
    if (!patch) return;
    for (const s of this.subs.keys()) s('patch', patch);
  }

  subscribe(send: Send, client?: string): () => void {
    // Bring existing subscribers up to date first, so the new snapshot and their state agree.
    if (this.timer) {
      clearTimeout(this.timer);
      this.flush();
    } else {
      this.engine.takePatch();
    }
    this.subs.set(send, client);
    this.lastWatched = Date.now();
    send('snapshot', this.engine.snapshot());
    return () => {
      this.subs.delete(send);
      this.lastWatched = Date.now();
    };
  }

  /** Calls `f` (throttled) whenever new events arrive. */
  onChange(f: () => void): () => void {
    this.changeSubs.add(f);
    return () => this.changeSubs.delete(f);
  }

  /** Whether a page other than `except` has this run open (its full stream). */
  shownBy(except?: string): boolean {
    for (const c of this.subs.values()) if (c === undefined || c !== except) return true;
    return false;
  }

  /** Whether it can be opened again from its file (so closing it loses nothing). */
  get reopenable(): boolean {
    return !!this.source?.path;
  }

  /** The run's state for its tab, and its name: the session's title, or else its first request. */
  summary(now = Date.now()): RunSummary & { title?: string } {
    const r = this.engine.run;
    const first = r.goals.length ? this.engine.nodes.get(r.goals[0])?.title : undefined;
    return { ...runSummary(r, this.engine.nodes, now), title: r.title ?? first ?? this.label };
  }

  info(): RunInfoSummary {
    const r = this.engine.run;
    return {
      id: this.id,
      key: this.key,
      label: this.label,
      title: r.title,
      live: this.live,
      status: r.status,
      eventCount: r.eventCount,
      updatedAt: r.updatedAt,
      subscribers: this.subs.size,
      ...(this.source?.path ? { path: this.source.path } : {}),
    };
  }

  save(): SaveFile {
    const r = this.engine.run;
    return {
      format: SAVE_FORMAT,
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      label: this.label,
      meta: { title: r.title, cwd: r.cwd, agent: r.agent, sessionId: r.sessionId },
      events: this.events,
    };
  }

  static fromSave(id: string, data: unknown): RunSession {
    const f = data as Partial<SaveFile>;
    if (!f || f.format !== SAVE_FORMAT || !Array.isArray(f.events)) throw new Error('Not a Lucidly save file');
    if ((f.version ?? 0) > SAVE_VERSION) throw new Error(`Save file version ${f.version} is newer than this Lucidly`);
    const s = new RunSession(id, null, { label: f.label ?? f.meta?.title ?? 'Saved run' });
    s.ingest(f.events);
    return s;
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.source?.stop();
    this.subs.clear();
    this.changeSubs.clear();
  }
}
