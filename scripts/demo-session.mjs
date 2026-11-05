#!/usr/bin/env node
/**
 * Writes a made-up Claude Code session for screenshots and demos: a small recipes and
 * shopping-list app ("Pantry") worked on over five requests, staged so every part of Lucidly has
 * something to show (a plan, edits with diffs, commands, a failure then its fix, a subagent, a
 * question to you, a Q&A, token usage), with the last task still running.
 *
 *   node scripts/demo-session.mjs [dir]          writes it, ending a few seconds ago
 *   node scripts/demo-session.mjs [dir] --play   writes the first four tasks at once, then
 *                                                replays the last one live (for a GIF)
 *   lucidly <dir>/<session>.jsonl                opens it (the script prints the command)
 *
 * Nothing in it is real: names, paths, code and output are invented. Lucidly shows a session as
 * still working for 5 minutes after its last record, so generate it right before shooting.
 */
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const PLAY = args.includes('--play');
const DIR = resolve(args.find((a) => !a.startsWith('--')) ?? 'demo-session');
const SESSION = '7c1a3e52-4b8d-4f0e-9a61-2d5c8e9b0f14';
const CWD = '/home/demo/pantry';
const P = (f) => `${CWD}/${f}`;
const MAIN = 'claude-opus-5-5';
const SUB = 'claude-haiku-5-5';
/** The model takes a while between calls: its gaps are stretched by this much. */
const THINK = 5;

// ───────────────────────────── building the records
/** Every record, with its time offset in seconds and the file it goes to ('main' or an agent). */
const out = [];
let t = 0;
let seq = 0;
const uid = () => `d${(++seq).toString(16).padStart(6, '0')}-demo`;
/** Context per transcript: what the model has read so far, and what it took in since its last reply. */
const ctx = { main: { read: 18000, fresh: 2600 } };

function put(file, rec, dt = 0) {
  t += dt;
  out.push({ file, t, rec });
}
function base(file) {
  return { parentUuid: null, isSidechain: file !== 'main', uuid: uid(), cwd: CWD, sessionId: SESSION, version: '2.1.300', gitBranch: 'main', ...(file !== 'main' ? { agentId: file } : {}) };
}
function assistant(file, block, output, dt) {
  output = Math.round(output);
  const c = (ctx[file] ??= { read: 9000, fresh: 1200 });
  const usage = { input_tokens: 3 + (seq % 37), cache_creation_input_tokens: c.fresh, cache_read_input_tokens: c.read, output_tokens: output };
  c.read += c.fresh;
  c.fresh = output + 40;
  put(file, { ...base(file), type: 'assistant', message: { id: `msg_${uid()}`, type: 'message', role: 'assistant', model: file === 'main' ? MAIN : SUB, content: [block], usage } }, dt > 0 ? dt * (file === 'main' ? THINK : 2) : dt);
}
const say = (text, output = 160, dt = 6, file = 'main') => assistant(file, { type: 'text', text }, output, dt);
const think = (text, dt = 3, file = 'main') => assistant(file, { type: 'thinking', thinking: text, signature: 'demo' }, 90, dt);
function prompt(text, dt) {
  put('main', { ...base('main'), type: 'user', message: { role: 'user', content: text } }, dt);
  ctx.main.fresh += Math.ceil(text.length / 3);
}
let callN = 0;
/**
 * One tool call and its result. `size` is roughly how many tokens the result adds to the context;
 * `dur` how long the tool ran; `error` makes it fail; `extra` is Claude Code's toolUseResult.
 */
function tool(name, input, result, { file = 'main', output = 120, dt = 4, dur = 2, size = 300, error = false, extra, open = false } = {}) {
  const id = `toolu_demo${(++callN).toString().padStart(3, '0')}`;
  assistant(file, { type: 'tool_use', id, name, input }, output, dt);
  if (open) return id; // still running: no result yet
  const rec = { ...base(file), type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: result, ...(error ? { is_error: true } : {}) }] } };
  if (extra) rec.toolUseResult = extra;
  put(file, rec, dur);
  (ctx[file] ??= { read: 9000, fresh: 0 }).fresh += size;
  return id;
}
const read = (f, size, o = {}) => tool('Read', { file_path: P(f) }, `(${size * 3} characters of ${f})`, { size, dur: 0.4, output: 70, ...o });
const grep = (pattern, path, result, o = {}) => tool('Grep', { pattern, path: P(path), output_mode: 'content' }, result, { size: 260, dur: 0.6, output: 80, ...o });
const bash = (command, description, result, o = {}) => tool('Bash', { command, description }, result, { output: 90, ...o });
function write(f, content, o = {}) {
  const lines = content.split('\n');
  return tool('Write', { file_path: P(f), content }, `File created successfully at: ${P(f)}`, {
    output: 40 + content.length / 2.6,
    size: 120,
    dur: 0.3,
    extra: { type: 'create', filePath: P(f), content, structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => '+' + l) }] },
    ...o,
  });
}
/** An edit: lines starting with "-" are removed, "+" added, " " context; `at` is the first line. */
function edit(f, at, diff, o = {}) {
  const lines = diff.replace(/^\n|\n\s*$/g, '').split('\n');
  const oldS = lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1)).join('\n');
  const newS = lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1)).join('\n');
  const oldN = lines.filter((l) => !l.startsWith('+')).length;
  const newN = lines.filter((l) => !l.startsWith('-')).length;
  return tool('Edit', { file_path: P(f), old_string: oldS, new_string: newS, replace_all: false }, `The file ${P(f)} has been updated successfully.`, {
    output: 60 + newS.length / 2.4,
    size: 140,
    dur: 0.3,
    extra: { filePath: P(f), oldString: oldS, newString: newS, structuredPatch: [{ oldStart: at, oldLines: oldN, newStart: at, newLines: newN, lines }] },
    ...o,
  });
}
const todos = (items, dt = 3) =>
  tool('TodoWrite', { todos: items.map(([content, status]) => ({ content, status, activeForm: content })) }, 'Todos have been modified successfully.', { output: 110, dt, dur: 0.2, size: 60 });
const done = (ms) => put('main', { ...base('main'), type: 'system', subtype: 'turn_duration', durationMs: ms, isMeta: false }, 1);

// ───────────────────────────── the story
put('main', { type: 'permission-mode', permissionMode: 'default', sessionId: SESSION });

// 1. Dark mode, with a plan
prompt('Add a dark mode toggle to the settings page. It should follow the system setting until the user picks one.', 0);
const t1 = t;
think('Look at how theming works now before planning: CSS variables or a theme object?');
const plan1 = ['Inspect the settings page and the colour tokens', 'Add a theme store that follows the system setting', 'Add the toggle to Settings', 'Run the tests and the type check'];
todos(plan1.map((s, i) => [s, i === 0 ? 'in_progress' : 'pending']));
tool('Glob', { pattern: 'src/**/*.{ts,tsx,css}' }, `src/App.tsx
src/main.tsx
src/pages/Settings.tsx
src/pages/Recipes.tsx
src/pages/ShoppingList.tsx
src/styles/tokens.css
(31 more)`, { size: 200, dur: 0.3, output: 60 });
read('src/pages/Settings.tsx', 2100);
read('src/components/Segmented.tsx', 800);
read('src/styles/tokens.css', 1400);
grep('prefers-color-scheme|data-theme', 'src', 'No matches found');
read('src/main.tsx', 400);
read('test/settings.test.tsx', 1300);
say("Colours are already CSS variables in tokens.css, so dark mode is a second set of values. Nothing reads the system setting yet.", 140, 5);
todos(plan1.map((s, i) => [s, i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending']));
write('src/lib/theme.ts', `export type Theme = 'system' | 'light' | 'dark';

const KEY = 'pantry.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) ?? 'system';
}

export function setTheme(theme: Theme): void {
  if (theme === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, theme);
  apply();
}

function apply(): void {
  const theme = getTheme();
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function initTheme(): void {
  apply();
  media.addEventListener('change', apply);
}`, { dt: 8 });
edit('src/styles/tokens.css', 1, `
 :root {
   --bg: #ffffff;
   --text: #1d2330;
   --accent: #2f6fed;
 }
+
+[data-theme='dark'] {
+  --bg: #14171f;
+  --text: #e6e9f0;
+  --accent: #6b9bff;
+}`);
todos(plan1.map((s, i) => [s, i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending']));
edit('src/pages/Settings.tsx', 14, `
 export function Settings() {
+  const [theme, choose] = useState<Theme>(getTheme());
   return (
     <Page title="Settings">
+      <Field label="Theme">
+        <Segmented
+          value={theme}
+          options={['system', 'light', 'dark']}
+          onChange={(t) => { setTheme(t); choose(t); }}
+        />
+      </Field>
       <Field label="Units">`, { dt: 6 });
edit('src/main.tsx', 6, `
 import { App } from './App';
+import { initTheme } from './lib/theme';

+initTheme();
 createRoot(document.getElementById('root')!).render(<App />);`);
todos(plan1.map((s, i) => [s, i < 3 ? 'completed' : 'in_progress']));
bash('npm test -- --run', 'Run the test suite', ' ✓ test/theme.test.ts (4 tests)\n ✓ test/settings.test.tsx (7 tests)\n\n Test Files  14 passed (14)\n      Tests  96 passed (96)\n   Duration  3.41s', { dur: 5 });
bash('npm run typecheck', 'Type-check the project', '> pantry@1.4.0 typecheck\n> tsc --noEmit', { dur: 4 });
todos(plan1.map((s) => [s, 'completed']));
say('Dark mode is in. Settings has a **Theme** switch (System, Light, Dark). On *System* the app follows the operating system, and changes as soon as it does; a choice is remembered. The dark colours are a second set of the existing tokens, so every screen picks them up. Tests and the type check pass.', 260, 5);
done((t - t1) * 1000);

// 2. A question answered without any work
prompt('Does the choice survive a reload?', 240);
const t2 = t;
say("Yes. The choice is saved in `localStorage` under `pantry.theme`, and `initTheme()` applies it before the first render, so there's no flash of the wrong theme. *System* removes the key, so the app goes back to following the operating system.", 150, 7);
done((t - t2) * 1000);

// 3. A bug: a failing test, a wrong first fix, then the right one
prompt('Exporting the shopping list to CSV breaks when an item has a comma in its name, like "Eggs, large". Fix it and add a test.', 400);
const t3 = t;
think('Probably the fields are joined with commas without quoting. Reproduce it with a test first.');
say("Let me reproduce it with a test first.", 50, 3);
grep('toCsv|exportCsv', 'src', `src/lib/exportCsv.ts:3:export function toCsv(rows: Row[]): string {
src/pages/ShoppingList.tsx:88:  const csv = toCsv(items);`);
read('src/lib/exportCsv.ts', 600);
read('vitest.config.ts', 300);
write('test/exportCsv.test.ts', `import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/exportCsv';

describe('toCsv', () => {
  it('quotes names with commas', () => {
    expect(toCsv([{ name: 'Eggs, large', qty: 12 }])).toBe('name,qty\\n"Eggs, large",12');
  });
  it('doubles quotes inside a field', () => {
    expect(toCsv([{ name: '12" pizza base', qty: 1 }])).toBe('name,qty\\n"12"" pizza base",1');
  });
});`);
bash('npm test -- --run exportCsv', 'Run the CSV export tests', ' ❯ test/exportCsv.test.ts (2 tests | 2 failed)\n   × quotes names with commas\n     → expected \'name,qty\\nEggs, large,12\' to be \'name,qty\\n"Eggs, large",12\'\n   × doubles quotes inside a field\n\n Test Files  1 failed (1)\n      Tests  2 failed (2)', { error: true, dur: 3 });
say('Both tests fail as expected: fields are never quoted. Now the fix: quote a field when it contains a comma, a quote or a line break.', 120, 5);
edit('src/lib/exportCsv.ts', 3, `
-const cell = (v: unknown) => String(v);
+const cell = (v: unknown) => {
+  const s = String(v);
+  return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '\\\\"')}"\` : s;
+};`);
bash('npm test -- --run exportCsv', 'Run the CSV export tests', ' ❯ test/exportCsv.test.ts (2 tests | 1 failed)\n   ✓ quotes names with commas\n   × doubles quotes inside a field\n     → expected \'"12\\" pizza base"\' to be \'"12"" pizza base"\'\n\n Test Files  1 failed (1)\n      Tests  1 failed | 1 passed (2)', { error: true, dur: 3 });
say('Close: in CSV a quote inside a field is doubled, not escaped with a backslash.', 70, 4);
edit('src/lib/exportCsv.ts', 5, `
-  return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '\\\\"')}"\` : s;
+  return /[",\\n]/.test(s) ? \`"\${s.replace(/"/g, '""')}"\` : s;`);
bash('npm test -- --run exportCsv', 'Run the CSV export tests', ' ✓ test/exportCsv.test.ts (2 tests)\n\n Test Files  1 passed (1)\n      Tests  2 passed (2)', { dur: 3 });
say('Running the whole suite to be safe.', 30, 3);
bash('npm test -- --run', 'Run the test suite', ' Test Files  15 passed (15)\n      Tests  98 passed (98)\n   Duration  3.52s', { dur: 5 });
say('Fixed. Fields with a comma, a quote or a line break are now quoted, and quotes inside them are doubled, as CSV requires, so "Eggs, large" exports as one column. Two new tests cover both cases, and the full suite passes.', 170, 4);
done((t - t3) * 1000);

// 4. An audit with a subagent and a question to you
prompt('Audit the app for accessibility problems and fix the important ones.', 520);
const t4 = t;
say("I'll have a subagent scan the components for common problems while I check the colour contrast.", 70, 4);
const scanPrompt = 'Scan every component under src/components and src/pages for accessibility problems: images without alt text, buttons without an accessible name, form inputs without a label, and click handlers on elements that are not buttons or links. Report the file, the line and a one-line fix for each.';
const agentCall = tool('Agent', { description: 'Scan components for accessibility problems', subagent_type: 'Explore', model: 'haiku', prompt: scanPrompt }, '', { output: 160, open: true });
const agentAt = t;
// the subagent, in its own transcript
const A = 'a7f3c19e2d4b8a601';
put(A, { ...base(A), type: 'user', message: { role: 'user', content: scanPrompt } }, 1);
grep('<img(?![^>]*alt=)', 'src', 'src/components/RecipeCard.tsx:18:      <img src={recipe.photo} className="photo" />', { file: A, dt: 2 });
grep('<button[^>]*>\\s*<Icon', 'src', 'src/components/IconButton.tsx:9:    <button className="icon" onClick={onClick}>\nsrc/pages/ShoppingList.tsx:52:          <button onClick={() => remove(item.id)}><Icon name="trash" /></button>', { file: A, dt: 2 });
read('src/components/SearchBar.tsx', 700, { file: A, dt: 2 });
grep('<input(?![^>]*aria-label)(?![^>]*id=)', 'src', `src/components/SearchBar.tsx:7:      <input type="search" placeholder="Search recipes" />
src/pages/Settings.tsx:41:      <input type="number" id="servings" />`, { file: A, dt: 2 });
read('src/components/IconButton.tsx', 500, { file: A, dt: 2 });
read('src/pages/ShoppingList.tsx', 2400, { file: A, dt: 2 });
grep('tabIndex|role=', 'src', 'src/components/Rating.tsx:22:      <span role="img" aria-label={label}>', { file: A, dt: 2 });
grep('<div[^>]*onClick', 'src', 'src/components/RecipeCard.tsx:12:    <div className="card" onClick={open}>', { file: A, dt: 2 });
read('src/components/RecipeCard.tsx', 900, { file: A, dt: 2 });
const report = `Found 5 problems:

1. src/components/RecipeCard.tsx:18: the recipe photo has no alt text. Use alt={recipe.title}.
2. src/components/RecipeCard.tsx:12: the card is a clickable div. Make it a link to the recipe.
3. src/components/IconButton.tsx:9: icon-only button with no name. Add a required label prop, used as aria-label.
4. src/pages/ShoppingList.tsx:52: the remove button has only an icon. Use IconButton with label "Remove {item.name}".
5. src/components/SearchBar.tsx:7: the search input has only a placeholder. Add a visually hidden label.`;
say(report, 380, 4, A);
const subEnd = t;
// meanwhile, the main agent checks the colour contrast
t = agentAt;
read('src/styles/tokens.css', 1500, { dt: 3 });
bash('node scripts/contrast-check.mjs', 'Check colour contrast of the text tokens', 'text on bg          16.1:1  ok\nmuted on bg          3.9:1  FAIL (needs 4.5:1)\naccent on bg         4.8:1  ok\ndark: muted on bg    4.1:1  FAIL (needs 4.5:1)\nprint: muted on bg   2.8:1  FAIL (needs 4.5:1)', { dur: 2 });
// the subagent's report reaches the main agent once it is done
t = Math.max(t, subEnd);
put('main', { ...base('main'), type: 'user', message: { role: 'user', content: [{ tool_use_id: agentCall, type: 'tool_result', content: report }] }, toolUseResult: { status: 'completed', agentId: A, resolvedModel: SUB, usage: { output_tokens: 380 } } }, 3);
ctx.main.fresh += 420;
tool('AskUserQuestion', { questions: [{ question: 'The print stylesheet has low-contrast text too. Fix it as well, or leave printing as it is?', header: 'Print styles', options: [{ label: 'Fix it too', description: 'Same contrast rules for printed recipes' }, { label: 'Leave it', description: 'Only the screen styles' }], multiSelect: false }] }, 'User has answered your questions: "The print stylesheet has low-contrast text too. Fix it as well, or leave printing as it is?"="Fix it too". You can now continue with the user\'s answers in mind.', { output: 150, dur: 25 });
say('Fixing the five problems the scan found, then the contrast, including print.', 60, 3);
edit('src/components/RecipeCard.tsx', 12, `
-    <div className="card" onClick={open}>
+    <Link className="card" to={\`/recipes/\${recipe.id}\`}>
       <h3>{recipe.title}</h3>
       <p className="meta">{recipe.minutes} min · {recipe.servings} servings</p>
       <Tags tags={recipe.tags} />
       <Rating value={recipe.rating} />
       <Favourite id={recipe.id} />
-      <img src={recipe.photo} className="photo" />
-    </div>
+      <img src={recipe.photo} className="photo" alt={recipe.title} />
+    </Link>`);
edit('src/components/IconButton.tsx', 3, `
-export function IconButton({ icon, onClick }: Props) {
+export function IconButton({ icon, label, onClick }: Props) {
   return (
-    <button className="icon" onClick={onClick}>
+    <button className="icon" onClick={onClick} aria-label={label} title={label}>`);
edit('src/pages/ShoppingList.tsx', 52, `
-          <button onClick={() => remove(item.id)}><Icon name="trash" /></button>
+          <IconButton icon="trash" label={\`Remove \${item.name}\`} onClick={() => remove(item.id)} />`);
edit('src/components/SearchBar.tsx', 7, `
+      <label htmlFor="search" className="sr-only">Search recipes</label>
-      <input type="search" placeholder="Search recipes" />
+      <input id="search" type="search" placeholder="Search recipes" />`);
edit('src/styles/tokens.css', 4, `
-  --muted: #7a8194;
+  --muted: #636a7c;`);
edit('src/styles/tokens.css', 13, `
-  --muted: #8890a3;
+  --muted: #9aa2b4;`);
edit('src/styles/print.css', 2, `
-.meta, .note { color: #999; }
+.meta, .note { color: #555; }`);
bash('node scripts/contrast-check.mjs', 'Check colour contrast again', 'text on bg          16.1:1  ok\nmuted on bg          5.6:1  ok\naccent on bg         4.8:1  ok\ndark: muted on bg    6.9:1  ok\nprint: muted on bg   7.5:1  ok', { dur: 2 });
bash('npm test -- --run && npm run lint', 'Run the tests and the linter', ' Test Files  15 passed (15)\n      Tests  98 passed (98)\n\n> pantry@1.4.0 lint\n> eslint src --max-warnings 0', { dur: 9 });
say(`Done. The important problems are fixed:

| Problem | Fix |
| --- | --- |
| Recipe photos without alt text | \`alt\` is the recipe title |
| Clickable card that was a \`div\` | It's a link now, so it works with the keyboard |
| Icon-only buttons without a name | \`IconButton\` takes a required \`label\` |
| Search box without a label | A visually hidden label |
| Low-contrast secondary text | Darker in light mode, lighter in dark mode, and in print |

All text now meets the 4.5:1 contrast ratio. Tests and the linter pass.`, 420, 6);
done((t - t4) * 1000);

// 5. Offline mode, still being worked on
prompt('Add an offline mode: cache the recipes and the shopping list so the app works without a connection.', 600);
const PLAY_FROM = t;
const t5 = t;
think('Service worker for the app shell and recipes; the shopping list needs a queue for changes made offline.');
const plan5 = ['Register a service worker', 'Cache the recipes and their photos', 'Queue shopping list changes made offline', 'Show an offline banner', 'Test it end to end offline'];
todos(plan5.map((s, i) => [s, i === 0 ? 'in_progress' : 'pending']), 4);
read('vite.config.ts', 500);
read('src/api/client.ts', 900);
grep('fetch\\(|api\\.', 'src', `src/api/client.ts:12:  const res = await fetch(base + path, init);
src/store/recipes.ts:9:  return api.get('/recipes');
src/store/shoppingList.ts:23:  await api.post('/list', item);`);
write('public/sw.js', `const SHELL = 'pantry-shell-v1';
const RECIPES = 'pantry-recipes-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/index.html', '/assets/app.js', '/assets/app.css'])));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, RECIPES].includes(k)).map((k) => caches.delete(k)))));
});`, { dt: 7 });
edit('src/main.tsx', 9, `
 initTheme();
+if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
 createRoot(document.getElementById('root')!).render(<App />);`);
todos(plan5.map((s, i) => [s, i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending']));
edit('public/sw.js', 11, `
+
+// Recipes: network first, so they stay fresh, falling back to the cache offline.
+// Photos: cache first, as they never change once uploaded.
+self.addEventListener('fetch', (e) => {
+  const url = new URL(e.request.url);
+  if (url.pathname.startsWith('/api/recipes')) {
+    e.respondWith(
+      fetch(e.request)
+        .then((res) => {
+          const copy = res.clone();
+          caches.open(RECIPES).then((c) => c.put(e.request, copy));
+          return res;
+        })
+        .catch(() => caches.match(e.request)),
+    );
+  } else if (url.pathname.startsWith('/photos/')) {
+    e.respondWith(caches.match(e.request).then((hit) => hit ?? fetch(e.request)));
+  }
+});`, { dt: 9 });
bash('npm run build', 'Build the app', 'vite v6.2.0 building for production...\n✓ 214 modules transformed.\ndist/index.html          0.62 kB\ndist/assets/app.css     18.40 kB\ndist/assets/app.js     186.95 kB\n✓ built in 2.84s', { dur: 6 });
todos(plan5.map((s, i) => [s, i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending']));
read('src/store/shoppingList.ts', 1800);
write('src/lib/offlineQueue.ts', `type Change = { at: number; op: 'add' | 'update' | 'remove'; item: Item };

const KEY = 'pantry.queue';

export function enqueue(change: Omit<Change, 'at'>): void {
  const queue: Change[] = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  queue.push({ ...change, at: Date.now() });
  localStorage.setItem(KEY, JSON.stringify(queue));
}

export async function flush(send: (c: Change) => Promise<void>): Promise<void> {
  const queue: Change[] = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  for (const change of queue) await send(change);
  localStorage.removeItem(KEY);
}`);
edit('src/store/shoppingList.ts', 21, `
 export async function addItem(item: Item) {
   items.push(item);
-  await api.post('/list', item);
+  if (navigator.onLine) await api.post('/list', item);
+  else enqueue({ op: 'add', item });
 }`);
bash('npm test -- --run shoppingList', 'Run the shopping list tests', ' ❯ test/shoppingList.test.ts (9 tests | 1 failed)\n   × replays offline changes in order\n     → expected [ "remove milk", "add milk" ] to equal [ "add milk", "remove milk" ]\n\n Test Files  1 failed (1)\n      Tests  1 failed | 8 passed (9)', { error: true, dur: 4 });
say('Changes replay out of order. Back online, `flush` sent them all at once, so a removal could overtake the add it undoes: sending them one at a time, oldest first.', 140, 6);
edit('src/store/shoppingList.ts', 48, `
-window.addEventListener('online', () => Promise.all(pending().map(send)));
+window.addEventListener('online', () => flush(send));`);
tool('Bash', { command: 'npm test -- --run shoppingList', description: 'Run the shopping list tests' }, '', { open: true, dt: 3 });
const END = t;

// ───────────────────────────── writing it out
rmSync(DIR, { recursive: true, force: true });
const subDir = join(DIR, SESSION, 'subagents');
mkdirSync(subDir, { recursive: true });
const pathOf = (file) => (file === 'main' ? join(DIR, `${SESSION}.jsonl`) : join(subDir, `agent-${file}.jsonl`));
writeFileSync(pathOf('main'), '');
writeFileSync(join(subDir, `agent-${A}.meta.json`), JSON.stringify({ toolUseId: agentCall, agentType: 'Explore' }));
const titleRec = { type: 'ai-title', aiTitle: 'Pantry: dark mode, CSV export, accessibility, offline mode', sessionId: SESSION };
out.sort((a, b) => a.t - b.t);
const line = (o, when) => JSON.stringify(o.rec.type === 'permission-mode' ? o.rec : { ...o.rec, timestamp: new Date(when).toISOString() }) + '\n';

const cmd = `lucidly "${pathOf('main')}"`;
if (!PLAY) {
  const start = Date.now() - (END + 8) * 1000; // the last record lands 8 seconds ago
  for (const o of out) appendFileSync(pathOf(o.file), line(o, start + o.t * 1000));
  appendFileSync(pathOf('main'), JSON.stringify(titleRec) + '\n');
  console.log(`Wrote a demo session (${out.length} records, ${Math.round(END / 60)} minutes of work) to ${DIR}`);
  console.log(`Open it with:\n  ${cmd}\nIt shows as still working for about 5 minutes: run this again for a fresh one.`);
} else {
  const start = Date.now() - PLAY_FROM * 1000;
  for (const o of out.filter((o) => o.t < PLAY_FROM)) appendFileSync(pathOf(o.file), line(o, start + o.t * 1000));
  appendFileSync(pathOf('main'), JSON.stringify(titleRec) + '\n');
  console.log(`Wrote the first four tasks to ${DIR}. Open it now in another terminal:\n  ${cmd}`);
  console.log('Replaying the last task live in 8 seconds (Ctrl+C to stop)...');
  await new Promise((r) => setTimeout(r, 8000));
  const live = out.filter((o) => o.t >= PLAY_FROM);
  let prev = PLAY_FROM;
  for (const o of live) {
    // Real gaps, squeezed: between 0.5 and 3 seconds each.
    await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(500, (o.t - prev) * 350))));
    prev = o.t;
    appendFileSync(pathOf(o.file), line(o, Date.now()));
  }
  console.log('Replay done: the last test run is left running.');
}
