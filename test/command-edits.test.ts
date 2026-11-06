import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.ts';
import { resolveFrom } from '../src/adapters/claude-tools.ts';
import { Engine } from '../src/core/engine.ts';
import type { LucidlyEvent, ToolStartEvent } from '../src/core/events.ts';

const CWD = 'C:\\w\\app';
let n = 0;
const call = (name: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  uuid: `u${++n}`,
  cwd: CWD,
  timestamp: '2026-11-06T10:00:00.000Z',
  message: { id: `m${n}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name, input }] },
});

function starts(records: object[]): ToolStartEvent[] {
  const a = new ClaudeCodeAdapter();
  return records.flatMap((r) => a.push(r)).filter((e): e is ToolStartEvent => e.type === 'tool.start');
}

test('paths are resolved from the folder the command ran in', () => {
  assert.equal(resolveFrom(CWD, 'web/app.js'), 'C:\\w\\app\\web\\app.js');
  assert.equal(resolveFrom(CWD, '/c/Other/x.ts'), 'C:\\Other\\x.ts');
  assert.equal(resolveFrom('/home/me/app', 'a/b.md'), '/home/me/app/a/b.md');
  assert.equal(resolveFrom('/home/me/app', '/etc/hosts'), '/etc/hosts');
});

test('a command that writes files is an edit made by a command', () => {
  const script = `node - <<'EOF'
const fs = require('fs');
const edit = (f) => fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('a', 'b'));
edit('web/app.js');
edit('README.md');
EOF`;
  const [read, ed, plain, ren, del] = starts([
    call('Read', { file_path: 'C:\\w\\app\\web\\app.js' }),
    call('Bash', { command: script, description: 'Patch the app' }),
    call('Bash', { command: 'npm test 2>&1 | tail -5' }),
    call('Bash', { command: 'mv docs/a.md docs/b.md' }),
    call('PowerShell', { command: 'Remove-Item -Force old.txt' }),
  ]);
  assert.equal(read.kind, 'read');
  // README.md is only a string in the script and the session never saw it: not counted.
  assert.equal(ed.kind, 'edit');
  assert.equal(ed.via, 'command');
  assert.equal(ed.label, 'Edit app.js (by command)');
  assert.deepEqual(ed.files, ['C:\\w\\app\\web\\app.js']);
  assert.equal(plain.kind, 'command');
  assert.equal(plain.via, undefined);
  assert.equal(ren.label, 'Rename a.md → b.md (by command)');
  assert.equal(del.label, 'Delete old.txt (by command)');
});

test('the engine lists a command edit with the edits, keeping its command line', () => {
  const a = new ClaudeCodeAdapter();
  const e = new Engine();
  const evs: LucidlyEvent[] = [
    { type: 'run.meta', agent: 'Claude Code', cwd: CWD },
    ...a.push(call('Bash', { command: "sed -i 's/a/b/' src/x.ts" })),
  ];
  for (const ev of evs) e.apply(ev);
  const [row] = e.actions();
  assert.equal(row.kind, 'edit');
  assert.equal(row.via, 'command');
  assert.equal(row.command, "sed -i 's/a/b/' src/x.ts");
  assert.deepEqual(row.files, ['C:\\w\\app\\src\\x.ts']);
});
