/** Plain-text rendering of a run, for terminals, debugging adapters and quick checks. */
import type { Engine } from './core/engine.ts';
import type { ActionRow } from './core/model.ts';

export interface ActionListOptions {
  kinds?: string[];
  errorsOnly?: boolean;
  /** Only the last n goals. */
  goals?: number;
  /** Print full multi-line inputs (e.g. to copy commands), not just the first line. */
  full?: boolean;
  /** Case-insensitive substring filter over label, command and step. */
  grep?: string;
}

export function filterActions(e: Engine, rows: ActionRow[], o: ActionListOptions): ActionRow[] {
  const goalIds = o.goals ? new Set(e.run.goals.slice(-o.goals)) : null;
  const q = o.grep?.toLowerCase();
  return rows.filter(
    (r) =>
      (!o.kinds?.length || o.kinds.includes(r.kind)) &&
      (!o.errorsOnly || r.status === 'failed') &&
      (!goalIds || (r.goalId && goalIds.has(r.goalId))) &&
      (!q || [r.title, r.command, r.step, r.input].some((s) => s?.toLowerCase().includes(q))),
  );
}

const time = (ts?: string) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '--:--:--');

/** Chronological action list for terminals: one line per action, grouped under its task. */
export function actionList(e: Engine, o: ActionListOptions = {}): string {
  const rows = filterActions(e, e.actions(o.full ? 1_000_000 : 4000), o);
  const out: string[] = [];
  let goal: string | undefined;
  for (const r of rows) {
    if (r.goalId !== goal) {
      goal = r.goalId;
      out.push(`\n■ ${r.goal ?? 'Session'}`);
    }
    const mark = r.status === 'failed' ? '✖' : r.status === 'active' ? '▶' : '✔';
    const what = r.command !== undefined ? `$ ${o.full ? r.command : (r.short ?? firstLineOf(r.command))}` : r.title;
    const where = [r.subagent ? `subagent: ${r.subagent}` : '', r.step ?? ''].filter(Boolean).join(' › ');
    out.push(`${time(r.startedAt)}  ${mark}  ${what}${r.retry ? '  (retry)' : ''}${where ? `    [${where}]` : ''}`);
    if (r.status === 'failed' && r.issue) out.push(`            └ ${r.issue}${r.recovered ? '  (recovered)' : ''}`);
  }
  const failed = rows.filter((r) => r.status === 'failed').length;
  const recovered = rows.filter((r) => r.status === 'failed' && r.recovered).length;
  out.push(`\n${rows.length} actions${failed - recovered ? `, ${failed - recovered} failed` : ''}${recovered ? `, ${recovered} recovered after failing` : ''}`);
  return out.join('\n').replace(/^\n/, '');
}

function firstLineOf(s: string): string {
  const lines = s.split('\n');
  return lines[0] + (lines.length > 1 ? ' …' : '');
}

const ICON: Record<string, string> = {
  done: '✔',
  active: '▶',
  pending: '○',
  failed: '✖',
  open: '⛔',
  resolved: '✓',
  waiting: '⏸',
};

export function outline(e: Engine, opts: { goals?: number; activities?: boolean } = {}): string {
  const out: string[] = [];
  const r = e.run;
  out.push(`${r.title ?? 'Run'} — ${r.agent ?? 'agent'} · ${r.status} · ${r.goals.length} goals · ${r.eventCount} events`);
  const show = (id: string, depth: number) => {
    const n = e.nodes.get(id);
    if (!n) return;
    const pad = '  '.repeat(depth);
    if (n.type === 'activity') {
      if (opts.activities) out.push(`${pad}${ICON[n.status] ?? '·'} ${n.title}${n.retry ? ' (retry)' : ''}${n.issue ? ` — ${n.issue}` : ''}`);
      return;
    }
    const stats = n.stats && n.type !== 'goal' ? `  [${n.stats.actions} actions${n.stats.errors ? `, ${n.stats.errors} errors` : ''}]` : '';
    const origin = n.origin && n.origin !== 'inferred' && n.origin !== 'plan' ? ` (${n.origin})` : '';
    out.push(`${pad}${ICON[n.status] ?? '·'} ${n.type === 'goal' ? 'GOAL ' : n.type === 'step' ? '' : n.type + ': '}${n.title}${origin}${stats}`);
    if (n.type === 'goal' && n.intent) out.push(`${pad}    intent: ${n.intent}`);
    for (const c of n.children) show(c, depth + 1);
    if (n.type === 'goal' && n.outcome) out.push(`${pad}    outcome: ${n.outcome}`);
  };
  const goals = opts.goals ? r.goals.slice(-opts.goals) : r.goals;
  for (const g of goals) show(g, 0);
  return out.join('\n');
}
