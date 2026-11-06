/**
 * Which files a shell command changes, read from the command text alone.
 *
 * Agents often edit files through the shell instead of their edit tools: `sed -i`, a redirect, a
 * heredoc, a small node or python script. The transcript only records the command, so this
 * recognizes the common ways of writing a file and returns their targets. It errs on the side of
 * missing a change rather than inventing one:
 *  - shell forms (redirects, tee, sed -i, cp, mv, rm, touch, PowerShell's Set-Content and the like)
 *    count when they are commands, never inside quotes, comments or heredoc text;
 *  - a script (node -e, python - <<EOF, ...) counts only if it calls something that writes files;
 *    then the path given straight to that call counts, and other path-like strings in it only
 *    when the caller recognizes them as files of the session (`known`).
 */

import type { CommandPart } from '../core/events.ts';

export interface ShellWrite {
  /** The path as written in the command (relative, absolute, or Git Bash style /c/...). */
  path: string;
  /** The directory the command had moved to with `cd` before this write, as written. */
  dir?: string;
  /** 'from' and 'to': the two ends of a move or rename. */
  op: 'write' | 'delete' | 'from' | 'to';
  /** Found in a script among other strings, rather than as the target of a write. */
  guessed?: boolean;
}

/** A word or operator; `at` is where a word sits in the source, as [start, end). */
type Tok = { t: string; op?: boolean; at?: [number, number] };
interface Simple {
  words: Tok[];
  /** Heredoc and here-string bodies fed to this command. */
  bodies: string[];
  /** Where each heredoc body sits in the source, its delimiter line included, as [start, end). */
  spans: [number, number][];
  /** Run in the background (`cmd &`): its redirects are logs, not edits. */
  background?: boolean;
}

const SEP = new Set(['&&', '||', ';', '|', '&', '\n', '(', ')', '{', '}']);
// Redirects (with descriptor duplications like 2>&1 kept whole) and command separators.
const SH_OPS = /^(?:\d?>>?&\d|&>>?|\d?>>?\|?|<<<|<|&&|\|\||;|\||&|\(|\))/;
const PS_OPS = /^(?:\*>>?|\d>>?(?:&\d)?|>>?|&&|\|\||;|\||\(|\)|\{|\})/;
/** Operators followed by a file name: input or output redirects. */
const TAKES_TARGET = /^(?:\d|&|\*)?(?:>>?\|?|<)$/;
const NULL_TARGETS = /^(?:\/dev\/(?:null|stdout|stderr|tty)|nul|\$null|&\d?|-)$/i;

/** Splits a command line into simple commands, words and operators, like a (small) shell would. */
function parse(src: string, powershell: boolean): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], bodies: [], spans: [] };
  let word = '';
  let inWord = false;
  let wordStart = 0;
  let i = 0;
  const heredocs: { delim: string; strip: boolean; into: Simple }[] = [];
  const mark = () => {
    if (!inWord) wordStart = i;
    inWord = true;
  };
  const endWord = () => {
    if (inWord) cur.words.push({ t: word, at: [wordStart, i] });
    word = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (cur.words.length || cur.bodies.length) out.push(cur);
    cur = { words: [], bodies: [], spans: [] };
  };
  while (i < src.length) {
    const c = src[i];
    const at = (s: string) => src.startsWith(s, i);
    if (!powershell && c === '\\' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') {
        word += src[i + 1];
        mark();
      }
      i += 2;
      continue;
    }
    if (powershell && c === '`' && i + 1 < src.length) {
      if (src[i + 1] !== '\n') {
        word += src[i + 1];
        mark();
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // PowerShell here-strings: @' ... '@ and @" ... "@ hold text, not commands.
      if (powershell && word === '@' && src[i + 1] === '\n') {
        const end = src.indexOf(`\n${c}@`, i);
        const stop = end < 0 ? src.length : end;
        cur.bodies.push(src.slice(i + 2, stop));
        word = '';
        inWord = false;
        cur.words.push({ t: '<here-string>' });
        i = stop + 3;
        continue;
      }
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (c === '"' && !powershell && src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        if (powershell && src[j] === '`' && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      word += s;
      mark();
      i = j + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endCmd();
      i++;
      // Heredoc bodies start on the next line and run to their delimiter line.
      for (const h of heredocs.splice(0)) {
        const start = i;
        const lines: string[] = [];
        while (i < src.length) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
          lines.push(line);
        }
        h.into.bodies.push(lines.join('\n'));
        h.into.spans.push([start, i]);
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    // $( ... ) and backticks: keep them inside the word, unparsed.
    if (!powershell && (at('$(') || c === '`')) {
      const close = c === '`' ? '`' : ')';
      let depth = 0;
      let j = i + (c === '`' ? 1 : 2);
      for (; j < src.length; j++) {
        if (close === ')' && src[j] === '(') depth++;
        else if (src[j] === close && depth-- === 0) break;
      }
      word += src.slice(i, j + 1);
      mark();
      i = j + 1;
      continue;
    }
    if (!powershell && at('<<') && !at('<<<')) {
      endWord();
      const m = /^<<(-?)\s*(['"]?)([\w.-]+)\2/.exec(src.slice(i));
      if (m) {
        heredocs.push({ delim: m[3], strip: m[1] === '-', into: cur });
        cur.words.push({ t: '<<', op: true });
        i += m[0].length;
        continue;
      }
    }
    const op = (powershell ? PS_OPS : SH_OPS).exec(src.slice(i, i + 8))?.[0];
    // A digit before > is a file descriptor only at the start of a word ("2>x"), not in "a2>x".
    if (op && !(inWord && /^\d/.test(op))) {
      endWord();
      if (op === '&' && !powershell) cur.background = true;
      if (SEP.has(op)) endCmd();
      else cur.words.push({ t: op, op: true });
      i += op.length;
      continue;
    }
    word += c;
    mark();
    i++;
  }
  endCmd();
  return out;
}

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '1>', '1>>', '*>', '*>>']);
const INTERPRETERS = /^(?:node|nodejs|deno|bun|python[\d.]*|py|ruby|php|perl)(?:\.exe)?$/i;
const WRAPPERS = new Set(['&', '.', 'sudo', 'env', 'time', 'command', 'nohup', 'exec', 'nice', 'stdbuf', 'npx', 'call']);

const base = (w: string) => w.replace(/^.*[\\/]/, '').toLowerCase();
const isOpt = (w: string) => /^-/.test(w) && w !== '-';

/** Files changed by one command line (Bash or PowerShell). */
export function shellWrites(command: string, opts: { powershell?: boolean } = {}): ShellWrite[] {
  const out: ShellWrite[] = [];
  const add = (path: string, op: ShellWrite['op'], dir?: string, guessed?: boolean) => {
    path = path.trim();
    // Not a file: /dev/null and the like, globs, variables and substitutions, URLs.
    if (!path || NULL_TARGETS.test(path) || /[*?\n]|\$[\w({]|^\w{2,}:\/\//.test(path)) return;
    if (!out.some((w) => w.path === path && w.dir === dir)) out.push({ path, op, ...(dir ? { dir } : {}), ...(guessed ? { guessed } : {}) });
  };
  let dir: string | undefined;
  // Variables set earlier in the same command line (SP=/tmp/x; ... > $SP/out.txt).
  const vars = new Map<string, string>();
  const expand = (w: string) =>
    w.replace(/\$(?:\{(\w+)\}|(\w+))/g, (m, a?: string, b?: string) => vars.get(((a ?? b) as string).toLowerCase()) ?? m);
  for (const cmd of parse(command, !!opts.powershell)) {
    const words: string[] = [];
    for (let k = 0; k < cmd.words.length; k++) {
      const w = cmd.words[k];
      if (w.op) {
        const target = cmd.words[k + 1];
        if (TAKES_TARGET.test(w.t) && target && !target.op) {
          // Output sent to a log (a .log file, or a command left running in the background) is not an edit.
          const t = expand(target.t);
          if (WRITE_REDIRECTS.has(w.t) && !cmd.background && !/\.log$/i.test(t)) add(t, 'write', dir);
          k++; // the redirect's file is not an argument of the command
        }
        continue;
      }
      words.push(expand(w.t));
    }
    // NAME=value (Bash, also after export) and $name = 'value' (PowerShell) set a variable.
    const assign = words[0] === 'export' ? words.slice(1) : words;
    if (assign.length && assign.every((w) => /^[A-Za-z_]\w*=/.test(w))) {
      for (const w of assign) vars.set(w.slice(0, w.indexOf('=')).toLowerCase(), w.slice(w.indexOf('=') + 1));
      continue;
    }
    if (opts.powershell && words.length === 3 && words[1] === '=' && /^\$\w+$/.test(words[0])) {
      vars.set(words[0].slice(1).toLowerCase(), words[2]);
      continue;
    }
    // Leading VAR=value assignments and wrappers like sudo.
    while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || WRAPPERS.has(base(words[0])))) words.shift();
    if (!words.length) continue;
    const name = base(words[0]);
    const args = words.slice(1);
    const plain = args.filter((a) => !isOpt(a));
    if (opts.powershell) {
      powershellCommand(name, args, (p, op) => add(p, op, dir));
    }
    if (name === 'cd' || name === 'pushd' || name === 'set-location' || name === 'sl') {
      if (plain[0]) dir = dir && !/^(?:[a-z]:)?[\\/~]/i.test(plain[0]) ? `${dir}/${plain[0]}` : plain[0];
      continue;
    }
    if (name === 'tee') for (const a of plain.filter((p) => !/\.log$/i.test(p))) add(a, 'write', dir);
    else if (name === 'touch') for (const a of plain) add(a, 'write', dir);
    else if (name === 'rm' || name === 'unlink' || name === 'del') for (const a of plain) add(a, 'delete', dir);
    else if (name === 'cp') {
      const t = args.indexOf('-t');
      const dest = t >= 0 ? args[t + 1] : plain.length > 1 ? plain[plain.length - 1] : undefined;
      if (dest) add(dest, 'write', dir);
    } else if (name === 'mv') {
      if (plain.length > 1) {
        for (const a of plain.slice(0, -1)) add(a, 'from', dir);
        add(plain[plain.length - 1], 'to', dir);
      }
    } else if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      inPlace(args, (p) => add(p, 'write', dir));
    } else if (name === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) {
      inPlace(args, (p) => add(p, 'write', dir));
    } else if ((name === 'bash' || name === 'sh' || name === 'zsh') && args[0] === '-c' && args[1]) {
      for (const w of shellWrites(args[1])) add(w.path, w.op, w.dir ?? dir);
    } else if ((name === 'powershell' || name === 'pwsh') && args.length) {
      const c = args.findIndex((a) => /^-c(?:ommand)?$/i.test(a));
      const code = c >= 0 ? args.slice(c + 1).join(' ') : '';
      if (code) for (const w of shellWrites(code, { powershell: true })) add(w.path, w.op, w.dir ?? dir);
    } else if (INTERPRETERS.test(name)) {
      const e = args.findIndex((a) => /^(?:-e|-c|-p|-pe|--eval|--print|-r)$/.test(a));
      const code = e >= 0 && args[e + 1] ? [args[e + 1]] : args.includes('-') || !plain.length ? cmd.bodies : [];
      for (const src of code) for (const w of scriptWrites(src)) add(w.path, w.op, dir, w.guessed);
    }
  }
  return out;
}

/** sed -i / perl -i: every argument after the script is a file. */
function inPlace(args: string[], add: (p: string) => void): void {
  let script = false;
  let skipNext = false;
  const files: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (/^(?:-e|-f|--expression|--file)$/.test(a)) {
      script = true;
      skipNext = true;
      continue;
    }
    if (/^-[a-zA-Z]*e$/.test(a) && a !== '-e') {
      // perl -pe 's/..//' and sed -ie: the script follows
      script = true;
      skipNext = true;
      continue;
    }
    if (isOpt(a)) continue;
    files.push(a);
  }
  for (const f of script ? files : files.slice(1)) add(f);
}

/** PowerShell's file cmdlets (and their usual aliases). */
function powershellCommand(name: string, args: string[], add: (p: string, op: ShellWrite['op']) => void): void {
  const named = (...keys: string[]) => {
    const k = args.findIndex((a) => keys.includes(a.toLowerCase()));
    return k >= 0 ? args[k + 1] : undefined;
  };
  // Positional arguments: skip -Name value pairs (switches like -Force take no value, but the
  // ones that matter here are recognized by name first).
  const positional: string[] = [];
  for (let k = 0; k < args.length; k++) {
    if (/^-[a-z]/i.test(args[k])) {
      if (!/^-(?:force|recurse|nonewline|append|confirm(?::\S+)?|whatif|passthru|r|fo?)$/i.test(args[k])) k++;
      continue;
    }
    positional.push(args[k]);
  }
  const path = () => named('-path', '-literalpath', '-filepath', '-lp') ?? positional[0];
  switch (name) {
    case 'set-content':
    case 'sc':
    case 'add-content':
    case 'ac':
    case 'out-file':
    case 'new-item':
    case 'ni': {
      const p = path();
      if (p && !(name.startsWith('n') && /^dir/i.test(named('-itemtype', '-type') ?? ''))) add(p, 'write');
      break;
    }
    case 'remove-item':
    case 'ri':
    case 'erase':
    case 'rd':
    case 'rmdir': {
      const p = path();
      if (p) add(p, 'delete');
      break;
    }
    case 'copy-item':
    case 'cpi':
    case 'copy': {
      const d = named('-destination') ?? positional[1];
      if (d) add(d, 'write');
      break;
    }
    case 'move-item':
    case 'mi':
    case 'move':
    case 'rename-item':
    case 'rni':
    case 'ren': {
      const p = path();
      const d = named('-destination', '-newname') ?? positional[1];
      if (p && d) {
        add(p, 'from');
        add(name.startsWith('ren') || name === 'rni' ? p.replace(/[^\\/]*$/, d) : d, 'to');
      }
      break;
    }
  }
}

// ───────────────────────────── scripts (node, python, ...)
/** Calls that write, delete or move files, with the target as their first argument. */
const WRITE_CALL =
  /\b(?:(?:fs|fsp|promises)\s*\.\s*)?(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|unlinkSync|rmSync|cpSync|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText)\s*\(|\bopen\s*\([^()\n]*,\s*(?:mode\s*=\s*)?['"][wax]b?\+?['"]|\.write_(?:text|bytes)\s*\(|\bshutil\s*\.\s*(?:copy\w*|move)\s*\(|\bos\s*\.\s*(?:remove|unlink|rename|replace)\s*\(|\bFile\s*\.\s*(?:write|open)\s*\(/;
const TARGETED =
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|open|File\s*\.\s*write)\s*\(\s*(['"`])([^'"`\n$]+)\1|\bPath\s*\(\s*(['"])([^'"\n]+)\3\s*\)\s*\.\s*write_(?:text|bytes)|\b(?:unlinkSync|rmSync|os\s*\.\s*(?:remove|unlink))\s*\(\s*(['"`])([^'"`\n$]+)\5/g;
/** A string that looks like a file path: a name with an extension, maybe in folders. */
const PATHISH = /(['"`])((?:[\w@.~-]+[\\/]+)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,9}|(?:[A-Za-z]:)?(?:[\\/]+[\w@.~ -]+)+\.[A-Za-z][A-Za-z0-9]{0,9})\1/g;
/** Strings passed to calls that only read or import. */
const READ_ONLY = /(?:readFileSync|readFile|existsSync|statSync|require|import|from|open|read_text|read_bytes|Path|resolve|join|dirname|basename)\s*\(?\s*$/;

export function scriptWrites(code: string): { path: string; op: ShellWrite['op']; guessed?: boolean }[] {
  if (!WRITE_CALL.test(code)) return [];
  const out: { path: string; op: ShellWrite['op']; guessed?: boolean }[] = [];
  const sure = new Set<string>();
  for (const m of code.matchAll(TARGETED)) {
    const p = m[2] ?? m[4] ?? m[6];
    const del = m[6] !== undefined;
    // open('x') without a write mode is a read: TARGETED matched any open(), so check the mode.
    if (/^open/.test(m[0]) && !new RegExp(`open\\s*\\(\\s*(['"\`])${escapeRe(p)}\\1[^()\\n]*,\\s*(?:mode\\s*=\\s*)?['"][wax]`).test(code)) continue;
    sure.add(p);
    out.push({ path: p, op: del ? 'delete' : 'write' });
  }
  for (const m of code.matchAll(PATHISH)) {
    const p = m[2];
    if (sure.has(p) || /^(?:node|npm|https?):/.test(p)) continue;
    const before = code.slice(Math.max(0, m.index! - 40), m.index);
    // Only a value given to something (edit('a.ts', ...), ['a.ts', 'b.ts'], f = 'a.ts'), not a
    // path quoted in text the script writes, and not one handed to a call that only reads.
    if (!/[([,=]\s*$/.test(before) || READ_ONLY.test(before)) continue;
    if (out.some((w) => w.path === p)) continue;
    out.push({ path: p, op: 'write', guessed: true });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ───────────────────────────── a command, split into readable parts
// A long command cut where it embeds other text: the shell lines, a script it runs (node - <<EOF,
// python -c "..."), content it writes to a file (cat > a.py <<EOF), or other text fed to a command.

/** Interpreters and the language of the scripts they run ('' keeps the interpreter's name). */
const LANG: [RegExp, string][] = [
  [/^(?:node|nodejs|deno|bun)$/, 'javascript'],
  [/^(?:python[\d.]*|py)$/, 'python'],
  [/^(?:bash|sh|zsh)$/, 'shell'],
  [/^(?:ruby|php|perl)$/, ''],
];
const langOf = (name: string): string | undefined => {
  const n = name.replace(/\.exe$/, '');
  for (const [re, lang] of LANG) if (re.test(n)) return lang || n;
  return undefined;
};

/**
 * The parts of a Bash command, in order, or undefined when it embeds nothing worth splitting out
 * (then it is shown whole, as before). Inline scripts are cut out of their line, which keeps an
 * ellipsis in their place; heredoc bodies follow the line that starts them.
 */
export function commandParts(command: string): CommandPart[] | undefined {
  type Cut = { start: number; end: number; part: CommandPart; inline: boolean };
  const cuts: Cut[] = [];
  for (const cmd of parse(command, false)) {
    const words = cmd.words.filter((w) => !w.op);
    let k = 0;
    while (k < words.length && (/^[A-Za-z_]\w*=/.test(words[k].t) || WRAPPERS.has(base(words[k].t)))) k++;
    const name = words[k] ? base(words[k].t) : '';
    const lang = langOf(name);
    // Where a heredoc goes: a file it is written to (> file, tee file), else the command reading it.
    let file: string | undefined;
    for (let j = 0; j < cmd.words.length - 1; j++) {
      const w = cmd.words[j];
      if (w.op && WRITE_REDIRECTS.has(w.t) && !cmd.words[j + 1].op) file = cmd.words[j + 1].t;
    }
    if (!file && name === 'tee') file = words.slice(k + 1).find((w) => !isOpt(w.t))?.t;
    cmd.bodies.forEach((text, b) => {
      const span = cmd.spans[b];
      if (!span) return;
      const part: CommandPart = file ? { kind: 'content', file, text } : lang !== undefined ? { kind: 'script', lang, text } : { kind: 'text', text };
      cuts.push({ start: span[0], end: span[1], part, inline: false });
    });
    // node -e "...", python -c "...", bash -c "...": cut out when long enough to deserve a block.
    if (lang !== undefined) {
      const e = words.findIndex((w, j) => j > k && /^(?:-e|-c|-p|--eval|--print)$/.test(w.t));
      const script = e >= 0 ? words[e + 1] : undefined;
      if (script?.at && (script.t.includes('\n') || script.t.length > 100)) {
        cuts.push({ start: script.at[0], end: script.at[1], part: { kind: 'script', lang, text: script.t }, inline: true });
      }
    }
  }
  if (!cuts.length) return undefined;
  cuts.sort((a, b) => a.start - b.start);
  const parts: CommandPart[] = [];
  const held: CommandPart[] = [];
  let shell = '';
  let pos = 0;
  const flush = () => {
    const text = shell.replace(/\s+$/, '');
    if (text.trim()) parts.push({ kind: 'shell', text });
    shell = '';
    parts.push(...held.splice(0));
  };
  for (const c of cuts) {
    if (c.start < pos) continue; // nested in an earlier cut
    shell += command.slice(pos, c.start);
    if (c.inline) {
      shell += '…';
      held.push(c.part);
    } else {
      flush();
      parts.push(c.part);
    }
    pos = c.end;
  }
  shell += command.slice(pos);
  flush();
  return parts;
}
