/**
 * Generic adapter for agents that only print plain text.
 * Line heuristics: prose paragraphs become narration (plans and intents are inferred by the engine),
 * shell-looking lines become command activities whose following lines are their output,
 * and error-looking lines mark failures.
 */
import type { ActivityKind, Adapter, LucidlyEvent } from '../core/events.ts';
import { truncate } from '../core/text.ts';
import { baseName } from './claude-tools.ts';

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const COMMAND = /^\s*(?:\$|>|PS[^>]*>|Running:?|Executing:?|Run:)\s+(.+)$/;
const FILE_OP = /^\s*(Reading|Read|Opening|Editing|Edited|Updating|Updated|Writing|Wrote|Creating|Created)\s+(?:file\s+)?[`'"]?([^\s`'"]+\.[A-Za-z0-9]{1,8})[`'"]?\s*$/i;
const ERROR = /^\s*(?:error\b|fatal\b|traceback\b|exception\b|panic\b|✗|✘|×\s|FAIL(?:ED)?\b|npm ERR!)|exit(?:ed with)? code [1-9]/i;
const PROMPT = /^\s*(?:user|you|human|prompt)\s*[:>]\s*(.+)$/i;

function fileKind(verb: string): ActivityKind {
  const v = verb.toLowerCase();
  if (v.startsWith('read') || v.startsWith('open')) return 'read';
  if (v.startsWith('writ') || v.startsWith('wrote') || v.startsWith('creat')) return 'write';
  return 'edit';
}

export class TextAdapter implements Adapter {
  readonly name = 'text';
  private buffer = '';
  private paragraph: string[] = [];
  private open: { callId: string; output: string[]; failed: boolean } | null = null;
  private n = 0;

  push(input: unknown): LucidlyEvent[] {
    this.buffer += String(input).replace(ANSI, '');
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    const out: LucidlyEvent[] = [];
    for (const l of lines) this.line(l, out);
    return out;
  }

  flush(): LucidlyEvent[] {
    const out: LucidlyEvent[] = [];
    if (this.buffer) this.line(this.buffer, out);
    this.buffer = '';
    this.flushParagraph(out);
    this.closeTool(out);
    out.push({ type: 'turn.end', ts: new Date().toISOString() });
    return out;
  }

  private line(raw: string, out: LucidlyEvent[]): void {
    const ts = new Date().toISOString();
    const line = raw.replace(/\s+$/, '');
    const prompt = PROMPT.exec(line);
    const cmd = COMMAND.exec(line);
    const file = FILE_OP.exec(line);
    if (prompt) {
      this.flushParagraph(out);
      this.closeTool(out);
      out.push({ type: 'user.prompt', text: prompt[1], ts, raw: line });
      return;
    }
    if (cmd) {
      this.flushParagraph(out);
      this.closeTool(out);
      const callId = `text-${++this.n}`;
      const command = cmd[1].trim();
      out.push({ type: 'tool.start', callId, tool: 'shell', kind: 'command', label: `$ ${truncate(command, 80)}`, command, ts, raw: line });
      this.open = { callId, output: [], failed: false };
      return;
    }
    if (file) {
      this.flushParagraph(out);
      this.closeTool(out);
      const callId = `text-${++this.n}`;
      const kind = fileKind(file[1]);
      const verb = kind === 'read' ? 'Read' : kind === 'write' ? 'Write' : 'Edit';
      out.push({ type: 'tool.start', callId, tool: 'file', kind, label: `${verb} ${baseName(file[2])}`, files: [file[2]], ts, raw: line });
      out.push({ type: 'tool.end', callId, ok: true, ts });
      return;
    }
    if (this.open) {
      // Command output continues until a blank line followed by prose, or the next action.
      if (line.trim() === '' && this.open.output.length > 0) {
        this.closeTool(out);
        return;
      }
      if (ERROR.test(line)) this.open.failed = true;
      this.open.output.push(raw);
      return;
    }
    if (line.trim() === '') {
      this.flushParagraph(out);
      return;
    }
    if (ERROR.test(line)) {
      this.flushParagraph(out);
      out.push({ type: 'notice', level: 'error', text: truncate(line.trim(), 160), ts, raw: line });
      return;
    }
    this.paragraph.push(line);
  }

  private flushParagraph(out: LucidlyEvent[]): void {
    if (!this.paragraph.length) return;
    out.push({ type: 'agent.text', text: this.paragraph.join('\n'), ts: new Date().toISOString() });
    this.paragraph = [];
  }

  private closeTool(out: LucidlyEvent[]): void {
    if (!this.open) return;
    out.push({ type: 'tool.end', callId: this.open.callId, ok: !this.open.failed, output: this.open.output.join('\n'), ts: new Date().toISOString() });
    this.open = null;
  }
}
