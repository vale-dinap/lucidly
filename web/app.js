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
  layout: ['glance', 'detailed', 'files'].includes(localStorage.getItem('lucidly.layout')) ? localStorage.getItem('lucidly.layout') : 'simple',
  // Keep the overview (stats and timeline) on screen while scrolling.
  pinOv: localStorage.getItem('lucidly.pinOverview') !== '0', // pinned unless you unpinned it
  // Token heat: a green-to-red glow around tasks and steps by how many tokens they used.
  heat: localStorage.getItem('lucidly.heat') === '1',
  // Colour theme: 'system' (follows the OS), 'light' or 'dark'.
  theme: ['light', 'dark'].includes(localStorage.getItem('lucidly.theme')) ? localStorage.getItem('lucidly.theme') : 'system',
  // Zoom of the simple view (1 = normal), one of FLOW_ZOOMS.
  fz: Number(localStorage.getItem('lucidly.flowZoom')) || 1,
  // path view
  openGoals: new Set(),
  closedGoals: new Set(),
  openSteps: new Set(),
  closedSteps: new Set(),
  allActs: new Set(), // units whose full action list is shown
  // Expand all / collapse all: true or false once you chose, null until then (the running task
  // open, and search hits). It wins over the automatic opening; a filter opens nothing by itself.
  expandAll: null,
  pf: { mode: 'all', hideChat: false, q: '' },
  // File edits view: sort order, files opened, files showing their diffs inline.
  ff: { sort: 'recent', open: new Set(), diffs: new Set(), outside: false, layout: 'files', histDiffs: false },
  // detail panel
  raw: new Map(), // nodeId -> { chunks, stale, loading, at }
  openActs: new Set(),
  closedActs: new Set(),
  fullPre: new Set(),
  /** Commands shown whole instead of in parts (shell lines, script, written content). */
  wholeCmd: new Set(),
  /** Script blocks shown reformatted, by block key. */
  reformat: new Set(),
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

/**
 * Safe markdown (GitHub flavour, the parts agents write): fenced code with highlighting,
 * headings, tables, nested and task lists, quotes, rules, and inline code, links, bold,
 * italic and strikethrough. Everything is escaped first; only these tags come out.
 */
function mdInline(t) {
  const keep = [];
  const stash = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = String(t)
    // code spans first: nothing inside them is markdown
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, c) => stash(`<code>${esc(c.trim() || c)}</code>`))
    // backslash escapes
    .replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (_, c) => stash(esc(c)));
  const url = (u) => (/^(https?:|mailto:)/i.test(u) ? u : null);
  s = s
    .replace(/!?\[([^\]]+)\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g, (m, text, href) => {
      const u = url(href);
      return u ? stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${mdInline(text)}</a>`) : m;
    })
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_, u) => stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`))
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g, (_, pre, u) => pre + stash(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
  s = esc(s)
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

const MD_LANG = { py: 'python', python: 'python', python3: 'python', sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell', powershell: 'shell', ps1: 'shell', pwsh: 'shell' };

/** Cells of a table row: outer pipes dropped, `\|` kept as a literal pipe. */
function mdCells(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const out = [];
  let cur = '';
  let tick = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (c === '`') {
      tick = !tick;
      cur += c;
    } else if (c === '|' && !tick) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const MD_TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/;

function md(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map((l) => mdInline(l.trim())).join('<br>')}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = MD_FENCE.exec(line);
    if (fence) {
      flush();
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = MD_LANG[fence[2].toLowerCase()] ?? null;
      out.push(`<pre${lang ? ` class="lang-${lang}"` : ''}>${highlight(body.join('\n'), lang)}</pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      i++;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${Math.min(6, h[1].length + 2)} class="md-h${h[1].length}">${mdInline(h[2])}</h${Math.min(6, h[1].length + 2)}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-') && lines[i + 1].includes('|')) {
      flush();
      const head = mdCells(line);
      const align = mdCells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
      const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${mdInline(c)}</${tag}>`;
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = mdCells(lines[i++]);
        rows.push(`<tr>${head.map((_, k) => cell('td', cells[k] ?? '', k)).join('')}</tr>`);
      }
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${md(body.join('\n'))}</blockquote>`);
      continue;
    }
    if (MD_ITEM.test(line)) {
      flush();
      // The whole list block: items, their wrapped lines, and blank lines between items.
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = MD_ITEM.exec(l);
        if (m && !MD_TABLE_SEP.test(l)) {
          const num = /^\d/.test(m[2]);
          const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
          items.push({ ind: m[1].replace(/\t/g, '    ').length, tag: num ? 'ol' : 'ul', start: num ? parseInt(m[2], 10) : 1, text: task ? task[2] : m[3], task: task ? task[1] !== ' ' : null });
          i++;
        } else if (l.trim() && /^\s+/.test(l) && items.length && !MD_FENCE.test(l)) {
          items[items.length - 1].text += ' ' + l.trim();
          i++;
        } else if (!l.trim() && i + 1 < lines.length && (MD_ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
          i++;
        } else break;
      }
      out.push(mdList(items));
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return out.join('');
}

/** Nested lists from items with their indentation: deeper items go inside the previous one. */
function mdList(items) {
  const root = { ind: -1, lists: [] };
  const stack = [];
  for (const it of items) {
    while (stack.length && stack[stack.length - 1].ind > it.ind) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.ind === it.ind && top.tag !== it.tag) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.ind < it.ind) {
      const list = { ind: it.ind, tag: it.tag, start: it.start, items: [] };
      const parent = top ? top.items[top.items.length - 1] : root;
      (parent.lists ??= []).push(list);
      stack.push(list);
      top = list;
    }
    top.items.push({ ...it, lists: [] });
  }
  const render = (list) =>
    `<${list.tag}${list.tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : ''}${list.items.some((x) => x.task !== null) ? ' class="tasks"' : ''}>${list.items
      .map((x) => `<li${x.task !== null ? ' class="task"' : ''}>${x.task !== null ? `<span class="tick${x.task ? ' on' : ''}" aria-label="${x.task ? 'done' : 'to do'}"></span>` : ''}${mdInline(x.text)}${x.lists.map(render).join('')}</li>`)
      .join('')}</${list.tag}>`;
  return root.lists.map(render).join('');
}

// ───────────────────────────── token heat
/** Tokens a unit used, the way the meter counts them: fresh input, cache writes and output. */
const unitTokens = (n) => (n?.usage ? n.usage.input + n.usage.cacheWrite + n.usage.output : 0);

/**
 * Each task and step's place on a green-to-red scale, relative to the others of its kind in this
 * run. Log scale: token use is lopsided, and on a linear one a single huge step would leave
 * everything else green. Tasks and steps are ranked apart (a task's total includes its steps).
 */
function computeHeat() {
  const heat = new Map();
  if (!S.heat || !S.run) return heat;
  const goals = S.run.goals.map(N).filter(Boolean);
  const rank = (nodes) => {
    const xs = nodes.map((n) => [n, unitTokens(n)]).filter(([, t]) => t > 0);
    if (!xs.length) return;
    const logs = xs.map(([, t]) => Math.log(t)).sort((a, b) => a - b);
    const lo = logs[Math.floor(logs.length * 0.05)];
    const hi = logs[logs.length - 1];
    for (const [n, t] of xs) heat.set(n.id, { v: hi - lo < 1e-6 ? 0.5 : Math.max(0, Math.min(1, (Math.log(t) - lo) / (hi - lo))), t });
  };
  rank(goals); // questions too: they are ranked with the tasks
  rank(goals.flatMap((g) => kids(g).filter((c) => c.type === 'step')));
  return heat;
}

/** Inline style for a glowing element: its colour from green (few tokens) to red (most). */
function heatStyle(id) {
  const h = S.heatMap?.get(id);
  if (!h) return '';
  const hue = Math.round(120 * (1 - h.v));
  return ` style="--heat:hsl(${hue} 100% 50%);--heat-a:${(0.5 + 0.45 * h.v).toFixed(2)}"`;
}
const heatTip = (id) => {
  const h = S.heatMap?.get(id);
  const u = N(id)?.usage;
  return h && u ? `\n${tok(h.t)} tokens (${tok(freshIn(u))} in · ${tok(u.output)} out)${u.cacheRead ? ` · ${tok(u.cacheRead)} cached` : ''}` : '';
};

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

const isStale = () => !!S.downAt || (!!S.run?.updatedAt && Date.now() - Date.parse(S.run.updatedAt) > 5 * 60 * 1000);
const liveEnd = (n) => n.endedAt ?? (isStale() || n.status !== 'active' ? S.run.updatedAt : undefined);

function runState() {
  const r = S.run;
  if (!r) return ['idle', 'No run'];
  if (S.downAt) return ['down', 'Server stopped'];
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
const filtering = () => S.pf.mode !== 'all' || !!pathQuery();

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
  if (S.expandAll !== null) return S.expandAll;
  if (pathQuery()) return true; // only the matching tasks are listed: show where they match
  return g.id === S.run.currentGoal || S.run.goals.length === 1;
}

function isStepOpen(s) {
  if (S.openSteps.has(s.id)) return true;
  if (S.closedSteps.has(s.id)) return false;
  if (S.expandAll !== null) return S.expandAll;
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
    <button type="button" class="ibtn pin${S.pinOv ? ' on' : ''}" data-pin title="${S.pinOv ? 'Unpin the timeline: let it scroll away (P)' : 'Pin the timeline: keep it on screen while scrolling (P)'}" aria-pressed="${S.pinOv}">${SVG('M9 4h6l-1 5 3 3v2H7v-2l3-3z M12 14v6')}</button>
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
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(8000) });
    setDown(false);
    // A server without this route predates the page: it is outdated too.
    if (res.status === 404) $('#outdated').hidden = false;
    else if (res.ok) $('#outdated').hidden = !(await res.json()).outdated;
  } catch {
    setDown(true);
  }
}

/**
 * The Lucidly server stopped (or came back). While it is gone the page says so, in the status pill
 * and a bar under the header, freezes everything live, and checks every few seconds for its return;
 * the session's stream reconnects by itself then.
 */
function setDown(down) {
  if (!!S.downAt === down) return;
  S.downAt = down ? Date.now() : null;
  clearInterval(S.downPoll);
  if (down) S.downPoll = setInterval(checkHealth, 3000);
  const bar = $('#downBar');
  bar.hidden = !down;
  if (down) $('#downAt').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  schedule();
  void syncWake();
}
setInterval(checkHealth, 30000);
addEventListener('load', checkHealth);

// ───────────────────────────── file edits: every change to every file, at a glance
/** Edits and writes grouped by file, with their totals. A command that changed several files counts for each. */
function fileEdits() {
  const map = new Map();
  for (const r of liveActions()) {
    if ((r.kind !== 'edit' && r.kind !== 'write') || !r.files?.length) continue;
    for (const path of r.files) {
      const key = relPath(path);
      const id = key.toLowerCase();
      let e = map.get(id);
      if (!e) map.set(id, (e = { key, path, inside: !isAbsPath(key), edits: [], add: 0, del: 0, failed: 0, last: '' }));
      e.edits.push(r);
      // Only failures nothing has made up for: recovered ones show on their own rows, not on the file.
      if (isUnresolved(r)) e.failed++;
      else if (r.diff) {
        e.add += r.diff.add;
        e.del += r.diff.del;
      }
      if ((r.startedAt ?? '') > e.last) e.last = r.startedAt ?? '';
    }
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

/** Every edit in time order, newest first: the same file shows once per change. */
function historyHtml(files, ql) {
  const inside = files.filter((f) => f.inside);
  const outside = files.filter((f) => !f.inside);
  const showOut = S.ff.outside || (ql && !inside.length);
  const pick = showOut ? files : inside.length ? inside : files;
  // One row per file and change: a command that changed several files shows under each.
  const edits = pick
    .flatMap((f) => f.edits.map((r) => ({ r, f })))
    .sort((x, y) => ((x.r.startedAt ?? '') > (y.r.startedAt ?? '') ? -1 : (x.r.startedAt ?? '') < (y.r.startedAt ?? '') ? 1 : 0));
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
        ${f.failed ? `<span class="ftag bad" title="${plural(f.failed, 'edit')} failed, with nothing succeeding after in the same step">${f.failed} failed</span>` : ''}        <span class="grow"></span>
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
      return `<button type="button" class="layer-box${running ? ' running' : ''}${un ? ' bad' : ''}${row ? ' rx' : ''}${sel}" data-layer="${g.id}" style="left:${left}%;width:${Math.max(0, right - left)}%;top:${row * 17}px" title="${esc(tip)}"><span>${esc(title)}</span></button>`;
    })
    .join('');
  if (!visible.length) return '';
  const rowsN = Math.min(MAX, Math.max(1, ends.length));
  const more = capped
    ? `<span class="layer-more" style="top:${(MAX - 1) * 17}px;left:calc(${Math.min(94, Math.max(...extra.map((it) => xOf(it.e0 + 1))))}% + 4px)" title="${esc(`${extra.length} subagents overlap on this row:\n${extra.map((it) => it.g.title.replace(/^Subagent:\s*/, '')).join('\n')}`)}">+${extra.length}</span>`
    : '';
  // The compact (pinned, scrolled) card keeps one row: what overlaps it is counted on a "+N".
  const folded = visible.filter((it) => it.row > 0);
  const more1 = folded.length
    ? `<span class="layer-more c1" style="left:calc(${Math.min(94, Math.max(...folded.map((it) => xOf(it.e0 + 1))))}% + 4px)" title="${esc(`${folded.length} more subagents in parallel:\n${folded.map((it) => it.g.title.replace(/^Subagent:\s*/, '')).join('\n')}`)}">+${folded.length}</span>`
    : '';
  return `<div class="layers" style="--lh:${rowsN * 17 - 2}px" aria-label="Subagents">${boxes}${more}${more1}</div>`;
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
    // Steps have their own list, and your messages on a task sit between them (see stepRows).
    if (c.type === 'step' || (n.type === 'goal' && c.kind === 'user')) continue;
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
      <span class="mk"${heatStyle(s.id)}${S.heat ? ` title="${esc(heatTip(s.id).trim())}"` : ''}></span><span class="st-title">${hl(s.title)}</span>
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

/**
 * A task's steps in order and, when it ran over several rounds, where each round ended (done,
 * with a question, or interrupted) and the reply that continued it. Filtering shows matching
 * steps only.
 */
function stepRows(g, shown) {
  const show = new Set(shown.map((s) => s.id));
  const out = [];
  let round = 0;
  for (const c of kids(g)) {
    if (c.type === 'step') {
      if (show.has(c.id)) out.push(stepHtml(c));
    } else if (c.kind === 'user' && !filtering()) {
      const r = c.round;
      if (r) {
        const head = r.interrupted ? 'Interrupted' : r.asked ? 'Asked you' : 'Done for now';
        out.push(`<li class="finish round${r.interrupted || r.asked ? '' : ' reached'}" data-select="${g.id}" data-focus="end:${round++}"><span class="mk"></span><div class="ft"><small>${head}</small>${esc(clip(r.outcome ?? '', 360))}</div></li>`);
      }
      const who = r ? 'You replied' : 'You wrote, while the agent worked';
      out.push(`<li class="round-reply${S.selected === g.id && S.focus?.id === c.id ? ' sel' : ''}" data-select="${g.id}" data-focus="u:${c.id}"><span class="mk">${icon('user')}</span><div class="rr-t"><small>${who}</small>${hl(c.title.replace(/^You: /, ''))}</div></li>`);
    }
  }
  return out.join('');
}

function taskHtml(g, q) {
  if (!g) return '';
  const steps = kids(g).filter((c) => c.type === 'step');
  const qa = isQA(g);
  const mode = S.pf.mode;
  if (qa && S.pf.hideChat && mode === 'all') return '';
  if (mode === 'qa' && !qa) return '';
  if (qa && mode !== 'all' && mode !== 'qa') return '';
  let shown = steps;
  if (filtering()) {
    const gm = !!q && (g.title.toLowerCase().includes(q) || (g.intent ?? '').toLowerCase().includes(q) || (g.outcome ?? '').toLowerCase().includes(q));
    shown = steps.filter((s) => stepMatches(s, gm ? '' : q));
    if (!shown.length && !(qa && (!q || gm)) && !(gm && mode === 'all')) return '';
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
      <span class="tstat${qa ? ' qa' : ''} s-${g.status}"${heatStyle(g.id)}${S.heat ? ` title="${esc(heatTip(g.id).trim())}"` : ''}></span>
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
  const finish = (tag) => `<${tag} class="finish${reached ? ' reached' : ''}" data-select="${g.id}" data-focus="end:${kids(g).filter((c) => c.round).length}"><span class="mk"></span><div class="ft">${endText}</div></${tag}>`;
  if (qa) return `<section class="${cls}">${head}<div class="task-b">${finish('div')}</div></section>`;
  const own = filtering() ? '' : childrenHtml(g);
  return `<section class="${cls}">${head}
    <div class="task-b">
      ${g.usage ? `<div style="margin:0 0 8px 30px">${unitInfo(g)}</div>` : ''}
      ${own ? `<div class="step-b" style="margin-left:30px">${own}</div>` : ''}
      <ol class="steps">${stepRows(g, shown)}${finish('li')}</ol>
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
  // Intermediate goals: a round that ended done, with a question, or interrupted.
  mid: 'M6.5 12.5l3.5 3.5 7.5-8',
  'mid-ask': 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6 M12 17.5v.01',
  'mid-wait': 'M10 8v8 M14 8v8',
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
  // The end's diamond, smaller: a goal reached on the way.
  mid: '<path class="sh" d="M18 8l10 10-10 10L8 18z"/>',
  'mid-ask': '<path class="sh" d="M18 8l10 10-10 10L8 18z"/>',
  'mid-wait': '<path class="sh" d="M18 8l10 10-10 10L8 18z"/>',
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
  if (S.expandAll !== null) return S.expandAll;
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
    html: `<i class="fl"></i><button type="button" class="fn-s" data-fnode="${id}" data-node="${key.startsWith('s:') ? id : ''}" title="${esc(tip + (key.startsWith('s:') || key.startsWith('w:') ? heatTip(id) : ''))}" aria-label="${esc(tip)}"${key.startsWith('s:') || key.startsWith('w:') ? heatStyle(id) : ''}><svg class="shp" viewBox="0 0 36 36" aria-hidden="true">${SHAPE[kind]}</svg>${glyphSvg(kind)}${badge}</button><span class="fn-l">${esc(label)}</span>`,
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
  // A task can run over several rounds: a reply after its turn ended continues it. The round's
  // end node stays where it was, turned into an intermediate goal, and the reply follows it.
  // End nodes are keyed by round, so that change happens in place.
  let round = 0;
  const roundEnd = (r, final) => {
    if (final) {
      const reached = !!g.outcome || g.status === 'done';
      const st = reached ? 'done' : g.status === 'waiting' ? 'wait' : 'pend';
      const label = reached ? 'Done' : g.status === 'waiting' ? 'Interrupted' : 'Goal';
      const tip = g.outcome ? `Result: ${clip(g.outcome, 400)}` : `Goal: ${clip(goalAim(g), 300)}`;
      return flowNode({ key: `end:${round}`, id: g.id, kind: 'end', st, label, tip, extra: ' end' });
    }
    const label = r.interrupted ? 'Interrupted' : r.asked ? 'Asked' : 'Done';
    const tip = `${r.interrupted ? 'Interrupted' : r.asked ? 'Asked you' : 'Done for now'}${r.outcome ? `: ${clip(r.outcome, 400)}` : ''}\nThe task went on after your reply.`;
    return flowNode({ key: `end:${round}`, id: g.id, kind: r.interrupted ? 'mid-wait' : r.asked ? 'mid-ask' : 'mid', st: r.interrupted ? 'wait' : 'done', label, tip, extra: ' mid' });
  };
  // Every message of yours is a node: a reply that continued the task, or one sent while it worked.
  const replyNode = (c) =>
    flowNode({
      key: `u:${c.id}`,
      id: g.id,
      kind: 'start',
      st: 'start',
      label: c.round ? 'Reply' : 'Message',
      tip: `${c.round ? 'You replied' : 'You wrote, while the agent worked'} (${clock(c.startedAt)}): ${clip(c.title.replace(/^You: /, ''), 300)}`,
      extra: ' reply',
    });
  let i = 0;
  for (const c of kids(g)) {
    if (c.kind === 'user') {
      if (c.round) {
        items.push(roundEnd(c.round, false));
        round++;
      }
      items.push(replyNode(c));
      continue;
    }
    if (c.type !== 'step') continue;
    stepItem(c, i++);
  }
  items.push(roundEnd(null, true));
  items.forEach((it, j) => (it.i = j));
  return items;

  function stepItem(s, i) {
    const kind = stepKind(s);
    const st = stepState(s);
    const a = s.stats?.actions ?? 0;
    const rec = st !== 'bad' && hasRecovered(s);
    const dim = (q || S.pf.mode !== 'all') && !stepMatches(s, q) ? ' dim' : '';
    const tip = [
      `${i + 1}. ${s.title}`,
      [a ? plural(a, 'action') : 'no actions yet', kind !== 'todo' ? `mostly ${KIND_LABEL[kind]}` : '', s.startedAt ? dur(s.startedAt, liveEnd(s)) : ''].filter(Boolean).join(' · '),
      st === 'bad' ? 'Failed: nothing has worked after it yet' : rec ? 'Failed along the way, then recovered' : s.untracked ? "Done with the others: its work wasn't told apart" : '',
    ].filter(Boolean).join('\n');
    const badge = (st === 'bad' ? '<span class="fn-b bad">!</span>' : rec ? '<span class="fn-b rec"></span>' : '') + (a > 1 ? `<span class="fn-n">${a > 99 ? '99+' : a}</span>` : '');
    items.push({ ...flowNode({ key: `s:${s.id}`, id: s.id, kind, st, label: s.title, tip, badge, extra: (s.untracked ? ' untr' : '') + dim }), i });
    const cap = capsuleItem(s, dim);
    if (cap) items.push(cap);
  }
}

// ───────────────────────────── glance view: the run at a glance, with (nearly) no text
/*
 * Answers "is it going fine, and does it need me?" from across the room. A large orb says what
 * the agent is doing (working, your turn, in trouble, quiet), the current task's steps run below
 * it as large shapes, and the earlier tasks are rows of small dots fading with age. Text only in
 * tooltips; a click opens the side panel, a double click the task or step in the Simple view.
 */
const GLANCE_GLYPH = {
  trouble: 'M12 6.5v7 M12 17.5v.01',
  quiet: 'M7.5 12h.01 M12 12h.01 M16.5 12h.01',
  done: GLYPH.check,
  pause: GLYPH.pause,
  ask: 'M9 9.2a3 3 0 1 1 4.2 2.8c-.7.3-1.2 1-1.2 1.8v.7 M12 17.6v.01',
};
// What the agent is doing now, from the kind of its latest action.
const DOING = { edit: 'edit', write: 'edit', command: 'command', read: 'read', search: 'read', web: 'read', agent: 'agent', ask: 'ask' };

/** The run's state for the orb: its class, glyph, tooltip, and when the current stretch began. */
function glanceState() {
  const r = S.run;
  const g = N(r.currentGoal) ?? N(r.goals[r.goals.length - 1]);
  if (S.downAt) return { st: 'off', path: GLANCE_GLYPH.pause, tip: 'The Lucidly server has stopped: this is the session as it was', since: r.updatedAt, ago: true };
  if (r.status === 'working') {
    if (isStale()) return { st: 'off', path: GLANCE_GLYPH.quiet, tip: `Quiet: nothing new since ${clock(r.updatedAt)}`, since: r.updatedAt, ago: true };
    const step = N(r.currentStep);
    if (step && hasOpenIssue(step)) return { st: 'bad', path: GLANCE_GLYPH.trouble, tip: 'Working, with failures nothing has fixed yet in this step', since: turnStart(g) };
    const unit = N(r.currentUnit) ?? step;
    const acts = unit ? descendants(unit, isAct) : [];
    const kind = DOING[acts[acts.length - 1]?.kind] ?? 'read';
    return { st: 'work', path: GLYPH[kind], tip: `Working: ${KIND_LABEL[kind] ?? 'reading'} now`, since: turnStart(g) };
  }
  if (g?.status === 'waiting') return { st: 'off', path: GLANCE_GLYPH.pause, tip: 'Interrupted', since: r.updatedAt, ago: true };
  const asking = g ? descendants(g, isAct).some((a) => a.kind === 'ask' && a.status === 'active') : false;
  const asked = asking || !!g?.asked;
  const recent = !!r.updatedAt && Date.now() - Date.parse(r.updatedAt) < 30 * 60 * 1000;
  if (recent) return { st: 'you', path: asked ? GLANCE_GLYPH.ask : GLANCE_GLYPH.done, tip: asked ? 'Your turn: the agent asked you something' : 'Your turn: the agent finished', since: r.updatedAt, ago: true };
  return { st: 'rest', path: GLANCE_GLYPH.done, tip: `Finished, ${ago(r.updatedAt)}`, since: r.updatedAt, ago: true };
}

/** When the current turn began: your latest message on the task, or the task itself. */
function turnStart(g) {
  if (!g) return S.run.updatedAt;
  let t = g.startedAt;
  for (const c of kids(g)) if (c.kind === 'user' && c.startedAt && (!t || c.startedAt > t)) t = c.startedAt;
  return t;
}

const glanceTime = (s) => (s.ago ? ago(s.since) : dur(s.since));

function renderGlance(view) {
  if (!view.__glance) {
    view.innerHTML = `<div class="glance">
      <div class="gx-state"><button type="button" class="gx-orb" data-glive><svg viewBox="0 0 24 24" aria-hidden="true"><path d=""/></svg></button><div class="gx-time"></div></div>
      <div class="gx-title"></div>
      <div class="gx-wheel"></div>
      <div class="gx-hint">Scroll or <kbd>↑</kbd> <kbd>↓</kbd> for other tasks · <kbd>←</kbd> <kbd>→</kbd> along the steps · <kbd>F</kbd> back to now</div>
    </div>`;
    view.__glance = true;
    view.__flow = false;
    view.__html = null;
    S.glanceReady = false;
  }
  const root = view.firstChild;
  const r = S.run;
  const goals = r.goals.map(N).filter(Boolean);
  const live = N(r.currentGoal) ?? goals[goals.length - 1];
  // The spotlight: the live task, unless you moved to another one (see glanceMove).
  let at = S.gSpot ? goals.findIndex((g) => g.id === S.gSpot) : -1;
  if (at < 0) {
    S.gSpot = null;
    at = live ? goals.indexOf(live) : goals.length - 1;
  }
  const spot = goals[at];
  // While the wheel turns, the spotlight stays compressed like the rest: the task unfolds only
  // once it has settled there, so scrolling past tasks doesn't open each one on the way.
  const wait = (S.gMoveAt ?? 0) + GLANCE_SETTLE - Date.now();
  const settled = wait <= 0;
  if (!settled) {
    clearTimeout(S.gSettleTimer);
    S.gSettleTimer = setTimeout(schedule, wait + 20);
  }
  // With the side panel open, a past task shows its conversation there as soon as it reaches the
  // spotlight (from your first message), without waiting for it to unfold; back on the live
  // task, the panel shows what it showed before. A closed panel stays closed.
  const past = !!spot && spot !== live;
  if (past && S.gOpened !== spot.id) {
    S.gOpened = spot.id;
    if (S.selected) {
      if (!S.gAutoSel) S.gPrevSel = { sel: S.selected, pick: S.flowPick, focus: S.focus };
      S.gAutoSel = spot.id;
      S.selected = spot.id;
      S.flowPick = 'start';
      S.focus = { at: 'request' };
    }
  } else if (!past) {
    S.gOpened = null;
    if (S.gAutoSel && S.selected === S.gAutoSel && S.gPrevSel) {
      S.selected = N(S.gPrevSel.sel) ? S.gPrevSel.sel : live.id;
      S.flowPick = S.gPrevSel.pick;
      S.focus = S.gPrevSel.focus;
    }
    S.gAutoSel = null;
    S.gPrevSel = null;
  }

  const s = glanceState();
  const state = root.querySelector('.gx-state');
  const away = !!S.gSpot;
  const cls = `gx-state ${s.st}${away ? ' away' : ''}`;
  if (state.className !== cls) state.className = cls;
  const orb = state.firstChild;
  const path = orb.querySelector('path');
  if (path.getAttribute('d') !== s.path) {
    path.setAttribute('d', s.path);
    orb.classList.remove('swap');
    void orb.offsetWidth; // restart the glyph's fade-in
    orb.classList.add('swap');
  }
  const tip = away ? `${s.tip}\nClick to go back to the current task (F)` : s.tip;
  orb.title = tip;
  orb.setAttribute('aria-label', tip);
  S.glanceSince = s;
  root.querySelector('.gx-time').textContent = glanceTime(s);
  const title = root.querySelector('.gx-title');
  const t = spot ? spot.title : '';
  if (title.textContent !== t) title.textContent = t;
  title.title = t;

  // The wheel: two tasks above the spotlight and two below, compressed to their node and fading
  // with distance. Empty slots keep the spotlight on the same spot at the start and end of the run.
  const wheel = root.querySelector('.gx-wheel');
  const before = new Map();
  for (const el of wheel.children) before.set(el.dataset.key, el.getBoundingClientRect().top);
  const old = new Map([...wheel.children].map((el) => [el.dataset.key, el]));
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = !!S.glanceReady && !calm;
  let prev = null;
  for (let d = -2; d <= 2; d++) {
    const g = goals[at + d];
    const key = g ? g.id : `pad${d}`;
    let el = old.get(key);
    const fresh = !el;
    if (fresh) {
      el = document.createElement('div');
      el.dataset.key = key;
      if (g) el.innerHTML = '<div class="gw-c"></div><div class="gx-track"></div><div class="gx-gaps"><span class="gx-gap l" hidden></span><span class="gx-gap r" hidden></span></div>';
    } else old.delete(key);
    const open = d === 0 && settled;
    const wasOpen = el.classList.contains('spot');
    const c = g
      ? `gw-row d${Math.abs(d)}${open ? ' spot' : ''}${goals[at + d - 1] ? ' up' : ''}${goals[at + d + 1] ? ' down' : ''}`
      : 'gw-row pad';
    if (el.className !== c) el.className = c;
    const next = prev ? prev.nextSibling : wheel.firstChild;
    if (next !== el) wheel.insertBefore(el, next);
    prev = el;
    if (g) glanceRow(el, g, open, open && !wasOpen && !calm);
  }
  for (const el of old.values()) el.remove();
  // Rows slide to their new places (measured before and after); new ones come in from the side
  // the wheel turns from.
  if (animate)
    for (const el of wheel.children) {
      const top = el.getBoundingClientRect().top;
      const from = before.get(el.dataset.key);
      if (from === undefined) {
        if (!el.classList.contains('pad')) el.animate([{ opacity: 0, transform: `translateY(${(S.gDir ?? 1) > 0 ? 36 : -36}px)` }, {}], { duration: glanceFast() ? 170 : 380, easing: 'cubic-bezier(.2,.7,.3,1)' });
      } else if (Math.abs(from - top) > 1) el.animate([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], { duration: glanceFast() ? 170 : 380, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
  S.glanceReady = true;
}

/** Moving fast through the wheel: rows slide quicker so they keep up. */
const glanceFast = () => (S.gStreak ?? 0) >= 2 && Date.now() - (S.gStepAt ?? 0) < 200;

/** How long the wheel must rest before the task in the spotlight unfolds. */
const GLANCE_SETTLE = 140;
/** A step's slot along the spotlight's line, in px (the node itself is --sz in the CSS). */
const GLANCE_SLOT = 88;

/** A task in the wheel: its node when compressed; its chain, on one line, in the spotlight. */
function glanceRow(el, g, open, unfold) {
  const qa = isQA(g);
  const head = flowGoalHead(g, qa);
  const un = unresolvedOf(g);
  const tip = [g.title, [qa ? 'Question' : plural(kids(g).filter((c) => c.type === 'step').length, 'step'), un ? `${un} failed` : '', ago(g.startedAt)].filter(Boolean).join(' · ')].join('\n');
  const node = `<button type="button" class="gw-n" data-gspot="${g.id}" title="${esc(tip)}" aria-label="${esc(g.title)}"><span class="fg-n st-${head.st}">${head.st === 'qa' ? glyphSvg('ask') : head.st === 'done' ? glyphSvg('check') : head.st === 'wait' ? glyphSvg('pause') : ''}${un ? '<span class="fn-b bad">!</span>' : ''}</span></button>`;
  const c = el.firstChild;
  if (c.__html !== node) {
    c.innerHTML = node;
    c.__html = node;
  }
  if (!open) return;
  const track = el.children[1];
  const items = chainItems(g, '')
    .filter((it) => it.st !== 'cap')
    .map((it) => ({ ...it, cls: it.cls.replace(' dim', '') }));
  reconcile(track, items, !unfold && !!S.glanceReady);
  placeChain(el, g, items, unfold);
}

/**
 * Lays the spotlight's chain out on one line: one node in the middle, on the wheel's spine (the
 * live step, the latest one, or the one you picked), the start and the end always in view, and
 * the steps between fading with distance. Steps that don't fit leave a dotted gap.
 */
function placeChain(row, g, items, unfold) {
  const track = row.children[1];
  const els = [...track.children].filter((x) => !x.__leaving);
  const n = items.length;
  if (!n) return;
  const keys = items.map((it) => it.key);
  // The node in the middle.
  let c = S.gFocus?.goal === g.id ? keys.indexOf(S.gFocus.key) : -1;
  // By default: on a past task, your request (where it began); on the live one, the step under
  // way, its goal once it's done, or the latest step.
  if (c < 0 && g.id !== (S.run.currentGoal ?? S.run.goals[S.run.goals.length - 1])) c = 0;
  if (c < 0 && (g.status === 'done' || g.status === 'failed')) c = n - 1;
  if (c < 0) {
    for (let i = n - 1; i >= 0 && c < 0; i--) if (items[i].st === 'live' || items[i].st === 'idle' || items[i].st === 'bad') c = i;
    if (c < 0) c = Math.max(0, n - 2);
  }
  S.gFocusNow = { goal: g.id, keys, c };
  const s = GLANCE_SLOT;
  const W = track.clientWidth;
  const mid = W / 2;
  const L = s / 2 + 4;
  const R = W - s / 2 - 4;
  const nat = (i) => mid + (i - c) * s;
  const pinL = nat(0) < L;
  const pinR = nat(n - 1) > R;
  const x = [];
  const op = [];
  let hidL = 0;
  let hidR = 0;
  for (let i = 0; i < n; i++) {
    let xi = nat(i);
    let o = 1;
    if (i === 0) xi = Math.max(L, xi);
    else if (i === n - 1) xi = Math.min(R, xi);
    else if (i !== c) {
      // Between the pinned ends: room for a gap of one slot next to each pinned end.
      const lo = pinL ? L + s * 1.25 : L;
      const hi = pinR ? R - s * 1.25 : R;
      if (xi < lo - 1) {
        o = 0;
        hidL++;
      } else if (xi > hi + 1) {
        o = 0;
        hidR++;
      } else {
        const d = Math.abs(i - c);
        o = Math.max(0.42, 1 - d * 0.14);
        // Fading out towards a gap.
        if (pinL && xi < lo + s) o *= 0.35 + (0.65 * (xi - lo)) / s;
        if (pinR && xi > hi - s) o *= 0.35 + (0.65 * (hi - xi)) / s;
      }
      xi = Math.max(L, Math.min(R, xi));
    }
    x.push(xi);
    op.push(o);
  }
  // Hidden nodes wait at the gap, so they slide in from there.
  els.forEach((el, i) => {
    if (i >= n) return;
    const to = `translateX(${Math.round(x[i] - s / 2)}px)`;
    if (unfold) {
      el.style.transition = 'none';
      el.style.transform = `translateX(${Math.round(mid - s / 2)}px)`;
      el.style.opacity = '0';
    }
    el.__to = [to, op[i]];
    el.classList.toggle('gx-mid', i === c);
    el.classList.toggle('gx-off', op[i] === 0);
  });
  if (unfold) void track.offsetWidth;
  els.forEach((el, i) => {
    if (i >= n) return;
    if (unfold) el.style.transition = '';
    el.style.transform = el.__to[0];
    el.style.opacity = String(el.__to[1]);
  });
  const [gl, gr] = row.querySelectorAll('.gx-gap');
  gl.hidden = !hidL;
  gr.hidden = !hidR;
  if (hidL) {
    gl.style.left = `${(x[0] + L + s * 1.25) / 2}px`;
    gl.title = `${plural(hidL, 'more step')}: ← to see them`;
  }
  if (hidR) {
    gr.style.left = `${(x[n - 1] + R - s * 1.25) / 2}px`;
    gr.title = `${plural(hidR, 'more step')}: → to see them`;
  }
}

/** Moves the spotlight by `by` tasks, or back to the live task (by = 0). */
function glanceMove(by) {
  const r = S.run;
  if (!r) return;
  const goals = r.goals;
  S.gFocus = null;
  if (!by) {
    if (S.gSpot) S.gMoveAt = Date.now();
    S.gSpot = null;
  } else {
    const live = r.currentGoal ?? goals[goals.length - 1];
    const cur = goals.indexOf(S.gSpot ?? live);
    const to = Math.max(0, Math.min(goals.length - 1, cur + by));
    if (to === cur) return;
    S.gSpot = goals[to] === live ? null : goals[to];
    S.gMoveAt = Date.now();
  }
  S.gDir = by;
  S.gSpotAt = Date.now();
  schedule();
}

function glanceSpot(id) {
  const r = S.run;
  if (!r) return;
  const live = r.currentGoal ?? r.goals[r.goals.length - 1];
  const cur = S.gSpot ?? live;
  if (id === cur) return;
  S.gDir = r.goals.indexOf(id) - r.goals.indexOf(cur);
  S.gSpot = id === live ? null : id;
  S.gFocus = null;
  S.gMoveAt = Date.now();
  S.gSpotAt = Date.now();
  schedule();
}

/** Moves the middle of the spotlight's chain by one step; with a node selected, the selection moves along. */
function glanceStep(by) {
  const f = S.gFocusNow;
  if (!f) return;
  const i = Math.max(0, Math.min(f.keys.length - 1, f.c + by));
  S.gFocus = { goal: f.goal, key: f.keys[i] };
  S.gSpotAt = Date.now();
  if (S.selected) {
    const fn = [...document.querySelectorAll('.gw-row.spot .gx-track > .fn')].find((x) => x.dataset.key === f.keys[i]);
    if (fn) pickNode(fn);
  }
  schedule();
}

/** Selects a chain node (a .fn element) as a click does. */
function pickNode(fn) {
  const key = fn?.dataset.key ?? '';
  const id = fn?.querySelector('[data-fnode]')?.dataset.fnode;
  if (!id) return;
  S.flowPick = key === 'start' || key.startsWith('end:') || key.startsWith('u:') ? key : null;
  select(id);
  // In Glance, the step you pick comes to the middle of the line.
  const row = fn.closest('.gw-row');
  if (row) {
    S.gFocus = { goal: row.dataset.key, key };
    S.gSpotAt = Date.now();
  }
  // The task's nodes (request, your messages, where each round ended) open the task's whole
  // conversation in the panel, with that point glowing.
  S.focus = key === 'start' ? { at: 'request' } : key.startsWith('u:') ? { at: 'msg', id: key.slice(2) } : key.startsWith('end:') ? { at: 'end', round: Number(key.slice(4)) } : null;
}

// The wheel turns one task per notch of the mouse wheel (a trackpad's small steps add up).
$('#pathView').addEventListener(
  'wheel',
  (e) => {
    if (S.view !== 'path' || S.layout !== 'glance' || e.ctrlKey) return;
    e.preventDefault();
    const now = Date.now();
    S.gWheel = (now - (S.gWheelAt ?? 0) > 400 ? 0 : (S.gWheel ?? 0)) + e.deltaY;
    S.gWheelAt = now;
    if (Math.abs(S.gWheel) < 50 || now - (S.gStepAt ?? 0) < 40) return;
    // One task per notch. Only a fast, sustained spin (notches under 120ms apart, several in a
    // row) speeds up, a task more every few notches, up to 5 at a time.
    S.gStreak = now - (S.gStepAt ?? 0) < 120 ? (S.gStreak ?? 0) + 1 : 0;
    S.gStepAt = now;
    const by = Math.min(5, 1 + Math.max(0, Math.floor((S.gStreak - 2) / 3)));
    glanceMove(Math.sign(S.gWheel) * by);
    S.gWheel = 0;
  },
  { passive: false },
);

// The orb's clock moves every second; nothing else is redrawn for it.
setInterval(() => {
  if (document.hidden || !S.run || S.view !== 'path' || S.layout !== 'glance' || !S.glanceSince) return;
  const el = document.querySelector('#pathView .gx-time');
  if (el) el.textContent = glanceTime(S.glanceSince);
  // Left on another task: back to the live one after half a minute without a touch.
  if ((S.gSpot || S.gFocus) && Date.now() - (S.gSpotAt ?? 0) > 30000) glanceMove(0);
}, 1000);

/** At most this many action marks in a capsule; the rest are a "+N" that opens the step. */
const CAP_MAX = 12;
const MARK_KIND = { edit: 'ed', write: 'ed', command: 'cmd', agent: 'sa' };

/**
 * The selected step, opened in place: a capsule of small marks, one per action, in the usual
 * colours (failed red, recovered ringed, running blue). Only while the step or one of its
 * actions is selected, so the chain stays as short as ever otherwise.
 */
function capsuleItem(s, dim) {
  if (!S.selected) return null;
  const acts = descendants(s, isAct).sort((x, y) => ((x.startedAt ?? '') < (y.startedAt ?? '') ? -1 : 1));
  if (!acts.length || (S.selected !== s.id && !acts.some((a) => a.id === S.selected))) return null;
  const marks = acts.slice(0, acts.length > CAP_MAX ? CAP_MAX - 1 : CAP_MAX).map((a, j) => {
    const st = isUnresolved(a) ? 's-bad' : a.status === 'failed' ? 's-rec' : a.status === 'active' ? 's-live' : '';
    const tip = [
      a.title,
      [MARK_LABEL[a.kind] ?? 'Action', a.endedAt ? dur(a.startedAt, a.endedAt) : a.status === 'active' ? 'running' : ''].filter(Boolean).join(' · '),
      st === 's-bad' ? `Failed${a.issue ? ': ' + clip(a.issue, 160) : ''}` : st === 's-rec' ? 'Failed, then recovered' : '',
    ].filter(Boolean).join('\n');
    return `<button type="button" class="fm m-${MARK_KIND[a.kind] ?? 'rd'} ${st}${S.selected === a.id ? ' sel' : ''}" style="--j:${j}" data-select="${a.id}" data-node="${a.id}" title="${esc(tip)}" aria-label="${esc(a.title)}">${icon(a.kind)}</button>`;
  });
  const rest = acts.length - marks.length;
  const more = rest ? `<button type="button" class="fm-more" data-select="${s.id}" title="${plural(rest, 'more action')}: all of them are in the panel">+${rest}</button>` : '';
  return { key: `c:${s.id}`, st: 'cap', cls: `fcap${dim}`, html: `<div class="fcap-in"${heatStyle(s.id)}>${marks.join('')}${more}</div>` };
}
const MARK_LABEL = { read: 'Read', edit: 'Edit', write: 'Write', command: 'Command', search: 'Search', web: 'Web', agent: 'Subagent', ask: 'Question', other: 'Other' };

/** A capsule closing: it folds back to nothing, pulling the nodes after it in, then goes. */
function foldAway(el) {
  if (el.__leaving) return;
  el.__leaving = true;
  el.style.overflow = 'hidden';
  const cs = getComputedStyle(el);
  el.__anim = el.animate(
    [
      { maxWidth: `${el.offsetWidth}px`, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight, marginLeft: cs.marginLeft, opacity: 1 },
      { maxWidth: '0px', paddingLeft: '0px', paddingRight: '0px', marginLeft: '0px', opacity: 0 },
    ],
    { duration: 220, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
  );
  el.__anim.onfinish = () => el.__leaving && el.remove();
}

/** Keyed update of a list of elements: reuse, reorder, add (with an entrance) and remove. */
function reconcile(parent, items, animate) {
  const old = new Map();
  for (const el of parent.children) old.set(el.dataset.key, el);
  // Capsules on their way out stay where they are while they fold (see foldAway).
  const keep = new Set(items.map((it) => it.key));
  for (const [k, el] of old) if (!keep.has(k) && el.classList.contains('fcap')) el.__leaving ||= 'soon';
  let prev = null;
  for (const it of items) {
    let el = old.get(it.key);
    const fresh = !el;
    if (fresh) {
      el = document.createElement('div');
      el.dataset.key = it.key;
    } else old.delete(it.key);
    if (el.__leaving) {
      // Selected again while folding: open it back up.
      el.__anim?.cancel();
      el.__leaving = false;
      el.style.overflow = '';
    }
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
    let next = prev ? prev.nextSibling : parent.firstChild;
    while (next && next.__leaving && next !== el) next = next.nextSibling;
    if (next !== el) parent.insertBefore(el, next);
    prev = el;
    // A capsule that opens past the chain's edge: bring it into view once it has its width.
    if (fresh && it.st === 'cap') setTimeout(() => el.isConnected && el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }), 300);
  }
  for (const el of old.values()) {
    if (el.__leaving === 'soon') {
      el.__leaving = false;
      foldAway(el);
    } else if (!el.__leaving) el.remove();
  }
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
    html: `<span class="fg-n st-${st}"${heatStyle(g.id)}${S.heat ? ` title="${esc(heatTip(g.id).trim())}"` : ''}>${glyph}${un ? '<span class="fn-b bad">!</span>' : ''}</span>
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

/** Expand all / collapse all, as a compact icon button: arrows apart to expand, together to collapse. */
function setExpandBtn(collapse) {
  const b = $('#expandAll');
  const label = collapse ? 'Collapse all (E)' : 'Expand all (E)';
  if (b.title === label) return;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.textContent = collapse ? 'Collapse all' : 'Expand all';
}

/** The button's label from the tasks as rendered: Collapse all once every listed one is open. */
function syncExpandBtn(view, simple) {
  const rows = [...view.querySelectorAll(simple ? '.fg:not(.qa)' : ':scope > .task')];
  const collapse = rows.length > 0 && rows.every((el) => el.classList.contains('open'));
  $('#expandAll').dataset.collapse = collapse ? '1' : '';
  setExpandBtn(collapse);
}

const MODE_LABEL = { all: 'All', open: 'Failed', recovered: 'Recovered', agents: 'Subagents', qa: 'Questions' };

/** The filters as chips, plus the same as a menu for when the toolbar is too narrow for chips. */
function modesHtml(modes, nOpen) {
  const cur = S.pf.mode;
  const chips = modes
    .filter(([m, , n]) => m === 'all' || n || cur === m)
    .map(([m, label, n, cls]) => `<button class="chip-f${cur === m ? ' on' : ''} ${n ? cls : ''}" data-mode="${m}">${label}${n !== null ? ` <span class="n">${n}</span>` : ''}</button>`)
    .join('');
  const n = modes.find(([m]) => m === cur)?.[2];
  const alert = nOpen && cur !== 'open' ? `<i class="fsel-dot" title="${plural(nOpen, 'step')} with failures nothing has fixed yet"></i>` : '';
  const menu = S.fselOpen
    ? `<div class="fsel-menu" role="menu">${modes
        .map(([m, label, k, cls]) => `<button type="button" role="menuitemradio" aria-checked="${cur === m}" class="${cur === m ? 'on' : ''} ${k ? cls : ''}" data-mode="${m}"${m !== 'all' && !k && cur !== m ? ' disabled' : ''}><span>${label}</span>${k !== null ? `<span class="n">${k}</span>` : ''}</button>`)
        .join('')}</div>`
    : '';
  return `<div class="chips-row">${chips}</div><div class="fsel"><button type="button" class="fsel-b${S.fselOpen ? ' open' : ''}" data-fsel aria-haspopup="menu" aria-expanded="${!!S.fselOpen}" title="Show">${MODE_LABEL[cur] ?? 'All'}${n ? ` <span class="n">${n}</span>` : ''}${alert}${SVG('M7 10l5 5 5-5', 'dd')}</button>${menu}</div>`;
}

/** Chips while they fit on one row with the rest of the toolbar; a menu when they don't. */
function fitToolbar() {
  const tb = $('#tbPath');
  if (tb.hidden) return;
  tb.classList.remove('tight');
  const kids = [...tb.children].filter((el) => el.offsetParent !== null);
  // Items are centred on the row: an item whose middle sits lower than the first one's has wrapped.
  const mid = (el) => el.offsetTop + el.offsetHeight / 2;
  const wrapped = kids.length > 1 && kids.some((el) => mid(el) > mid(kids[0]) + 10);
  tb.classList.toggle('tight', wrapped);
}
new ResizeObserver(() => {
  fitToolbar();
  // Glance lays the spotlight's line out in pixels: again at the new width.
  if (S.run && S.view === 'path' && S.layout === 'glance') schedule();
}).observe($('#pane'));

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
  const nQA = goals.filter(isQA).length;
  const modes = [
    ['all', 'All', null, ''],
    ['open', 'Failed', nOpen, 'bad'],
    ['recovered', 'Recovered', nRec, ''],
    ['agents', 'Subagents', nAgents, ''],
    ['qa', 'Questions', nQA, ''],
  ];
  const files = S.layout === 'files';
  const simple = S.layout === 'simple';
  const view = $('#pathView');
  $('#pathModes').hidden = files;
  $('#hideChat').closest('.switch').hidden = files;
  if (!files) setHTML($('#pathModes'), modesHtml(modes, nOpen));
  // Hide Q&A only means something in All: the other filters leave questions out anyway, and
  // Questions shows nothing else. Elsewhere it stays in place, greyed out (no reshuffling).
  const sw = $('#hideChat').closest('.switch');
  const applies = S.pf.mode === 'all';
  $('#hideChat').checked = S.pf.hideChat && applies;
  $('#hideChat').disabled = !applies;
  sw.classList.toggle('off', !applies);
  sw.title = !applies
    ? `Only applies to All: ${S.pf.mode === 'qa' ? 'Questions shows only them' : 'this filter already leaves questions out'}`
    : nQA
      ? `${S.pf.hideChat ? 'Hiding' : 'Hide'} ${plural(nQA, 'question')} answered without any work`
      : 'No questions answered without work in this run yet: nothing to hide for now';
  if (files) setExpandBtn(S.ff.open.size > 0);
  applyFlowZoom();
  const hb = $('#heatBtn');
  hb.hidden = files;
  hb.classList.toggle('on', S.heat);
  hb.setAttribute('aria-pressed', String(S.heat));
  hb.title = S.heat ? 'Token heat on: tasks and steps glow green to red by tokens used, relative to the rest of the run (H)' : 'Token heat: make tasks and steps glow green to red by tokens used (H)';
  $('#pathSearch').placeholder = files ? 'Filter files and edits' : 'Search steps, files, commands';
  requestAnimationFrame(fitToolbar);
  const glance = S.layout === 'glance';
  $('#tbPath').classList.toggle('tb-glance', glance);
  if (glance) return void renderGlance(view);
  view.__glance = false;
  if (files) {
    if (view.__flow) {
      view.__flow = false;
      view.__html = null;
    }
    view.classList.remove('working');
    setHTML(view, filesHtml(q));
    return;
  }
  if (simple) {
    view.classList.remove('working');
    const mode = S.pf.mode;
    const shown = goals.filter((g) =>
      mode === 'qa' ? isQA(g) : mode === 'all' ? !(S.pf.hideChat && isQA(g)) : kids(g).some((s) => s.type === 'step' && stepMatches(s, '')),
    );
    renderFlow(view, shown, q);
    syncExpandBtn(view, true);
    return;
  }
  if (view.__flow) {
    view.__flow = false;
    view.__html = null;
  }
  const html = goals.map((g) => taskHtml(g, q)).join('');
  view.classList.toggle('working', S.run.status === 'working' && !isStale());
  setHTML(
    view,
    html ||
    (goals.length
      ? '<div class="no-match">Nothing matches these filters.</div>'
      : '<div class="no-match">The run is open. Progress appears as soon as the agent does something.</div>'),
  );
  syncExpandBtn(view, false);
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
  void syncWake(); // the run's state decides whether "only while working" holds the lock
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
        if (S.view === 'path' && S.layout === 'files') schedule();
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
  if (mode === 'shell' || mode === 'python' || mode === 'javascript') return highlight(text, mode);
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

/*
 * Copy buttons. Each holds an id into a registry of texts, not the text itself (outputs can be
 * long). Ids only grow; the oldest entries go once there are many, long after their buttons were
 * redrawn away.
 */
const copies = new Map();
let copySeq = 0;
const COPY_ICON = 'M9 9h10v11H9z M5 15V4h10';
function copyBtn(text) {
  const what = 'Copy to clipboard';
  const id = ++copySeq;
  copies.set(id, String(text ?? ''));
  if (copies.size > 4000) copies.delete(copies.keys().next().value);
  return `<button type="button" class="cpy" data-copy="${id}" title="${esc(what)}" aria-label="${esc(what)}">${SVG(COPY_ICON)}</button>`;
}

async function copyText(btn) {
  const text = copies.get(Number(btn.dataset.copy));
  if (text === undefined) return toast('Nothing to copy: select the item again');
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add('ok');
    clearTimeout(btn.__t);
    btn.__t = setTimeout(() => btn.classList.remove('ok'), 1200);
  } catch {
    toast('Clipboard not available');
  }
}

/** A diff as unified text: hunk headers, then lines marked +, - or a space. */
const diffText = (rows) => rows.map((r) => (r.t === 'hunk' ? r.text : `${r.t === 'add' ? '+' : r.t === 'del' ? '-' : ' '}${r.text}`)).join('\n');

function preBlock(key, label, text, cls = '', mode = 'auto', copy = text) {
  const lines = String(text ?? '').split('\n');
  const LIMIT = 16;
  const full = S.fullPre.has(key) || lines.length <= LIMIT;
  const shown = full ? text : lines.slice(0, LIMIT).join('\n');
  let body = cls.includes('failed') ? esc(shown) : diffHtml(shown, mode);
  if (cls.includes('hang')) body = hangLines(body);
  return `<div class="pl"><span class="pl-t">${esc(label)}</span>${copyBtn(copy)}</div><pre class="${cls}">${body}</pre>${
    full ? '' : `<button class="show-all" data-full="${esc(key)}">Show all ${lines.length} lines</button>`
  }`;
}

/**
 * Highlighted HTML as one block per line, for a hanging indent: a long line that wraps continues
 * indented, so each real line stands out. Colour spans open across a line break are closed at its
 * end and opened again on the next line.
 */
function hangLines(html) {
  const out = [];
  let open = [];
  let line = '';
  for (const m of String(html).matchAll(/<span[^>]*>|<\/span>|\n|[^<\n]+|</g)) {
    const t = m[0];
    if (t === '\n') {
      out.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      if (t.startsWith('<span')) open.push(t);
      else if (t === '</span>') open = open.slice(0, -1);
      line += t;
    }
  }
  out.push(line);
  return out.map((l) => `<span class="ln">${l || ' '}</span>`).join('');
}

/**
 * Dense JavaScript laid out for reading: a line break after `{`, `;` and `}`, indented by brace
 * depth. Display only (the code itself is shown as written next to it), so it stays simple:
 * strings, template literals, comments and regex literals are kept whole; everything else is
 * left as it is.
 */
function reformatJs(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?)|(\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*)|([{}();\n])|([^'"`/{}();\n]+|\/)/g;
  let out = '';
  let depth = 0;
  let parens = 0;
  let prevSig = '';
  const nl = () => {
    out = out.replace(/[ \t]+$/, '');
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const put = (t) => {
    if (out.endsWith('\n') || !out) t = '  '.repeat(Math.max(0, depth)) + t.replace(/^\s+/, '');
    out += t;
  };
  for (const m of code.matchAll(re)) {
    const [t, com, str, rx, punct, other] = m;
    if (rx !== undefined && !/[\w$)\]]$/.test(prevSig)) {
      // A regex literal where a value is expected; after a value, '/' is division.
      put(t);
      prevSig = t;
      continue;
    }
    if (com !== undefined || str !== undefined) {
      put(t);
      if (com?.startsWith('//')) nl();
      prevSig = t;
      continue;
    }
    const p = punct;
    if (p === '\n') {
      nl();
      continue;
    }
    if (p === '(') parens++;
    if (p === ')') parens = Math.max(0, parens - 1);
    if (p === '{') {
      put('{');
      depth++;
      nl();
    } else if (p === '}') {
      depth = Math.max(0, depth - 1);
      nl();
      put('}');
      // `} else`, `});`, `},` stay on the line; anything else starts a new one.
      const rest = code.slice(m.index + 1).match(/^\s*(\S)/)?.[1] ?? '';
      if (!/[;,)\].]/.test(rest) && !/^\s*(?:else|catch|finally|while)\b/.test(code.slice(m.index + 1))) nl();
    } else if (p === ';') {
      put(';');
      if (!parens) nl();
    } else if (p) put(p);
    else put(rx !== undefined ? t : other ?? t);
    if (t.trim()) prevSig = t.trim();
  }
  return out.replace(/\n+$/, '');
}

/** Code dense enough to be worth reformatting: some line over 100 characters. */
const isDense = (code) => String(code).split('\n').some((l) => l.length > 100);

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
const highlight = (code, lang) => (lang === 'python' ? hlPython(code) : lang === 'shell' ? hlShell(code) : lang === 'javascript' ? hlJs(code) : esc(code));

/**
 * Language of a script or of content a command writes. Wider than langOf, which also drives the
 * line-by-line diff colouring: there, multi-line JavaScript comments and template strings would
 * be coloured wrongly, so JavaScript stays out of diffs for now.
 */
function scriptLang(path) {
  const lang = langOf(path);
  if (lang) return lang;
  const ext = /\.([A-Za-z0-9]+)$/.exec(String(path ?? ''))?.[1]?.toLowerCase();
  return ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'json'].includes(ext) ? 'javascript' : null;
}
const LANG_NAMES = { javascript: 'JavaScript', python: 'Python', shell: 'Shell' };

const JS_KW = new Set(
  'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as interface type enum implements declare readonly public private protected abstract keyof satisfies'.split(' '),
);
const JS_BI = new Set(
  'true false null undefined NaN Infinity console require module exports process JSON Math Object Array Promise Map Set String Number Boolean Error RegExp Date Symbol Buffer globalThis window document'.split(' '),
);

/**
 * JavaScript / TypeScript (and JSON): comments, strings (template literals whole, ${} included),
 * numbers, keywords, built-ins, and the names after function / class. Regex literals are not
 * recognized (telling them from division needs a parser): they show as plain text.
 */
function hlJs(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?)|(\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b)|([A-Za-z_$][\w$]*)/g;
  let out = '';
  let last = 0;
  let prev = '';
  for (let m; (m = re.exec(code)); ) {
    out += esc(code.slice(last, m.index));
    last = re.lastIndex;
    const [t, com, str, num, word] = m;
    if (com) out += span('c', t);
    else if (str) out += span('s', t);
    else if (num) out += span('n', t);
    else if (word) {
      if (prev === 'function' || prev === 'class') out += span('f', t);
      else if (JS_KW.has(t)) out += span('k', t);
      else if (JS_BI.has(t)) out += span('b', t);
      else out += esc(t);
      prev = t;
      continue;
    }
    prev = '';
  }
  return out + esc(code.slice(last));
}

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
  return `<div class="pl dfile"><span title="${esc(file)}">${esc(relPath(file))}</span><span class="dstat">${del ? `<span class="d">−${del}</span>` : ''}${add ? `<span class="a">+${add}</span>` : ''}${copyBtn(diffText(rows))}</span></div>
    <div class="diff"><table>${body}</table></div>${full ? '' : `<button class="show-all" data-full="${esc(key)}">Show all ${rows.length} lines</button>`}`;
}

/**
 * The chunk a task's node points at in its conversation (S.focus): the request, one of your
 * messages, or a round's result (the last result before the reply that continued it; the final
 * one for the last round).
 */
function focusChunk(rootId, chunks) {
  const f = S.focus;
  if (!f || S.selected !== rootId || N(rootId)?.type !== 'goal') return null;
  if (f.at === 'request') return chunks.find((c) => c.kind === 'prompt') ?? null;
  if (f.at === 'msg') return chunks.find((c) => c.kind === 'prompt' && c.node === f.id) ?? null;
  const replies = kids(N(rootId)).filter((c) => c.round);
  const reply = replies[f.round];
  const until = reply ? chunks.findIndex((c) => c.kind === 'prompt' && c.node === reply.id) : chunks.length;
  return chunks.slice(0, until < 0 ? chunks.length : until).findLast((c) => c.kind === 'outcome') ?? null;
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
  const focus = focusChunk(rootId, chunks);
  const glow = (c) => (c === focus ? ' focus' : '');
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
        {
          const sub = c.label === 'Task given to subagent';
          out.push(`<div class="ev ev-prompt${sub ? '' : ' you'}${glow(c)}">${copyBtn(c.text)}<span class="who">${sub ? 'Task for subagent' : 'You'}</span>${esc(c.text)}</div>`);
        }
        break;
      case 'text':
        out.push(`<div class="ev ev-text">${copyBtn(c.text)}${md(c.text)}</div>`);
        break;
      case 'plan':
        out.push(`<div class="ev ev-text ev-plan">${copyBtn(c.text)}<span class="who">Plan</span>${md(c.text)}</div>`);
        break;
      case 'outcome':
        out.push(`<div class="ev ev-text ev-outcome${glow(c)}">${copyBtn(c.text)}<span class="who">Result</span>${md(c.text)}</div>`);
        break;
      case 'thinking':
        out.push(`<details class="ev ev-think"><summary>Thinking…</summary><div>${copyBtn(c.text)}${esc(c.text)}</div></details>`);
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

/**
 * A shell command. A long one comes in parts, from the server: its shell lines, a script it runs
 * (highlighted in its language), content it writes to a file, other text it feeds a command. The
 * whole command, as recorded, is one click away.
 */
function commandHtml(c, n) {
  const key = `${c.node}:in`;
  const parts = Array.isArray(c.parts) && c.parts.length ? c.parts : null;
  // Commands that change files get a hanging indent, and dense JavaScript can be reformatted.
  const edits = n?.via === 'command';
  const hang = edits ? 'hang' : '';
  const toggle = (label) => `<button class="show-all" data-wholecmd="${esc(c.node)}">${label}</button>`;
  if (!parts || S.wholeCmd.has(c.node)) return preBlock(key, 'Command', c.text, hang, 'shell') + (parts ? toggle('Show in parts') : '');
  const prompt = /^PS>/.test(c.text) ? 'PS> ' : '$ ';
  let shells = 0;
  const code = (k, label, text, lang) => {
    if (!edits || lang !== 'javascript' || !isDense(text)) return preBlock(k, label, text, hang, lang);
    const on = S.reformat.has(k);
    return (
      preBlock(k, on ? `${label} · reformatted` : label, on ? reformatJs(text) : text, hang, lang, text) +
      `<button class="show-all" data-reformat="${esc(k)}">${on ? 'Show as written' : 'Reformat for reading'}</button>`
    );
  };
  const html = parts.map((p, i) => {
    const k = `${key}:${i}`;
    if (p.kind === 'shell') return preBlock(k, shells++ ? 'Then' : 'Command', (shells === 1 ? prompt : '') + p.text, hang, 'shell', p.text);
    if (p.kind === 'script') return code(k, `Script${LANG_NAMES[p.lang] ? ` · ${LANG_NAMES[p.lang]}` : p.lang ? ` · ${p.lang}` : ''}`, p.text, p.lang);
    if (p.kind === 'content') return code(k, `Written to ${relPath(p.file)}`, p.text, scriptLang(p.file) ?? '');
    return preBlock(k, 'Input', p.text, hang, '');
  });
  return html.join('') + toggle('Show the whole command');
}

/** An action's input: a diff for file changes, the command or raw input otherwise. */
function inputHtml(c, n, result) {
  const file = n.files?.[0] ?? String(c.text).split('\n')[0].replace(/^(?:Edit|Write)\s+/, '');
  if (result?.patch?.length && !result.failed) return diffView(`${c.node}:diff`, file, markWords(rowsFromPatch(result.patch)), true);
  // Changed by a shell command: the transcript has the command, not the change.
  if (n.via === 'command' || n.kind === 'command') return commandHtml(c, n);
  if (n.kind === 'edit') return diffView(`${c.node}:diff`, file, markWords(rowsFromInput(c.text)), false);
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

/**
 * The details panel slides open and shut (fast) instead of snapping: its width animates while
 * its content keeps the final width, so the text doesn't rewrap as it goes.
 */
function panelAnim(el, open) {
  // Turned around halfway: carry on from the width it has now.
  const from = el.__anim && !el.hidden ? el.offsetWidth : null;
  el.__anim?.cancel();
  el.__closing = !open;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.hidden = !open;
    el.__closing = false;
    return;
  }
  el.hidden = false;
  const w = el.offsetWidth;
  const px = `${w}px`;
  el.style.setProperty('--dw', px);
  el.classList.add('anim');
  const a = (el.__anim = el.animate(
    open ? [{ flexBasis: `${from ?? 0}px`, opacity: from === null ? 0.3 : 1 }, { flexBasis: px, opacity: 1 }] : [{ flexBasis: `${from ?? w}px`, opacity: 1 }, { flexBasis: '0px', opacity: 0.3 }],
    { duration: open ? 180 : 160, easing: open ? 'cubic-bezier(.2,.7,.3,1)' : 'cubic-bezier(.4,0,.7,1)', fill: 'forwards' },
  ));
  a.onfinish = () => {
    if (el.__anim !== a) return;
    el.__anim = null;
    el.classList.remove('anim');
    if (!open) {
      el.hidden = true;
      el.__closing = false;
    }
    a.cancel();
  };
}

function renderDetail() {
  const el = $('#detail');
  const n = N(S.selected);
  if (!n || !S.run) {
    if (!el.hidden && !el.__closing) panelAnim(el, false);
    delete el.dataset.shown;
    return;
  }
  if (el.hidden || el.__closing) panelAnim(el, true);
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
  // Bring the glowing point into view once, when it is first shown (not on every redraw).
  const glow = chunks && el.querySelector('.ev.focus');
  const focusKey = glow ? `${n.id}|${JSON.stringify(S.focus)}` : null;
  if (glow && S.focusShown !== focusKey) {
    S.focusShown = focusKey;
    glow.classList.add('flash');
    el.scrollTop += glow.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
    return;
  }
  if (!glow) S.focusShown = null;
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
  if (r.kind !== 'edit' || r.via || !r.input || r.input.endsWith('\n…')) return '';
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
    ? '<span class="fb rec" title="This failed, then something succeeded after it, in the same step">failed → recovered</span>'
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
  if (v === 'glance' || v === 'simple' || v === 'detailed' || v === 'files') {
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
  S.heatMap = computeHeat();
  $('#pane').classList.toggle('heat-on', S.heat);
  renderHeader();
  const has = !!S.run;
  const pane = $('#pane');
  $('#empty').hidden = has;
  $('#overview').hidden = !has;
  pane.classList.toggle('pin-ov', has && S.pinOv);
  if (!S.pinOv) $('#overview').classList.remove('compact');
  $('#tbPath').hidden = $('#pathView').hidden = !has || S.view !== 'path';
  pane.classList.toggle('glance-on', has && S.view === 'path' && S.layout === 'glance');
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
  Object.assign(S, { runId, run: null, nodes: {}, selected: null, follow: false, raw: new Map(), lastFollowTarget: null, expandAll: null, firstPaint: true, seenActs: null });
  for (const set of [S.openGoals, S.closedGoals, S.openSteps, S.closedSteps, S.allActs, S.openActs, S.closedActs]) set.clear();
  Object.assign(S, { actions: null, actionsStale: true, actionsLimit: 400, stripRows: [], zoom: { a: 0, b: 1 } });
  writeHash();
  const es = new EventSource(`/api/s/${runId}/stream`);
  S.es = es;
  es.addEventListener('open', () => setDown(false));
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
      const res = await fetch('/api/runs', { signal: AbortSignal.timeout(8000) });
      const { runs } = await res.json();
      setDown(false);
      if (!runs.some((r) => r.id === runId) && S.runId === runId) {
        es.close();
        S.run = null;
        S.runId = null;
        history.replaceState(null, '', '#');
        schedule();
        openPicker();
      }
    } catch {
      // The server is gone: say so. EventSource keeps retrying, and reconnects when it is back.
      setDown(true);
    }
  };
}

// ───────────────────────────── picker
/*
 * The session list. While it is open (and the tab is visible) it refreshes every few seconds, so a
 * session started in the meantime shows up at once; the server only reads again the files that
 * changed. A refresh is quiet: no "Loading…", the list is only redrawn if it changed, and a failed
 * one leaves the list as it was (the server-stopped bar says why).
 */
const PICKER_REFRESH = 4000;
async function openPicker({ quiet = false } = {}) {
  const dlg = $('#picker');
  if (!dlg.open) {
    if (quiet) return;
    dlg.showModal();
  }
  S.pickerTimer ??= setInterval(() => {
    if (!dlg.open) S.pickerTimer = void clearInterval(S.pickerTimer);
    else if (!document.hidden) openPicker({ quiet: true });
  }, PICKER_REFRESH);
  for (const b of dlg.querySelectorAll('[data-scope]')) b.classList.toggle('on', b.dataset.scope === S.pickerScope);
  const list = $('#pickerList');
  if (!quiet) fill(list, '<li class="mute">Loading…</li>');
  // Only the latest request may fill the list (switching tabs while one is slow), and a failure
  // says so with a retry instead of leaving "Loading…" up for good. A quiet refresh takes the
  // current ticket: it never cancels a visible load still in flight.
  const ticket = quiet ? S.pickerTicket : (S.pickerTicket = (S.pickerTicket ?? 0) + 1);
  const get = async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`the server answered ${r.status}`);
    return r.json();
  };
  let runs, data;
  try {
    [{ runs }, data] = await Promise.all([get('/api/runs'), get(`/api/sessions?scope=${S.pickerScope}`)]);
    if (!Array.isArray(runs) || !Array.isArray(data?.sessions)) throw new Error('unexpected reply from the server');
  } catch (e) {
    if (ticket !== S.pickerTicket || quiet) return;
    const why = e?.name === 'TimeoutError' ? 'the server took too long to answer' : e instanceof TypeError ? 'the Lucidly server is not reachable (is it still running?)' : (e?.message ?? String(e));
    fill(list, `<li class="mute perr">Couldn't load the sessions: ${esc(why)}. <button type="button" class="tbtn" data-picker-retry>Retry</button></li>`);
    return;
  }
  if (ticket !== S.pickerTicket) return;
  const others = runs.filter((r) => !r.key.startsWith('claude:'));
  fill($('#pickerOpen'), others.length
    ? `<div class="psec">Open in Lucidly</div><ul class="plist">${others
        .map((r) => `<li data-run="${r.id}"><span class="dot${r.live ? ' live' : ''}"></span><div class="pm"><div class="pt">${esc(r.title ?? r.label)}</div><div class="ps">${esc(r.live ? 'Live stream' : 'Saved run')} · ${r.eventCount} events</div></div></li>`)
        .join('')}</ul>`
    : '');
  if (!data.sessions.length) {
    fill(list, `<li class="mute">${S.pickerScope === 'project' ? `No Claude Code sessions for ${esc(data.cwd)} yet. Try “All projects”.` : 'No Claude Code sessions found.'}</li>`);
    return;
  }
  S.pickerData = data;
  fill(list, sessionListHtml(data));
}

// Redraw only on change (compared with what was last written: the browser may serialize differently).
function fill(el, html) {
  if (el.lucidlyHtml !== html) el.innerHTML = el.lucidlyHtml = html;
}

function sessionRow(s, withDir) {
  const title = s.title ?? s.firstPrompt ?? s.id;
  const sub = [s.title ? s.firstPrompt : '', withDir ? s.cwd ?? s.project : ''].filter(Boolean).join(' · ');
  return `<li data-path="${esc(s.path)}" title="${esc(s.path)}">
        <span class="dot${s.live ? ' live' : ''}" title="${s.live ? 'Active in the last few minutes' : ''}"></span>
        <div class="pm"><div class="pt">${esc(title)}</div><div class="ps">${esc(sub)}</div></div>
        <span class="pw">${esc(ago(s.mtime))}</span></li>`;
}

/** A directory as a comparable key: forward slashes, no trailing slash, any case on Windows. */
const dirKey = (p) => {
  const k = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(k) ? k.toLowerCase() : k;
};

/**
 * The session list. On "All projects" sessions are grouped by project directory: the project
 * Lucidly was started from first, then by the latest session. Groups fold; what you open or close
 * is kept (S.pgOpen) across the list's refreshes. By default the start project and any project
 * with a live session are open, or every project when there are only a few.
 */
function sessionListHtml(data) {
  if (S.pickerScope !== 'all') return data.sessions.map((s) => sessionRow(s, false)).join('');
  const here = dirKey(data.cwd);
  const groups = new Map();
  for (const s of data.sessions) {
    const key = s.cwd ? dirKey(s.cwd) : `project:${s.project}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, dir: s.cwd ?? s.project ?? '', named: !!s.cwd, sessions: [], latest: 0, live: false }));
    g.sessions.push(s);
    g.latest = Math.max(g.latest, s.mtime);
    g.live ||= !!s.live;
  }
  const list = [...groups.values()].sort((a, b) => (b.key === here) - (a.key === here) || b.latest - a.latest);
  const few = list.length <= 3;
  const isOpen = (g) => S.pgOpen?.get(g.key) ?? (few || g.key === here || g.live);
  const allOpen = list.every(isOpen);
  const bar = list.length > 1 ? `<li class="pbar"><button type="button" class="linkbtn" data-pgall="${allOpen ? 'close' : 'open'}">${allOpen ? 'Collapse all' : 'Expand all'}</button></li>` : '';
  return (
    bar +
    list
      .map((g) => {
        const open = isOpen(g);
        const name = g.named ? g.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || g.dir : g.dir;
        const head = `<button type="button" class="pg-h" data-pgroup="${esc(g.key)}" aria-expanded="${open}" title="${esc(g.dir)}">
          <span class="dot${g.live ? ' live' : ''}"></span>
          <span class="pg-n">${esc(name)}</span>${g.key === here ? '<span class="pg-here">this project</span>' : ''}
          <span class="pg-d">${g.named ? esc(g.dir) : ''}</span>
          <span class="pg-c">${plural(g.sessions.length, 'session')} · ${esc(ago(g.latest))}</span>${CHEV}</button>`;
        return `<li class="pg${open ? ' open' : ''}">${head}${open ? `<ul>${g.sessions.map((s) => sessionRow(s, false)).join('')}</ul>` : ''}</li>`;
      })
      .join('')
  );
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
// ───────────────────────────── keep awake (the Screen Wake Lock API)
/*
 * Holds a screen wake lock so the device doesn't sleep. "Only while the agent works" holds it
 * while a turn is running and lets it go once the session is idle. Browsers drop the lock when
 * the tab is hidden; it is taken again as soon as the tab is visible.
 */
const QUIET_LIMIT = 30 * 60 * 1000; // a "working" session with no news for this long has stopped
S.wake = {
  on: localStorage.getItem('lucidly.wake') === '1',
  onlyWorking: localStorage.getItem('lucidly.wakeWorking') !== '0',
  lock: null,
  pending: false,
  err: '',
};
const wakeSupported = () => 'wakeLock' in navigator;
const agentWorking = () => !S.downAt && !!S.run && S.run.status === 'working' && !!S.run.updatedAt && Date.now() - Date.parse(S.run.updatedAt) < QUIET_LIMIT;
const wakeWanted = () => S.wake.on && wakeSupported() && document.visibilityState === 'visible' && (!S.wake.onlyWorking || agentWorking());

async function syncWake() {
  const w = S.wake;
  if (wakeWanted() && !w.lock && !w.pending) {
    w.pending = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => {
        // Released by the browser (tab hidden, battery saver...): take it again when we can.
        if (w.lock !== lock) return;
        w.lock = null;
        renderWake();
      });
      w.lock = lock;
      w.err = '';
    } catch (e) {
      w.err = e?.message || 'The browser refused';
    }
    w.pending = false;
    if (!wakeWanted()) return syncWake(); // things changed while we waited
  } else if (!wakeWanted() && w.lock) {
    const lock = w.lock;
    w.lock = null;
    lock.release().catch(() => {});
  }
  renderWake();
}
document.addEventListener('visibilitychange', () => void syncWake());
setInterval(() => void syncWake(), 20000); // a working session that falls quiet lets go in time

function wakeState() {
  const w = S.wake;
  if (!w.on) return ['off', 'Off: the device sleeps as usual'];
  if (!wakeSupported()) return ['err', "This browser can't keep the device awake"];
  if (w.err) return ['err', `Couldn't keep the device awake: ${w.err}`];
  if (w.lock) return ['awake', w.onlyWorking ? 'Awake while the agent works' : 'Keeping the device awake'];
  if (document.visibilityState !== 'visible') return ['wait', 'Paused while this tab is hidden'];
  if (w.onlyWorking && !agentWorking()) return ['wait', 'The agent is idle: the device may sleep. Awake again as soon as it works'];
  return ['wait', 'Starting…'];
}

function renderWake() {
  const [st, text] = wakeState();
  const btn = $('#wakeBtn');
  btn.dataset.wake = st;
  const label = st === 'off' ? 'Keep this device awake' : `Keep awake: ${text.toLowerCase()}`;
  if (btn.title !== label) {
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  const pop = $('#wakePop');
  if (pop.hidden) return;
  const w = S.wake;
  setHTML(
    pop,
    `<div class="pop-h">Keep awake</div>
    <label class="switch wk-row"><input type="checkbox" data-wake="on"${w.on ? ' checked' : ''} /><span></span>Keep this device from sleeping</label>
    ${w.on ? `<label class="wk-opt"><input type="checkbox" data-wake="working"${w.onlyWorking ? ' checked' : ''} /><span><b>Only while the agent is working</b><small>Once the work is done and the session is idle, the device can sleep again.</small></span></label>` : ''}
    <div class="wk-st st-${st}"><i></i>${esc(text)}</div>
    <p class="wk-note">Works while this tab is visible: a hidden or minimised tab lets the device sleep.</p>`,
  );
}

function toggleWake(show = $('#wakePop').hidden) {
  $('#wakePop').hidden = !show;
  $('#wakeBtn').classList.toggle('on', show);
  renderWake();
}

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.dataset.wake) return;
  if (t.dataset.wake === 'on') {
    S.wake.on = t.checked;
    S.wake.err = '';
    localStorage.setItem('lucidly.wake', t.checked ? '1' : '0');
  } else {
    S.wake.onlyWorking = t.checked;
    localStorage.setItem('lucidly.wakeWorking', t.checked ? '1' : '0');
  }
  void syncWake();
});

function toggleTokens(show = $('#tokensPop').hidden) {
  $('#tokensPop').hidden = !show;
  $('#tokens').classList.toggle('on', show);
  renderTokens();
}

// ───────────────────────────── simple view zoom
/** The zoom steps of the simple view: half to twice the normal size. */
const FLOW_ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];

/**
 * Zooms the simple view by a step (+1 / -1), or back to normal (0). It scales the layout itself
 * (CSS zoom), so text stays sharp and the chains keep scrolling; the spot in the middle of the
 * pane stays put while everything grows or shrinks around it.
 */
function zoomFlow(dir) {
  const i = FLOW_ZOOMS.indexOf(S.fz);
  setFlowZoom(dir === 0 ? 1 : FLOW_ZOOMS[Math.max(0, Math.min(FLOW_ZOOMS.length - 1, (i < 0 ? 3 : i) + dir))]);
}

function setFlowZoom(next) {
  if (!next || next === S.fz) return;
  const pane = $('#pane');
  const view = $('#pathView');
  const top = view.offsetTop;
  const mid = pane.scrollTop + pane.clientHeight / 2 - top;
  const ratio = next / S.fz;
  S.fz = next;
  localStorage.setItem('lucidly.flowZoom', String(next));
  applyFlowZoom();
  if (mid > 0) pane.scrollTop = top + mid * ratio - pane.clientHeight / 2;
}

function applyFlowZoom() {
  const simple = S.layout === 'simple' && S.view === 'path';
  const view = $('#pathView');
  view.style.zoom = simple && S.fz !== 1 ? String(S.fz) : '';
  view.style.setProperty('--fz', String(simple ? S.fz : 1));
  view.classList.toggle('fz-small', simple && S.fz < 0.75);
  const box = $('#flowZoom');
  box.hidden = !simple;
  const range = $('#flowZoomRange');
  range.value = String(Math.max(0, FLOW_ZOOMS.indexOf(S.fz)));
  range.setAttribute('aria-valuetext', `${Math.round(S.fz * 100)}%`);
  const v = box.querySelector('[data-fz="0"]');
  v.textContent = `${Math.round(S.fz * 100)}%`;
  v.title = S.fz === 1 ? 'Zoom of the simple view (Ctrl+scroll, - and =)' : 'Back to 100% (0)';
}

$('#flowZoomRange').addEventListener('input', (e) => setFlowZoom(FLOW_ZOOMS[Number(e.target.value)]));

// Ctrl+scroll over the simple view zooms it (one step per notch), instead of the whole page.
let wheelAt = 0;
$('#pathView').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || S.layout !== 'simple' || S.view !== 'path') return;
    e.preventDefault();
    if (Date.now() - wheelAt < 140) return;
    wheelAt = Date.now();
    zoomFlow(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

// ───────────────────────────── theme
const THEMES = {
  system: { label: 'System', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="11.5" rx="1.5" /><path d="M9 20h6M12 16v4" /></svg>' },
  light: { label: 'Light', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.8" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" /></svg>' },
  dark: { label: 'Dark', icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" /></svg>' },
};
const THEME_ORDER = ['system', 'light', 'dark'];
const darkMedia = matchMedia('(prefers-color-scheme: dark)');

/** Applies the theme (the page's own script in <head> did it once before the first paint). */
function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'system' && darkMedia.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const next = THEME_ORDER[(THEME_ORDER.indexOf(S.theme) + 1) % THEME_ORDER.length];
  const b = $('#themeBtn');
  b.innerHTML = THEMES[S.theme].icon;
  b.title = `Theme: ${THEMES[S.theme].label}${S.theme === 'system' ? ` (${dark ? 'dark' : 'light'})` : ''}. Click for ${THEMES[next].label}`;
  b.setAttribute('aria-label', b.title);
}

/** System, then Light, then Dark: remembered, except System, which is the default. */
function cycleTheme() {
  S.theme = THEME_ORDER[(THEME_ORDER.indexOf(S.theme) + 1) % THEME_ORDER.length];
  if (S.theme === 'system') localStorage.removeItem('lucidly.theme');
  else localStorage.setItem('lucidly.theme', S.theme);
  applyTheme();
}
darkMedia.addEventListener('change', () => S.theme === 'system' && applyTheme());
applyTheme();

function toggleHeat() {
  S.heat = !S.heat;
  localStorage.setItem('lucidly.heat', S.heat ? '1' : '0');
  schedule();
}

function togglePin() {
  S.pinOv = !S.pinOv;
  localStorage.setItem('lucidly.pinOverview', S.pinOv ? '1' : '0');
  schedule();
}

// The toolbar sits right under a pinned overview: track its height.
// The Files header pins right under the toolbar: track the toolbar's height too.
new ResizeObserver(() => $('#pane').style.setProperty('--tb-h', `${$('#tbPath').offsetHeight}px`)).observe($('#tbPath'));
let ovH = 0;
new ResizeObserver(() => {
  const ov = $('#overview');
  const pane = $('#pane');
  const h = ov.offsetHeight;
  pane.style.setProperty('--ov-h', `${h}px`);
  if (ovH && h !== ovH && S.pinOv && ov.classList.contains('compact')) pane.scrollTop += h - ovH;
  ovH = h;
}).observe($('#overview'));

function setFollow(on) {
  S.follow = on;
  if (on) S.lastFollowTarget = null;
  schedule();
}

function select(id) {
  S.selected = id;
  S.focus = null;
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

// In Glance, a double click takes you to the task or step in the Simple view.
document.addEventListener('dblclick', (e) => {
  const el = e.target instanceof Element && e.target.closest('#pathView .glance [data-fnode], #pathView .glance [data-gspot]');
  if (!el) return;
  const id = el.dataset.fnode ?? el.dataset.gspot;
  if (!N(id)) return;
  setView('simple');
  select(id);
  reveal(id);
  S.follow = false;
  schedule();
  setTimeout(() => findEl(id)?.scrollIntoView({ block: 'center' }), 120);
});

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  const on = (sel) => t.closest(sel);
  let el;
  if (on('[data-glive]')) return void glanceMove(0);
  if ((el = on('[data-gspot]'))) return void glanceSpot(el.dataset.gspot);
  if ((el = on('[data-copy]'))) {
    e.preventDefault();
    return void copyText(el);
  }
  if (on('[data-close]')) {
    S.follow = false;
    S.selected = null;
    return schedule();
  }
  if (on('#tokens')) return toggleTokens();
  if (!on('#tokensPop') && !$('#tokensPop').hidden) toggleTokens(false);
  if (on('#wakeBtn')) return toggleWake();
  if (!on('#wakePop') && !$('#wakePop').hidden) toggleWake(false);
  if (on('#wakePop')) return;
  if (on('#emptyOpen')) return void openPicker();
  if ((el = on('[data-view]'))) return setView(el.dataset.view);
  if (on('[data-pin]')) return togglePin();
  if (on('#heatBtn')) return toggleHeat();
  if (on('#themeBtn')) return cycleTheme();
  if ((el = on('[data-fz]'))) return zoomFlow(Number(el.dataset.fz));
  if (on('[data-fsel]')) {
    S.fselOpen = !S.fselOpen;
    return schedule();
  }
  if (S.fselOpen && !on('.fsel-menu')) {
    S.fselOpen = false;
    schedule();
  }
  if ((el = on('[data-mode]'))) {
    S.fselOpen = false;
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
    if (S.view === 'path' && S.layout === 'files') {
      if (S.ff.open.size) S.ff.open.clear();
      else for (const f of fileEdits()) S.ff.open.add(f.key);
      return schedule();
    }
    // The button says what it will do, from what is on screen: collapse if every listed task is open.
    S.expandAll = $('#expandAll').dataset.collapse !== '1';
    for (const set of [S.openGoals, S.closedGoals, S.openSteps, S.closedSteps]) set.clear();
    return schedule();
  }
  if ((el = on('[data-full]'))) {
    S.fullPre.add(el.dataset.full);
    return renderDetail();
  }
  if ((el = on('[data-reformat]'))) {
    const k = el.dataset.reformat;
    if (!S.reformat.delete(k)) S.reformat.add(k);
    renderDetail();
    return schedule();
  }
  if ((el = on('[data-wholecmd]'))) {
    const id = el.dataset.wholecmd;
    if (!S.wholeCmd.delete(id)) S.wholeCmd.add(id);
    renderDetail();
    return schedule();
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
  if (on('[data-picker-retry]')) return void openPicker();
  if ((el = on('[data-pgroup]'))) {
    S.pgOpen ??= new Map();
    S.pgOpen.set(el.dataset.pgroup, el.getAttribute('aria-expanded') !== 'true');
    return void (S.pickerData && fill($('#pickerList'), sessionListHtml(S.pickerData)));
  }
  if ((el = on('[data-pgall]'))) {
    S.pgOpen ??= new Map();
    for (const b of document.querySelectorAll('#pickerList [data-pgroup]')) S.pgOpen.set(b.dataset.pgroup, el.dataset.pgall === 'open');
    return void (S.pickerData && fill($('#pickerList'), sessionListHtml(S.pickerData)));
  }
  if ((el = on('[data-scope]'))) {
    S.pickerScope = el.dataset.scope;
    return void openPicker();
  }
  if ((el = on('[data-fnode]'))) {
    const key = el.closest('.fn')?.dataset.key ?? '';
    // Clicking the selected node again clears the selection (and folds its capsule).
    if (el.closest('.fn')?.classList.contains('sel')) {
      S.follow = false;
      S.selected = null;
      return schedule();
    }
    pickNode(el.closest('.fn'));
    return;
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
  // The selected mark in a capsule, clicked again: back to its step (the capsule stays open).
  if ((el = on('#pathView .fcap .fm.sel'))) return select(el.closest('.fcap').dataset.key.slice(2));
  if ((el = on('#pathView [data-select]'))) {
    select(el.dataset.select);
    const k = el.dataset.focus ?? '';
    S.focus = k.startsWith('u:') ? { at: 'msg', id: k.slice(2) } : k.startsWith('end:') ? { at: 'end', round: Number(k.slice(4)) } : null;
    return;
  }
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
// Hide Q&A folds the questions away (and unfolds them back) rather than making them blink.
const qaEls = () =>
  S.layout === 'simple'
    ? [...document.querySelectorAll('#pathView .fg.qa')]
    : [...document.querySelectorAll('#pathView .task')].filter((el) => el.querySelector(':scope > .task-h .tstat.qa'));
const FOLD = { duration: 240, easing: 'cubic-bezier(0.3, 0.7, 0.2, 1)' };
function foldFrames(el) {
  const cs = getComputedStyle(el);
  return [
    { height: `${el.offsetHeight}px`, opacity: 1, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
    { height: '0px', opacity: 0, marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px' },
  ];
}
function fold(els, open) {
  return Promise.all(
    els.map((el) => {
      const frames = foldFrames(el);
      el.style.overflow = 'hidden';
      const anim = el.animate(open ? frames.reverse() : frames, { ...FOLD, fill: open ? 'none' : 'forwards' });
      return anim.finished.then(() => (el.style.overflow = ''), () => {});
    }),
  );
}
$('#hideChat').addEventListener('change', async (e) => {
  const hide = e.target.checked;
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches || S.view !== 'path' || S.layout === 'files';
  if (hide && !calm) await fold(qaEls(), false);
  S.pf.hideChat = hide;
  render();
  if (!hide && !calm) {
    const els = qaEls();
    for (const el of els) el.classList.remove('enter');
    void fold(els, true);
  }
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

// Pinned and scrolled down, the overview folds to just its timeline; back at the top it unfolds.
// The content below moves up by what the card loses, so the scroll position takes that back:
// what you were looking at stays put.
function updateCompact() {
  const pane = $('#pane');
  const ov = $('#overview');
  const on = ov.classList.contains('compact');
  const want = S.pinOv && (on ? pane.scrollTop > 4 : pane.scrollTop > Math.max(90, ov.offsetHeight - 70));
  if (want !== on) ov.classList.toggle('compact', want);
}
$('#pane').addEventListener('scroll', () => requestAnimationFrame(updateCompact), { passive: true });
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
  const glance = S.run && S.view === 'path' && S.layout === 'glance';
  if (glance && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    glanceMove(e.key === 'ArrowUp' ? -1 : 1);
  } else if (glance && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    glanceStep(e.key === 'ArrowLeft' ? -1 : 1);
  } else if (glance && (e.key === 'f' || e.key === 'End')) glanceMove(0);
  else if (e.key === 'f' || e.key === 'End') jumpToEnd();
  else if (e.key === 'v') {
    const order = ['glance', 'simple', 'detailed', 'files', 'actions'];
    setView(order[(order.indexOf(S.view === 'actions' ? 'actions' : S.layout) + 1) % order.length]);
  }
  else if (e.key === 'e' && S.view === 'path') $('#expandAll').click();
  else if (e.key === '/') {
    e.preventDefault();
    $(S.view === 'path' ? '#pathSearch' : '#actionsSearch').focus();
  } else if (e.key === 'o') openPicker();
  else if (e.key === 'p' && S.run) togglePin();
  else if (e.key === 'h' && S.run && S.view === 'path') toggleHeat();
  else if ((e.key === '-' || e.key === '=' || e.key === '+' || e.key === '0') && S.run && S.view === 'path' && S.layout === 'simple') zoomFlow(e.key === '-' ? -1 : e.key === '0' ? 0 : 1);
  else if (e.key === 't' && S.run?.usage) toggleTokens();
  else if (e.key === 'Escape' && !$('#tokensPop').hidden) toggleTokens(false);
  else if (e.key === 'Escape' && !$('#wakePop').hidden) toggleWake(false);
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
  else {
    // The server opened nothing (no obvious session for this folder): let the user choose.
    render();
    openPicker();
  }
})();
// The search box widens while in use: re-check whether the filter chips still fit.
for (const ev of ['focus', 'blur']) $('#pathSearch').addEventListener(ev, () => setTimeout(fitToolbar, 230));

// ───────────────────────────── instant tooltips on the timeline
/*
 * The strip's bars and the subagent boxes describe themselves on hover right away, instead of
 * after the browser's tooltip delay. Their native title is taken over on first hover, so the
 * browser's own tooltip never doubles it.
 */
const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.hidden = true;
document.body.append(tipEl);
const TIP_TARGET = '#overview .strip > rect, #overview .strip > polygon, #overview .layers > *, #pathView .fcap .fm, #pathView .fcap .fm-more';
function tipText(el) {
  if (el.dataset.tip === undefined) {
    const t = el.querySelector(':scope > title');
    el.dataset.tip = t ? t.textContent : (el.getAttribute('title') ?? '');
    t?.remove();
    el.removeAttribute('title');
  }
  return el.dataset.tip;
}
function placeTip(x, y) {
  const r = tipEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - r.width - 8, x - r.width / 2));
  const top = y - r.height - 14 < 8 ? y + 18 : y - r.height - 14;
  tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}
let tipOn = null;
document.addEventListener('pointerover', (e) => {
  const el = e.target instanceof Element ? e.target.closest(TIP_TARGET) : null;
  if (el === tipOn) return;
  tipOn = el;
  const text = el && tipText(el);
  if (!text) {
    tipEl.hidden = true;
    return;
  }
  tipEl.textContent = text;
  tipEl.hidden = false;
  placeTip(e.clientX, e.clientY);
});
document.addEventListener(
  'pointermove',
  (e) => {
    if (!tipOn || tipEl.hidden) return;
    // A live update may have rebuilt the strip under the pointer: describe what is there now.
    if (!tipOn.isConnected) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest(TIP_TARGET);
      if (!el) return hideTip();
      tipOn = el;
      tipEl.textContent = tipText(el);
    }
    placeTip(e.clientX, e.clientY);
  },
  { passive: true },
);
const hideTip = () => {
  tipOn = null;
  tipEl.hidden = true;
};
document.addEventListener('pointerleave', hideTip);
$('#pane').addEventListener('scroll', hideTip, { passive: true });
document.addEventListener('pointerdown', hideTip);
