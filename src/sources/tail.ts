/**
 * Incremental line reader for files that grow (live transcripts).
 * Reads from a byte offset in chunks, keeps a partial trailing line until it completes,
 * and reacts to both fs.watch notifications and a slow poll (fs.watch is unreliable on some platforms).
 */
import { open, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';

const CHUNK = 1 << 20;

export class LineTailer {
  private offset = 0;
  private partial = '';
  private timer: NodeJS.Timeout | null = null;
  private watcher: FSWatcher | null = null;
  private reading = false;
  private again = false;
  private stopped = false;
  private decoder = new TextDecoder('utf-8');
  readonly path: string;
  private readonly onLines: (lines: string[]) => void;
  private readonly pollMs: number;

  constructor(path: string, onLines: (lines: string[]) => void, pollMs = 500) {
    this.path = path;
    this.onLines = onLines;
    this.pollMs = pollMs;
  }

  /** Read everything currently in the file, then keep following it. */
  async start(follow = true): Promise<void> {
    await this.read();
    if (!follow || this.stopped) return;
    try {
      this.watcher = watch(this.path, () => void this.read());
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      /* polling still works */
    }
    this.timer = setInterval(() => void this.read(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
  }

  /** Read new bytes. Safe to call concurrently: overlapping calls coalesce. */
  async read(): Promise<void> {
    if (this.stopped) return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.again = false;
        await this.readOnce();
      } while (this.again && !this.stopped);
    } finally {
      this.reading = false;
    }
  }

  private async readOnce(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      // truncated or replaced: start over
      this.offset = 0;
      this.partial = '';
      this.decoder = new TextDecoder('utf-8');
    }
    if (size === this.offset) return;
    const fh = await open(this.path, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      while (this.offset < size && !this.stopped) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - this.offset), this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        const text = this.partial + this.decoder.decode(buf.subarray(0, bytesRead), { stream: true });
        const lines = text.split('\n');
        this.partial = lines.pop() ?? '';
        const complete = lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
        if (complete.length) this.onLines(complete);
      }
    } finally {
      await fh.close();
    }
  }
}
