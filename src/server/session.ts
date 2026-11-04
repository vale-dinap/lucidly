/**
 * One open run: a source feeding an engine, the event log (for saving), and live subscribers.
 * State lives in memory; saving writes the event log, loading replays it.
 */
import { Engine } from '../core/engine.ts';
import type { LucidlyEvent } from '../core/events.ts';
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
}

const FLUSH_MS = 120;

export class RunSession {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly live: boolean;
  readonly engine = new Engine();
  readonly events: LucidlyEvent[] = [];
  private readonly source: Source | null;
  private subs = new Set<Send>();
  private timer: NodeJS.Timeout | null = null;

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
  }

  private flush(): void {
    this.timer = null;
    const patch = this.engine.takePatch();
    if (!patch) return;
    for (const s of this.subs) s('patch', patch);
  }

  subscribe(send: Send): () => void {
    // Bring existing subscribers up to date first, so the new snapshot and their state agree.
    if (this.timer) {
      clearTimeout(this.timer);
      this.flush();
    } else {
      this.engine.takePatch();
    }
    this.subs.add(send);
    send('snapshot', this.engine.snapshot());
    return () => this.subs.delete(send);
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
    this.source?.stop();
    this.subs.clear();
  }
}
