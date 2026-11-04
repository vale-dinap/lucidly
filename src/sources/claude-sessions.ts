/** Discover and follow Claude Code session transcripts under ~/.claude/projects. */
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readdir, stat, open, readFile } from 'node:fs/promises';
import { ClaudeCodeAdapter, cleanPrompt, harnessNotice } from '../adapters/claude-code.ts';
import type { LucidlyEvent } from '../core/events.ts';
import { truncate } from '../core/text.ts';
import { LineTailer } from './tail.ts';
import type { Source } from './source.ts';

export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function projectsDir(): string {
  return join(claudeDir(), 'projects');
}

/** Claude Code names a project folder after its cwd with every non-alphanumeric char replaced by '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SessionInfo {
  id: string;
  path: string;
  project: string;
  cwd?: string;
  title?: string;
  firstPrompt?: string;
  mtime: number;
  size: number;
}

async function readSlice(path: string, start: number, length: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Cheap metadata: read the head for cwd/first prompt and the tail for the latest title. */
export async function describeSession(path: string): Promise<SessionInfo> {
  const st = await stat(path);
  const info: SessionInfo = {
    id: basename(path, '.jsonl'),
    path,
    project: basename(join(path, '..')),
    mtime: st.mtimeMs,
    size: st.size,
  };
  const head = await readSlice(path, 0, Math.min(st.size, 256 * 1024));
  for (const line of head.split('\n')) {
    if (!line.startsWith('{')) continue;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!info.cwd && r.cwd) info.cwd = r.cwd;
    if (r.type === 'ai-title' && r.aiTitle) info.title = r.aiTitle;
    if (!info.firstPrompt && r.type === 'user' && !r.isMeta && !r.isSidechain) {
      const c = r.message?.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
      if (t && !harnessNotice(t)) {
        const p = cleanPrompt(t);
        if (p) info.firstPrompt = truncate(p, 140);
      }
    }
    if (info.cwd && info.firstPrompt && info.title) break;
  }
  if (st.size > 256 * 1024) {
    const tailLen = Math.min(st.size, 512 * 1024);
    const tail = await readSlice(path, st.size - tailLen, tailLen);
    const titles = [...tail.matchAll(/"aiTitle":"((?:[^"\\]|\\.)*)"/g)];
    if (titles.length) {
      try {
        info.title = JSON.parse(`"${titles[titles.length - 1][1]}"`);
      } catch {
        /* keep head title */
      }
    }
  }
  return info;
}

/** Recent sessions, newest first. With `cwd`, only that project's sessions. */
export async function listSessions(opts: { cwd?: string; limit?: number } = {}): Promise<SessionInfo[]> {
  const root = projectsDir();
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }
  if (opts.cwd) {
    const want = encodeCwd(opts.cwd).toLowerCase();
    projects = projects.filter((p) => p.toLowerCase() === want);
  }
  const files: { path: string; mtime: number }[] = [];
  for (const p of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(root, p));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(root, p, f);
      try {
        files.push({ path, mtime: (await stat(path)).mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionInfo[] = [];
  for (const f of files.slice(0, opts.limit ?? 30)) {
    try {
      out.push(await describeSession(f.path));
    } catch {
      /* unreadable */
    }
  }
  return out;
}

/** Resolve a session id (or id prefix) to its transcript path. */
export async function findSession(idOrPath: string): Promise<string | null> {
  if (idOrPath.endsWith('.jsonl')) return idOrPath;
  const root = projectsDir();
  let projects: string[] = [];
  try {
    projects = await readdir(root);
  } catch {
    return null;
  }
  for (const p of projects) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(root, p));
    } catch {
      continue;
    }
    const hit = entries.find((f) => f.endsWith('.jsonl') && f.startsWith(idOrPath));
    if (hit) return join(root, p, hit);
  }
  return null;
}

function parseLines(lines: string[], adapter: ClaudeCodeAdapter): LucidlyEvent[] {
  const out: LucidlyEvent[] = [];
  for (const l of lines) {
    if (!l.startsWith('{')) continue;
    try {
      out.push(...adapter.push(JSON.parse(l)));
    } catch {
      /* a corrupt line must not stop the stream */
    }
  }
  out.push(...adapter.flush());
  return out;
}

/** Text of a transcript record's user message (string or text blocks). */
function messageText(rec: any): string {
  const c = rec?.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.type === 'text' ? b.text : '')).join('');
  return '';
}

/** Reads the first complete line of a file (a subagent's first record is its task). */
async function firstLine(path: string): Promise<string | null> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(0, nl) : null;
  } finally {
    await fh.close();
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Follows one Claude Code session: the main transcript plus its subagent transcripts.
 *
 * A subagent's transcript is written live, but its `.meta.json` (which names the parent
 * Agent call) only appears when the subagent finishes. To show subagent work as it happens,
 * a new subagent file is linked to its parent call by matching its first prompt against
 * the `prompt` input of the Agent/Task calls seen in the main transcript.
 */
export class ClaudeSessionSource implements Source {
  readonly live: boolean;
  readonly key: string;
  label: string;
  private readonly path: string;
  private tailers: LineTailer[] = [];
  private subagents = new Set<string>();
  /** Agent/Task calls from the main transcript: tool_use id -> normalized prompt. */
  private agentCalls = new Map<string, string>();
  private claimed = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;
  private emit: (events: LucidlyEvent[]) => void = () => {};

  constructor(path: string, live = true) {
    this.path = path;
    this.key = `claude:${path.toLowerCase()}`;
    this.label = basename(path, '.jsonl');
    this.live = live;
  }

  async start(emit: (events: LucidlyEvent[]) => void): Promise<void> {
    this.emit = emit;
    const main = new ClaudeCodeAdapter();
    const t = new LineTailer(this.path, (lines) => {
      const spawned = this.noteAgentCalls(lines);
      const evs = parseLines(lines, main);
      if (evs.length) this.emit(evs);
      if (spawned && this.live) setTimeout(() => void this.scanSubagents(), 250);
    });
    this.tailers.push(t);
    await t.start(this.live);
    await this.scanSubagents();
    if (this.live) {
      this.timer = setInterval(() => void this.scanSubagents(), 1000);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.tailers) t.stop();
  }

  private noteAgentCalls(lines: string[]): boolean {
    let found = false;
    for (const line of lines) {
      if (!line.includes('"tool_use"') || !/"name":"(?:Agent|Task)"/.test(line)) continue;
      try {
        const rec = JSON.parse(line);
        for (const b of rec?.message?.content ?? []) {
          if (b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.input?.prompt === 'string') {
            this.agentCalls.set(b.id, norm(b.input.prompt));
            found = true;
          }
        }
      } catch {
        /* not a full record */
      }
    }
    return found;
  }

  private async parentOf(dir: string, f: string): Promise<string | undefined> {
    try {
      const meta = JSON.parse(await readFile(join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
      if (meta.toolUseId) return meta.toolUseId;
    } catch {
      /* meta not written yet: the subagent is still running */
    }
    try {
      const line = await firstLine(join(dir, f));
      if (!line) return undefined;
      const prompt = norm(messageText(JSON.parse(line)));
      if (!prompt) return undefined;
      const open = [...this.agentCalls].filter(([id]) => !this.claimed.has(id));
      const hit = open.find(([, p]) => p === prompt) ?? open.find(([, p]) => p.startsWith(prompt.slice(0, 200)) || prompt.startsWith(p.slice(0, 200)));
      return hit?.[0];
    } catch {
      return undefined;
    }
  }

  private async scanSubagents(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const dir = join(this.path.replace(/\.jsonl$/, ''), 'subagents');
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const f of entries.sort()) {
        if (!f.endsWith('.jsonl') || this.subagents.has(f)) continue;
        // Compaction runs replay the conversation to summarise it: not a subagent.
        if (f.startsWith('agent-acompact')) {
          this.subagents.add(f);
          continue;
        }
        const toolUseId = await this.parentOf(dir, f);
        if (!toolUseId) continue; // retry on the next scan
        this.subagents.add(f);
        this.claimed.add(toolUseId);
        const adapter = new ClaudeCodeAdapter(toolUseId);
        const t = new LineTailer(join(dir, f), (lines) => {
          const evs = parseLines(lines, adapter);
          if (evs.length) this.emit(evs);
        });
        this.tailers.push(t);
        await t.start(this.live);
      }
    } finally {
      this.scanning = false;
    }
  }
}
