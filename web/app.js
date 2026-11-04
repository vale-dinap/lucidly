// Lucidly web UI. Plain ES module, no framework: state in, HTML strings out.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ───────────────────────────── icons (stroke paths, 24×24 grid)
const PATHS = {
  read: 'M4 4h11l5 5v11H4z M15 4v5h5 M8 13h8 M8 17h6',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  write: 'M4 4h11l5 5v11H4z M12 11v6 M9 14h6',
  command: 'M4 6l6 6-6 6 M12 18h8',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M16 16l4 4',
  web: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  agent: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
  ask: 'M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .8-1 1.6V14 M12 18h.01',
  user: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M4 20c1.5-4 4.5-5 8-5s6.5 1 8 5',
  other: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z',
  issue: 'M12 3l9 16H3z M12 10v4 M12 17h.01',
};
const SVG = (d, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const icon = (k) => `<span class="k">${SVG(PATHS[k] ?? PATHS.other)}</span>`;
const CHEV = SVG('M9 6l6 6-6 6', 'chev');
const CLOSE = SVG('M6 6l12 12M18 6L6 18');

// ───────────────────────────── state
const S = {
  runId: null,
  run: null,
  nodes: {},
  selected: null,
  follow: true,
  es: null,
  queued: false,
  lastFollowTarget: null,
  view: 'path', // 'path' | 'actions'
  // The path view's layout: 'simple' (tasks as nodes) or 'detailed' (cards with every step).
  layout: localStorage.getItem('lucidly.layout') === 'detailed' ? 'detailed' : 'simple',
  // path view
  openGoals: new Set(),
  closedGoals: new Set(),
  openSteps: new Set(),
  closedSteps: new Set(),
  allActs: new Set(), // units whose full action list is shown
  expandAll: false,
  pf: { mode: 'all', hideChat: false, q: '' },
  // File edits view: sort order, files opened, files showing their diffs inline.
  ff: { sort: 'recent', open: new Set(), diffs: new Set(), outside: false, layout: 'files', histDiffs: false },
  // detail panel
  raw: new Map(), // nodeId -> { chunks, stale, loading, at }
  openActs: new Set(),
  closedActs: new Set(),
  fullPre: new Set(),
  closedSecs: new Set(),
  // actions view
  actions: null,
  actionsStale: true,
  actionsLoading: false,
  actionsAt: 0,
  actionsLimit: 400,
  af: { kinds: new Set(), errors: 'all', q: '', goal: 'all' },
  stripRows: [],
  zoom: { a: 0, b: 1 },
  laneRows: [],
  pickerScope: 'project',
};
window.__lucidly = S; // debugging aid
const N = (id) => S.nodes[id];
const kids = (n) => (n?.children ?? []).map(N).filter(Boolean);
const isAct = (c) => c.type === 'activity' && c.kind !== 'user';

// ───────────────────────────── formatting
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function dur(a, b) {
  if (!a) return '';
  const ms = (b ? Date.parse(b) : Date.now()) - Date.parse(a);
  if (!(ms >= 0)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const base = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? p;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));
const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : '');
const firstOf = (s) => {
  const lines = String(s ?? '').split('\n');
  return lines[0] + (lines.length > 1 ? ' …' : '');
};
const stMark = (n) => (n.status === 'active' && S.run?.status !== 'idle' ? '<span class="spin"></span>' : n.status === 'failed' ? '✕' : n.status === 'active' ? '·' : '✓');

/** "claude-haiku-5-5" → "Haiku 5.5"; unknown ids pass through. */
function modelName(id) {
  const m = String(id ?? '');
  let x = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(m);
  if (x) return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? '.' + x[3] : ''}`;
  x = /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)/i.exec(m);
  if (x) return `${x[3][0].toUpperCase()}${x[3].slice(1)} ${x[1]}${x[2] ? '.' + x[2] : ''}`;
  return m;
}
/** 1234 → "1.2k", 5470752 → "5.5M". */
function tok(n) {
  n = n ?? 0;
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}
const freshIn = (u) => (u?.input ?? 0) + (u?.cacheWrite ?? 0);
const modelsLabel = (n) => (n?.models ?? []).map(modelName).join(' · ');
const usageLine = (u) => (u ? `${tok(freshIn(u))} in · ${tok(u.output)} out${u.cacheRead ? ` · ${tok(u.cacheRead)} cached` : ''}` : '');

/** Escapes text and highlights the path search term. */
function hl(text) {
  const s = esc(text);
  const q = S.pf.q.trim();
  if (!q) return s;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return s.replace(re, (m) => `<mark>${m}</mark>`);
}

/** Small, safe markdown subset: fences, headings, lists, paragraphs, `code`, **bold**. */
function md(src) {
  const parts = String(src).split('```');
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${esc(part.replace(/^[^\n]*\n/, ''))}</pre>`;
      const inline = (t) =>
        esc(t)
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      const out = [];
      let list = null;
      let para = [];
      const flushPara = () => {
        if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
        para = [];
      };
      const flushList = () => {
        if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`);
        list = null;
      };
      for (const line of part.split('\n')) {
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (h) {
          flushPara();
          flushList();
          out.push(`<h4>${inline(h[2])}</h4>`);
        } else if (li) {
          flushPara();
          const tag = li[1] ? 'ul' : 'ol';
          if (!list || list.tag !== tag) {
            flushList();
            list = { tag, items: [] };
          }
          list.items.push(li[3]);
        } else if (!line.trim()) {
          flushPara();
          flushList();
        } else if (list && /^\s{2,}/.test(line)) {
          list.items[list.items.length - 1] += ' ' + line.trim();
        } else {
          flushList();
          para.push(line);
        }
      }
      flushPara();
      flushList();
      return out.join('');
    })
    .join('');
}

// ───────────────────────────── derived info
const idNum = (id) => Number(String(id).slice(1));

function latestActivity(id) {
  let best = null;
  const visit = (n) => {
    for (const c of kids(n)) {
      if (isAct(c) && (!best || idNum(c.id) > idNum(best.id))) best = c;
      if (c.type === 'subtask' || c.type === 'step') visit(c);
    }
  };
  visit(N(id));
  return best;
}

function descendants(n, f, acc = []) {
  for (const c of kids(n)) {
    if (f(c)) acc.push(c);
    if (c.type === 'subtask') descendants(c, f, acc);
  }
  return acc;
}
const openBlockers = (n) => descendants(n, (c) => c.type === 'blocker' && c.status === 'open');
/** Failed actions nothing has succeeded after yet (in their step or subtask). */
const unresolvedOf = (n) => Math.max(0, (n?.stats?.errors ?? 0) - (n?.stats?.recovered ?? 0));
/** Needs a look: an open blocker, or failures not recovered. */
const hasOpenIssue = (s) => openBlockers(s).length > 0 || unresolvedOf(s) > 0;
/** Had trouble along the way, all of it got past. */
const hasRecovered = (s) => !hasOpenIssue(s) && ((s.stats?.recovered ?? 0) > 0 || descendants(s, (c) => c.type === 'blocker').length > 0);
const isUnresolved = (r) => r.status === 'failed' && !r.recovered;
const hasAgent = (s) => descendants(s, (c) => c.type === 'subtask' && c.origin === 'subagent').length > 0;
/** A question answered without doing anything. A task still in progress isn't one yet: it may be about to act. */
const isQA = (g) => g.status !== 'active' && !kids(g).some((c) => c.type === 'step') && !(g.stats?.actions > 0);

const isStale = () => !!S.run?.updatedAt && Date.now() - Date.parse(S.run.updatedAt) > 5 * 60 * 1000;
const liveEnd = (n) => n.endedAt ?? (isStale() || n.status !== 'active' ? S.run.updatedAt : undefined);

function runState() {
  const r = S.run;
  if (!r) return ['idle', 'No run'];
  const stale = isStale();
  if (r.status === 'working' && r.currentStep && N(r.currentStep) && openBlockers(N(r.currentStep)).length) return ['blocked', 'Blocked'];
  if (r.status === 'working') return stale ? ['idle', `Quiet · ${ago(r.updatedAt)}`] : ['working', 'Working'];
  // The agent finished its turn: nothing is running until the next message.
  if (r.status === 'waiting') return ['idle', `Idle · ${ago(r.updatedAt)}`];
  return ['idle', 'Idle'];
}

function followTarget() {
  const r = S.run;
  if (!r) return null;
  if (S.view === 'actions') {
    const rows = filteredActions();
    if (rows.length) return rows[rows.length - 1].id;
  }
  return r.currentUnit ?? r.currentStep ?? r.currentGoal ?? r.goals[r.goals.length - 1] ?? null;
}

function ancestors(id) {
  const out = [];
  let n = N(id);
  while (n) {
    out.push(n);
    n = n.parent ? N(n.parent) : null;
  }
  return out; // self first, goal last
}
const goalOf = (id) => ancestors(id).pop();

// ───────────────────────────── path: filters and open state
function pathQuery() {
  return S.pf.q.trim().toLowerCase();
}
const filtering = () => (S.layout !== 'simple' && S.pf.mode !== 'all') || !!pathQuery();

function stepText(s) {
  return [
    s.title,
    ...(s.context?.files ?? []),
    ...(s.context?.commands ?? []),
    ...descendants(s, (c) => c.type !== 'activity' || c.kind === 'user').map((c) => c.title),
    ...kids(s).filter(isAct).map((c) => c.title),
  ]
    .join('\n')
    .toLowerCase();
}

function stepMatches(s, q) {
  if (S.pf.mode === 'open' && !hasOpenIssue(s)) return false;
  if (S.pf.mode === 'recovered' && !hasRecovered(s)) return false;
  if (S.pf.mode === 'agents' && !hasAgent(s)) return false;
  return !q || stepText(s).includes(q);
}

function isGoalOpen(g) {
  if (S.openGoals.has(g.id)) return true;
  if (S.closedGoals.has(g.id)) return false;
  if (S.expandAll || filtering()) return true;
  return g.id === S.run.currentGoal || S.run.goals.length === 1;
}

function isStepOpen(s) {
  if (S.openSteps.has(s.id)) return true;
  if (S.closedSteps.has(s.id)) return false;
  if (S.expandAll) return true;
  const q = pathQuery();
  if (q && !s.title.toLowerCase().includes(q) && stepText(s).includes(q)) return true; // the match is inside
  return s.status === 'active' && s.id === S.run.currentStep;
}

// ───────────────────────────── overview
function renderOverview() {
  const goals = S.run.goals.map(N).filter(Boolean);
  const work = goals.filter((g) => !isQA(g));
  let steps = 0;
  let done = 0;
  for (const g of goals)
    for (const s of kids(g))
      if (s.type === 'step') {
        steps++;
        if (s.status === 'done') done++;
      }
  const rows = S.actions ? liveActions() : null;
  const nAct = rows ? rows.length : goals.reduce((a, g) => a + (g.stats?.actions ?? 0), 0);
  const nErr = rows ? rows.filter((r) => r.status === 'failed').length : goals.reduce((a, g) => a + (g.stats?.errors ?? 0), 0);
  const nUn = rows ? rows.filter(isUnresolved).length : goals.reduce((a, g) => a + unresolvedOf(g), 0);
  const qa = goals.length - work.length;
  const first = goals[0]?.startedAt;
  const stat = (n, label, cls = '') => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  const span = first ? `<div class="stat span">${esc(clock(first))} → ${S.run.status === 'working' && !isStale() ? 'now' : esc(clock(S.run.updatedAt))} · ${esc(dur(first, isStale() || S.run.status !== 'working' ? S.run.updatedAt : undefined))}</div>` : '';
  const working = S.run.status === 'working' && !isStale();
  setHTML($('#overview'), `<div class="ov${working ? ' working' : ''}">
    <div class="ov-stats">
      ${stat(work.length, work.length === 1 ? 'task' : 'tasks')}
      ${qa ? stat(qa, qa === 1 ? 'question' : 'questions') : ''}
      ${steps ? stat(`${done}/${steps}`, 'steps done') : ''}
      ${stat(nAct, nAct === 1 ? 'action' : 'actions')}
      ${nErr ? `<div class="stat${nUn ? ' bad' : ' calm'}" title="Failed: nothing has succeeded after them in their step yet. Recovered: something worked afterwards."><b>${nUn}</b><span>failed</span><small>${nErr - nUn} of ${nErr} failures recovered</small></div>` : stat(0, 'errors')}
      ${tokStat()}
      ${span}
    </div>
    ${rows && rows.length ? stripHtml(rows) : ''}
    ${laneHtml()}
  </div>`);
}

/** Writes HTML only when it changed: untouched parts keep their elements, hover and animations. */
function setHTML(el, html) {
  if (el.__html === html) return false;
  el.innerHTML = html;
  el.__html = html;
  return true;
}

/**
 * Pins every looping animation (glows, pulses, spinners) to the page clock, so an element
 * rebuilt by a live update continues the same beat instead of restarting from zero.
 */
function syncAnimations() {
  if (!document.getAnimations) return;
  for (const a of document.getAnimations()) {
    if (a.startTime !== 0 && a.effect?.getTiming?.().iterations === Infinity) a.startTime = 0;
  }
}

/** Tokens in the overview row too, where the eye already is (the top-bar meter is easy to miss). */
function tokStat() {
  const u = S.run?.usage;
  if (!u) return '';
  const rate = liveRate(u);
  return `<button class="stat tokstat" data-tokens title="Token usage: fresh input + output (cache reads not counted). Click for the breakdown (T)"><b>${tok(freshIn(u) + u.output)}</b><span>tokens</span><small>${tok(freshIn(u))} in · ${tok(u.output)} out${rate ? ` · ${tok(rate)}/min` : ''}</small></button>`;
}

// Tell the user when the server runs older engine code than the page it serves.
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    // A server without this route predates the page: it is outdated too.
    if (res.status === 404) $('#outdated').hidden = false;
    else if (res.ok) $('#outdated').hidden = !(await res.json()).outdated;
  } catch {
    // Server unreachable: the status pill already says so.
  }
}
setInterval(checkHealth, 30000);
addEventListener('load', checkHealth);

// ───────────────────────────── file edits: every change to every file, at a glance
/** Edits and writes grouped by file, with their totals. */
function fileEdits() {
  const map = new Map();
  for (const r of liveActions()) {
    if ((r.kind !== 'edit' && r.kind !== 'write') || !r.files?.length) continue;
    const key = relPath(r.files[0]);
    const id = key.toLowerCase();
    let e = map.get(id);
    if (!e) map.set(id, (e = { key, path: r.files[0], inside: !isAbsPath(key), edits: [], add: 0, del: 0, failed: 0, last: '' }));
    e.edits.push(r);
    if (r.status === 'failed') e.failed++;
    else if (r.diff) {
      e.add += r.diff.add;
      e.del += r.diff.del;
    }
    if ((r.startedAt ?? '') > e.last) e.last = r.startedAt ?? '';
  }
  return [...map.values()];
}

const isAbsPath = (p) => /^(?:[a-z]:)?[\\/]/i.test(p);
/** Long paths outside the project: keep the last two segments, the full path goes in the tooltip. */
const shortPath = (p) => {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
};

/** Where in the run a file's edits happened: one tick per edit along the run. */
function fileSpark(f, index, total) {
  const ticks = f.edits
    .map((r) => {
      const i = index.get(r.id);
      if (i === undefined) return '';
      const x = total > 1 ? (100 * i) / (total - 1) : 50;
      return `<rect x="${Math.min(99, x).toFixed(2)}" y="1" width="1" height="8" class="${r.status === 'failed' ? 'k-bad' : r.kind === 'write' ? 'k-w' : 'k-ok'}"/>`;
    })
    .join('');
  return `<svg class="fspark" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect x="0" y="4.5" width="100" height="1" class="k-base"/>${ticks}</svg>`;
}

function editDiff(r) {
  const chunks = rawFor(r.id);
  if (!chunks) return '<div class="loading">Loading the change…</div>';
  const c = chunks.find((x) => x.kind === 'tool' && x.node === r.id);
  const res = chunks.find((x) => x.kind === 'result' && x.node === r.id);
  return c ? inputHtml(c, N(r.id) ?? r, res) : '<div class="loading">No change recorded.</div>';
}

/** Every edit in time order, oldest first: the same file shows once per change. */
function historyHtml(files, ql) {
  const inside = files.filter((f) => f.inside);
  const outside = files.filter((f) => !f.inside);
  const showOut = S.ff.outside || (ql && !inside.length);
  const pick = showOut ? files : inside.length ? inside : files;
  const byId = new Map();
  for (const f of pick) for (const r of f.edits) byId.set(r.id, f);
  const edits = [...byId.keys()]
    .map((id) => ({ r: byId.get(id).edits.find((x) => x.id === id), f: byId.get(id) }))
    .sort((x, y) => ((x.r.startedAt ?? '') < (y.r.startedAt ?? '') ? -1 : (x.r.startedAt ?? '') > (y.r.startedAt ?? '') ? 1 : 0));
  if (!edits.length) return '<div class="no-match">No file or edit matches.</div>';
  let goal = null;
  const out = [];
  for (const { r, f } of edits) {
    if (r.goalId !== goal) {
      goal = r.goalId;
      out.push(`<div class="fh-goal"><span>${esc(clip(r.goal ?? 'Task', 110))}</span><span class="fago">${esc(clock(r.startedAt))}</span></div>`);
    }
    const shown = f.inside ? f.key : shortPath(f.key);
    const slash = shown.lastIndexOf('/');
    const dir = slash >= 0 ? shown.slice(0, slash + 1) : '';
    const base = shown.slice(slash + 1);
    const sel = S.selected === r.id ? ' sel' : '';
    out.push(`<div class="fe fe-hist${sel} s-${r.status}" data-fe="${r.id}" title="${esc(f.path)}">
      <span class="fe-t">${esc(clock(r.startedAt))}</span>
      <span class="fe-k">${r.kind === 'write' ? 'Write' : 'Edit'}</span>
      <span class="fe-m"><span class="fpath"><span class="fdir">${hl(dir)}</span><b>${hl(base)}</b></span>${r.subagent ? `<span class="tag agent">subagent</span>` : ''}${failBadge(r)}<span class="fe-where">${esc(clip(r.step ?? r.title, 80))}</span></span>
      <span class="fe-d">${diffStat(r)}</span>
      <span class="as">${stMark(r)}</span>
    </div>${S.ff.histDiffs ? `<div class="fe-diff">${editDiff(r)}</div>` : ''}`);
  }
  const outNote = outside.length && !showOut && inside.length
    ? `<button type="button" class="fgroup" data-foutside><span class="chev">${CHEV}</span>Include files outside the project <span class="n">${plural(outside.reduce((a, f) => a + f.edits.length, 0), 'edit')}</span></button>`
    : outside.length && S.ff.outside
      ? `<button type="button" class="fgroup" data-foutside><span class="chev open">${CHEV}</span>Hide files outside the project</button>`
      : '';
  return `<div class="fhist">${out.join('')}</div>${outNote}`;
}

function filesHtml(q) {
  if (!S.actions) return '<div class="loading">Loading edits…</div>';
  const allRows = S.allRows ?? S.stripRows;
  const index = new Map(allRows.map((r, i) => [r.id, i]));
  const total = allRows.length;
  const ql = q.trim().toLowerCase();
  let files = fileEdits();
  if (!files.length) return '<div class="no-match">No files have been edited in this run yet.</div>';
  if (ql) {
    files = files
      .map((f) => (f.key.toLowerCase().includes(ql) ? f : { ...f, edits: f.edits.filter((r) => [r.title, r.step, r.goal].some((x) => x && x.toLowerCase().includes(ql))) }))
      .filter((f) => f.edits.length);
  }
  const sorters = {
    recent: (a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0),
    most: (a, b) => b.edits.length - a.edits.length || b.add + b.del - (a.add + a.del),
    path: (a, b) => a.key.localeCompare(b.key),
  };
  files.sort(sorters[S.ff.sort] ?? sorters.recent);
  const proj = files.some((f) => f.inside) ? files.filter((f) => f.inside) : files;
  const E = proj.reduce((a, f) => a + f.edits.length, 0);
  const A = proj.reduce((a, f) => a + f.add, 0);
  const D = proj.reduce((a, f) => a + f.del, 0);
  const sorts = [['recent', 'Recent'], ['most', 'Most edited'], ['path', 'Path']]
    .map(([k, l]) => `<button type="button" data-fsort="${k}" class="${S.ff.sort === k ? 'on' : ''}">${l}</button>`)
    .join('');
  const layouts = [['files', 'By file'], ['history', 'History']]
    .map(([k, l]) => `<button type="button" data-flayout="${k}" class="${S.ff.layout === k ? 'on' : ''}">${l}</button>`)
    .join('');
  const hist = S.ff.layout === 'history';
  const right = hist
    ? `<button type="button" class="linkbtn" data-fhdiffs>${S.ff.histDiffs ? 'Hide diffs' : 'Show all diffs'}</button>`
    : `<span class="fsum-l">Sort</span><nav class="seg fsort">${sorts}</nav>`;
  const head = `<div class="fsum"><nav class="seg flayout">${layouts}</nav><span><b>${proj.length}</b> ${proj.length === 1 ? 'file' : 'files'}${proj !== files ? ' in the project' : ''} · <b>${E}</b> ${E === 1 ? 'edit' : 'edits'}</span>${diffBadge(D, A)}<span class="grow"></span>${right}</div>`;
  if (hist) return head + historyHtml(files, ql);
  const card = (f) => {
      const open = S.ff.open.has(f.key) || (ql && files.length <= 3);
      const shown = f.inside ? f.key : shortPath(f.key);
      const slash = shown.lastIndexOf('/');
      const dir = slash >= 0 ? shown.slice(0, slash + 1) : '';
      const base = shown.slice(slash + 1);
      const created = f.edits[0].kind === 'write';
      const inline = S.ff.diffs.has(f.key);
      const head = `<div class="fh${open ? ' open' : ''}" data-file="${esc(f.key)}" title="${esc(f.path)}">
        <span class="chev">${CHEV}</span>
        <span class="fpath"><span class="fdir">${hl(dir)}</span><b>${hl(base)}</b></span>
        ${created ? '<span class="ftag" title="The first change was a full write: probably created in this run">written</span>' : ''}
        ${f.failed ? `<span class="ftag bad" title="${plural(f.failed, 'edit')} failed to apply">${f.failed} failed</span>` : ''}
        <span class="grow"></span>
        ${fileSpark(f, index, total)}
        <span class="fcount">${plural(f.edits.length, 'edit')}</span>
        <span class="fdiff">${diffBadge(f.del, f.add)}</span>
        <span class="fago">${esc(ago(f.last))}</span>
      </div>`;
      if (!open) return `<div class="fcard">${head}</div>`;
      const rows = f.edits
        .map((r) => {
          const sel = S.selected === r.id ? ' sel' : '';
          const where = [r.goal, r.step].filter(Boolean).map((x) => esc(clip(x, 60))).join(' › ');
          return `<div class="fe${sel} s-${r.status}" data-fe="${r.id}">
            <span class="fe-t">${esc(clock(r.startedAt))}</span>
            <span class="fe-k">${r.kind === 'write' ? 'Write' : 'Edit'}</span>
            <span class="fe-m"><span class="fe-title">${hl(r.title)}</span>${r.subagent ? `<span class="tag agent">subagent</span>` : ''}${failBadge(r)}<span class="fe-where">${where}</span></span>
            <span class="fe-d">${diffStat(r)}</span>
            <span class="as">${stMark(r)}</span>
          </div>${inline ? `<div class="fe-diff">${editDiff(r)}</div>` : ''}`;
        })
        .join('');
      return `<div class="fcard open">${head}
        <div class="fbody">
          <div class="fbar"><span>History, oldest first</span><span class="grow"></span><button type="button" class="linkbtn" data-fdiffs="${esc(f.key)}">${inline ? 'Hide diffs' : 'Show all diffs'}</button></div>
          ${rows}
        </div></div>`;
  };
  const inside = files.filter((f) => f.inside);
  const outside = files.filter((f) => !f.inside);
  const showOut = S.ff.outside || (ql && !inside.length);
  const outHtml = outside.length
    ? `<button type="button" class="fgroup" data-foutside><span class="chev${showOut ? ' open' : ''}">${CHEV}</span>Outside the project <span class="n">${plural(outside.length, 'file')} · ${plural(outside.reduce((a, f) => a + f.edits.length, 0), 'edit')}</span><span class="fgroup-h">scratch files, notes, configs</span></button>${showOut ? outside.map(card).join('') : ''}`
    : '';
  return head + (inside.map(card).join('') + outHtml || '<div class="no-match">No file or edit matches.</div>');
}

// ───────────────────────────── subagent lane: its own timeline, open while it (or anything in it) is selected
/** The subagent the selection sits in (or is), if any. */
function openAgent() {
  if (!S.selected) return null;
  return ancestors(S.selected).find((n) => n.type === 'subtask' && n.origin === 'subagent') ?? null;
}

function laneHtml() {
  const ag = openAgent();
  if (!ag) {
    S.laneRows = [];
    S.laneShown = null;
    return '';
  }
  const acts = descendants(ag, isAct).sort((x, y) => ((x.startedAt ?? '') < (y.startedAt ?? '') ? -1 : 1));
  S.laneRows = acts;
  const n = acts.length;
  const B = Math.min(n, 360);
  const { unitPx: laneUnit, nowW: laneNow, total } = stripScale($('#overview .lane-strip')?.clientWidth || 700, B, ag.status === 'active');
  let rects = '';
  for (let i = 0; i < B; i++) {
    const a = Math.floor((i * n) / B);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / B));
    const seg = acts.slice(a, b);
    const bad = seg.some(isUnresolved);
    const rec = !bad && seg.some((r) => r.status === 'failed');
    const live = seg.some((r) => r.status === 'active');
    const sel = seg.some((r) => r.id === S.selected);
    const kind = seg.some((r) => r.kind === 'edit' || r.kind === 'write') ? 'ed' : seg.some((r) => r.kind === 'command') ? 'cmd' : 'etc';
    const cls = sel ? 'k-sel' : bad ? 'k-bad' : live ? 'k-live' : rec ? 'k-rec' : kind === 'ed' ? 'k-ed' : kind === 'cmd' ? 'k-ok' : 'k-rd';
    const h = bad || sel ? 8.5 : live ? 7.5 : rec ? 7 : kind === 'ed' ? 7.5 : kind === 'cmd' ? 5.5 : 3.5;
    const last = seg[seg.length - 1];
    const state = bad ? ' · failed' : rec ? ' · failed, then recovered' : live ? ' · running' : '';
    const tip = seg.length > 1 ? `${seg.length} actions · ${clock(seg[0].startedAt)}–${clock(last.startedAt)}${state}` : `${clock(last.startedAt)} · ${last.title}${state}`;
    rects += barShape(i, h, kind, cls, `data-lb="${b - 1}"`, tip, laneUnit);
  }
  const title = ag.title.replace(/^Subagent:\s*/, '');
  const un = unresolvedOf(ag);
  const rec = ag.stats?.recovered ?? 0;
  const meta = [
    ag.models?.length ? `<span class="model">${esc(modelsLabel(ag))}</span>` : '',
    `<span>${plural(n, 'action')}</span>`,
    ag.startedAt ? `<span>${esc(dur(ag.startedAt, ag.status === 'active' ? undefined : ag.endedAt ?? lastOf(acts)?.endedAt))}</span>` : '',
    ag.usage ? `<span>${esc(usageLine(ag.usage))}</span>` : '',
    un ? `<span class="bad">${un} failed</span>` : '',
    rec ? `<span>${rec} recovered</span>` : '',
  ].filter(Boolean).join('<i>·</i>');
  const status = ag.status === 'active' ? '<span class="now-dot"></span>running' : STATUS_LABEL[ag.status] ?? ag.status;
  const nowMark = laneNow ? nowRect(B, laneNow) : '';
  rects += nowMark;
  if (S.laneShown?.id !== ag.id) S.laneShown = { id: ag.id, at: Date.now() };
  const enter = Date.now() - S.laneShown.at < 250 ? ' enter' : '';
  return `<div class="lane${enter}${ag.status === 'active' ? ' working' : ''}" data-lane="${ag.id}">
    <div class="lane-h">
      <span class="lane-tag">Subagent</span>
      <button class="lane-t" data-lane-open="${ag.id}" title="Show this subagent's details">${esc(title)}</button>
      <span class="lane-st s-${ag.status}">${status}</span>
      <span class="grow"></span>
      <button class="ibtn" data-lane-close aria-label="Close the subagent timeline" title="Close">${CLOSE}</button>
    </div>
    <div class="lane-m">${meta}</div>
    ${n ? `<svg class="strip lane-strip" viewBox="0 0 ${total} 10" preserveAspectRatio="none" role="img" aria-label="Subagent activity">${rects}</svg>
    <div class="strip-axis"><span>${esc(clock(acts[0].startedAt))}</span><span></span><span>${esc(clock(acts[n - 1].startedAt))}</span></div>` : '<div class="lane-empty">No actions yet</div>'}
  </div>`;
}
const lastOf = (a) => a[a.length - 1];

// The strip always spans its full width: bars stretch to fill it and sit side by side, with a
// thin gap between them (at most BAR_GAP_PX, or the usual 28% of a slot on long runs).
const BAR_GAP_PX = 3;
/** Width (in slot units) and left edge of a bar filling slot `i`; `frac` is its share on long runs. */
function slotBar(i, unitPx, frac = 0.72) {
  const w = 1 - Math.min(1 - frac, BAR_GAP_PX / Math.max(1, unitPx));
  return [i + 0.5 - w / 2, w];
}

/**
 * Slot sizes for a strip of `slots` bars plus an optional live mark. On long runs the mark takes
 * one slot like a bar; on short ones bars stretch, so the mark keeps a slim fixed width instead.
 */
function stripScale(px, slots, live) {
  const NOW_PX = 6;
  let unitPx = px / Math.max(1, slots + (live ? 1 : 0));
  let nowW = live ? 1 : 0;
  if (live && slots && unitPx > NOW_PX * 1.5) {
    unitPx = (px - NOW_PX) / slots;
    nowW = NOW_PX / unitPx;
  }
  return { unitPx, nowW, total: slots + nowW };
}
const nowRect = (x, w) => `<rect x="${x + w * 0.1}" y="0" width="${w * 0.8}" height="8.5" class="k-now"><title>Working now</title></rect>`;

/** A strip bar; file edits get a pointed top (visible once zoomed in enough to be wide). */
function barShape(i, h, kind, cls, data, tip, unitPx = 8) {
  const [x0, bw] = slotBar(i, unitPx);
  const x1 = x0 + bw;
  let top = 8.5 - h;
  const title = `<title>${esc(tip)}</title>`;
  // The tip follows the bar's real width on screen: a gentle roof when wide, none when a bar
  // is only a couple of pixels (zoomed far out, where spikes would just look like noise).
  const wpx = bw * unitPx;
  // Zoomed far out the colour already sets edits apart: keep them only a little taller.
  if (kind === 'ed' && wpx < 3 && cls.startsWith('k-ed')) {
    h = 6;
    top = 8.5 - h;
  }
  if (kind !== 'ed' || wpx < 3) return `<rect x="${x0}" y="${top}" width="${bw}" height="${h}" class="${cls}" ${data}>${title}</rect>`;
  const cap = Math.min(1.6, h / 3, (Math.min(wpx, 16) * 0.5) / 2.6); // 2.6 px per vertical unit (26px / 10)
  // Wide bars (a short run stretched to fit) keep the same small roof at each corner.
  const run = wpx > 16 ? (8 / wpx) * bw : bw / 2;
  return `<polygon points="${x0},8.5 ${x0},${top + cap} ${x0 + run},${top} ${x1 - run},${top} ${x1},${top + cap} ${x1},8.5" class="${cls}" ${data}>${title}</polygon>`;
}

/** One thin bar per action (bucketed on long runs): green = done, red = failed, blue = running. */
function stripHtml(rows) {
  // One axis for everything, in time order: the main track draws the main agent's actions
  // (gaps are where it waited), the layers below draw each subagent across its own actions.
  S.allRows = rows;
  const n = rows.length;
  S.stripRows = rows;
  const [lo, hi] = zoomWindow(n);
  const zoomed = lo > 0 || hi < n;
  const span = hi - lo;
  const B = Math.min(span, 360);
  const stripPx = $('#overview .strip')?.clientWidth || ($('#overview').clientWidth || 800) - 34;
  // The current task's steps that haven't started yet: the work still ahead, in grey.
  const g = N(S.run.currentGoal);
  const pending = hi === n && g ? kids(g).filter((c) => c.type === 'step' && c.status === 'pending') : [];
  const P = Math.min(pending.length, 40);
  // While the agent works, a pulsing blue mark holds the live end of the run.
  const W = hi === n && S.run.status === 'working' && !isStale() ? 1 : 0;
  const { unitPx, nowW, total } = stripScale(stripPx, B + P, !!W);
  let rects = '';
  let lines = '';
  for (let i = 0; i < B; i++) {
    const a = lo + Math.floor((i * span) / B);
    const b = Math.max(a + 1, lo + Math.floor(((i + 1) * span) / B));
    const slice = rows.slice(a, b);
    if (i > 0 && slice.some((r, j) => (j ? slice[j - 1] : rows[a - 1]).goalId !== r.goalId)) lines += `<line x1="${i}" x2="${i}" y1="0" y2="10"/>`;
    const seg = slice.filter((r) => !r.subagentId);
    if (!seg.length) continue; // only subagents worked here: their layer shows it
    const lastMain = a + slice.lastIndexOf(seg[seg.length - 1]);
    const bad = seg.some(isUnresolved);
    const rec = !bad && seg.some((r) => r.status === 'failed');
    const live = seg.some((r) => r.status === 'active');
    const sel = seg.some((r) => r.id === S.selected);
    const sa = seg.some((r) => r.kind === 'agent');
    // What kind of work: file edits stand tallest with a pointed top, commands are plain bars,
    // reads, searches and the rest stay short, so the eye finds the changes.
    const kind = seg.some((r) => r.kind === 'edit' || r.kind === 'write') ? 'ed' : seg.some((r) => r.kind === 'command') ? 'cmd' : 'etc';
    const cls = `${sel ? 'k-sel' : bad ? 'k-bad' : live ? 'k-live' : rec ? 'k-rec' : sa ? 'k-sa' : kind === 'ed' ? 'k-ed' : kind === 'cmd' ? 'k-ok' : 'k-rd'} kk-${kind}`;
    const h = bad || sel ? 8.5 : live ? 7.5 : rec ? 7 : kind === 'ed' ? 7.5 : kind === 'cmd' ? 5.5 : 3.5;
    const last = seg[seg.length - 1];
    const state = bad ? ' · failed' : rec ? ' · failed, then recovered' : '';
    const nEd = seg.filter((r) => r.kind === 'edit' || r.kind === 'write').length;
    const nCmd = seg.filter((r) => r.kind === 'command').length;
    const mix = seg.length > 1 && (nEd || nCmd) ? ` (${[nEd ? plural(nEd, 'file edit') : '', nCmd ? plural(nCmd, 'command') : ''].filter(Boolean).join(', ')})` : '';
    const tip = seg.length > 1 ? `${seg.length} actions${mix} · ${clock(seg[0].startedAt)}–${clock(last.startedAt)}${state}` : `${clock(last.startedAt)} · ${last.subagent ? 'subagent · ' : ''}${last.title}${state}`;
    rects += barShape(i, h, kind, cls, `data-b="${lastMain}"`, tip, unitPx);
  }
  if (W) rects += nowRect(B, nowW);
  pending.slice(0, P).forEach((p, j) => {
    const [px, pw] = slotBar(B + nowW + j, unitPx);
    rects += `<rect x="${px}" y="3.5" width="${pw}" height="5" class="k-pend" data-pstep="${p.id}"><title>${esc(`Not started · ${p.title}`)}</title></rect>`;
  });
  if (P) lines += `<line x1="${B + nowW}" x2="${B + nowW}" y1="0" y2="10"/>`;
  const zctl = n > 20
    ? `<span class="zctl"><button data-zoom="out" title="Zoom out" ${zoomed ? '' : 'disabled'}>−</button><button data-zoom="in" title="Zoom in (scroll over the strip)" ${span <= minSpanCount(n) ? 'disabled' : ''}>+</button>${zoomed ? `<button data-zoom="fit" title="Show the whole run">Fit</button>` : ''}</span>`
    : '';
  const range = zoomed ? `<span class="zrange">actions ${lo + 1}–${hi} of ${n}</span>` : '';
  return `<svg class="strip" viewBox="0 0 ${total} 10" preserveAspectRatio="none" role="img" aria-label="Activity over the run">${rects}${lines}</svg>
    ${layersHtml(rows, lo, hi, B, total)}
    ${n > 20 ? navHtml(rows, lo, hi) : ''}
    <div class="strip-axis"><span>${esc(clock(rows[lo].startedAt))}</span>
      <span class="lg"><span><i class="lg-ed"></i>file edit</span><span><i style="background:var(--done)"></i>command</span><span><i class="lg-rd"></i>read, search, other</span><span><i class="lg-sa"></i>subagent</span><span><i style="background:var(--accent)"></i>running</span><span><i class="lg-rec"></i>recovered</span><span><i style="background:var(--bad)"></i>failed</span>${P ? '<span><i style="background:var(--border-strong)"></i>to do</span>' : ''}${range}${zctl}</span>
      <span>${esc(clock(rows[hi - 1].startedAt))}</span></div>`;
}

// ───────────────────────────── subagent layers (one box per subagent, from launch to finish)
/**
 * Subagents as boxes on their own track under the main one, on the same axis: a box spans
 * the main agent's actions from the launch to the finish, so parallel work shows as overlap.
 * Overlapping subagents stack on separate rows, like layers in a video editor.
 */
function layersHtml(rows, lo, hi, B, total) {
  const agents = Object.values(S.nodes).filter((n) => n.type === 'subtask' && n.origin === 'subagent' && n.startedAt);
  if (!agents.length) return '';
  const n = rows.length;
  const span = hi - lo;
  const pos = new Map(rows.map((r, i) => [r.id, i]));
  const live = S.run.status === 'working' && !isStale();
  const items = agents
    .filter((g) => pos.has(g.id))
    .map((g) => {
      const s0 = pos.get(g.id);
      const running = g.status === 'active' && live;
      // From the launch to its last action (to the live end while it runs).
      let e0 = s0;
      for (const a of descendants(g, isAct)) e0 = Math.max(e0, pos.get(a.id) ?? s0);
      if (running) e0 = n - 1;
      return { g, s0, e0, running };
    })
    .sort((x, y) => x.s0 - y.s0 || x.e0 - y.e0);
  // Stack only what is in view, and at most MAX rows: a burst of parallel subagents shares
  // the last row (marked "+N") instead of pushing the page down.
  const MAX = 4;
  const visible = items.filter((it) => it.e0 >= lo && it.s0 < hi);
  const ends = [];
  for (const it of visible) {
    let row = ends.findIndex((e) => e < it.s0);
    if (row < 0) row = ends.push(-1) - 1;
    ends[row] = it.e0;
    it.row = row;
  }
  const extra = visible.filter((it) => it.row >= MAX - 1);
  const capped = ends.length > MAX;
  if (capped) for (const it of extra) it.row = MAX - 1;
  const xOf = (j) => (100 * (((j - lo) * B) / span)) / total;
  const boxes = visible
    .map(({ g, s0, e0, row, running }) => {
      const left = Math.max(0, xOf(s0));
      const right = Math.min((100 * B) / total, xOf(e0 + 1));
      const acts = g.stats?.actions ?? 0;
      const un = unresolvedOf(g);
      const title = g.title.replace(/^Subagent:\s*/, '');
      const tip = [
        `Subagent · ${title}`,
        [g.models?.length ? modelsLabel(g) : '', plural(acts, 'action'), g.startedAt ? dur(g.startedAt, running ? undefined : g.endedAt) : '', un ? `${un} failed` : ''].filter(Boolean).join(' · '),
        running ? 'running' : `${clock(g.startedAt)}–${clock(g.endedAt)}`,
      ].join('\n');
      const sel = openAgent()?.id === g.id ? ' sel' : '';
      return `<button type="button" class="layer-box${running ? ' running' : ''}${un ? ' bad' : ''}${sel}" data-layer="${g.id}" style="left:${left}%;width:${Math.max(0, right - left)}%;top:${row * 17}px" title="${esc(tip)}"><span>${esc(title)}</span></button>`;
    })
    .join('');
  if (!visible.length) return '';
  const rowsN = Math.min(MAX, Math.max(1, ends.length));
  const more = capped
    ? `<span class="layer-more" style="top:${(MAX - 1) * 17}px;left:calc(${Math.min(94, Math.max(...extra.map((it) => xOf(it.e0 + 1))))}% + 4px)" title="${esc(`${extra.length} subagents overlap on this row:\n${extra.map((it) => it.g.title.replace(/^Subagent:\s*/, '')).join('\n')}`)}">+${extra.length}</span>`
    : '';
  return `<div class="layers" style="height:${rowsN * 17 - 2}px" aria-label="Subagents">${boxes}${more}</div>`;
}

// ───────────────────────────── strip zoom (a window over the run, like a video editor's zoom bar)
const minSpanCount = (n) => Math.min(n, 12);
/** The visible slice [lo, hi) of the actions, from the zoom window (fractions of the run). */
function zoomWindow(n) {
  const lo = Math.max(0, Math.min(n - 1, Math.floor(S.zoom.a * n)));
  const hi = Math.max(lo + Math.min(n, minSpanCount(n)), Math.min(n, Math.ceil(S.zoom.b * n)));
  return [lo, Math.min(n, hi)];
}

/** A mini map of the whole run with the visible window on it: drag it, or its edges. */
function navHtml(rows, lo, hi) {
  const n = rows.length;
  const M = Math.min(n, 240);
  let cells = '';
  for (let i = 0; i < M; i++) {
    const a = Math.floor((i * n) / M);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / M));
    const bad = rows.slice(a, b).some(isUnresolved);
    cells += `<rect x="${i}" y="0" width="1" height="1"${bad ? ' class="k-bad"' : ''}/>`;
  }
  const left = (100 * lo) / n;
  const width = (100 * (hi - lo)) / n;
  return `<div class="nav" data-nav title="Drag the window to pan, its edges to zoom · double-click to fit">
    <svg class="nav-mini" viewBox="0 0 ${M} 1" preserveAspectRatio="none">${cells}</svg>
    <div class="nav-win" style="left:${left}%;width:${width}%"><i class="nav-h" data-h="a"></i><i class="nav-h" data-h="b"></i></div>
  </div>`;
}

function setZoom(a, b) {
  S.zoom = { a: Math.max(0, Math.min(1, a)), b: Math.max(0, Math.min(1, b)) };
  if (S.zoom.b - S.zoom.a >= 0.999) S.zoom = { a: 0, b: 1 };
  if (S.run) renderOverview();
}
/** Zooms by factor k (<1 zooms in) around a point given as a fraction of the visible window. */
function zoomBy(k, at = 0.5) {
  const n = S.stripRows.length || 1;
  const min = minSpanCount(n) / n;
  const { a, b } = S.zoom;
  const span = b - a;
  const ns = Math.max(min, Math.min(1, span * k));
  const c = a + at * span;
  let na = c - at * ns;
  na = Math.max(0, Math.min(1 - ns, na));
  setZoom(na, na + ns);
}
function panBy(frac) {
  const { a, b } = S.zoom;
  const span = b - a;
  const na = Math.max(0, Math.min(1 - span, a + frac));
  setZoom(na, na + span);
}

// ───────────────────────────── path rendering
function nowLine(n) {
  if (n.status !== 'active') return '';
  const act = latestActivity(n.id);
  if (!act) return '';
  const running = act.status === 'active' && S.run.status !== 'idle';
  return `<div class="now${running ? '' : ' idle'}">${running ? '<span class="spin"></span>' : icon(act.kind ?? 'other')}<span>${esc(act.title)}</span></div>`;
}

function tagsHtml(ctx, max) {
  if (!ctx) return '';
  const files = [...new Set(ctx.files)];
  const items = [
    ...files.map((f) => `<span class="tag" title="${esc(f)}">${hl(base(f))}</span>`),
    ...ctx.commands.map((c) => `<span class="tag" title="${esc(c)}">$ ${hl(c)}</span>`),
  ];
  if (!items.length) return '';
  const more = items.length > max ? `<span class="tag more">+${items.length - max}</span>` : '';
  return `<div class="ctx">${items.slice(0, max).join('')}${more}</div>`;
}

function miniRow(a) {
  const sel = S.selected === a.id ? ' sel' : '';
  const d = a.endedAt ? dur(a.startedAt, a.endedAt) : '';
  return `<div class="mini-row s-${a.status}${sel}" data-select="${a.id}" data-node="${a.id}" title="${esc(a.issue ?? a.detail ?? a.title)}">
    ${icon(a.kind)}<span class="ml">${hl(a.title)}${a.retry ? '<span class="retry">retry</span>' : ''}</span>
    <span class="st-count">${esc(d)}</span><span class="ms">${stMark(a)}</span></div>`;
}

function branchHtml(n) {
  const sel = S.selected === n.id ? ' sel' : '';
  if (n.type === 'note' || n.kind === 'user') {
    const cls = n.kind === 'user' ? 'note you' : `note l-${n.level ?? 'info'}`;
    return `<div class="branch ${cls}${sel}" data-select="${n.id}" data-node="${n.id}">${n.kind === 'user' ? icon('user') : ''}<span class="bt">${hl(n.title)}</span></div>`;
  }
  let tag;
  let state = '';
  if (n.type === 'blocker') {
    tag = n.status === 'resolved' ? 'Resolved' : 'Blocker';
    state = n.detail ?? '';
  } else {
    tag = n.origin === 'subagent' ? 'Subagent' : 'Subtask';
    const a = n.stats?.actions ?? 0;
    state = n.status === 'active' ? 'running' : a ? plural(a, 'action') : '';
    if (n.origin === 'subagent' && n.models?.length) state = `${modelsLabel(n)}${state ? ' · ' + state : ''}`;
    if (n.stats?.errors) state += ` · ${plural(n.stats.errors, 'error')}`;
  }
  const title = n.origin === 'subagent' ? n.title.replace(/^Subagent:\s*/, '') : n.title;
  const row = `<div class="branch ${n.type} ${n.origin ?? ''} s-${n.status}${sel}" data-select="${n.id}" data-node="${n.id}">
    <span class="bk">${tag}</span><span class="bt" title="${esc(n.title)}">${hl(title)}</span><span class="bs">${esc(clip(state, 70))}</span></div>`;
  if (n.type !== 'subtask') return row;
  const inner = kids(n).filter((c) => c.type === 'subtask' || c.type === 'blocker' || c.type === 'note');
  const now = nowLine(n);
  return inner.length || now ? `<div>${row}<div class="nested">${now}${inner.map(branchHtml).join('')}</div></div>` : row;
}

/** A unit's children in order: actions as compact rows (latest few), everything else as branches. */
function childrenHtml(n) {
  const acts = kids(n).filter(isAct);
  const LIMIT = 5;
  const hide = S.allActs.has(n.id) ? 0 : Math.max(0, acts.length - LIMIT);
  const hidden = new Set(acts.slice(0, hide).map((a) => a.id));
  const out = [];
  let mini = [];
  const flush = () => {
    if (mini.length) out.push(`<div class="mini">${mini.join('')}</div>`);
    mini = [];
  };
  if (hide) out.push(`<button class="mini-more" data-allacts="${n.id}">Show ${plural(hide, 'earlier action')}</button>`);
  for (const c of kids(n)) {
    if (c.type === 'step') continue;
    if (isAct(c)) {
      if (!hidden.has(c.id)) mini.push(miniRow(c));
      continue;
    }
    flush();
    out.push(branchHtml(c));
  }
  flush();
  return out.join('');
}

function stepHtml(s) {
  const open = isStepOpen(s);
  const blockers = openBlockers(s);
  const errs = s.stats?.errors ?? 0;
  const subs = descendants(s, (c) => c.type === 'subtask');
  const nSa = subs.filter((c) => c.origin === 'subagent').length;
  const nSub = subs.length - nSa;
  const flags = [
    blockers.length
      ? `<span class="flag bad">Blocked</span>`
      : unresolvedOf(s)
        ? `<span class="flag bad" title="${plural(unresolvedOf(s), 'failed action')} nothing has succeeded after yet">${unresolvedOf(s)} ✕</span>`
        : '',
    !blockers.length && (s.stats?.recovered ?? 0)
      ? `<span class="flag rec" title="${plural(s.stats.recovered, 'failure')} along the way, recovered: something worked afterwards">↺ ${s.stats.recovered}</span>`
      : '',
    nSub ? `<span class="flag sub">${plural(nSub, 'subtask')}</span>` : '',
    nSa ? `<span class="flag sa">${plural(nSa, 'subagent')}</span>` : '',
  ].join('');
  const a = s.stats?.actions ?? 0;
  const hasBody = s.children.length > 0;
  const sel = S.selected === s.id ? ' sel' : '';
  const cls = `step s-${s.status}${s.tentative ? ' tentative' : ''}${open && hasBody ? ' open' : ''}${sel}`;
  let body = '';
  if (open && hasBody) body = `<div class="step-b">${unitInfo(s)}${tagsHtml(s.context, 10)}${childrenHtml(s)}</div>`;
  else if (blockers.length || s.status === 'active') body = `${nowLine(s)}${blockers.length ? `<div class="step-b">${blockers.map(branchHtml).join('')}</div>` : ''}`;
  return `<li class="${cls}">
    <div class="step-h${s.untracked ? ' untracked' : ''}" data-step="${s.id}" data-node="${s.id}" title="${esc(s.untracked ? `${s.title}
Done together with the other steps: the agent's work on it wasn't told apart.` : s.title)}">
      <span class="mk"></span><span class="st-title">${hl(s.title)}</span>
      <span class="flags">${s.untracked ? '<span class="flag untr">with the others</span>' : ''}${flags}</span><span class="st-count" title="${plural(a, 'action')}">${a || ''}</span>
      ${hasBody ? CHEV : '<span style="width:16px"></span>'}
    </div>${body}</li>`;
}

/** Models and tokens of a unit, shown when it is expanded. */
function unitInfo(n) {
  if (!n.usage) return '';
  return `<div class="uinfo">${(n.models ?? []).map((m) => `<span class="model">${esc(modelName(m))}</span>`).join('')}<span title="${esc(usageTitle(n.usage))}">${esc(usageLine(n.usage))}</span></div>`;
}
const usageTitle = (u) => `Fresh input ${u.input.toLocaleString()} · cache write ${u.cacheWrite.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · output ${u.output.toLocaleString()} · ${plural(u.responses, 'response')}`;

function segbarHtml(steps) {
  if (!steps.length) return '';
  return `<div class="segbar" title="${steps.filter((s) => s.status === 'done').length} of ${steps.length} steps done">${steps
    .map((s) => `<i class="s-${s.status}${openBlockers(s).length ? ' blk' : ''}" style="flex:${Math.max(1, Math.min(12, s.stats?.actions ?? 0))}"></i>`)
    .join('')}</div>`;
}

/**
 * What a task is heading for. The agent's intent line counts only when it reads as an aim for
 * the whole task, not as its first move (then it is just the first step's title); otherwise the
 * request itself is the target.
 */
function goalAim(g) {
  const norm = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
  const intent = norm(g.intent);
  const first = norm(kids(g).find((c) => c.type === 'step')?.title);
  const isFirstMove = !!first && (intent === first || intent.startsWith(first) || first.startsWith(intent));
  return g.intent && !isFirstMove && intent !== norm(g.title) ? g.intent : g.title;
}

function taskHtml(g, q) {
  if (!g) return '';
  const steps = kids(g).filter((c) => c.type === 'step');
  const qa = isQA(g);
  if (qa && S.pf.hideChat) return '';
  let shown = steps;
  if (filtering()) {
    if (qa && S.pf.mode !== 'all') return '';
    const gm = !!q && (g.title.toLowerCase().includes(q) || (g.intent ?? '').toLowerCase().includes(q));
    shown = steps.filter((s) => stepMatches(s, gm ? '' : q));
    if (!shown.length && !(gm && S.pf.mode === 'all')) return '';
  }
  const open = isGoalOpen(g);
  const done = steps.filter((s) => s.status === 'done').length;
  const a = g.stats?.actions ?? 0;
  const e = g.stats?.errors ?? 0;
  const meta = qa
    ? `<span>${esc(ago(g.startedAt))}</span>`
    : [
        steps.length ? `<span>${done}/${steps.length} steps</span>` : '',
        a ? `<span>${plural(a, 'action')}</span>` : '',
        unresolvedOf(g) ? `<span class="bad">${unresolvedOf(g)} failed</span>` : '',
        e - unresolvedOf(g) ? `<span title="Failures along the way that something worked after">${e - unresolvedOf(g)} recovered</span>` : '',
        g.startedAt ? `<span>${esc(dur(g.startedAt, liveEnd(g)))}</span>` : '',
        `<span>${esc(ago(g.startedAt))}</span>`,
      ].join('');
  const answer = qa && !open && g.outcome ? `<div class="task-answer">${esc(g.outcome)}</div>` : '';
  const cur = g.id === S.run.currentGoal;
  const sel = S.selected === g.id ? ' sel' : '';
  const head = `<div class="task-h" data-toggle="${g.id}" data-node="${g.id}">
      <span class="tstat${qa ? ' qa' : ''} s-${g.status}"></span>
      <div class="task-main"><div class="task-title">${hl(g.title)}</div><div class="task-meta">${meta}</div>${answer}</div>
      ${segbarHtml(steps)}${CHEV}
    </div>`;
  const cls = `task${open ? ' open' : ''}${cur ? ' current' : ''}${cur && S.run.status === 'working' && !isStale() ? ' working' : ''}${sel}`;
  if (!open) return `<section class="${cls}">${head}</section>`;

  const reached = !!g.outcome || g.status === 'done';
  // The end point names what the task is heading for; once reached, what came out of it.
  const aim = goalAim(g);
  const endText = g.outcome
    ? `<small>Result</small>${esc(clip(g.outcome, 360))}`
    : `<small>Goal${g.status === 'waiting' ? ' · interrupted' : g.status === 'done' ? ' · done' : ''}</small>${hl(clip(aim, 240))}`;
  const finish = (tag) => `<${tag} class="finish${reached ? ' reached' : ''}" data-select="${g.id}"><span class="mk"></span><div class="ft">${endText}</div></${tag}>`;
  if (qa) return `<section class="${cls}">${head}<div class="task-b">${finish('div')}</div></section>`;
  const own = filtering() ? '' : childrenHtml(g);
  return `<section class="${cls}">${head}
    <div class="task-b">
      ${g.usage ? `<div style="margin:0 0 8px 30px">${unitInfo(g)}</div>` : ''}
      ${own ? `<div class="step-b" style="margin-left:30px">${own}</div>` : ''}
      <ol class="steps">${shown.map(stepHtml).join('')}${finish('li')}</ol>
    </div></section>`;
}

// ───────────────────────────── simple view: tasks on a spine, each task's steps as a chain of nodes
/*
 * Built with keyed DOM updates rather than HTML strings: a node keeps its element for its whole
 * life, so it pops in once, changes colour smoothly when its status changes, and a chain keeps
 * its scroll position while the agent works.
 */
const GLYPH = {
  edit: PATHS.edit,
  command: PATHS.command,
  read: PATHS.read,
  agent: PATHS.agent,
  ask: PATHS.ask,
  start: PATHS.user,
  end: 'M6 21V4h11l-2.5 3.5L17 11H6',
  check: 'M5 12.5l4.5 4.5L19 7',
  pause: 'M9 6v12 M15 6v12',
  todo: '',
};
// One silhouette per kind of work, so the chain reads even without colour.
const SHAPE = {
  edit: '<path class="sh" d="M5 31V12.5L11 6h14l6 6.5V31z"/>',
  command: '<rect class="sh" x="3.5" y="8" width="29" height="20" rx="6"/>',
  read: '<circle class="sh" cx="18" cy="18" r="13"/>',
  agent: '<path class="sh" d="M18 4.5l12 7v13l-12 7-12-7v-13z"/>',
  ask: '<path class="sh" d="M6 7h24a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2H15l-6 5v-5H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>',
  todo: '<circle class="sh" cx="18" cy="18" r="11"/>',
  start: '<circle class="sh" cx="18" cy="18" r="13"/>',
  end: '<path class="sh" d="M18 4l14 14-14 14L4 18z"/>',
};
const KIND_LABEL = { edit: 'file edits', command: 'commands', read: 'reading and searching', agent: 'a subagent', ask: 'a question', todo: 'not started' };
const glyphSvg = (k) => (GLYPH[k] ? `<svg class="gl" viewBox="0 0 24 24" aria-hidden="true"><path d="${GLYPH[k]}"/></svg>` : '');

/** What a step mostly did: it sets the node's shape (and colour, once done). */
function stepKind(s) {
  const acts = descendants(s, isAct);
  if (!acts.length) return s.status === 'pending' || s.status === 'active' ? 'todo' : 'read';
  if (descendants(s, (c) => c.type === 'subtask' && c.origin === 'subagent').length) return 'agent';
  if (acts.some((a) => a.kind === 'edit' || a.kind === 'write')) return 'edit';
  if (acts.some((a) => a.kind === 'command')) return 'command';
  if (acts.some((a) => a.kind === 'ask')) return 'ask';
  return 'read';
}

const liveNow = () => S.run.status === 'working' && !isStale();

function stepState(s) {
  if (hasOpenIssue(s)) return 'bad';
  if (s.status === 'active') return liveNow() && s.id === S.run.currentStep ? 'live' : 'idle';
  if (s.status === 'done') return 'done';
  if (s.status === 'failed') return 'bad';
  return 'pend';
}

function flowOpen(g, q, hit) {
  if (S.openGoals.has(g.id)) return true;
  if (S.closedGoals.has(g.id)) return false;
  if (S.expandAll) return true;
  if (q) return hit;
  return g.id === S.run.currentGoal || S.run.goals.length === 1;
}

/** One chain node: its incoming connector, the shape, and a short label. */
function flowNode({ key, id, kind, st, label, tip, badge = '', extra = '' }) {
  // Start and end both stand for the task: only the one you clicked shows as selected.
  const sel = S.selected === id && (key.startsWith('s:') || key.startsWith('w:') || (S.flowPick ?? 'start') === key) ? ' sel' : '';
  return {
    key,
    st,
    cls: `fn k-${kind} st-${st}${sel}${extra}`,
    html: `<i class="fl"></i><button type="button" class="fn-s" data-fnode="${id}" data-node="${key.startsWith('s:') ? id : ''}" title="${esc(tip)}" aria-label="${esc(tip)}"><svg class="shp" viewBox="0 0 36 36" aria-hidden="true">${SHAPE[kind]}</svg>${glyphSvg(kind)}${badge}</button><span class="fn-l">${esc(label)}</span>`,
  };
}

function chainItems(g, q) {
  const steps = kids(g).filter((c) => c.type === 'step');
  const items = [
    flowNode({ key: 'start', id: g.id, kind: 'start', st: 'start', label: 'Request', tip: `You asked (${clock(g.startedAt)}): ${clip(g.title, 300)}`, extra: ' start' }),
  ];
  // A task with no steps but some work of its own: one node stands for that work.
  if (!steps.length && (g.stats?.actions ?? 0) > 0) {
    const kind = stepKind(g);
    const st = unresolvedOf(g) ? 'bad' : g.status === 'active' ? (liveNow() ? 'live' : 'idle') : 'done';
    items.push(flowNode({ key: `w:${g.id}`, id: g.id, kind, st, label: plural(g.stats.actions, 'action'), tip: `${plural(g.stats.actions, 'action')}, mostly ${KIND_LABEL[kind]}` }));
  }
  steps.forEach((s, i) => {
    const kind = stepKind(s);
    const st = stepState(s);
    const a = s.stats?.actions ?? 0;
    const rec = st !== 'bad' && hasRecovered(s);
    const dim = q && !stepMatches(s, q) ? ' dim' : '';
    const tip = [
      `${i + 1}. ${s.title}`,
      [a ? plural(a, 'action') : 'no actions yet', kind !== 'todo' ? `mostly ${KIND_LABEL[kind]}` : '', s.startedAt ? dur(s.startedAt, liveEnd(s)) : ''].filter(Boolean).join(' · '),
      st === 'bad' ? 'Failed: nothing has worked after it yet' : rec ? 'Failed along the way, then recovered' : s.untracked ? "Done with the others: its work wasn't told apart" : '',
    ].filter(Boolean).join('\n');
    const badge = (st === 'bad' ? '<span class="fn-b bad">!</span>' : rec ? '<span class="fn-b rec"></span>' : '') + (a > 1 ? `<span class="fn-n">${a > 99 ? '99+' : a}</span>` : '');
    items.push({ ...flowNode({ key: `s:${s.id}`, id: s.id, kind, st, label: s.title, tip, badge, extra: (s.untracked ? ' untr' : '') + dim }), i });
  });
  const reached = !!g.outcome || g.status === 'done';
  const st = reached ? 'done' : g.status === 'waiting' ? 'wait' : 'pend';
  const label = reached ? 'Done' : g.status === 'waiting' ? 'Interrupted' : 'Goal';
  const tip = g.outcome ? `Result: ${clip(g.outcome, 400)}` : `Goal: ${clip(goalAim(g), 300)}`;
  items.push(flowNode({ key: 'end', id: g.id, kind: 'end', st, label, tip, extra: ' end' }));
  items.forEach((it, i) => (it.i = i));
  return items;
}

/** Keyed update of a list of elements: reuse, reorder, add (with an entrance) and remove. */
function reconcile(parent, items, animate) {
  const old = new Map();
  for (const el of parent.children) old.set(el.dataset.key, el);
  let prev = null;
  for (const it of items) {
    let el = old.get(it.key);
    const fresh = !el;
    if (fresh) {
      el = document.createElement('div');
      el.dataset.key = it.key;
    } else old.delete(it.key);
    const turnedDone = !fresh && el.__st && el.__st !== it.st && it.st === 'done';
    if (el.__cls !== it.cls) {
      el.className = it.cls;
      el.__cls = it.cls;
    }
    el.__st = it.st;
    if (el.__html !== it.html) {
      el.innerHTML = it.html;
      el.__html = it.html;
    }
    if (it.i !== undefined) el.style.setProperty('--i', String(Math.min(it.i, 24)));
    if ((fresh && animate) || turnedDone) {
      const c = fresh ? 'enter' : 'just-done';
      el.classList.add(c);
      setTimeout(() => el.classList.remove(c), 900);
    }
    const next = prev ? prev.nextSibling : parent.firstChild;
    if (next !== el) parent.insertBefore(el, next);
    prev = el;
  }
  for (const el of old.values()) el.remove();
}

/** Keeps the working node of a live chain in view, unless you scrolled the chain yourself. */
function followChain(chain, instant) {
  const t = chain.querySelector('.fn.st-live, .fn.st-idle') ?? [...chain.querySelectorAll('.fn.st-done, .fn.st-bad')].pop();
  if (!t || chain.__user) return;
  const right = t.offsetLeft + t.offsetWidth + 110; // the live node, plus a peek at what comes next
  const left = t.offsetLeft - 120; // never under the pinned start node
  let x = chain.scrollLeft;
  if (right > x + chain.clientWidth) x = right - chain.clientWidth;
  if (left < x) x = Math.max(0, left);
  if (Math.abs(x - chain.scrollLeft) < 2) return;
  chain.__autoAt = Date.now();
  chain.scrollTo({ left: x, behavior: instant ? 'auto' : 'smooth' });
}

function chainEdges(chain) {
  const more = chain.scrollLeft + chain.clientWidth < chain.scrollWidth - 2;
  chain.parentElement.classList.toggle('more-r', more);
}

function flowGoalHead(g, qa) {
  const steps = kids(g).filter((c) => c.type === 'step');
  const done = steps.filter((s) => s.status === 'done').length;
  const live = g.id === S.run.currentGoal && g.status === 'active' && liveNow();
  const st = qa ? 'qa' : live ? 'live' : g.status === 'active' ? 'idle' : g.status === 'waiting' ? 'wait' : 'done';
  const glyph = qa ? glyphSvg('ask') : st === 'done' ? glyphSvg('check') : st === 'wait' ? glyphSvg('pause') : '';
  const un = unresolvedOf(g);
  const meta = qa
    ? `<span class="fg-ans">${esc(clip(g.outcome ?? '', 200))}</span>`
    : [
        steps.length ? `<span>${done}/${steps.length} steps</span>` : g.stats?.actions ? `<span>${plural(g.stats.actions, 'action')}</span>` : '',
        un ? `<span class="bad">${un} failed</span>` : '',
        g.startedAt ? `<span>${esc(dur(g.startedAt, liveEnd(g)))}</span>` : '',
        st === 'wait' ? '<span>interrupted</span>' : '',
        `<span>${esc(ago(g.startedAt))}</span>`,
      ].filter(Boolean).join('<i>·</i>');
  return {
    st,
    html: `<span class="fg-n st-${st}">${glyph}${un ? '<span class="fn-b bad">!</span>' : ''}</span>
      <span class="fg-t"><span class="fg-title">${hl(g.title)}</span><span class="fg-meta">${meta}</span></span>
      ${qa ? '' : CHEV}`,
  };
}

function renderFlow(view, goals, q) {
  if (!view.__flow) {
    view.innerHTML = '<div class="flow"></div>';
    view.__html = null;
    view.__flow = true;
    S.flowReady = false;
  }
  const root = view.firstChild;
  if (!goals.length) {
    root.innerHTML = '<div class="no-match">The run is open. Progress appears as soon as the agent does something.</div>';
    return;
  }
  root.querySelector(':scope > .no-match')?.remove();
  const animate = !!S.flowReady;
  const old = new Map();
  for (const el of root.children) old.set(el.dataset.key, el);
  let prev = null;
  for (const g of goals) {
    const qa = isQA(g);
    const hit = !q || g.title.toLowerCase().includes(q) || (g.intent ?? '').toLowerCase().includes(q) || kids(g).some((s) => s.type === 'step' && stepMatches(s, q));
    const open = !qa && flowOpen(g, q, hit);
    let row = old.get(g.id);
    const fresh = !row;
    if (fresh) {
      row = document.createElement('section');
      row.dataset.key = g.id;
      row.innerHTML = `<div class="fg-h" data-ftoggle="${g.id}" data-node="${g.id}"></div><div class="fg-b"><div class="fg-bi"><div class="chain"><div class="chain-in"></div></div></div></div>`;
      const chain = row.querySelector('.chain');
      chain.addEventListener(
        'scroll',
        () => {
          // Your own scroll pauses the auto-follow; scrolling back to the end resumes it.
          if (Date.now() - (chain.__autoAt ?? 0) > 700) chain.__user = chain.scrollLeft + chain.clientWidth < chain.scrollWidth - 30;
          chainEdges(chain);
        },
        { passive: true },
      );
      if (animate) {
        row.classList.add('enter');
        setTimeout(() => row.classList.remove('enter'), 900);
      }
    } else old.delete(g.id);
    const head = flowGoalHead(g, qa);
    const cur = g.id === S.run.currentGoal;
    const cls = `fg${open ? ' open' : ''}${qa ? ' qa' : ''}${cur ? ' cur' : ''} st-${head.st}${S.selected === g.id ? ' sel' : ''}${hit ? '' : ' dim'}`;
    const wasOpen = row.classList.contains('open');
    if (row.__cls !== cls) {
      row.className = cls;
      row.__cls = cls;
    }
    if (open && (fresh ? animate : !wasOpen)) {
      row.classList.add('opening');
      setTimeout(() => row.classList.remove('opening'), 900);
    }
    const h = row.firstChild;
    if (h.__html !== head.html) {
      h.innerHTML = head.html;
      h.__html = head.html;
    }
    const chain = row.querySelector('.chain');
    // A chain is built the first time it opens and kept (for the closing animation) afterwards.
    if (open) {
      const track = chain.firstChild;
      const first = !track.firstChild;
      reconcile(track, chainItems(g, q), animate && !first);
      if (cur) followChain(chain, first || !animate);
      requestAnimationFrame(() => chainEdges(chain));
    }
    const next = prev ? prev.nextSibling : root.firstChild;
    if (next !== row) root.insertBefore(row, next);
    prev = row;
  }
  for (const el of old.values()) el.remove();
  S.flowReady = true;
}

function renderPath() {
  const q = pathQuery();
  const goals = S.run.goals.map(N).filter(Boolean);
  let nOpen = 0;
  let nRec = 0;
  let nAgents = 0;
  for (const g of goals)
    for (const s of kids(g))
      if (s.type === 'step') {
        if (hasOpenIssue(s)) nOpen++;
        if (hasRecovered(s)) nRec++;
        if (hasAgent(s)) nAgents++;
      }
  const modes = [
    ['all', 'All', null, ''],
    ['open', 'Failed', nOpen, 'bad'],
    ['recovered', 'Recovered', nRec, ''],
    ['agents', 'Subagents', nAgents, ''],
    ['files', 'File edits', S.actions ? fileEdits().filter((f) => f.inside).length || fileEdits().length : 0, ''],
  ];
  $('#pathModes').innerHTML = modes
    .filter(([m, , n]) => m === 'all' || n || S.pf.mode === m)
    .map(([m, label, n, cls]) => `<button class="chip-f${S.pf.mode === m ? ' on' : ''} ${n ? cls : ''}" data-mode="${m}">${label}${n !== null ? ` <span class="n">${n}</span>` : ''}</button>`)
    .join('');
  const simple = S.layout === 'simple';
  $('#pathModes').hidden = simple;
  $('#hideChat').closest('.switch').hidden = simple;
  if (simple) {
    $('#expandAll').textContent = S.expandAll ? 'Collapse all' : 'Expand all';
    $('#pathSearch').placeholder = 'Search steps, files, commands';
    const view = $('#pathView');
    view.classList.remove('working');
    renderFlow(view, goals, q);
    return;
  }
  if ($('#pathView').__flow) {
    $('#pathView').__flow = false;
    $('#pathView').__html = null;
  }
  $('#hideChat').checked = S.pf.hideChat;
  // Always in place (a toolbar that reshuffles is hard to use); greyed out when it has nothing to do.
  const sw = $('#hideChat').closest('.switch');
  const nQA = goals.filter(isQA).length;
  // Always usable: a switch that locks itself is more confusing than one with nothing to do yet.
  $('#hideChat').disabled = false;
  sw.classList.remove('off');
  sw.title = S.pf.mode === 'files'
    ? 'Applies to the task list, not to File edits'
    : nQA
      ? `${S.pf.hideChat ? 'Hiding' : 'Hide'} ${plural(nQA, 'question')} answered without any work`
      : 'No questions answered without work in this run yet: nothing to hide for now';
  $('#expandAll').textContent = S.pf.mode === 'files' ? (S.ff.open.size ? 'Collapse all' : 'Expand all') : S.expandAll ? 'Collapse all' : 'Expand all';
  $('#pathSearch').placeholder = S.pf.mode === 'files' ? 'Filter files and edits' : 'Search steps, files, commands';
  if (S.pf.mode === 'files') {
    const view = $('#pathView');
    view.classList.remove('working');
    setHTML(view, filesHtml(q));
    return;
  }

  const html = goals.map((g) => taskHtml(g, q)).join('');
  const view = $('#pathView');
  view.classList.toggle('working', S.run.status === 'working' && !isStale());
  setHTML(
    view,
    html ||
    (goals.length
      ? '<div class="no-match">Nothing matches these filters.</div>'
      : '<div class="no-match">The run is open. Progress appears as soon as the agent does something.</div>'),
  );
}

/** Tokens per minute over the last hour, as a tiny bar chart. */
function rateChart(u) {
  const now = Math.floor(Date.now() / 60000);
  const end = isStale() ? Math.floor(Date.parse(u.lastAt ?? S.run.updatedAt) / 60000) : now;
  const M = 60;
  const vals = new Array(M).fill(0);
  for (const [m, v] of u.perMinute) if (m > end - M && m <= end) vals[M - 1 - (end - m)] = v;
  const max = Math.max(...vals, 1);
  const bars = vals.map((v, i) => (v ? `<rect x="${i + 0.12}" y="${20 - (18 * v) / max}" width="0.76" height="${(18 * v) / max}"><title>${tok(v)} tokens</title></rect>` : '')).join('');
  return `<svg class="rate" viewBox="0 0 ${M} 20" preserveAspectRatio="none">${bars}<line x1="0" x2="${M}" y1="20" y2="20"/></svg>
    <div class="rate-axis"><span>${isStale() ? 'last hour of activity' : '60 min ago'}</span><span>peak ${tok(max)}/min</span><span>${isStale() ? clock(u.lastAt) : 'now'}</span></div>`;
}

/** Average tokens per minute over the last 5 minutes, while the run is live. */
function liveRate(u) {
  if (isStale() || !u?.perMinute.length) return 0;
  const now = Math.floor(Date.now() / 60000);
  const recent = u.perMinute.filter(([m]) => m > now - 5);
  return recent.length ? Math.round(recent.reduce((a, [, v]) => a + v, 0) / 5) : 0;
}

function renderTokens() {
  const u = S.run?.usage;
  const btn = $('#tokens');
  btn.hidden = !u;
  if (!u) {
    $('#tokensPop').hidden = true;
    return;
  }
  const rate = liveRate(u);
  btn.innerHTML = `${SVG('M4 7h16M4 12h10M4 17h6')}<span><b>${tok(freshIn(u))}</b> in</span><span><b>${tok(u.output)}</b> out</span>${
    u.context ? `<span class="ctxn" title="Context size of the main agent's latest response">ctx <b>${tok(u.context)}</b></span>` : ''
  }${rate ? `<span class="live">${tok(rate)}/min</span>` : ''}`;
  const pop = $('#tokensPop');
  if (pop.hidden) return;
  const models = Object.entries(u.byModel).sort((a, b) => freshIn(b[1]) + b[1].output - (freshIn(a[1]) + a[1].output));
  const totalWork = freshIn(u) + u.output || 1;
  const row = (label, x, share) => `<tr><td>${label}</td><td>${x.responses}</td><td>${tok(freshIn(x))}</td><td>${tok(x.cacheRead)}</td><td>${tok(x.output)}</td><td class="sh"><i style="width:${Math.max(2, Math.round(share * 100))}%"></i></td></tr>`;
  pop.innerHTML = `<div class="pop-h">Token usage<span>${plural(u.responses, 'response')}</span></div>
    <div class="pop-tot">
      <div><b>${tok(freshIn(u))}</b><span>input</span><small>${tok(u.input)} fresh + ${tok(u.cacheWrite)} cache write</small></div>
      <div><b>${tok(u.output)}</b><span>output</span></div>
      <div><b>${tok(u.cacheRead)}</b><span>cache reads</span><small>billed at a fraction of input</small></div>
      ${u.context ? `<div><b>${tok(u.context)}</b><span>context now</span><small>${esc(modelName(u.contextModel))}, main agent</small></div>` : ''}
    </div>
    <table class="pop-t"><thead><tr><th>Model</th><th>Resp.</th><th>In</th><th>Cached</th><th>Out</th><th></th></tr></thead>
      <tbody>${models.map(([m, x]) => row(esc(modelName(m)), x, (freshIn(x) + x.output) / totalWork)).join('')}</tbody></table>
    <div class="pop-sec">Tokens per minute <small>(input + cache write + output)</small></div>
    ${rateChart(u)}
    <div class="pop-note">As reported in the agent's transcripts, subagents included. Shares are by input + output.</div>`;
}

function renderHeader() {
  const r = S.run;
  $('#runTitle').textContent = r ? (r.title ?? r.cwd ?? 'Untitled run') : 'No run open';
  $('#runSub').textContent = r ? [r.cwd, r.updatedAt ? `updated ${ago(r.updatedAt)}` : ''].filter(Boolean).join(' · ') : '';
  document.title = r?.title ? `${r.title} · Lucidly` : 'Lucidly';
  const [st, text] = runState();
  $('#status').dataset.status = st;
  $('#statusText').textContent = text;
  $('#status').hidden = !r;
  const save = $('#saveBtn');
  if (S.runId) {
    save.href = `/api/s/${S.runId}/save`;
    save.setAttribute('download', '');
    save.removeAttribute('aria-disabled');
  } else {
    save.removeAttribute('href');
    save.setAttribute('aria-disabled', 'true');
  }
  renderTokens();
  const shown = S.view === 'actions' ? 'actions' : S.layout;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === shown);
}

// ───────────────────────────── detail panel
function rawFor(id) {
  const n = N(id);
  let entry = S.raw.get(id);
  if (!entry) {
    entry = { chunks: null, stale: true, loading: false, at: 0 };
    S.raw.set(id, entry);
  }
  if (entry.stale && !entry.loading) {
    const wait = Math.max(0, 700 - (Date.now() - entry.at));
    entry.loading = true;
    setTimeout(async () => {
      try {
        const own = n?.type === 'goal' ? '?own=1' : '';
        const res = await fetch(`/api/s/${S.runId}/raw/${id}${own}`);
        if (res.ok) {
          entry.chunks = (await res.json()).chunks;
          entry.stale = false;
        }
      } finally {
        entry.loading = false;
        entry.at = Date.now();
        if (S.selected === id) renderDetail();
        if (S.view === 'path' && S.pf.mode === 'files') schedule();
      }
    }, entry.chunks ? wait : 0);
  }
  return entry.chunks;
}

function invalidateRaw(id) {
  for (const n of ancestors(id)) {
    const e = S.raw.get(n.id);
    if (e) e.stale = true;
  }
}

/**
 * Colours diff lines: an edit's "- old" / "+ new" lines (mode 'edit'), or a unified diff
 * (git diff output, patches) wherever it is recognised.
 */
const UNIFIED = /^(?:diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- a\/|\+\+\+ b\/)/m;
function diffHtml(text, mode) {
  if (mode === 'shell' || mode === 'python') return highlight(text, mode);
  const unified = mode !== 'edit' && UNIFIED.test(text);
  if (mode !== 'edit' && !unified) return esc(text);
  return String(text)
    .split('\n')
    .map((l) => {
      let cls = '';
      if (mode === 'edit') cls = l.startsWith('- ') ? 'del' : l.startsWith('+ ') ? 'add' : '';
      else if (/^(?:diff --git |index |--- |\+\+\+ )/.test(l)) cls = 'dh';
      else if (l.startsWith('@@')) cls = 'hunk';
      else if (l.startsWith('+')) cls = 'add';
      else if (l.startsWith('-')) cls = 'del';
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    })
    .join('\n');
}

function preBlock(key, label, text, cls = '', mode = 'auto') {
  const lines = String(text ?? '').split('\n');
  const LIMIT = 16;
  const full = S.fullPre.has(key) || lines.length <= LIMIT;
  const shown = full ? text : lines.slice(0, LIMIT).join('\n');
  const body = cls.includes('failed') ? esc(shown) : diffHtml(shown, mode);
  return `<div class="pl">${esc(label)}</div><pre class="${cls}">${body}</pre>${
    full ? '' : `<button class="show-all" data-full="${esc(key)}">Show all ${lines.length} lines</button>`
  }`;
}

function scopeOf(nodeId, rootId) {
  // nearest subtask/blocker between the chunk's node and the selected root
  let found = null;
  for (const n of ancestors(nodeId)) {
    if (n.id === rootId) break;
    if (n.type === 'subtask' || n.type === 'blocker') found = n;
  }
  return found;
}

// ───────────────────────────── syntax highlighting (shell + Python, dependency-free)
const PY_KW = new Set(
  'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '),
);
const PY_BI = new Set(
  'print len range open str int float bool list dict set tuple enumerate zip map filter sorted sum min max abs any all isinstance type super self cls repr round iter next getattr setattr hasattr Exception ValueError TypeError KeyError'.split(' '),
);
const SH_KW = new Set('if then else elif fi for while until do done case esac in function return export local readonly unset select time'.split(' '));
/** Keywords followed by a command, and wrappers whose next word is the real command. */
const SH_THEN_CMD = new Set('if then else elif while until do time'.split(' '));
const SH_WRAP = new Set('timeout sudo env nohup xargs nice exec command builtin'.split(' '));
const SH_BI = new Set('cd echo printf exit set source eval exec test read shift trap wait true false'.split(' '));
const span = (cls, text) => `<span class="tk-${cls}">${esc(text)}</span>`;

/** Python: comments, strings (incl. triple-quoted, f/r/b prefixes), numbers, keywords, builtins, defs, decorators. */
function hlPython(code) {
  const re =
    /(#[^\n]*)|((?:[rRbBuUfF]{1,2})?(?:'''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?))|(\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(@[\w.]+)|([A-Za-z_]\w*)/g;
  let out = '';
  let last = 0;
  let prev = '';
  for (let m; (m = re.exec(code)); ) {
    out += esc(code.slice(last, m.index));
    last = re.lastIndex;
    const [t, com, str, num, deco, word] = m;
    if (com) out += span('c', t);
    else if (str) out += span('s', t);
    else if (num) out += span('n', t);
    else if (deco) out += span('f', t);
    else if (word) {
      if (prev === 'def' || prev === 'class') out += span('f', t);
      else if (PY_KW.has(t)) out += span('k', t);
      else if (PY_BI.has(t)) out += span('b', t);
      else out += esc(t);
      prev = t;
      continue;
    }
    prev = '';
  }
  return out + esc(code.slice(last));
}

/**
 * Shell (bash / PowerShell): command names, flags, strings, $variables, comments, operators.
 * Python heredocs (`python - <<'EOF'`) and long `python -c "…"` strings are highlighted as Python.
 */
function hlShell(code) {
  const lines = String(code).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(hlShellLine(line));
    const hd = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
    if (!hd) continue;
    // heredoc body: until the terminator line
    const body = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== hd[2]) body.push(lines[j++]);
    const isPy = /\bpython[\d.]*(?:\.exe)?\b|\bpy\b/.test(line.slice(0, hd.index));
    if (body.length) out.push(isPy ? hlPython(body.join('\n')) : span('s', body.join('\n')));
    if (j < lines.length) out.push(span('k', lines[j]));
    i = j;
  }
  return out.join('\n');
}

function hlShellLine(line) {
  const re =
    /(\s#[^\n]*|^#[^\n]*)|('[^']*'?|"(?:\\.|[^"\\])*"?)|(\$\{[^}]*\}|\$\(|\$[A-Za-z_]\w*|\$[@#?$!*0-9]|%[A-Za-z_]\w*%)|(&&|\|\||[|;&]|>>|2>&1|[<>])|((?<=^|\s)--?[A-Za-z][\w-]*)|(\b\d+\b)|([^\s'"$|;&<>()#]+)/g;
  let out = '';
  let last = 0;
  let expectCmd = true;
  let cmd = '';
  for (let m; (m = re.exec(line)); ) {
    out += esc(line.slice(last, m.index));
    last = re.lastIndex;
    const [t, com, str, v, op, flag, num, word] = m;
    if (com) out += span('c', t);
    else if (str) {
      const inner = t.slice(1, t.endsWith(t[0]) && t.length > 1 ? -1 : undefined);
      // python -c "…": show the code as Python
      if (/^python|^py$/.test(cmd) && inner.length > 12) out += span('s', t[0]) + hlPython(inner) + (t.length > 1 && t.endsWith(t[0]) ? span('s', t[0]) : '');
      else out += span('s', t);
      expectCmd = false;
    } else if (v) {
      out += span('v', t);
      if (t === '$(') expectCmd = true;
    } else if (op) {
      out += span('o', t);
      expectCmd = /^(?:&&|\|\||[|;&])$/.test(t);
    } else if (flag) out += span('fl', t);
    else if (num) out += span('n', t);
    else if (word || num) {
      if (/^[A-Za-z_]\w*=/.test(t) && expectCmd) out += span('v', t.slice(0, t.indexOf('=') + 1)) + esc(t.slice(t.indexOf('=') + 1));
      else if (SH_KW.has(t) && (expectCmd || t === 'in' || t === 'do' || t === 'then')) {
        out += span('k', t);
        expectCmd = SH_THEN_CMD.has(t);
        continue;
      } else if (expectCmd) {
        cmd = t.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
        out += span(SH_BI.has(t) ? 'b' : 'f', t);
        expectCmd = SH_WRAP.has(cmd); // `timeout 90 node …`: node is the command
      } else out += esc(t);
    }
    if (t === ')') expectCmd = false;
  }
  return out + esc(line.slice(last));
}

/** Language for a file path, if we highlight it. */
function langOf(path) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ''))?.[1]?.toLowerCase();
  return ext === 'py' || ext === 'pyw' || ext === 'pyi' ? 'python' : ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'ps1' ? 'shell' : null;
}
const highlight = (code, lang) => (lang === 'python' ? hlPython(code) : lang === 'shell' ? hlShell(code) : esc(code));

// ───────────────────────────── diffs (GitHub-style)
/** Line diff of two texts (longest common subsequence) → rows of context / removed / added. */
function lineDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 250000) return [...a.map((text) => ({ t: 'del', text })), ...b.map((text) => ({ t: 'add', text }))];
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ t: 'del', text: a[i++] });
    else out.push({ t: 'add', text: b[j++] });
  }
  while (i < n) out.push({ t: 'del', text: a[i++] });
  while (j < m) out.push({ t: 'add', text: b[j++] });
  return out;
}

/** Rows from recorded hunks, with real file line numbers. */
function rowsFromPatch(patch) {
  const rows = [];
  for (const h of patch) {
    rows.push({ t: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    let o = h.oldStart;
    let nn = h.newStart;
    for (const l of h.lines) {
      const c = l[0];
      const text = l.slice(1);
      if (c === '+') rows.push({ t: 'add', n: nn++, text });
      else if (c === '-') rows.push({ t: 'del', o: o++, text });
      else if (c !== '\\') rows.push({ t: 'ctx', o: o++, n: nn++, text });
    }
  }
  return rows;
}

/** Rows computed from an edit's "- old" / "+ new" input, when no patch was recorded (no line numbers). */
function rowsFromInput(text) {
  const groups = [];
  let cur = null;
  for (const l of String(text).split('\n').slice(1)) {
    if (l.startsWith('- ') || l === '-') {
      if (!cur || cur.add.length) groups.push((cur = { del: [], add: [] }));
      cur.del.push(l.slice(2));
    } else if (l.startsWith('+ ') || l === '+') {
      if (!cur) groups.push((cur = { del: [], add: [] }));
      cur.add.push(l.slice(2));
    }
  }
  const rows = [];
  groups.forEach((g, i) => {
    if (groups.length > 1) rows.push({ t: 'hunk', text: `Change ${i + 1} of ${groups.length}` });
    rows.push(...lineDiff(g.del, g.add));
  });
  return rows;
}

/** Highlights the changed part of lines replaced one-for-one, like GitHub's word highlights. */
function markWords(rows) {
  for (let i = 0; i < rows.length; ) {
    if (rows[i].t !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d].t === 'del') d++;
    let a = d;
    while (a < rows.length && rows[a].t === 'add') a++;
    if (a - d === d - i) for (let k = 0; k < d - i; k++) pairMark(rows[i + k], rows[d + k]);
    i = Math.max(a, i + 1);
  }
  return rows;
}
function pairMark(x, y) {
  const a = x.text;
  const b = y.text;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  if (p + s < Math.min(a.length, b.length) * 0.35) return; // rewritten, not tweaked
  x.mark = [p, a.length - s];
  y.mark = [p, b.length - s];
}
function codeHtml(r, lang) {
  if (!r.mark || r.mark[0] >= r.mark[1]) return (lang ? highlight(r.text, lang) : esc(r.text)) || ' ';
  const [s, e] = r.mark;
  return `${esc(r.text.slice(0, s))}<span class="wd">${esc(r.text.slice(s, e))}</span>${esc(r.text.slice(e))}`;
}

function relPath(p) {
  const cwd = S.run?.cwd;
  const a = String(p ?? '').replace(/\\/g, '/');
  const c = String(cwd ?? '').replace(/\\/g, '/').replace(/\/$/, '');
  return c && a.toLowerCase().startsWith(c.toLowerCase() + '/') ? a.slice(c.length + 1) : a;
}

function diffView(key, file, rows, numbered) {
  const LIMIT = 80;
  const full = S.fullPre.has(key) || rows.length <= LIMIT;
  const shown = full ? rows : rows.slice(0, LIMIT);
  const add = rows.filter((r) => r.t === 'add').length;
  const del = rows.filter((r) => r.t === 'del').length;
  const lnCols = numbered ? 2 : 0;
  const lang = langOf(file);
  const body = shown
    .map((r) =>
      r.t === 'hunk'
        ? `<tr class="dl-h"><td colspan="${lnCols + 2}">${esc(r.text)}</td></tr>`
        : `<tr class="dl-${r.t}">${numbered ? `<td class="ln">${r.o ?? ''}</td><td class="ln">${r.n ?? ''}</td>` : ''}<td class="sg">${r.t === 'add' ? '+' : r.t === 'del' ? '−' : ''}</td><td class="cd">${codeHtml(r, lang)}</td></tr>`,
    )
    .join('');
  return `<div class="pl dfile"><span title="${esc(file)}">${esc(relPath(file))}</span><span class="dstat">${del ? `<span class="d">−${del}</span>` : ''}${add ? `<span class="a">+${add}</span>` : ''}</span></div>
    <div class="diff"><table>${body}</table></div>${full ? '' : `<button class="show-all" data-full="${esc(key)}">Show all ${rows.length} lines</button>`}`;
}

function transcriptHtml(rootId, chunks) {
  if (!chunks.length) return '<div class="loading">No output recorded for this item.</div>';
  const out = [];
  let scope = null;
  // Pair each action with its result even when parallel calls interleave them.
  const results = new Map();
  const tools = new Set(chunks.filter((c) => c.kind === 'tool').map((c) => c.node));
  for (const c of chunks) if (c.kind === 'result' && tools.has(c.node) && !results.has(c.node)) results.set(c.node, c);
  const paired = new Set([...results.values()]);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const sc = scopeOf(c.node, rootId);
    if ((sc?.id ?? null) !== (scope?.id ?? null)) {
      scope = sc;
      if (sc) {
        const label = sc.type === 'blocker' ? 'Blocker' : sc.origin === 'subagent' ? 'Subagent' : 'Subtask';
        out.push(`<div class="scope ${sc.type === 'blocker' ? 'blocker' : sc.origin ?? ''}">↳ ${label}: ${esc(sc.title.replace(/^Subagent:\s*/, ''))}</div>`);
      } else out.push('<div class="scope back">↰ back to this step</div>');
    }
    switch (c.kind) {
      case 'prompt':
        out.push(`<div class="ev ev-prompt"><span class="who">${esc(c.label === 'Task given to subagent' ? 'Task for subagent' : 'You')}</span>${esc(c.text)}</div>`);
        break;
      case 'text':
        out.push(`<div class="ev ev-text">${md(c.text)}</div>`);
        break;
      case 'plan':
        out.push(`<div class="ev ev-text ev-plan"><span class="who">Plan</span>${md(c.text)}</div>`);
        break;
      case 'outcome':
        out.push(`<div class="ev ev-text ev-outcome"><span class="who">Result</span>${md(c.text)}</div>`);
        break;
      case 'thinking':
        out.push(`<details class="ev ev-think"><summary>Thinking…</summary><div>${esc(c.text)}</div></details>`);
        break;
      case 'notice': {
        const n = N(c.node);
        out.push(`<div class="ev ev-notice${n?.type === 'blocker' || n?.level === 'error' ? ' err' : ''}">${esc(c.text)}</div>`);
        break;
      }
      case 'tool': {
        const n = N(c.node) ?? { status: 'done', title: c.label, kind: 'other' };
        const result = results.get(c.node) ?? null;
        const open = S.openActs.has(c.node) || (c.node === rootId && !S.closedActs.has(c.node)) ? ' open' : '';
        const kindIcon = n.type === 'subtask' ? 'agent' : (n.kind ?? 'other');
        const detail = n.detail && n.detail !== n.title ? `<span class="ad">${esc(n.detail)}</span>` : '';
        out.push(`<details class="ev act s-${n.status}" data-act="${c.node}"${open}>
          <summary>${icon(kindIcon)}<span class="al">${esc(n.title)}</span>${n.retry ? '<span class="retry">retry</span>' : ''}${failBadge(n)}${detail}<span class="as">${stMark(n)}</span></summary>
          ${n.issue ? `<div class="iss">${esc(n.issue)}</div>` : ''}
          ${open ? inputHtml(c, n, result) : ''}
          ${open && result && !(result.patch?.length && !result.failed) ? preBlock(`${c.node}:out`, result.failed ? 'Error' : 'Output', result.text || '(no output)', result.failed ? 'failed' : '') : ''}
          ${open && !result ? '<div class="pl" style="padding-bottom:8px">Waiting for result…</div>' : ''}
        </details>`);
        break;
      }
      case 'result':
        if (paired.has(c)) break;
        out.push(`<div class="ev act">${preBlock(`${c.node}:r${c.id}`, 'Output', c.text)}</div>`);
        break;
    }
  }
  return out.join('');
}

/** An action's input: a diff for file changes, the command or raw input otherwise. */
function inputHtml(c, n, result) {
  const file = n.files?.[0] ?? String(c.text).split('\n')[0].replace(/^(?:Edit|Write)\s+/, '');
  if (result?.patch?.length && !result.failed) return diffView(`${c.node}:diff`, file, markWords(rowsFromPatch(result.patch)), true);
  if (n.kind === 'edit') return diffView(`${c.node}:diff`, file, markWords(rowsFromInput(c.text)), false);
  if (n.kind === 'command') return preBlock(`${c.node}:in`, 'Command', c.text, '', 'shell');
  if (n.kind === 'write' && langOf(file)) {
    const body = String(c.text).split('\n').slice(2).join('\n'); // drop the "Write <file>" header
    return preBlock(`${c.node}:in`, relPath(file), body, '', langOf(file));
  }
  return preBlock(`${c.node}:in`, 'Input', c.text);
}

const TYPE_LABEL = (n) =>
  n.type === 'goal'
    ? 'Task'
    : n.type === 'step'
      ? n.origin === 'plan'
        ? 'Planned step'
        : 'Step'
      : n.type === 'subtask'
        ? n.origin === 'subagent'
          ? 'Subagent'
          : 'Subtask'
        : n.type === 'blocker'
          ? 'Blocker'
          : n.type === 'note'
            ? 'Notice'
            : 'Action';
const STATUS_LABEL = { active: 'In progress', done: 'Done', pending: 'Not started', failed: 'Failed', open: 'Open', resolved: 'Resolved', waiting: 'Interrupted' };

function secHtml(key, title, body, ctl = '') {
  return `<details class="d-sec" data-sec="${key}"${S.closedSecs.has(key) ? '' : ' open'}><summary>${CHEV}${title}${ctl ? `<span class="ctl">${ctl}</span>` : ''}</summary><div class="d-body">${body}</div></details>`;
}

function renderDetail() {
  const el = $('#detail');
  const n = N(S.selected);
  if (!n || !S.run) {
    el.hidden = true;
    delete el.dataset.shown;
    return;
  }
  el.hidden = false;
  const meta = [
    n.startedAt ? `Started ${ago(n.startedAt)}` : '',
    n.startedAt && (n.endedAt || n.status === 'active') ? `${n.endedAt ? 'Took' : 'Running for'} ${dur(n.startedAt, liveEnd(n))}` : '',
    n.stats ? `${plural(n.stats.actions, 'action')}${n.stats.errors ? `, ${plural(n.stats.errors, 'error')}` : ''}` : '',
    n.models?.length ? modelsLabel(n) : '',
    n.usage ? `${usageLine(n.usage)} tokens` : '',
  ].filter(Boolean);
  const chunks = rawFor(n.id);
  const scroll = el.scrollTop;
  const sameNode = el.dataset.shown === n.id;
  const ctx = n.type !== 'activity' ? tagsHtml(n.context, 60) : '';
  const hasActs = chunks?.some((c) => c.kind === 'tool');
  el.innerHTML = `<div class="d-head">
      <div class="d-top"><span class="d-type">${TYPE_LABEL(n)}</span><span class="badge s-${n.status}">${STATUS_LABEL[n.status] ?? esc(n.status)}</span><span class="grow"></span><button class="ibtn" data-close aria-label="Close (Esc)" title="Close (Esc)">${CLOSE}</button></div>
      <h2>${esc(n.title)}</h2>
      ${n.type === 'goal' && n.intent ? `<div class="d-meta"><span>Intent · ${esc(n.intent)}</span></div>` : ''}
      <div class="d-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      ${crumbHtml(n)}
    </div>
    ${ctx ? secHtml('ctx', 'Working with', ctx) : ''}
    ${secHtml('tr', 'Transcript', chunks ? transcriptHtml(n.id, chunks) : '<div class="loading">Loading…</div>', hasActs ? '<a data-acts="open">Expand all</a><a data-acts="close">Collapse all</a>' : '')}`;
  el.dataset.shown = n.id;
  el.scrollTop = sameNode ? scroll : 0;
  // While following a live step, keep its newest output in view.
  if (S.follow && n.status === 'active' && sameNode && scroll + el.clientHeight >= el.scrollHeight - 140) el.scrollTop = el.scrollHeight;
}

/** "Task › Step" for the detail header, with a jump back to the visual path. */
function crumbHtml(n) {
  if (n.type === 'goal') return '';
  const chain = ancestors(n.id).slice(1).reverse();
  if (!chain.length) return '';
  const parts = chain.map((c) => `<span title="${esc(c.title)}">${esc(clip(c.title, 60))}</span>`).join('<span>›</span>');
  const link = S.view === 'actions' ? ` <a data-showpath="${n.id}">Show in path</a>` : '';
  return `<div class="crumb">${parts}${link}</div>`;
}

// ───────────────────────────── actions view
const KIND_LABELS = [
  ['command', 'Commands'],
  ['edit', 'Edits'],
  ['write', 'Writes'],
  ['read', 'Reads'],
  ['search', 'Searches'],
  ['web', 'Web'],
  ['agent', 'Subagents'],
  ['ask', 'Questions'],
  ['other', 'Other'],
];

function loadActions() {
  if (!S.runId || S.actionsLoading || !S.actionsStale) return;
  const wait = Math.max(0, 800 - (Date.now() - S.actionsAt));
  S.actionsLoading = true;
  const runId = S.runId;
  setTimeout(async () => {
    try {
      S.actionsStale = false;
      const res = await fetch(`/api/s/${runId}/actions`);
      if (res.ok && S.runId === runId) S.actions = (await res.json()).actions;
    } finally {
      S.actionsLoading = false;
      S.actionsAt = Date.now();
      schedule();
    }
  }, S.actions ? wait : 0);
}

/** Action rows with live status from the node map (it updates before the next fetch). */
function liveActions() {
  return (S.actions ?? []).map((r) => {
    const n = N(r.id);
    return n ? { ...r, status: n.status, issue: n.issue, retry: n.retry, recovered: n.recovered, endedAt: n.endedAt } : r;
  });
}

function inGoal(r) {
  if (S.af.goal === 'all') return true;
  const g = S.af.goal === 'current' ? S.run?.currentGoal : S.af.goal;
  return r.goalId === g;
}

function filteredActions() {
  const q = S.af.q.trim().toLowerCase();
  return liveActions().filter(
    (r) =>
      inGoal(r) &&
      (!S.af.kinds.size || S.af.kinds.has(r.kind)) &&
      (S.af.errors === 'all' || (S.af.errors === 'open' ? isUnresolved(r) : r.status === 'failed' && !!r.recovered)) &&
      (!q || [r.title, r.command, r.input, r.step, r.issue, r.subagent].some((x) => x && x.toLowerCase().includes(q))),
  );
}

/** "−2 +3" for an edit, counted from its recorded change (skipped when the input was capped). */
function diffStat(r) {
  if (r.diff) return diffBadge(r.diff.del, r.diff.add);
  if (r.kind !== 'edit' || !r.input || r.input.endsWith('\n…')) return '';
  let add = 0;
  let del = 0;
  for (const l of r.input.split('\n')) {
    if (l.startsWith('+ ')) add++;
    else if (l.startsWith('- ')) del++;
  }
  return diffBadge(del, add);
}
function diffBadge(del, add) {
  return add || del ? `<span class="dstat" title="${del} removed, ${add} added lines">${del ? `<span class="d">−${del}</span>` : ''}${add ? `<span class="a">+${add}</span>` : ''}</span>` : '';
}

/** "recovered" / "failed" next to a failed action. */
function failBadge(n) {
  if (n.status !== 'failed') return '';
  return n.recovered
    ? '<span class="fb rec" title="Something succeeded after this, in the same step">recovered</span>'
    : '<span class="fb open" title="Nothing has succeeded after this in its step yet">failed</span>';
}

function actionRowHtml(r) {
  const sel = S.selected === r.id ? ' sel' : '';
  let sub = '';
  if (r.command !== undefined) sub = `$ ${r.short ?? firstOf(r.command)}`;
  else if (['read', 'edit', 'write'].includes(r.kind) && r.input && !r.input.startsWith('{')) sub = firstOf(r.input);
  const where = [r.subagent ? `<span class="sa">subagent · ${esc(r.subagent)}</span>` : '', r.step && r.step !== r.title ? esc(r.step) : ''].filter(Boolean).join(' › ');
  return `<div class="ar s-${r.status}${sel}" data-arow="${r.id}">
    <span class="t">${esc(clock(r.startedAt))}</span>
    <span class="ic">${icon(r.kind)}</span>
    <div style="min-width:0">
      <div class="lbl">${esc(r.title)}${r.retry ? '<span class="retry">retry</span>' : ''}${failBadge(r)}</div>
      ${sub ? `<div class="cmd" title="${esc(r.command ?? r.input)}">${r.command !== undefined ? `<span class="tk-o">$</span> ${highlight(sub.replace(/^\$ /, ''), 'shell')}` : esc(sub)}</div>` : ''}
      ${r.status === 'failed' && r.issue ? `<div class="iss">${esc(r.issue)}</div>` : ''}
      ${where ? `<div class="wh">${where}</div>` : ''}
    </div>
    <div class="rt">${diffStat(r)}${r.endedAt ? esc(dur(r.startedAt, r.endedAt)) : ''}<span class="${r.status === 'failed' ? 'no' : r.status === 'done' ? 'ok' : ''}">${stMark(r)}</span></div>
  </div>`;
}

function renderActions() {
  const all = liveActions().filter(inGoal);
  const counts = {};
  for (const r of all) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  const chips = [`<button class="chip-f${S.af.kinds.size ? '' : ' on'}" data-kind="all">All <span class="n">${all.length}</span></button>`];
  for (const [k, label] of KIND_LABELS) {
    if (!counts[k]) continue;
    chips.push(`<button class="chip-f${S.af.kinds.has(k) ? ' on' : ''}" data-kind="${k}">${SVG(PATHS[k])}${label} <span class="n">${counts[k]}</span></button>`);
  }
  $('#kindFilters').innerHTML = chips.join('');
  const errors = all.filter((r) => r.status === 'failed').length;
  const open = all.filter(isUnresolved).length;
  $('#errFilter').innerHTML = [
    ['all', 'Everything', null],
    ['open', 'Failed', open],
    ['errors', 'Recovered', errors - open],
  ]
    .map(([k, label, n]) => `<button type="button" data-err="${k}" class="${S.af.errors === k ? 'on' : ''}" ${n === 0 ? 'disabled' : ''}>${label}${n ? ` <b class="${k === 'open' ? 'bad' : ''}">${n}</b>` : ''}</button>`)
    .join('');

  // task selector: rebuilt only when the set of tasks changes
  const sel = $('#actionsGoal');
  const key = S.run.goals.join(',');
  if (sel.dataset.key !== key) {
    const opts = ['<option value="all">All tasks</option>', '<option value="current">Current task</option>'];
    for (const id of [...S.run.goals].reverse()) {
      const g = N(id);
      if (g?.stats?.actions) opts.push(`<option value="${id}">${esc(clip(g.title, 70))}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.dataset.key = key;
  }
  sel.value = S.af.goal;
  if (sel.value !== S.af.goal) {
    S.af.goal = 'all';
    sel.value = 'all';
  }

  const view = $('#actionsView');
  if (!S.actions) {
    view.innerHTML = '<div class="no-match">Loading actions…</div>';
    return;
  }
  const rows = filteredActions();
  if (!rows.length) {
    view.innerHTML = `<div class="no-match">${all.length ? 'No actions match these filters.' : 'No actions yet.'}</div>`;
    return;
  }
  const hidden = Math.max(0, rows.length - S.actionsLimit);
  const shown = rows.slice(hidden);
  const groups = [];
  for (const r of shown) {
    const last = groups[groups.length - 1];
    if (last && last.id === r.goalId) last.rows.push(r);
    else groups.push({ id: r.goalId, title: r.goal ?? 'Session', rows: [r] });
  }
  const out = [];
  if (hidden) out.push(`<button class="tbtn a-more" id="actionsMore">Show ${Math.min(400, hidden)} earlier · ${hidden} hidden</button>`);
  for (const g of groups) {
    const errs = g.rows.filter((r) => r.status === 'failed').length;
    out.push(`<div class="ag"><div class="ag-h"><span class="agt" title="${esc(g.title)}">${esc(g.title)}</span><span class="agm">${plural(g.rows.length, 'action')}${errs ? ` · <span class="bad">${errs} failed</span>` : ''}</span></div>
      <div class="ag-b">${g.rows.map(actionRowHtml).join('')}</div></div>`);
  }
  view.innerHTML = out.join('');
}

function setView(v) {
  if (v === 'simple' || v === 'detailed') {
    S.layout = v;
    localStorage.setItem('lucidly.layout', v);
    v = 'path';
  }
  if (v !== 'path' && v !== 'actions') return;
  S.view = v;
  if (S.follow) S.lastFollowTarget = null;
  writeHash();
  schedule();
}

function writeHash() {
  if (!S.runId) return;
  history.replaceState(null, '', `#run=${S.runId}${S.view === 'actions' ? '&view=actions' : ''}`);
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

async function copyCommands() {
  const rows = filteredActions().filter((r) => r.command !== undefined);
  if (!rows.length) return toast('No commands in this list');
  const lines = [];
  let goal = null;
  for (const r of rows) {
    if (r.goalId !== goal) {
      goal = r.goalId;
      lines.push(`${lines.length ? '\n' : ''}# ── ${r.goal ?? 'Session'}`);
    }
    if (r.status === 'failed') lines.push(`# ✖ failed: ${r.issue ?? ''}`);
    lines.push(r.command);
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n') + '\n');
    toast(`Copied ${plural(rows.length, 'command')}`);
  } catch {
    toast('Clipboard not available');
  }
}

/** Opens every task and step on the way to a node, so it is visible in the path. */
function reveal(id) {
  for (const n of ancestors(id)) {
    if (n.type === 'goal') {
      S.closedGoals.delete(n.id);
      S.openGoals.add(n.id);
    } else if (n.type === 'step' && n.id !== id) {
      S.closedSteps.delete(n.id);
      S.openSteps.add(n.id);
    }
  }
}

function findEl(id) {
  const root = $('#pathView');
  for (const n of ancestors(id)) {
    const el = root.querySelector(`[data-node="${n.id}"]`);
    if (el) return el;
  }
  return null;
}

// ───────────────────────────── render loop
function schedule() {
  if (S.queued) return;
  S.queued = true;
  requestAnimationFrame(() => {
    S.queued = false;
    render();
  });
}

function render() {
  // Following with the panel closed scrolls along without opening it.
  if (S.follow && !S.followQuiet) {
    const t = followTarget();
    if (t) S.selected = t;
  }
  if (S.firstPaint && S.run) {
    // First picture of a session: the overview at the top, no panel until you pick something.
    S.firstPaint = false;
    S.selected = null;
    $('#pane').scrollTop = 0;
  }
  if (S.selected && !N(S.selected)) S.selected = null;
  renderHeader();
  const has = !!S.run;
  const pane = $('#pane');
  $('#empty').hidden = has;
  $('#overview').hidden = !has;
  $('#tbPath').hidden = $('#pathView').hidden = !has || S.view !== 'path';
  $('#tbActions').hidden = $('#actionsView').hidden = !has || S.view !== 'actions';
  if (has) {
    const top = pane.scrollTop;
    loadActions();
    renderOverview();
    if (S.view === 'path') renderPath();
    else renderActions();
    pane.scrollTop = top;
  }
  renderDetail();
  syncAnimations();
  requestAnimationFrame(updateToEnd);
  if (!has || !S.follow) return;
  if (S.view === 'actions') {
    pane.scrollTop = pane.scrollHeight;
    return;
  }
  const t = S.followQuiet ? followTarget() : S.selected;
  const el = t && findEl(t);
  if (el && S.lastFollowTarget !== t) el.scrollIntoView({ block: 'center', behavior: S.lastFollowTarget ? 'smooth' : 'auto' });
  else if (el) el.scrollIntoView({ block: 'nearest' });
  S.lastFollowTarget = t;
}

// ───────────────────────────── connection
function connect(runId) {
  S.es?.close();
  // A session opens at the top, on the timeline; the arrow button (or F) jumps to the end.
  Object.assign(S, { runId, run: null, nodes: {}, selected: null, follow: false, raw: new Map(), lastFollowTarget: null, expandAll: false, firstPaint: true, seenActs: null });
  for (const set of [S.openGoals, S.closedGoals, S.openSteps, S.closedSteps, S.allActs, S.openActs, S.closedActs]) set.clear();
  Object.assign(S, { actions: null, actionsStale: true, actionsLimit: 400, stripRows: [], zoom: { a: 0, b: 1 } });
  writeHash();
  const es = new EventSource(`/api/s/${runId}/stream`);
  S.es = es;
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    S.run = snap.run;
    S.nodes = snap.nodes;
    S.actionsStale = true;
    for (const v of S.raw.values()) v.stale = true;
    schedule();
  });
  es.addEventListener('patch', (e) => {
    const p = JSON.parse(e.data);
    S.run = p.run;
    S.actionsStale = true;
    for (const [id, n] of Object.entries(p.nodes)) {
      if (n === null) {
        invalidateRaw(S.nodes[id]?.parent ?? '');
        delete S.nodes[id];
        S.raw.delete(id);
      } else {
        S.nodes[id] = n;
        invalidateRaw(id);
      }
    }
    schedule();
  });
  es.onerror = async () => {
    try {
      const res = await fetch('/api/runs');
      const { runs } = await res.json();
      if (!runs.some((r) => r.id === runId) && S.runId === runId) {
        es.close();
        S.run = null;
        S.runId = null;
        history.replaceState(null, '', '#');
        schedule();
        openPicker();
      }
    } catch {
      /* server down; EventSource keeps retrying */
    }
  };
}

// ───────────────────────────── picker
async function openPicker() {
  const dlg = $('#picker');
  if (!dlg.open) dlg.showModal();
  for (const b of dlg.querySelectorAll('[data-scope]')) b.classList.toggle('on', b.dataset.scope === S.pickerScope);
  const list = $('#pickerList');
  list.innerHTML = '<li class="mute">Loading…</li>';
  const [{ runs }, data] = await Promise.all([
    fetch('/api/runs').then((r) => r.json()),
    fetch(`/api/sessions?scope=${S.pickerScope}`).then((r) => r.json()),
  ]);
  const others = runs.filter((r) => !r.key.startsWith('claude:'));
  $('#pickerOpen').innerHTML = others.length
    ? `<div class="psec">Open in Lucidly</div><ul class="plist">${others
        .map((r) => `<li data-run="${r.id}"><span class="dot${r.live ? ' live' : ''}"></span><div class="pm"><div class="pt">${esc(r.title ?? r.label)}</div><div class="ps">${esc(r.live ? 'Live stream' : 'Saved run')} · ${r.eventCount} events</div></div></li>`)
        .join('')}</ul>`
    : '';
  if (!data.sessions.length) {
    list.innerHTML = `<li class="mute">${S.pickerScope === 'project' ? `No Claude Code sessions for ${esc(data.cwd)} yet. Try “All projects”.` : 'No Claude Code sessions found.'}</li>`;
    return;
  }
  list.innerHTML = data.sessions
    .map((s) => {
      const title = s.title ?? s.firstPrompt ?? s.id;
      const sub = [s.title ? s.firstPrompt : '', S.pickerScope === 'all' ? s.cwd ?? s.project : ''].filter(Boolean).join(' · ');
      return `<li data-path="${esc(s.path)}" title="${esc(s.path)}">
        <span class="dot${s.live ? ' live' : ''}" title="${s.live ? 'Active in the last few minutes' : ''}"></span>
        <div class="pm"><div class="pt">${esc(title)}</div><div class="ps">${esc(sub)}</div></div>
        <span class="pw">${esc(ago(s.mtime))}</span></li>`;
    })
    .join('');
}

async function openSession(path) {
  const res = await fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  const data = await res.json();
  if (!res.ok) return alert(data.error ?? 'Could not open the session');
  $('#picker').close();
  connect(data.run.id);
}

async function loadFile(file) {
  const text = await file.text();
  const res = await fetch('/api/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  const data = await res.json();
  if (!res.ok) return alert(data.error ?? 'Could not load the file');
  connect(data.run.id);
}

// ───────────────────────────── interaction
function toggleTokens(show = $('#tokensPop').hidden) {
  $('#tokensPop').hidden = !show;
  $('#tokens').classList.toggle('on', show);
  renderTokens();
}

function setFollow(on) {
  S.follow = on;
  if (on) S.lastFollowTarget = null;
  schedule();
}

function select(id) {
  S.selected = id;
  S.followQuiet = false;
  S.follow = id === followTarget();
  schedule();
}

function toggleIn(open, id, openSet, closedSet) {
  if (open) {
    openSet.delete(id);
    closedSet.add(id);
  } else {
    closedSet.delete(id);
    openSet.add(id);
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const on = (sel) => t.closest(sel);
  let el;
  if (on('[data-close]')) {
    S.follow = false;
    S.selected = null;
    return schedule();
  }
  if (on('#tokens')) return toggleTokens();
  if (!on('#tokensPop') && !$('#tokensPop').hidden) toggleTokens(false);
  if (on('#emptyOpen')) return void openPicker();
  if ((el = on('[data-view]'))) return setView(el.dataset.view);
  if ((el = on('[data-mode]'))) {
    S.pf.mode = el.dataset.mode;
    return schedule();
  }
  if ((el = on('[data-err]'))) {
    S.af.errors = el.dataset.err;
    S.actionsLimit = 400;
    return schedule();
  }
  if ((el = on('[data-kind]'))) {
    const k = el.dataset.kind;
    if (k === 'all') S.af.kinds.clear();
    else if (S.af.kinds.has(k)) S.af.kinds.delete(k);
    else S.af.kinds.add(k);
    S.actionsLimit = 400;
    return schedule();
  }
  if ((el = on('[data-arow]'))) return select(el.dataset.arow);
  if ((el = on('[data-flayout]'))) {
    S.ff.layout = el.dataset.flayout;
    return schedule();
  }
  if (on('[data-fhdiffs]')) {
    S.ff.histDiffs = !S.ff.histDiffs;
    return schedule();
  }
  if (on('[data-foutside]')) {
    S.ff.outside = !S.ff.outside;
    return schedule();
  }
  if ((el = on('[data-fsort]'))) {
    S.ff.sort = el.dataset.fsort;
    return schedule();
  }
  if ((el = on('[data-fdiffs]'))) {
    const k = el.dataset.fdiffs;
    if (S.ff.diffs.has(k)) S.ff.diffs.delete(k);
    else S.ff.diffs.add(k);
    return schedule();
  }
  if ((el = on('[data-fe]'))) {
    S.follow = false;
    S.selected = el.dataset.fe;
    return schedule();
  }
  if ((el = on('[data-file]'))) {
    const k = el.dataset.file;
    if (S.ff.open.has(k)) S.ff.open.delete(k);
    else S.ff.open.add(k);
    return schedule();
  }
  if (on('[data-tokens]')) return toggleTokens();
  if ((el = on('[data-layer]'))) {
    S.follow = false;
    S.selected = el.dataset.layer;
    schedule();
    requestAnimationFrame(() => $('.lane')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return;
  }
  if (on('[data-lane-close]')) {
    // Back to where the subagent was called from.
    const ag = openAgent();
    S.follow = false;
    S.selected = ag?.parent ?? null;
    return schedule();
  }
  if ((el = on('[data-lane-open]'))) {
    S.follow = false;
    S.selected = el.dataset.laneOpen;
    if (S.view === 'path') reveal(S.selected);
    return schedule();
  }
  if ((el = on('[data-lb]'))) {
    const a = S.laneRows[Number(el.dataset.lb)];
    if (!a) return;
    S.follow = false;
    S.selected = a.id;
    if (S.view === 'path') reveal(a.id);
    schedule();
    requestAnimationFrame(() => {
      const t = S.view === 'path' ? findEl(a.id) : $(`[data-arow="${a.id}"]`);
      t?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return;
  }
  if ((el = on('[data-zoom]'))) {
    const z = el.dataset.zoom;
    if (z === 'fit') setZoom(0, 1);
    else zoomBy(z === 'in' ? 0.5 : 2);
    return;
  }
  if ((el = on('#overview [data-pstep]'))) {
    const id = el.dataset.pstep;
    reveal(id);
    if (S.view !== 'path') setView('path');
    select(id);
    requestAnimationFrame(() => findEl(id)?.scrollIntoView({ block: 'center' }));
    return;
  }
  if ((el = on('#overview [data-b]'))) {
    const row = S.stripRows[Number(el.dataset.b)];
    if (!row) return;
    S.follow = false;
    S.selected = row.id;
    if (row.subagentId || N(row.id)?.origin === 'subagent') {
      // Subagent work: open its timeline and bring it into view; its own bars lead to the details.
      schedule();
      requestAnimationFrame(() => $('.lane')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      return;
    }
    if (S.view === 'path') reveal(row.id);
    schedule();
    requestAnimationFrame(() => {
      const target = S.view === 'path' ? findEl(row.id) : $(`[data-arow="${row.id}"]`);
      target?.scrollIntoView({ block: 'center' });
    });
    return;
  }
  if ((el = on('[data-showpath]'))) {
    const id = el.dataset.showpath;
    reveal(id);
    S.follow = false;
    S.selected = id;
    setView('path');
    requestAnimationFrame(() => findEl(id)?.scrollIntoView({ block: 'center' }));
    return;
  }
  if (on('#actionsMore')) {
    S.actionsLimit += 400;
    return schedule();
  }
  if (on('#copyCommands')) return void copyCommands();
  if (on('#expandAll')) {
    if (S.view === 'path' && S.pf.mode === 'files') {
      if (S.ff.open.size) S.ff.open.clear();
      else for (const f of fileEdits()) S.ff.open.add(f.key);
      return schedule();
    }
    S.expandAll = !S.expandAll;
    for (const set of [S.openGoals, S.closedGoals, S.openSteps, S.closedSteps]) set.clear();
    return schedule();
  }
  if ((el = on('[data-full]'))) {
    S.fullPre.add(el.dataset.full);
    return renderDetail();
  }
  if ((el = on('[data-allacts]'))) {
    S.allActs.add(el.dataset.allacts);
    return schedule();
  }
  if ((el = on('[data-acts]'))) {
    e.preventDefault(); // don't toggle the section it sits in
    const openAll = el.dataset.acts === 'open';
    for (const d of $('#detail').querySelectorAll('[data-act]')) {
      const id = d.dataset.act;
      if (openAll) {
        S.openActs.add(id);
        S.closedActs.delete(id);
      } else {
        S.openActs.delete(id);
        S.closedActs.add(id);
      }
    }
    return renderDetail();
  }
  if ((el = on('#picker li[data-path]'))) return void openSession(el.dataset.path);
  if ((el = on('#picker li[data-run]'))) {
    $('#picker').close();
    return connect(el.dataset.run);
  }
  if ((el = on('[data-scope]'))) {
    S.pickerScope = el.dataset.scope;
    return void openPicker();
  }
  if ((el = on('[data-fnode]'))) {
    const key = el.closest('.fn')?.dataset.key ?? '';
    S.flowPick = key === 'start' || key === 'end' ? key : null;
    return select(el.dataset.fnode);
  }
  if ((el = on('[data-ftoggle]'))) {
    const g = N(el.dataset.ftoggle);
    if (!g) return;
    if (isQA(g)) return select(g.id); // nothing to unfold: its answer is in the panel
    const open = el.closest('.fg').classList.contains('open');
    toggleIn(open, g.id, S.openGoals, S.closedGoals);
    return schedule();
  }
  if ((el = on('[data-step]'))) {
    const s = N(el.dataset.step);
    if (!s) return;
    const open = isStepOpen(s);
    // Click opens and selects; clicking the selected step (or its chevron) folds it again.
    if (s.children.length && (on('.chev') || !open || S.selected === s.id)) toggleIn(open, s.id, S.openSteps, S.closedSteps);
    if (on('.chev')) return schedule();
    return select(s.id);
  }
  if ((el = on('[data-toggle]'))) {
    const g = N(el.dataset.toggle);
    if (!g) return;
    const open = isGoalOpen(g);
    toggleIn(open, g.id, S.openGoals, S.closedGoals);
    if (!open) return select(g.id);
    return schedule();
  }
  if ((el = on('#pathView [data-select]'))) return select(el.dataset.select);
});

document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement)) return;
    if (d.dataset.sec) {
      if (d.open) S.closedSecs.delete(d.dataset.sec);
      else S.closedSecs.add(d.dataset.sec);
      return;
    }
    if (!d.dataset.act) return;
    const was = S.openActs.has(d.dataset.act) || (!S.closedActs.has(d.dataset.act) && d.dataset.act === S.selected);
    if (d.open) {
      S.openActs.add(d.dataset.act);
      S.closedActs.delete(d.dataset.act);
    } else {
      S.openActs.delete(d.dataset.act);
      S.closedActs.add(d.dataset.act);
    }
    if (was !== d.open) renderDetail();
  },
  true,
);

// Strip zoom: drag the navigator window (pan) or its edges (zoom); click the track to jump there.
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  if (!(t instanceof Element) || e.button !== 0) return;
  const nav = t.closest('[data-nav]');
  if (!nav) return;
  e.preventDefault();
  const rect = nav.getBoundingClientRect();
  const n = S.stripRows.length || 1;
  const min = minSpanCount(n) / n;
  const edge = t.closest('[data-h]')?.dataset.h;
  let z0 = { ...S.zoom };
  if (!edge && !t.closest('.nav-win')) {
    const span = z0.b - z0.a;
    const c = (e.clientX - rect.left) / rect.width;
    const na = Math.max(0, Math.min(1 - span, c - span / 2));
    setZoom(na, na + span);
    z0 = { ...S.zoom };
  }
  const x0 = e.clientX;
  document.body.classList.add('zooming');
  const move = (ev) => {
    const d = (ev.clientX - x0) / rect.width;
    if (edge === 'a') setZoom(Math.max(0, Math.min(z0.b - min, z0.a + d)), z0.b);
    else if (edge === 'b') setZoom(z0.a, Math.min(1, Math.max(z0.a + min, z0.b + d)));
    else {
      const span = z0.b - z0.a;
      const na = Math.max(0, Math.min(1 - span, z0.a + d));
      setZoom(na, na + span);
    }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    document.body.classList.remove('zooming');
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
document.addEventListener('dblclick', (e) => {
  if (e.target instanceof Element && e.target.closest('[data-nav]')) setZoom(0, 1);
});
// Scroll over the strip to zoom around the cursor; shift+scroll (or a sideways swipe) pans.
document.addEventListener(
  'wheel',
  (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const el = t.closest('.strip, [data-nav]');
    if (!el || (S.stripRows.length ?? 0) <= 20) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const span = S.zoom.b - S.zoom.a;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.shiftKey ? e.deltaY : e.deltaX) || e.deltaY;
      panBy((Math.sign(d) * span) / 8);
    } else if (el.matches('[data-nav]')) {
      zoomBy(e.deltaY > 0 ? 1.25 : 0.8, 0.5);
    } else {
      zoomBy(e.deltaY > 0 ? 1.25 : 0.8, (e.clientX - rect.left) / rect.width);
    }
  },
  { passive: false },
);

$('#pathSearch').addEventListener('input', (e) => {
  S.pf.q = e.target.value;
  schedule();
});
$('#hideChat').addEventListener('change', (e) => {
  S.pf.hideChat = e.target.checked;
  schedule();
});
$('#actionsSearch').addEventListener('input', (e) => {
  S.af.q = e.target.value;
  S.actionsLimit = 400;
  schedule();
});
$('#actionsGoal').addEventListener('change', (e) => {
  S.af.goal = e.target.value;
  schedule();
});

// ───────────────────────────── jump to the end (a floating arrow, shown when not at the bottom)
const totalActs = () => (S.run ? S.run.goals.map(N).filter(Boolean).reduce((a, g) => a + (g.stats?.actions ?? 0), 0) : 0);
function atEnd() {
  const p = $('#pane');
  return p.scrollTop + p.clientHeight >= p.scrollHeight - 60;
}
function updateToEnd() {
  const btn = $('#toEnd');
  const show = !!S.run && !atEnd();
  btn.hidden = !show;
  // Like a chat app: count what arrived while you were looking elsewhere.
  const n = totalActs();
  if (!show || S.seenActs === null) S.seenActs = n;
  const fresh = n - S.seenActs;
  const badge = $('#toEndN');
  badge.hidden = !show || fresh <= 0;
  badge.textContent = fresh > 99 ? '99+' : String(fresh);
  btn.title = fresh > 0 ? `${plural(fresh, 'new action')}: jump to the end and follow the agent (F)` : 'Jump to the end and follow the agent (F)';
}
function jumpToEnd() {
  S.follow = true;
  S.followQuiet = !N(S.selected);
  S.lastFollowTarget = null;
  render();
  const p = $('#pane');
  p.scrollTo({ top: p.scrollHeight, behavior: 'smooth' });
}
$('#toEnd').addEventListener('click', jumpToEnd);
$('#pane').addEventListener('scroll', () => requestAnimationFrame(updateToEnd), { passive: true });
$('#sessionsBtn').addEventListener('click', () => openPicker());
$('#runBox').addEventListener('click', () => openPicker());
$('#loadInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) {
    if ($('#picker').open) $('#picker').close();
    loadFile(f);
  }
  e.target.value = '';
});
// Scrolling by hand pauses following; the arrow button (or F) resumes it.
$('#pane').addEventListener('wheel', () => S.follow && S.run && setFollow(false), { passive: true });
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'End') jumpToEnd();
  else if (e.key === 'v') setView(S.view === 'actions' ? 'simple' : S.layout === 'simple' ? 'detailed' : 'actions');
  else if (e.key === 'e' && S.view === 'path') $('#expandAll').click();
  else if (e.key === '/') {
    e.preventDefault();
    $(S.view === 'path' ? '#pathSearch' : '#actionsSearch').focus();
  } else if (e.key === 'o') openPicker();
  else if (e.key === 't' && S.run?.usage) toggleTokens();
  else if (e.key === 'Escape' && !$('#tokensPop').hidden) toggleTokens(false);
  else if (e.key === 'Escape' && !$('#picker').open) {
    S.follow = false;
    S.selected = null;
    schedule();
  }
});
// Relative times and the "quiet" state age even without new events.
setInterval(() => S.run && renderHeader(), 15000);

// ───────────────────────────── boot
(async () => {
  // Wait for styles: following needs the real scroll containers to exist.
  if (document.readyState !== 'complete') await new Promise((r) => addEventListener('load', r, { once: true }));
  const m = /run=([\w-]+)/.exec(location.hash);
  const { runs } = await fetch('/api/runs').then((r) => r.json());
  if (location.hash.includes('view=actions')) S.view = 'actions';
  const wanted = m && runs.find((r) => r.id === m[1]);
  if (wanted) connect(wanted.id);
  else if (runs.length) connect(runs[runs.length - 1].id);
  else render();
})();
