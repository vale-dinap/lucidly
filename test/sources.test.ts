import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LineTailer } from '../src/sources/tail.ts';
import { ClaudeSessionSource, describeSession, encodeCwd } from '../src/sources/claude-sessions.ts';
import { StreamSource } from '../src/sources/stdin.ts';
import { TextAdapter } from '../src/adapters/text.ts';
import { Engine } from '../src/core/engine.ts';
import type { LucidlyEvent } from '../src/core/events.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'lucidly-'));

test('tailer reads complete lines, holds partial ones, and follows appends', async () => {
  const f = join(dir(), 'a.jsonl');
  writeFileSync(f, 'one\ntwo\nthr');
  const got: string[] = [];
  const t = new LineTailer(f, (ls) => got.push(...ls), 10_000);
  await t.start(false);
  assert.deepEqual(got, ['one', 'two']);
  appendFileSync(f, 'ee\r\nfour\n');
  await t.read();
  assert.deepEqual(got, ['one', 'two', 'three', 'four']);
  writeFileSync(f, 'new\n'); // truncation
  await t.read();
  assert.deepEqual(got.at(-1), 'new');
  t.stop();
});

test('tailer keeps multi-byte characters split across reads intact', async () => {
  const f = join(dir(), 'u.jsonl');
  const bytes = Buffer.from('héllo ✓\n', 'utf8');
  writeFileSync(f, bytes.subarray(0, 2));
  const got: string[] = [];
  const t = new LineTailer(f, (ls) => got.push(...ls), 10_000);
  await t.start(false);
  appendFileSync(f, bytes.subarray(2));
  await t.read();
  assert.deepEqual(got, ['héllo ✓']);
});

test('encodeCwd matches Claude Code folder naming', () => {
  assert.equal(encodeCwd('C:\\Project\\lucidly'), 'C--Project-lucidly');
  assert.equal(encodeCwd('/home/me/my.app'), '-home-me-my-app');
});

test('session source nests subagent transcripts via meta.json', async () => {
  const d = dir();
  const main = join(d, 's1.jsonl');
  const rec = (o: object) => JSON.stringify(o) + '\n';
  writeFileSync(
    main,
    rec({ type: 'user', uuid: 'u1', cwd: '/x', sessionId: 's1', message: { content: 'Research the docs and write a summary of them' } }) +
      rec({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'I will delegate the reading.' }] } }) +
      rec({ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'tool_use', id: 'T1', name: 'Agent', input: { description: 'Read docs', prompt: 'read' } }] } }) +
      rec({ type: 'ai-title', aiTitle: 'Docs research' }),
  );
  const sub = join(d, 's1', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-1.meta.json'), JSON.stringify({ toolUseId: 'T1' }));
  writeFileSync(
    join(sub, 'agent-1.jsonl'),
    rec({ type: 'user', uuid: 's-u', isSidechain: true, message: { content: 'read' } }) +
      rec({ type: 'assistant', uuid: 's-a', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'S1', name: 'WebFetch', input: { url: 'https://example.com/docs' } }] } }),
  );
  const e = new Engine();
  const src = new ClaudeSessionSource(main, false);
  await src.start((evs) => e.applyAll(evs));
  const goal = e.nodes.get(e.run.goals[0])!;
  const step = e.nodes.get(goal.children[0])!;
  const agent = e.nodes.get(step.children[0])!;
  assert.equal(agent.origin, 'subagent');
  assert.equal(e.nodes.get(agent.children[0])!.title, 'Fetch example.com/docs');
  const info = await describeSession(main);
  assert.equal(info.title, 'Docs research');
  assert.equal(info.firstPrompt, 'Research the docs and write a summary of them');
});

test('a running subagent (no meta.json yet) is linked by its prompt', async () => {
  const d = dir();
  const main = join(d, 's2.jsonl');
  const rec = (o: object) => JSON.stringify(o) + '\n';
  writeFileSync(
    main,
    rec({ type: 'user', uuid: 'u1', cwd: '/x', sessionId: 's2', message: { content: 'Look into both libraries and compare them for me' } }) +
      rec({ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'I will research each library in parallel.' }] } }) +
      rec({
        type: 'assistant',
        uuid: 'a2',
        message: {
          content: [
            { type: 'tool_use', id: 'T1', name: 'Agent', input: { description: 'Library A', prompt: 'Read the docs of library A' } },
            { type: 'tool_use', id: 'T2', name: 'Agent', input: { description: 'Library B', prompt: 'Read the docs of library B' } },
          ],
        },
      }),
  );
  const sub = join(d, 's2', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(sub, 'agent-b.jsonl'),
    rec({ type: 'user', uuid: 'b-u', isSidechain: true, message: { content: 'Read the docs of library B' } }) +
      rec({ type: 'assistant', uuid: 'b-a', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'S1', name: 'WebFetch', input: { url: 'https://b.dev/docs' } }] } }),
  );
  const e = new Engine();
  const src = new ClaudeSessionSource(main, false);
  await src.start((evs) => e.applyAll(evs));
  const step = e.nodes.get(e.nodes.get(e.run.goals[0])!.children[0])!;
  const agents = step.children.map((id) => e.nodes.get(id)!).filter((n) => n.origin === 'subagent');
  const b = agents.find((n) => /Library B/.test(n.title))!;
  assert.equal(b.children.length, 1);
  assert.equal(e.nodes.get(b.children[0])!.title, 'Fetch b.dev/docs');
  assert.equal(agents.find((n) => /Library A/.test(n.title))!.children.length, 0);
});

test('text adapter turns plain output into narration, commands and failures', () => {
  const a = new TextAdapter();
  const evs: LucidlyEvent[] = [
    ...a.push('User: fix the failing build\nI will run the build first.\n\n$ npm run build\n'),
    ...a.push('compiling...\nError: cannot find module x\n\nThe build fails on a missing module. Let me fix the import.\nEditing src/index.ts\n'),
    ...a.flush(),
  ];
  const types = evs.map((e) => e.type);
  assert.deepEqual(types, ['user.prompt', 'agent.text', 'tool.start', 'tool.end', 'agent.text', 'tool.start', 'tool.end', 'turn.end']);
  const end = evs[3] as { ok: boolean; output: string };
  assert.equal(end.ok, false);
  assert.match(end.output, /cannot find module/);

  const e = new Engine();
  e.applyAll(evs);
  const g = e.nodes.get(e.run.goals[0])!;
  assert.equal(g.title, 'fix the failing build');
  const step = e.nodes.get(g.children[0])!;
  assert.equal(step.title, 'Run the build first');
  assert.equal(e.nodes.get(step.children[1])!.type, 'subtask');
});

test('stream source auto-detects JSON lines', async () => {
  const lines = [
    { type: 'system', subtype: 'init', cwd: '/w', session_id: 'z' },
    { type: 'user', message: { content: 'List the files in this directory please' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me list them.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'done' },
  ];
  const stream = Readable.from([lines.map((l) => JSON.stringify(l)).join('\n') + '\n']);
  const evs: LucidlyEvent[] = [];
  const src = new StreamSource(stream);
  await src.start((e) => evs.push(...e));
  await new Promise((r) => stream.on('end', r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    evs.map((e) => e.type),
    ['run.meta', 'user.prompt', 'agent.text', 'turn.end'],
  );
});
