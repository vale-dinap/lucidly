/** Knowledge about Claude Code's tools: kinds, short labels and raw renderings. */
import type { ActivityKind } from '../core/events.ts';
import { firstLine, truncate } from '../core/text.ts';

export interface ToolSummary {
  kind: ActivityKind;
  label: string;
  detail?: string;
  command?: string;
  files?: string[];
  spawnsAgent?: boolean;
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
