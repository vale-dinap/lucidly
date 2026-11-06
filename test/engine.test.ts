import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.ts';
import type { LucidlyEvent, ToolStartEvent } from '../src/core/events.ts';
import type { ViewNode } from '../src/core/model.ts';

let call = 0;
const tool = (label: string, extra: Partial<ToolStartEvent> = {}): ToolStartEvent => ({
  type: 'tool.start',
  callId: `c${++call}`,
  tool: 'Bash',
  kind: 'command',
  label,
  ...extra,
});
const end = (start: ToolStartEvent, ok = true, output = 'ok'): LucidlyEvent => ({ type: 'tool.end', callId: start.callId, ok, output });
const text = (t: string): LucidlyEvent => ({ type: 'agent.text', text: t });
const prompt = (t: string): LucidlyEvent => ({ type: 'user.prompt', text: t });

function children(e: Engine, id: string, type?: string): ViewNode[] {
  return e.nodes.get(id)!.children.map((c) => e.nodes.get(c)!).filter((n) => !type || n.type === type);
}
function goal(e: Engine, i = 0): ViewNode {
  return e.nodes.get(e.run.goals[i])!;
}

test('no plan: narration creates inferred steps, final text becomes outcome', () => {
  const e = new Engine();
  const t1 = tool('$ ls');
  const t2 = tool('$ npm test');
  e.applyAll([
    prompt('Please investigate why the build is slow on CI'),
    text('Let me look at the project layout first.'),
    t1,
    end(t1),
    text('Now let me run the test suite.'),
    t2,
    end(t2),
    text('The build is slow because tests run serially. I suggest enabling parallelism.'),
    { type: 'turn.end' },
  ]);
  const g = goal(e);
  const steps = children(e, g.id, 'step');
  assert.deepEqual(
    steps.map((s) => [s.title, s.status, s.origin]),
    [
      ['Look at the project layout first', 'done', 'inferred'],
      ['Run the test suite', 'done', 'inferred'],
    ],
  );
  assert.equal(g.intent, 'Look at the project layout first');
  assert.match(g.outcome!, /tests run serially/);
  assert.equal(g.status, 'done');
  assert.equal(e.run.status, 'waiting');
});

test('text plan: tentative until acted on, then narration advances steps', () => {
  const e = new Engine();
  const a = tool('Write package.json', { kind: 'write', tool: 'Write', files: ['package.json'] });
  const b = tool('Write engine.ts', { kind: 'write', tool: 'Write', files: ['src/engine.ts'] });
  e.applyAll([
    prompt('Build the first version of the project please'),
    text("Here's the plan:\n1. Scaffold the project\n2. Core engine with tests\n3. Web interface"),
  ]);
  let steps = children(e, goal(e).id, 'step');
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => s.tentative));

  e.applyAll([a, end(a), text('Scaffold is done. Now the core engine.'), b, end(b)]);
  steps = children(e, goal(e).id, 'step');
  assert.deepEqual(
    steps.map((s) => [s.title, s.status, !!s.tentative]),
    [
      ['Scaffold the project', 'done', false],
      ['Core engine with tests', 'active', false],
      ['Web interface', 'pending', false],
    ],
  );
  assert.deepEqual(steps[1].context?.files, ['src/engine.ts']);
  assert.equal(steps[1].stats?.actions, 1);
});

test('a numbered list in a final answer is not a plan', () => {
  const e = new Engine();
  e.applyAll([prompt('What are the options for hosting this service?'), text('Options:\n1. A VPS\n2. Serverless\n3. Kubernetes'), { type: 'turn.end' }]);
  const g = goal(e);
  assert.equal(children(e, g.id, 'step').length, 0);
  assert.match(g.outcome!, /Options/);
  assert.ok(e.raw(g.id).some((c) => c.kind === 'outcome'));
});

test('under a plan, a fix after failure becomes an unplanned subtask and a blocker resolves', () => {
  const e = new Engine();
  const a = tool('$ npm test');
  const b = tool('$ npm test');
  const fix = tool('Edit engine.ts', { kind: 'edit', tool: 'Edit', files: ['engine.ts'] });
  const c = tool('$ npm test');
  e.applyAll([
    prompt('Implement the engine and make the tests pass'),
    text('Plan:\n1. Write the engine\n2. Run the tests'),
    a,
    end(a, false, 'Error: expected 2 got 3'),
    b,
    end(b, false, 'Error: expected 2 got 3'),
  ]);
  const step1 = children(e, goal(e).id, 'step')[0];
  const blockers = children(e, step1.id, 'blocker');
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].status, 'open');
  assert.equal(children(e, step1.id, 'activity')[1].retry, true);

  e.applyAll([text('The test fails because of an off-by-one. Let me fix the loop bound.'), fix, end(fix)]);
  const subs = children(e, step1.id, 'subtask');
  assert.equal(subs.length, 1);
  assert.equal(subs[0].origin, 'unplanned');
  assert.equal(subs[0].title, 'Fix the loop bound');
  assert.equal(children(e, subs[0].id, 'activity').length, 1);

  e.applyAll([text('Now run the tests again.'), c, end(c)]);
  const steps = children(e, goal(e).id, 'step');
  assert.equal(steps[1].status, 'active');
  assert.equal(e.nodes.get(subs[0].id)!.status, 'done');
});

test('blocker opens on repeated failure and resolves on success in the same unit', () => {
  const e = new Engine();
  const a = tool('$ pip install x');
  const b = tool('$ pip install x');
  const c = tool('$ pip install x==1.0');
  e.applyAll([prompt('Install the dependency and run it please'), text('Let me install it.'), a, end(a, false, 'boom'), b, end(b, false, 'boom')]);
  const step = children(e, goal(e).id, 'step')[0];
  const blocker = children(e, step.id, 'blocker')[0];
  assert.equal(blocker.status, 'open');
  e.applyAll([c, end(c, true)]);
  assert.equal(e.nodes.get(blocker.id)!.status, 'resolved');
});

test('rejected action is a blocker immediately', () => {
  const e = new Engine();
  const a = tool('$ rm -rf build');
  e.applyAll([prompt('Clean the build directory and rebuild'), text('Let me clean it.'), a, { type: 'tool.end', callId: a.callId, ok: false, rejected: true }]);
  const step = children(e, goal(e).id, 'step')[0];
  assert.equal(children(e, step.id, 'blocker')[0].title, 'Rejected: $ rm -rf build');
});

test('tool plans drive statuses explicitly', () => {
  const e = new Engine();
  e.applyAll([
    prompt('Refactor the parser module into smaller files'),
    {
      type: 'plan.set',
      source: 'TodoWrite',
      replace: true,
      items: [
        { title: 'Split lexer', status: 'in_progress' },
        { title: 'Split parser', status: 'pending' },
      ],
    },
  ]);
  const a = tool('Edit lexer.ts', { kind: 'edit', tool: 'Edit' });
  e.applyAll([
    a,
    end(a),
    {
      type: 'plan.set',
      source: 'TodoWrite',
      replace: true,
      items: [
        { title: 'Split lexer', status: 'completed' },
        { title: 'Split parser', status: 'in_progress' },
        { title: 'Update imports', status: 'pending' },
      ],
    },
  ]);
  const steps = children(e, goal(e).id, 'step');
  assert.deepEqual(
    steps.map((s) => [s.title, s.status]),
    [
      ['Split lexer', 'done'],
      ['Split parser', 'active'],
      ['Update imports', 'pending'],
    ],
  );
  assert.equal(children(e, steps[0].id, 'activity').length, 1);
});

test('short replies continue the goal; substantive prompts open a new one', () => {
  const e = new Engine();
  e.applyAll([prompt('Add a README file describing the project'), text('Let me write it.'), { type: 'turn.end' }, prompt('yes')]);
  assert.equal(e.run.goals.length, 1);
  e.applyAll([text('Done.'), { type: 'turn.end' }, prompt('Now add a license file with the MIT license text')]);
  assert.equal(e.run.goals.length, 2);
  assert.equal(goal(e, 0).status, 'done');
  assert.equal(goal(e, 1).status, 'active');
});

test('a message sent mid-turn is an interjection in the current step, not a new task', () => {
  const e = new Engine();
  const a = tool('$ npm run build');
  e.applyAll([
    prompt('Redesign the web interface with a minimal look'),
    text('Let me rewrite the stylesheet.'),
    a,
    end(a),
    prompt('the session is currently open, so let me know if I need to exit in order to let you apply the changes'),
    text('No need to exit, just refresh the page.'),
    { type: 'turn.end' },
  ]);
  assert.equal(e.run.goals.length, 1);
  const step = children(e, goal(e).id, 'step')[0];
  const note = children(e, step.id, 'activity').find((n) => n.kind === 'user');
  assert.match(note!.title, /^You: the session is currently open/);
  // once the turn has ended, a substantive message does start a new task
  e.apply(prompt('Now add keyboard shortcuts to the actions view'));
  assert.equal(e.run.goals.length, 2);
});

test('subagent events nest inside the subagent subtask', () => {
  const e = new Engine();
  const spawn = tool('Agent: research docs', { tool: 'Agent', kind: 'agent', spawnsAgent: true });
  const inner = { ...tool('Fetch docs page', { kind: 'web', tool: 'WebFetch' }), scope: spawn.callId };
  e.applyAll([
    prompt('Research the plugin documentation and summarize it'),
    text('I will delegate the research.'),
    spawn,
    { type: 'user.prompt', text: 'Read the docs', scope: spawn.callId },
    inner,
    { type: 'tool.end', callId: inner.callId, ok: true, output: 'html', scope: spawn.callId },
    end(spawn, true, 'summary'),
  ]);
  const step = children(e, goal(e).id, 'step')[0];
  const sub = children(e, step.id, 'subtask')[0];
  assert.equal(sub.origin, 'subagent');
  assert.equal(sub.status, 'done');
  assert.equal(children(e, sub.id, 'activity').length, 1);
  assert.equal(e.run.goals.length, 1);
});

test('patches carry only changed nodes and deletions', () => {
  const e = new Engine();
  e.applyAll([prompt('Do a fairly long task with many parts'), text('Let me start.')]);
  e.takePatch();
  assert.equal(e.takePatch(), null);
  e.apply({ type: 'turn.end' });
  const p = e.takePatch()!;
  const deleted = Object.entries(p.nodes).filter(([, v]) => v === null);
  assert.equal(deleted.length, 1);
  assert.ok(p.nodes[e.run.goals[0]]);
});

test('raw returns chunks of a subtree in order', () => {
  const e = new Engine();
  const a = tool('$ echo hi');
  e.applyAll([prompt('Say hi in the terminal for me'), text('Let me echo.'), a, end(a, true, 'hi')]);
  const step = children(e, goal(e).id, 'step')[0];
  assert.deepEqual(
    e.raw(step.id).map((c) => c.kind),
    ['text', 'tool', 'result'],
  );
});

test('failures are recovered by a later success in the same unit or a fix nested in it; the rest stay unresolved', () => {
  const e = new Engine();
  const t1 = tool('$ npm test');
  const fix = tool('Edit engine.ts', { kind: 'edit', tool: 'Edit', files: ['engine.ts'] });
  const t2 = tool('$ npm run lint');
  e.applyAll([
    prompt('Implement the engine and make the tests pass'),
    text('Plan:\n1. Make the tests pass\n2. Lint'),
    t1,
    end(t1, false, 'Error: expected 2 got 3'),
    text('The test fails because of an off-by-one. Let me fix the loop bound.'),
    fix,
    end(fix),
    text('Now lint.'),
    t2,
    end(t2, false, 'error: unused variable'),
  ]);
  const [s1, s2] = children(e, goal(e).id, 'step');
  assert.equal(e.nodes.get(children(e, s1.id, 'activity')[0].id)!.recovered, true);
  assert.deepEqual(e.nodes.get(s1.id)!.stats, { actions: 2, errors: 1, recovered: 1 });
  const lint = children(e, s2.id, 'activity')[0];
  assert.equal(lint.recovered, undefined);
  const g = goal(e).stats!;
  assert.equal(g.errors - (g.recovered ?? 0), 1); // one still unresolved
  const rows = e.actions();
  assert.deepEqual(rows.filter((r) => r.status === 'failed').map((r) => !!r.recovered), [true, false]);
});

test('actions are listed by time even when subagent events arrive late', () => {
  const e = new Engine();
  const spawn = tool('Agent: research docs', { tool: 'Agent', kind: 'agent', spawnsAgent: true });
  const after = tool('$ npm test');
  e.applyAll([
    prompt('Research the plugin documentation and summarize it'),
    text('I will delegate the research.'),
    { ...spawn, ts: '2026-11-04T10:00:00Z' },
    { ...end(spawn, true, 'summary'), ts: '2026-11-04T10:05:00Z' },
    { ...after, ts: '2026-11-04T10:06:00Z' },
    { ...end(after), ts: '2026-11-04T10:06:05Z' },
    // the subagent's own transcript is read afterwards
    { ...tool('Fetch docs page', { kind: 'web', tool: 'WebFetch' }), scope: spawn.callId, ts: '2026-11-04T10:01:00Z' },
  ]);
  assert.deepEqual(
    e.actions().map((r) => r.title),
    ['Agent: research docs', 'Fetch docs page', '$ npm test'],
  );
});

test("the main agent's usage is never credited to a subagent, even when it arrives mid-subagent", () => {
  const e = new Engine();
  const spawn = tool('Agent: test chain', { tool: 'Agent', kind: 'agent', spawnsAgent: true });
  const use = (model: string, scope?: string) => ({ type: 'usage' as const, model, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...(scope ? { scope } : {}) });
  e.applyAll([
    prompt('Run a quick test chain in a subagent'),
    text('Delegating it.'),
    spawn,
    { ...tool('$ ls'), scope: spawn.callId },
    use('claude-haiku-5-5', spawn.callId),
    // the main agent answers while the subagent's action is the latest thing in the step
    use('claude-opus-5-5'),
  ]);
  const agent = [...e.nodes.values()].find((n) => n.origin === 'subagent')!;
  assert.deepEqual(agent.models, ['claude-haiku-5-5']);
  assert.equal(agent.usage!.responses, 1);
  const step = e.nodes.get(agent.parent!)!;
  assert.deepEqual([...step.models!].sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
});

test('text plan steps done all at once count as done when the task ends; not after an interruption', () => {
  const run = (interrupted: boolean) => {
    const e = new Engine();
    const a = tool('Edit app.js', { kind: 'edit', tool: 'Edit', files: ['web/app.js'] });
    e.applyAll([
      prompt('Change the strip colours and the edit tips please'),
      text("I'll make two changes:\n- **Colours:** a new one for reads\n- **Tips:** scale them with the bar width"),
      a,
      end(a),
      text('Done: both are in.'),
      { type: 'turn.end', interrupted },
      prompt('Now let us look at something else entirely, the header layout'),
    ]);
    return children(e, goal(e).id, 'step').map((s) => [s.status, !!s.untracked]);
  };
  assert.deepEqual(run(false), [
    ['done', false],
    ['done', true],
  ]);
  assert.deepEqual(run(true), [
    ['done', false],
    ['pending', false],
  ]);
});

test('a finished turn marks its task done; a follow-up reopens it; an interrupted one waits', () => {
  const e = new Engine();
  const a = tool('npm test');
  e.applyAll([prompt('Run the tests and tell me how they went'), a, end(a), text('All pass.'), { type: 'turn.end' }]);
  assert.equal(goal(e).status, 'done');
  assert.ok(goal(e).endedAt !== undefined || goal(e).status === 'done');
  e.applyAll([prompt('ok'), text('Anything else?')]);
  assert.equal(e.run.goals.length, 1);
  assert.equal(goal(e).status, 'active');
  assert.equal(goal(e).endedAt, undefined);
  const b = tool('npm run lint');
  e.applyAll([b, { type: 'turn.end', interrupted: true }]);
  assert.equal(goal(e).status, 'waiting');
});

test('after a turn, a short status update is a new task; an approval or an answer continues', () => {
  const e = new Engine();
  e.applyAll([prompt('Plan the commits for this repository please'), text('Here is the list. Want me to create them?'), { type: 'turn.end' }, prompt('not yet')]);
  assert.equal(e.run.goals.length, 1, 'an answer to a question continues the task');
  e.applyAll([text('Fine, tell me when.'), { type: 'turn.end' }, prompt('go ahead')]);
  assert.equal(e.run.goals.length, 1, 'an approval continues the task');
  e.applyAll([text('Done: all nine are in.'), { type: 'turn.end' }, prompt('all committed and pushed.')]);
  assert.equal(e.run.goals.length, 2, 'a status update is a new task');
  assert.equal(goal(e, 0).status, 'done');
});

test('a reply after the turn ended starts a new round of the task', () => {
  const e = new Engine();
  const a = tool('Read engine.ts', { kind: 'read', tool: 'Read' });
  const b = tool('$ npm test');
  e.applyAll([
    prompt('Look into why some edits are shown as commands'),
    text('Let me look at the classification.'),
    a,
    end(a),
    text('Commands are never edits today. Should I go with the first option?'),
    { type: 'turn.end' },
  ]);
  assert.equal(goal(e).outcome, 'Commands are never edits today. Should I go with the first option?');
  e.applyAll([prompt('yes go with the first'), text('Now the parser.'), b, end(b), text('Done: commands that write files are edits.'), { type: 'turn.end' }]);
  assert.equal(e.run.goals.length, 1);
  // The task's children, in order: round 1's step, the reply, round 2's step.
  const kids = goal(e).children.map((id) => e.snapshot().nodes[id]);
  assert.deepEqual(kids.map((n) => n.type), ['step', 'activity', 'step']);
  const reply = kids[1];
  assert.equal(reply.kind, 'user');
  assert.deepEqual(reply.round, { outcome: 'Commands are never edits today. Should I go with the first option?', asked: true });
  assert.equal(kids[0].children.length, 1, 'the first step keeps only its own work');
  assert.equal(kids[2].children.length, 1, 'the new work is a step of its own');
  assert.equal(goal(e).outcome, 'Done: commands that write files are edits.');
  assert.equal(goal(e).status, 'done');
});

test('a round goes between the steps done and a plan still to come', () => {
  const e = new Engine();
  const a = tool('$ step one');
  const b = tool('$ step two');
  e.applyAll([
    prompt('Do the three things on the list in order please'),
    { type: 'plan.set', source: 'TodoWrite', replace: true, items: [{ title: 'One', status: 'in_progress' }, { title: 'Two', status: 'pending' }, { title: 'Three', status: 'pending' }] },
    text('Starting with one.'),
    a,
    end(a),
    { type: 'plan.update', title: 'One', status: 'completed' },
    text('One is done. Shall I go on?'),
    { type: 'turn.end' },
    prompt('yes'),
    { type: 'plan.update', title: 'Two', status: 'in_progress' },
    b,
    end(b),
  ]);
  const kids = goal(e).children.map((id) => e.snapshot().nodes[id]);
  assert.deepEqual(kids.map((n) => (n.type === 'step' ? n.title : n.kind)), ['One', 'user', 'Two', 'Three']);
  assert.equal(kids[2].children.length, 1);
});

test('a message mid-turn and /compact do not start a round; after /compact the turn is still over', () => {
  const e = new Engine();
  e.applyAll([prompt('Write the release notes for the new version'), text('Here they are.'), { type: 'turn.end' }, prompt('/compact')]);
  assert.equal(e.run.status, 'waiting');
  assert.equal(goal(e).status, 'done');
  assert.ok(!goal(e).children.some((id) => e.snapshot().nodes[id].round));
  // A substantive message after /compact is a new task, not an interjection.
  e.apply(prompt('someone asked whether Lucidly streams the log as it runs'));
  assert.equal(e.run.goals.length, 2);
});
