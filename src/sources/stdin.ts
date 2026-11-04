/**
 * Reads an agent's output from a stream (stdin by default).
 * Format is auto-detected from the first non-blank line: JSON records go to the Claude Code adapter
 * (compatible with `claude -p --output-format stream-json`), anything else to the text adapter.
 */
import type { Readable } from 'node:stream';
import { ClaudeCodeAdapter } from '../adapters/claude-code.ts';
import { TextAdapter } from '../adapters/text.ts';
import type { Adapter, LucidlyEvent } from '../core/events.ts';
import type { Source } from './source.ts';

export type StreamFormat = 'auto' | 'json' | 'text';

class JsonLinesAdapter implements Adapter {
  readonly name = 'claude-code';
  private inner = new ClaudeCodeAdapter();
  private buffer = '';
  push(input: unknown): LucidlyEvent[] {
    this.buffer += String(input);
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.flatMap((l) => this.parse(l));
  }
  flush(): LucidlyEvent[] {
    const out = this.parse(this.buffer);
    this.buffer = '';
    return out;
  }
  private parse(l: string): LucidlyEvent[] {
    const t = l.trim();
    if (!t.startsWith('{')) return [];
    try {
      return this.inner.push(JSON.parse(t));
    } catch {
      return [];
    }
  }
}

export class StreamSource implements Source {
  readonly live = true;
  readonly key: string;
  readonly label: string;
  private readonly stream: Readable;
  private readonly format: StreamFormat;
  private adapter: Adapter | null = null;
  private pending = '';

  constructor(stream: Readable, label = 'stdin', format: StreamFormat = 'auto') {
    this.stream = stream;
    this.label = label;
    this.key = `stream:${label}:${Date.now()}`;
    this.format = format;
  }

  async start(emit: (events: LucidlyEvent[]) => void): Promise<void> {
    this.stream.setEncoding('utf8');
    this.stream.on('data', (chunk: string) => {
      if (!this.adapter) {
        this.pending += chunk;
        const first = this.pending.split('\n').find((l) => l.trim());
        if (first === undefined || (!this.pending.includes('\n') && this.format === 'auto')) return;
        const json = this.format === 'json' || (this.format === 'auto' && first.trim().startsWith('{'));
        this.adapter = json ? new JsonLinesAdapter() : new TextAdapter();
        chunk = this.pending;
        this.pending = '';
      }
      const evs = this.adapter.push(chunk);
      if (evs.length) emit(evs);
    });
    this.stream.on('end', () => {
      if (!this.adapter && this.pending) {
        this.adapter = this.pending.trim().startsWith('{') ? new JsonLinesAdapter() : new TextAdapter();
        emit(this.adapter.push(this.pending));
      }
      const evs = this.adapter?.flush() ?? [];
      if (evs.length) emit(evs);
    });
  }

  stop(): void {
    this.stream.pause();
  }
}
