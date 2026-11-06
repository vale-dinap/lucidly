/** Knowledge about Claude Code's tools: kinds, short labels and raw renderings. */
import type { ActivityKind } from '../core/events.ts';
import { posix, win32 } from 'node:path';
import { firstLine, truncate } from '../core/text.ts';
import { shellWrites } from './shell-writes.ts';

export interface ToolSummary {
  kind: ActivityKind;
  label: string;
  detail?: string;
  command?: string;
  files?: string[];
  spawnsAgent?: boolean;
  /** Set on file changes made by a shell command rather than an edit tool. */
  via?: 'command';
  raw: string;
}

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function host(url: string): string {
  try {
    const u = new URL(url);
    return truncate(u.host + (u.pathname === '/' ? '' : u.pathname), 60);
  } catch {
    return truncate(url, 60);
  }
}

function pretty(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function mcpName(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const server = m[1].replace(/^claude_ai_/, '').replace(/[_-]+/g, ' ');
  return `${server} › ${m[2].replace(/_/g, ' ')}`;
}

/**
 * The part of a shell command worth showing: drops leading `cd dir &&`, `VAR=x;`,
 * `set -e;` style preambles so "cd /long/path && npm test" reads as "npm test".
 */
export function essentialCommand(cmd: string): string {
  let c = cmd.trim();
  const preamble = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)|set\s+-\S+|export\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*))\s*(?:&&|;|\n)\s*/;
  for (let i = 0; i < 5; i++) {
    const m = preamble.exec(c);
    if (!m || m[0].length >= c.length) break;
    c = c.slice(m[0].length);
  }
  return c;
}

export function summarizeTool(name: string, input: Input): ToolSummary {
  const file = str(input.file_path ?? input.notebook_path ?? input.path);
  switch (name) {
    case 'Read':
      return { kind: 'read', label: `Read ${baseName(file)}`, files: [file], raw: `Read ${file}` };
    case 'Write':
      return {
        kind: 'write',
        label: `Write ${baseName(file)}`,
        files: [file],
        raw: `Write ${file}\n\n${str(input.content)}`,
      };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : [input];
      const diff = edits
        .map((e) => {
          const oldS = str(e.old_string);
          const newS = str(e.new_string ?? e.new_source);
          return `${oldS.split('\n').map((l) => '- ' + l).join('\n')}\n${newS.split('\n').map((l) => '+ ' + l).join('\n')}`;
        })
        .join('\n\n');
      return { kind: 'edit', label: `Edit ${baseName(file)}`, files: [file], raw: `Edit ${file}\n\n${diff}` };
    }
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(input.command);
      const desc = str(input.description);
      const short = firstLine(essentialCommand(cmd), 80);
      return {
        kind: 'command',
        label: desc ? truncate(desc, 80) : `$ ${short}`,
        detail: `$ ${short}`,
        command: short,
        raw: `${name === 'PowerShell' ? 'PS>' : '$'} ${cmd}`,
      };
    }
    case 'Grep':
      return {
        kind: 'search',
        label: `Search “${truncate(str(input.pattern), 50)}”`,
        detail: str(input.path) || undefined,
        raw: pretty(input),
      };
    case 'Glob':
      return { kind: 'search', label: `Find ${truncate(str(input.pattern), 60)}`, raw: pretty(input) };
    case 'WebSearch':
      return { kind: 'web', label: `Web search: ${truncate(str(input.query), 60)}`, raw: pretty(input) };
    case 'WebFetch':
      return { kind: 'web', label: `Fetch ${host(str(input.url))}`, detail: str(input.prompt) || undefined, raw: pretty(input) };
    case 'Agent':
    case 'Task': {
      const desc = str(input.description) || str(input.subagent_type) || 'Subagent';
      return {
        kind: 'agent',
        label: `Subagent: ${truncate(desc, 70)}`,
        detail: str(input.subagent_type) || undefined,
        spawnsAgent: true,
        raw: str(input.prompt) || pretty(input),
      };
    }
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as Input[]) : [];
      const q = qs[0] ? str(qs[0].question) : 'Question';
      return { kind: 'ask', label: `Ask: ${truncate(q, 80)}`, raw: pretty(input) };
    }
    case 'Skill':
      return { kind: 'other', label: `Skill: ${str(input.skill)}`, raw: pretty(input) };
    case 'ToolSearch':
      return { kind: 'other', label: 'Load tools', detail: str(input.query), raw: pretty(input) };
    default: {
      return { kind: 'other', label: mcpName(name) ?? name, raw: pretty(input) };
    }
  }
}

/** Tools that express a plan rather than an action. */
export const PLANNING_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'ExitPlanMode']);

// ───────────────────────────── files changed through the shell
/**
 * Files the session has dealt with (read, edited, written), by normalized absolute path: a path
 * found inside a script counts as a written file only if it is one of these.
 */
export class KnownFiles {
  private byKey = new Map<string, string>();
  add(path: string): void {
    if (path) this.byKey.set(fileKey(path), path);
  }
  /** The known file a path names: the same file, or else the only one it is the tail of. */
  find(path: string, resolved: string): string | undefined {
    const exact = this.byKey.get(fileKey(resolved));
    if (exact) return exact;
    const tail = '/' + fileKey(path).replace(/^(?:\.\/)+/, '');
    const hits = [...this.byKey].filter(([k]) => k.endsWith(tail));
    return hits.length === 1 ? hits[0][1] : undefined;
  }
}

const fileKey = (p: string) => {
  const s = p.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s;
};

/** A path from a command, made absolute from the folder it ran in (Git Bash's /c/... included). */
export function resolveFrom(base: string | undefined, p: string): string {
  if (p.startsWith('~')) return p;
  const win = base ? /^[a-z]:[\\/]/i.test(base) : /^[a-z]:[\\/]/i.test(p);
  const fix = (x: string) => (win ? x.replace(/^\/([a-z])(?=\/|$)/i, (_, d: string) => `${d.toUpperCase()}:`) : x);
  const path = win ? win32 : posix;
  const q = fix(p);
  if (path.isAbsolute(q) || !base) return win ? path.normalize(q) : q;
  return path.resolve(fix(base), q);
}

/**
 * A shell command that changes files, as an edit made by a command: the files it writes or deletes
 * (resolved from `cwd`), labelled "Edit a.ts, b.ts (by command)". Undefined when it changes none.
 */
export function commandEdit(name: string, input: Input, s: ToolSummary, cwd: string | undefined, known: KnownFiles): ToolSummary | undefined {
  const files: string[] = [];
  const ops: string[] = [];
  for (const w of shellWrites(str(input.command), { powershell: name === 'PowerShell' })) {
    const dir = w.dir ? resolveFrom(cwd, w.dir) : cwd;
    const abs = resolveFrom(dir, w.path);
    const file = w.guessed ? known.find(w.path, abs) : abs;
    if (!file || files.some((f) => fileKey(f) === fileKey(file))) continue;
    files.push(file);
    ops.push(w.op);
  }
  if (!files.length) return undefined;
  const names = files.map(baseName);
  const list = (n: string[]) => (n.length > 3 ? `${n.slice(0, 3).join(', ')} and ${n.length - 3} more` : n.join(', '));
  let what: string;
  if (ops.every((o) => o === 'delete')) what = `Delete ${list(names)}`;
  else if (ops.every((o) => o === 'from' || o === 'to')) {
    // Moves and renames only: "Rename a.md → b.md", or how many files moved.
    const from = files.filter((_, i) => ops[i] === 'from');
    const to = files.filter((_, i) => ops[i] === 'to');
    const verb = new Set(files.map((f) => fileKey(f).replace(/[^/]*$/, ''))).size === 1 ? 'Rename' : 'Move';
    what = from.length === 1 && to.length === 1 ? `${verb} ${baseName(from[0])} → ${baseName(to[0])}` : `${verb} ${list(from.map(baseName))}`;
  } else what = `Edit ${list(names)}`;
  return { ...s, kind: 'edit', via: 'command', label: `${what} (by command)`, files };
}
