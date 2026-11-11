/**
 * A run's state in one word, for a session tab: the same reading as Glance's orb (web/app.js,
 * glanceState), worked out on the server so tabs that aren't open can show it too.
 */
import type { RunInfo, ViewNode } from './model.ts';

/**
 * work: the agent is working · you: it asked you something · bad: working, with failures nothing
 * has fixed yet · done: it finished recently · rest: it finished a while ago · quiet: it's said to
 * be working, but nothing has come for a while · paused: interrupted.
 */
export type RunState = 'work' | 'you' | 'bad' | 'done' | 'rest' | 'quiet' | 'paused';

export interface RunSummary {
  state: RunState;
  /** The question waiting on you, when state is 'you' (empty when it can't be quoted). */
  question?: string;
  /** Subagents still at work (a background one can outlive the agent's turn). */
  agents: number;
  updatedAt?: string;
}

/** Nothing new for this long: a run said to be working has gone quiet (as in the web UI). */
export const QUIET_MS = 5 * 60 * 1000;
/** A finished run stays 'done' (rather than 'rest') this long. */
const RECENT_MS = 30 * 60 * 1000;

type Nodes = ReadonlyMap<string, ViewNode> | Record<string, ViewNode>;

export function runSummary(run: RunInfo, nodes: Nodes, now = Date.now()): RunSummary {
  const get = (id: string | undefined): ViewNode | undefined =>
    id === undefined ? undefined : nodes instanceof Map ? nodes.get(id) : (nodes as Record<string, ViewNode>)[id];
  const kids = (n: ViewNode | undefined): ViewNode[] => (n?.children ?? []).map(get).filter((c): c is ViewNode => !!c);
  // Like the UI's descendants(): children, and inside subtasks, theirs.
  const below = (n: ViewNode | undefined, f: (c: ViewNode) => boolean, acc: ViewNode[] = []): ViewNode[] => {
    for (const c of kids(n)) {
      if (f(c)) acc.push(c);
      if (c.type === 'subtask') below(c, f, acc);
    }
    return acc;
  };
  const openIssue = (s: ViewNode): boolean =>
    below(s, (c) => c.type === 'blocker' && c.status === 'open').length > 0 || (s.stats?.errors ?? 0) - (s.stats?.recovered ?? 0) > 0;

  const age = run.updatedAt ? now - Date.parse(run.updatedAt) : Infinity;
  const stale = age > QUIET_MS;
  const all = nodes instanceof Map ? [...nodes.values()] : Object.values(nodes as Record<string, ViewNode>);
  const agents = stale ? 0 : all.filter((n) => n.type === 'subtask' && n.origin === 'subagent' && n.status === 'active').length;
  const out = (state: RunState, question?: string): RunSummary => ({ state, ...(question !== undefined ? { question } : {}), agents, updatedAt: run.updatedAt });

  const g = get(run.currentGoal) ?? get(run.goals[run.goals.length - 1]);
  if (run.status === 'working') {
    if (stale) return out('quiet');
    const step = get(run.currentStep);
    return out(step && openIssue(step) ? 'bad' : 'work');
  }
  if (g?.status === 'waiting') return out('paused');
  const ask = g ? below(g, (c) => c.type === 'activity' && c.kind === 'ask' && c.status === 'active')[0] : undefined;
  if (ask) return out('you', String(ask.title ?? '').replace(/^Ask:\s*/, ''));
  if (g?.asked) return out('you', g.question ?? '');
  return out(age < RECENT_MS ? 'done' : 'rest');
}

/** The states that want you: a tab you're not looking at flashes when it turns one of these. */
export const ATTENTION: ReadonlySet<RunState> = new Set(['you', 'bad', 'done']);
