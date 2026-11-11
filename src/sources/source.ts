import type { LucidlyEvent } from '../core/events.ts';

/** Something that produces events for one run. */
export interface Source {
  /** Human label, e.g. the session title or "stdin". */
  readonly label: string;
  /** Stable key so the same input is not opened twice (e.g. the transcript path). */
  readonly key: string;
  /** Whether the source keeps producing events after the initial read. */
  readonly live: boolean;
  /** The file it reads, when it can be opened again from it (a session tab reopens it by this). */
  readonly path?: string;
  start(emit: (events: LucidlyEvent[]) => void): Promise<void>;
  stop(): void;
}
