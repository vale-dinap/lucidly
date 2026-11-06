/** Text heuristics shared by the engine: intent titles, plan extraction, step matching. */

export function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '') + '…';
}

export function stripMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/^#+\s*/, '')
    .trim();
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

const INTENT_CUE =
  /\b(?:let me|let's|i'll|i will|i'm going to|i am going to|i need to|i'm now going to|next,? i'll|now i'll|time to)\s+/i;

/** Split prose into sentences, ignoring code blocks, headings and list items. */
export function sentences(text: string): string[] {
  const noCode = text.replace(/```[\s\S]*?```/g, ' ');
  const out: string[] = [];
  for (const line of noCode.split(/\n+/)) {
    const l = line.trim();
    if (!l || /^(#|\||[-*+]\s|\d+[.)]\s)/.test(l)) continue;
    for (const s of l.split(/(?<=[.!?])\s+(?=[A-Z"'(`*])/)) {
      const c = stripMarkdown(s).trim();
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Derive a short step title from narration, favouring the sentence that states intent:
 * "Good. Now let me run the tests." → "Run the tests".
 */
export function intentTitle(text: string, max = 90): string {
  const ss = sentences(text);
  if (ss.length === 0) return truncate(stripMarkdown(text), max) || 'Working';
  for (const s of ss) {
    const m = INTENT_CUE.exec(s);
    if (m) {
      const rest = s
        .slice(m.index + m[0].length)
        .replace(/^(?:now|first|also|then|quickly|just)\s+/i, '')
        .replace(/^(?:start|begin) (?:by|with)\s+/i, '')
        .replace(/[.:!]+$/, '');
      if (rest.length > 3) return truncate(capitalize(rest), max);
    }
  }
  // A terse opener ("All pass.") followed by more text: the next sentence says more.
  const pick = ss.length > 1 && ss[0].split(/\s+/).length <= 3 ? ss[1] : ss[0];
  return truncate(pick.replace(/[.:]+$/, ''), max);
}

/** True when the text carries an explicit intent statement. */
export function hasIntent(text: string): boolean {
  return sentences(text).some((s) => INTENT_CUE.test(s));
}

const PLAN_CUE =
  /\b(plan|steps?|order of work|approach|roadmap|todo|to-do|phases?|i'll|i will|going to|let me|let's|first|then|next)\b/i;

export interface ExtractedPlan {
  intro: string;
  items: string[];
}

function cleanItem(s: string): string {
  let t = stripMarkdown(s);
  if (t.length > 60) {
    const m = /^(.{6,60}?)(?::\s| — | – | - )/.exec(t);
    if (m) t = m[1];
  }
  return truncate(t.replace(/[.;:]+$/, ''), 90);
}

/**
 * Find a plan-shaped list in narration. Numbered lists (1., 2., ...) qualify on their own;
 * bulleted lists need a planning cue in the line(s) right before them.
 * With `requireCue`, numbered lists also need the cue (used for re-planning mid-goal).
 */
export function extractPlan(text: string, requireCue = false): ExtractedPlan | null {
  const lines = text.replace(/```[\s\S]*?```/g, '').split('\n');
  let best: { start: number; items: string[]; numbered: boolean } | null = null;
  let i = 0;
  while (i < lines.length) {
    const num = /^\s{0,3}(\d{1,2})[.)]\s+(.+)$/.exec(lines[i]);
    const bul = /^\s{0,1}[-*+]\s+(.+)$/.exec(lines[i]);
    if (!num && !bul) {
      i++;
      continue;
    }
    const numbered = !!num;
    const start = i;
    const items: string[] = [];
    let expect = 1;
    while (i < lines.length) {
      const l = lines[i];
      if (numbered) {
        const m = /^\s{0,3}(\d{1,2})[.)]\s+(.+)$/.exec(l);
        if (m && Number(m[1]) === expect) {
          items.push(m[2]);
          expect++;
          i++;
          continue;
        }
      } else {
        const m = /^\s{0,1}[-*+]\s+(.+)$/.exec(l);
        if (m) {
          items.push(m[1]);
          i++;
          continue;
        }
      }
      // allow indented continuation / sub-items and blank lines inside the list
      if (/^\s{2,}\S/.test(l) || (l.trim() === '' && i + 1 < lines.length && /^\s{0,3}(\d{1,2}[.)]|[-*+])\s/.test(lines[i + 1]))) {
        i++;
        continue;
      }
      break;
    }
    if (i === start) i++;
    if (numbered && items.length > 0 && !/^\s{0,3}1[.)]/.test(lines[start])) items.length = 0;
    if (items.length >= 2 && (!best || items.length > best.items.length)) best = { start, items, numbered };
  }
  if (!best) return null;
  const before = lines.slice(0, best.start).filter((l) => l.trim());
  const lead = before.slice(-2).join(' ');
  const cue = PLAN_CUE.test(lead);
  if ((!best.numbered || requireCue) && !cue) return null;
  const items = best.items.map(cleanItem).filter((s) => s.length > 1);
  if (items.length < 2) return null;
  if (best.items.some((s) => s.length > 400)) return null;
  return { intro: stripMarkdown(lead), items };
}

const STOP = new Set(
  'the and for with that this from into then than them they have has had was were are will would should could can let lets now next also just some more most very what when where which while who why how all any each its it’s it\'s our you your not but out use using about over under after before again first second third step steps i\'ll done make sure need needs check'.split(
    ' ',
  ),
);

function stem(w: string): string {
  return w.replace(/(?:ing|ed|es|s)$/, '') || w;
}

export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

export function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  return common / Math.sqrt(a.size * b.size);
}

/**
 * Pick which plan step a narration refers to.
 * Returns an index into `steps`, or -1 when nothing matches well enough.
 */
export function matchStep(text: string, steps: { title: string; done: boolean }[], current: number): number {
  const explicit = /\b(?:step|phase|part)\s+#?(\d{1,2})\b/i.exec(text);
  if (explicit) {
    const idx = Number(explicit[1]) - 1;
    if (idx >= 0 && idx < steps.length) return idx;
  }
  // Use the intent sentence(s) rather than the whole message: long messages match everything.
  const focus = sentences(text).slice(0, 3).join(' ');
  const t = tokens(focus || text);
  let best = -1;
  let bestScore = 0;
  const from = Math.max(0, current);
  for (let i = from; i < steps.length; i++) {
    if (steps[i].done && i !== current) continue;
    const score = similarity(t, tokens(steps[i].title)) - 0.04 * Math.max(0, i - from - 1);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore >= 0.3 ? best : -1;
}

const DEVIATION =
  /\b(fix|fixing|fixed|retry|retrying|try again|instead|workaround|missing|failed|failing|fails|error|errors|broken|doesn't work|didn't work|not found|unexpected|turns out|wrong|bug|investigate|debug|debugging|revert)\b/i;

export function hasDeviationCue(text: string): boolean {
  return DEVIATION.test(sentences(text).slice(0, 2).join(' ') || text);
}

/** Is this user message the start of a new task, or a short reply within the current one? */
const REPLY = /^(yes|yep|yeah|yup|y|no|nope|ok|okay|k|sure|go|go ahead|go on|do it|do so|proceed|continue|carry on|keep going|please do|please|sounds good|looks good|lgtm|agreed|right|correct|exactly|perfect|great|thanks|thank you|both|neither|either|the (first|second|third|last) one|option \w+|\d+)\b/i;

const HOUSEKEEPING = /^\/(compact|clear|model|config|cost|context|status|help|memory|permissions|login|logout|doctor|resume|fast|effort|theme|usage|statusline)\b/i;

/**
 * A short message that answers the agent rather than giving it something new: an approval,
 * a choice, or anything at all when the agent's last words asked a question.
 */
/** A slash command that manages the session (/compact, /model...) rather than asking for anything. */
export function isHousekeeping(text: string): boolean {
  return HOUSEKEEPING.test(text.trim());
}

export function isReply(text: string, agentAsked: boolean): boolean {
  const t = text.trim();
  // Housekeeping commands never start a task; any other slash command is a new request.
  if (HOUSEKEEPING.test(t)) return true;
  if (t.startsWith('/')) return false;
  if (isSubstantivePrompt(t)) return false;
  return agentAsked || REPLY.test(text.trim());
}

/** The agent's words end by asking the user something. */
export function endsWithQuestion(text: string): boolean {
  return /\?\s*(\*+|_+|\)|")?\s*$/.test(text.trim());
}

export function isSubstantivePrompt(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  return words >= 6 || t.length >= 40;
}

const ERROR_LINE = /\b(error|exception|failed|failure|fatal|denied|not found|cannot|can't|unable|invalid|refused|timed? ?out|traceback|panic|undefined|missing)\b|✗|✖|FAIL\b/i;

/**
 * One-line summary of a failure. Prefers the most telling line (a Python traceback's last line,
 * an "error:" line) over boilerplate such as "Exit code 1", and keeps the exit code as a prefix.
 */
export function issueSummary(output: string, max = 160): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'Failed';
  let exit = '';
  const m = /^exit code (\d+)$/i.exec(lines[0]);
  if (m) {
    const hint: Record<string, string> = { '124': 'timed out', '126': 'not executable', '127': 'command not found', '130': 'interrupted', '137': 'killed', '143': 'terminated' };
    exit = `exit ${m[1]}${hint[m[1]] ? ` (${hint[m[1]]})` : ''}`;
    lines.shift();
  }
  if (!lines.length) return exit || 'Failed';
  const tracebackEnd = lines.some((l) => /^Traceback \(most recent call last\)/.test(l))
    ? lines.slice().reverse().find((l) => /^[A-Za-z_.]+(Error|Exception|Exit|Interrupt)\b/.test(l))
    : undefined;
  // No error-looking line: output usually ends with the failure, not starts with it.
  const pick =
    tracebackEnd ??
    lines.find((l) => ERROR_LINE.test(l) && !/^at\s/.test(l) && !/^Traceback \(most recent/.test(l)) ??
    lines[lines.length - 1];
  return truncate(exit ? `${exit} · ${stripMarkdown(pick)}` : pick, max);
}

export function firstLine(s: string, max = 160): string {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  return truncate(l, max);
}
