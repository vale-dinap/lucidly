import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ClaudeCodeAdapter, cleanPrompt } from '../src/adapters/claude-code.ts';
import { summarizeTool } from '../src/adapters/claude-tools.ts';
import { Engine } from '../src/core/engine.ts';
import type { LucidlyEvent } from '../src/core/events.ts';
import { actionList, filterActions } from '../src/outline.ts';

const fixture = new URL('./fixtures/claude-session.jsonl', import.meta.url);

function load(): LucidlyEvent[] {
  const a = new ClaudeCodeAdapter();
  return readFileSync(fixture, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => a.push(JSON.parse(l)));
}

test('adapter maps transcript records to events', () => {
  const evs = load();
  const types = evs.map((e) => e.type);
  assert.equal(types[0], 'run.meta');
  assert.ok(types.includes('agent.thinking'));
  assert.equal(types.filter((t) => t === 'tool.start').length, 5);
  assert.equal(types.filter((t) => t === 'turn.end').length, 1);
  const failed = evs.find((e) => e.type === 'tool.end' && !e.ok);
  assert.ok(failed);
  const prompts = evs.filter((e) => e.type === 'user.prompt').map((e) => (e as { text: string }).text);
  assert.deepEqual(prompts, ['Add input validation to the signup form and make sure the tests pass', '/review quick']);
  assert.ok(evs.some((e) => e.type === 'run.meta' && e.title === 'Signup form validation'));
});

test('actions list every action in order with its step, and filters work', () => {
  const e = new Engine();
  e.applyAll(load());
  const rows = e.actions();
  assert.deepEqual(
    rows.map((r) => [r.kind, r.title, r.status]),
    [
      ['read', 'Read Signup.tsx', 'done'],
      ['edit', 'Edit Signup.tsx', 'done'],
      ['command', 'Run the test suite', 'failed'],
      ['edit', 'Edit Signup.tsx', 'done'],
      ['command', 'Run the test suite', 'done'],
    ],
  );
  assert.equal(rows[2].command, 'npm test');
  assert.equal(rows[2].step, 'Run the test suite');
  assert.equal(rows[2].issue, 'FAIL src/Signup.test.tsx');
  assert.equal(rows[3].goal, 'Add input validation to the signup form and make sure the tests pass');

  const cmds = filterActions(e, rows, { kinds: ['command'] });
  assert.equal(cmds.length, 2);
  assert.equal(filterActions(e, rows, { errorsOnly: true }).length, 1);
  assert.equal(filterActions(e, rows, { grep: 'signup.tsx' }).length, 3);
  const text = actionList(e, { kinds: ['command'] });
  assert.match(text, /✖  \$ npm test/);
  assert.match(text, /└ FAIL src\/Signup\.test\.tsx/);
  assert.match(text, /2 actions, 1 recovered after failing/);
});

test('adapter dedupes records by uuid', () => {
  const a = new ClaudeCodeAdapter();
  const rec = { type: 'assistant', uuid: 'x', message: { content: [{ type: 'text', text: 'hi there' }] } };
  assert.equal(a.push(rec).length, 1);
  assert.equal(a.push(rec).length, 0);
});

test('full pipeline builds the expected picture', () => {
  const e = new Engine();
  e.applyAll(load());
  const g = e.nodes.get(e.run.goals[0])!;
  assert.equal(e.run.title, 'Signup form validation');
  const steps = g.children.map((c) => e.nodes.get(c)!).filter((n) => n.type === 'step');
  assert.deepEqual(
    steps.map((s) => [s.title, s.status]),
    [
      ['Inspect the signup form', 'done'],
      ['Add validation rules', 'done'],
      ['Run the test suite', 'done'],
    ],
  );
  const run = steps[2];
  const sub = run.children.map((c) => e.nodes.get(c)!).find((n) => n.type === 'subtask')!;
  assert.equal(sub.title, 'Fix the message');
  assert.deepEqual(run.context?.files, ['C:\\demo\\app\\src\\Signup.tsx']);
  assert.deepEqual(run.context?.commands, ['npm test']);
  assert.match(g.outcome!, /all 12 tests pass/);
  // the second prompt is a slash command asking for something new: its own task
  assert.equal(e.run.goals.length, 2);
});

test('cleanPrompt strips harness markup', () => {
  assert.equal(cleanPrompt('<local-command-stdout>x</local-command-stdout>'), null);
  assert.equal(cleanPrompt('<system-reminder>a</system-reminder>\nhello'), 'hello');
  assert.equal(cleanPrompt('<bash-input>ls</bash-input>'), '! ls');
  assert.equal(cleanPrompt('<ide_opened_file>The user opened x</ide_opened_file>\nRefactor main.rs'), 'Refactor main.rs');
  assert.equal(cleanPrompt('<pasted_content id="a1">\n---\nname: foo\n</pasted_content>\nreview this'), 'review this');
  assert.equal(cleanPrompt('<pasted_content id="a1">\n---\nname: foo\n</pasted_content>'), '[pasted] name: foo');
});

test('task notifications become notices, not prompts', () => {
  const a = new ClaudeCodeAdapter();
  const evs = a.push({
    type: 'user',
    uuid: 'n1',
    message: { content: '<task-notification>\n<task-id>b0d</task-id>\n<status>completed</status>\n<summary>Background command "Install" completed</summary>\n</task-notification>' },
  });
  assert.deepEqual(evs.map((e) => e.type), ['notice']);
  assert.match((evs[0] as { text: string }).text, /Install/);
});

test('intent comes from narration that leads to action, not from an answer', () => {
  const e = new Engine();
  e.applyAll([
    { type: 'user.prompt', text: 'What does this repository contain, in short?' },
    { type: 'tool.start', callId: 'x', tool: 'Bash', kind: 'command', label: '$ ls' },
    { type: 'tool.end', callId: 'x', ok: true },
    { type: 'agent.text', text: 'It contains only a README.' },
    { type: 'turn.end' },
  ]);
  const g = e.nodes.get(e.run.goals[0])!;
  assert.equal(g.intent, undefined);
  assert.equal(g.outcome, 'It contains only a README.');
});

test('tool summaries are short and typed', () => {
  assert.equal(summarizeTool('Bash', { command: 'npm test -- --watch', description: 'Run tests' }).label, 'Run tests');
  assert.equal(summarizeTool('Bash', { command: 'git status\ngit diff' }).label, '$ git status');
  assert.equal(summarizeTool('Bash', { command: 'cd /very/long/path && SP="x y"; npm test' }).command, 'npm test');
  assert.equal(summarizeTool('Bash', { command: 'cd /only/a/cd' }).command, 'cd /only/a/cd');
  assert.equal(summarizeTool('Read', { file_path: '/a/b/c.ts' }).label, 'Read c.ts');
  assert.equal(summarizeTool('mcp__claude_ai_Slack__send_message', {}).label, 'Slack › send message');
  assert.equal(summarizeTool('Agent', { description: 'Find docs', prompt: 'p' }).spawnsAgent, true);
});

test('planning tools become plan events, not activities', () => {
  const a = new ClaudeCodeAdapter();
  const evs = a.push({
    type: 'assistant',
    uuid: 'p1',
    message: {
      content: [
        { type: 'tool_use', id: 'tw', name: 'TodoWrite', input: { todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] } },
      ],
    },
  });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'plan.set');
  const res = a.push({ type: 'user', uuid: 'p2', message: { content: [{ type: 'tool_result', tool_use_id: 'tw', content: 'ok' }] } });
  assert.equal(res.length, 0);
});

test('TaskCreate/TaskUpdate are linked through the created task id', () => {
  const a = new ClaudeCodeAdapter();
  const e = new Engine();
  const feed = (r: object) => e.applyAll(a.push(r));
  feed({ type: 'user', uuid: 'q0', message: { content: 'Please refactor the module into three separate files' } });
  feed({ type: 'assistant', uuid: 'q1', message: { content: [{ type: 'tool_use', id: 'tc', name: 'TaskCreate', input: { subject: 'Split lexer', description: 'd' } }] } });
  feed({ type: 'user', uuid: 'q2', message: { content: [{ type: 'tool_result', tool_use_id: 'tc', content: 'Task #1 created successfully: Split lexer' }] } });
  feed({ type: 'assistant', uuid: 'q3', message: { content: [{ type: 'tool_use', id: 'tu', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] } });
  const g = e.nodes.get(e.run.goals[0])!;
  const step = e.nodes.get(g.children[0])!;
  assert.equal(step.title, 'Split lexer');
  assert.equal(step.status, 'active');
});

test('API error messages are blockers, not narration', () => {
  const a = new ClaudeCodeAdapter();
  const evs = a.push({
    type: 'assistant',
    uuid: 'e1',
    isApiErrorMessage: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text: "API Error: Can't reach the API server" }] },
  });
  assert.deepEqual(evs.map((e) => [e.type, (e as { blocking?: boolean }).blocking]), [['notice', true]]);
});

test('interruptions end the turn', () => {
  const a = new ClaudeCodeAdapter();
  const evs = a.push({ type: 'user', uuid: 'i1', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.deepEqual(evs.map((e) => e.type), ['turn.end']);
});

test('token usage is counted once per message and credited to the step and subagent that used it', () => {
  const usage = (input: number, output: number, read = 0, write = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write });
  const asst = (uuid: string, mid: string, model: string, block: object, u: object) => ({ type: 'assistant', uuid, timestamp: '2026-11-04T10:00:00Z', message: { id: mid, model, content: [block], usage: u } });
  const main = new ClaudeCodeAdapter();
  const sub = new ClaudeCodeAdapter('T1');
  const e = new Engine();
  const feed = (a: ClaudeCodeAdapter, recs: object[]) => {
    for (const r of recs) e.applyAll(a.push(r));
    e.applyAll(a.flush());
  };
  feed(main, [
    { type: 'user', uuid: 'u1', cwd: '/x', sessionId: 's', message: { content: 'Research the two libraries and compare them' } },
    // one message, two records: usage repeats and must count once
    asst('a1', 'm1', 'claude-opus-5-5', { type: 'text', text: 'Let me delegate the reading to a subagent.' }, usage(10, 100, 5000, 200)),
    asst('a2', 'm1', 'claude-opus-5-5', { type: 'tool_use', id: 'T1', name: 'Agent', input: { description: 'Read docs', prompt: 'read' } }, usage(10, 100, 5000, 200)),
  ]);
  feed(sub, [
    { type: 'user', uuid: 's1', isSidechain: true, message: { content: 'read' } },
    asst('s2', 'm2', 'claude-haiku-5-5', { type: 'text', text: 'Reading.' }, usage(50, 20)),
  ]);
  const u = e.run.usage!;
  assert.equal(u.responses, 2);
  assert.equal(u.output, 120);
  assert.equal(u.cacheRead, 5000);
  assert.equal(u.context, 5210); // main agent only: 10 + 5000 + 200
  assert.deepEqual(Object.keys(u.byModel).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  const goal = e.nodes.get(e.run.goals[0])!;
  assert.deepEqual(goal.models, ['claude-opus-5-5', 'claude-haiku-5-5']);
  const step = e.nodes.get(goal.children.find((id) => e.nodes.get(id)!.type === 'step')!)!;
  assert.equal(step.usage!.output, 120);
  const agent = e.nodes.get(step.children.find((id) => e.nodes.get(id)!.origin === 'subagent')!)!;
  assert.deepEqual(agent.models, ['claude-haiku-5-5']);
  assert.equal(agent.usage!.output, 20);
});

test('an edit carries its recorded diff hunks through to the result and the action counts', () => {
  const a = new ClaudeCodeAdapter();
  const e = new Engine();
  const recs = [
    { type: 'user', uuid: 'u1', cwd: '/x', sessionId: 's', message: { content: 'Rename the helper function in utils please' } },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'Let me rename it.' }] } },
    { type: 'assistant', uuid: 'a2', message: { id: 'm1', content: [{ type: 'tool_use', id: 'E1', name: 'Edit', input: { file_path: '/x/utils.ts', old_string: 'function a() {}', new_string: 'function b() {}' } }] } },
    {
      type: 'user',
      uuid: 'u2',
      message: { content: [{ type: 'tool_result', tool_use_id: 'E1', content: 'The file /x/utils.ts has been updated successfully.' }] },
      toolUseResult: { filePath: '/x/utils.ts', structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' // helpers', '-function a() {}', '+function b() {}', ' export {}'] }] },
    },
  ];
  for (const r of recs) e.applyAll(a.push(r));
  const row = e.actions().find((r) => r.kind === 'edit')!;
  assert.deepEqual(row.diff, { add: 1, del: 1 });
  const result = e.raw(row.id).find((c) => c.kind === 'result')!;
  assert.equal(result.patch![0].oldStart, 10);
  assert.equal(result.patch![0].lines.length, 4);
});

test('the working folder is picked up even when the first record has none', () => {
  const a = new ClaudeCodeAdapter();
  const e = new Engine();
  e.applyAll(a.push({ type: 'queue-operation', operation: 'enqueue', sessionId: 's', timestamp: '2026-11-04T10:00:00Z' }));
  e.applyAll(a.push({ type: 'user', uuid: 'u1', cwd: '/home/me/project', sessionId: 's', message: { content: 'Add a README file describing the project' } }));
  assert.equal(e.run.cwd, '/home/me/project');
  assert.equal(e.run.sessionId, 's');
});

test("a subagent's placeholder output count is corrected from the Agent result, in either reading order", () => {
  const main = [
    { type: 'user', message: { role: 'user', content: 'Fetch the docs and summarize them' }, timestamp: '2026-11-04T10:00:00Z', sessionId: 's', cwd: '/p' },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Fetch docs', prompt: 'Fetch the docs page' } }], usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, timestamp: '2026-11-04T10:00:01Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Summary' }] }, toolUseResult: { status: 'completed', agentId: 'x', resolvedModel: 'claude-haiku-5-5', usage: { input_tokens: 2, output_tokens: 700 } }, timestamp: '2026-11-04T10:01:00Z' },
  ];
  const sub = [
    { type: 'assistant', message: { id: 's1', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Fetching.' }], usage: { input_tokens: 5, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, timestamp: '2026-11-04T10:00:10Z' },
    { type: 'assistant', message: { id: 's2', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Summary' }], usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, timestamp: '2026-11-04T10:00:50Z' },
  ];
  const run = (subFirst: boolean) => {
    const e = new Engine();
    const a = new ClaudeCodeAdapter();
    const b = new ClaudeCodeAdapter();
    const mainEv = [...main.flatMap((r) => a.push(r)), ...a.flush()];
    const subEv = [...sub.flatMap((r) => b.push(r)), ...b.flush()].map((ev) => ({ ...ev, scope: 'ag1' }));
    e.applyAll(subFirst ? [...mainEv.slice(0, 3), ...subEv, ...mainEv.slice(3)] : [...mainEv, ...subEv]);
    return e.snapshot().run.usage!;
  };
  for (const order of [false, true]) {
    const u = run(order);
    assert.equal(u.byModel['claude-haiku-5-5'].output, 120 + 700, `subFirst=${order}`);
    assert.equal(u.byModel['claude-haiku-5-5'].responses, 2);
    assert.equal(u.output, 50 + 820);
  }
});

test('a background subagent stays running until its task notification arrives', () => {
  const recs = [
    { type: 'user', message: { role: 'user', content: 'Run a test chain in the background' }, timestamp: '2026-11-04T10:00:00Z', sessionId: 's', cwd: '/p', uuid: 'u1' },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'bg1', name: 'Agent', input: { description: 'Test chain', prompt: 'Do the chain', run_in_background: true } }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }, timestamp: '2026-11-04T10:00:01Z' },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Async agent launched successfully.' }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'x' }, timestamp: '2026-11-04T10:00:02Z' },
  ];
  const e = new Engine();
  const a = new ClaudeCodeAdapter();
  e.applyAll([...recs.flatMap((r) => a.push(r)), ...a.flush()]);
  const agent = () => [...e.nodes.values()].find((n) => n.origin === 'subagent')!;
  assert.equal(agent().status, 'active');
  const note = '<task-notification>\n<task-id>x</task-id>\n<tool-use-id>bg1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Test chain" finished</summary>\n</task-notification>';
  e.applyAll([
    ...a.push({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-04T10:00:30Z', sessionId: 's', content: note }),
    ...a.push({ type: 'queue-operation', operation: 'remove', timestamp: '2026-11-04T10:00:31Z', sessionId: 's', content: note }),
  ]);
  assert.equal(agent().status, 'done');
  assert.equal(agent().endedAt, '2026-11-04T10:00:30Z');
});
