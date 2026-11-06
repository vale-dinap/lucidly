#!/usr/bin/env node
/**
 * lucidly                     start the viewer; opens this project's session if there is an obvious one
 * lucidly <session-id|file>   open a specific Claude Code session (id prefix or .jsonl path)
 * agent | lucidly             view a piped stream (Claude stream-json or plain text)
 * lucidly --load run.lucidly.json
 * lucidly list [--all]        list recent sessions
 * lucidly outline <id|file>   print a text outline of a session
 * lucidly actions <id|file>   list every action in order (commands, edits, reads...)
 * lucidly commands <id|file>  list executed shell commands
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Engine } from './core/engine.ts';
import { actionList, outline } from './outline.ts';
import { LucidlyServer } from './server/server.ts';
import { RunSession } from './server/session.ts';
import { ClaudeSessionSource, LIVE_MS, findSession, listSessions } from './sources/claude-sessions.ts';
import { StreamSource, type StreamFormat } from './sources/stdin.ts';

interface Args {
  command: 'serve' | 'list' | 'outline' | 'actions' | 'commands' | 'help';
  target?: string;
  port: number;
  open: boolean;
  all: boolean;
  load?: string;
  cwd: string;
  format: StreamFormat;
  stdin: boolean;
  goals?: number;
  activities: boolean;
  kinds: string[];
  errors: boolean;
  full: boolean;
  grep?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: 'serve',
    port: Number(process.env.LUCIDLY_PORT ?? 4545),
    open: true,
    all: false,
    cwd: process.cwd(),
    format: 'auto',
    stdin: !process.stdin.isTTY,
    activities: false,
    kinds: [],
    errors: false,
    full: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === '--port' || x === '-p') a.port = Number(next());
    else if (x === '--no-open') a.open = false;
    else if (x === '--all') a.all = true;
    else if (x === '--load') a.load = next();
    else if (x === '--cwd') a.cwd = resolve(next());
    else if (x === '--text') a.format = 'text';
    else if (x === '--json') a.format = 'json';
    else if (x === '--no-stdin') a.stdin = false;
    else if (x === '--goals') a.goals = Number(next());
    else if (x === '--activities') a.activities = true;
    else if (x === '--kind') a.kinds.push(...next().split(','));
    else if (x === '--errors') a.errors = true;
    else if (x === '--full') a.full = true;
    else if (x === '--grep') a.grep = next();
    else if (x === '--help' || x === '-h') a.command = 'help';
    else if (x.startsWith('-')) throw new Error(`Unknown option ${x}`);
    else rest.push(x);
  }
  if (['list', 'outline', 'actions', 'commands', 'help'].includes(rest[0])) a.command = rest.shift() as Args['command'];
  a.target = rest[0];
  return a;
}

const HELP = `Lucidly — see what your AI agent is doing, at a glance.

Usage:
  lucidly [session]            Start the viewer. Without a session, it opens this folder's only
                               session, or the only live one; otherwise it lets you choose
  <agent> | lucidly            View a piped stream (Claude stream-json or plain text)
  lucidly --load <file>        Open a saved .lucidly.json run
  lucidly list [--all]         List recent Claude Code sessions
  lucidly outline <session>    Print a text outline of a session
  lucidly actions <session>    List every action in order (for debugging)
  lucidly commands <session>   List the shell commands that were executed

Options:
  -p, --port <n>     Port (default 4545, or next free)
  --no-open          Don't open the browser
  --cwd <dir>        Project folder whose sessions to show (default: current folder)
  --all              List sessions from all projects
  --text | --json    Force the format of piped input
  --goals <n>        outline: only the last n goals
  --activities       outline: include individual actions
  --kind <k,...>     actions: only these kinds (command, edit, write, read, search, web, agent, ask, other)
  --errors           actions: only failed ones
  --grep <text>      actions: only those mentioning text
  --full             actions: print full multi-line commands/inputs
`;

function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function resolveSession(target: string): Promise<string> {
  const path = target.endsWith('.jsonl') ? resolve(target) : await findSession(target);
  if (!path) throw new Error(`No Claude Code session matches "${target}"`);
  return path;
}

/** Build the full picture of a session or saved run, without serving it. */
async function loadEngine(target: string): Promise<Engine> {
  if (target.endsWith('.lucidly.json')) return RunSession.fromSave('x', JSON.parse(await readFile(target, 'utf8'))).engine;
  const e = new Engine();
  const src = new ClaudeSessionSource(await resolveSession(target), false);
  await src.start((evs) => e.applyAll(evs));
  return e;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (args.command === 'list') {
    const sessions = await listSessions({ cwd: args.all ? undefined : args.cwd, limit: 40 });
    if (!sessions.length) console.log(args.all ? 'No Claude Code sessions found.' : 'No sessions for this folder. Try: lucidly list --all');
    for (const s of sessions) {
      console.log(`${s.id.slice(0, 8)}  ${ago(s.mtime).padEnd(8)}  ${(s.title ?? s.firstPrompt ?? '').slice(0, 70)}${args.all ? `  [${s.cwd ?? s.project}]` : ''}`);
    }
    return;
  }

  if (args.command === 'actions' || args.command === 'commands') {
    if (!args.target) throw new Error(`${args.command} needs a session id or file`);
    const engine = await loadEngine(args.target);
    const kinds = args.command === 'commands' ? ['command'] : args.kinds;
    console.log(actionList(engine, { kinds, errorsOnly: args.errors, goals: args.goals, full: args.full, grep: args.grep }));
    return;
  }

  if (args.command === 'outline') {
    if (!args.target) throw new Error('outline needs a session id or file');
    const e = new Engine();
    if (args.target.endsWith('.lucidly.json')) {
      const run = RunSession.fromSave('x', JSON.parse(await readFile(args.target, 'utf8')));
      console.log(outline(run.engine, { goals: args.goals, activities: args.activities }));
      return;
    }
    const src = new ClaudeSessionSource(await resolveSession(args.target), false);
    await src.start((evs) => e.applyAll(evs));
    console.log(outline(e, { goals: args.goals, activities: args.activities }));
    return;
  }

  const server = new LucidlyServer({ port: args.port, cwd: args.cwd });
  await server.listen();
  let first: RunSession | undefined;

  if (args.load) {
    const data = JSON.parse(await readFile(args.load, 'utf8'));
    first = server.addRun((id) => RunSession.fromSave(id, data));
  }
  if (args.stdin && !args.target) {
    first = await server.open(new StreamSource(process.stdin, 'stdin', args.format));
  }
  if (args.target) {
    first = await server.open(new ClaudeSessionSource(await resolveSession(args.target)));
  } else if (!first) {
    const pick = await obviousSession(args.cwd);
    if (pick) first = await server.open(new ClaudeSessionSource(pick));
  }

  const url = server.url + (first ? `#run=${first.id}` : '');
  console.error(`Lucidly is running at ${url}`);
  console.error(first ? `Showing: ${first.engine.run.title ?? first.label}` : 'Choose a session in the browser.');
  console.error('Press Ctrl+C to stop.');
  if (args.open) openBrowser(url);

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/**
 * The session to open at startup, when there is no doubt which one is wanted: the folder's only
 * session, or the only one being written to (live). Otherwise none, and the page lets you choose.
 */
async function obviousSession(cwd: string): Promise<string | undefined> {
  const sessions = await listSessions({ cwd });
  if (sessions.length === 1) return sessions[0].path;
  const live = sessions.filter((s) => Date.now() - s.mtime < LIVE_MS);
  return live.length === 1 ? live[0].path : undefined;
}

main().catch((e) => {
  console.error(`lucidly: ${e?.message ?? e}`);
  process.exit(1);
});
