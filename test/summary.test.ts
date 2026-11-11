import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSummary, QUIET_MS } from '../src/core/summary.ts';
import type { RunInfo, ViewNode } from '../src/core/model.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A run with one task (g) and one step (s), plus whatever extra nodes a test adds under them. */
function setup(run: Partial<RunInfo>, extra: ViewNode[] = [], goal: Partial<ViewNode> = {}, step: Partial<ViewNode> = {}) {
  const nodes: Record<string, ViewNode> = {
    g: { id: 'g', type: 'goal', parent: null, children: ['s'], title: 'Task', status: 'active', ...goal },
    s: { id: 's', type: 'step', parent: 'g', children: [], title: 'Step', status: 'active', ...step },
  };
  for (const n of extra) {
    nodes[n.id] = n;
    nodes[n.parent!].children.push(n.id);
  }
  const info: RunInfo = { status: 'working', goals: ['g'], currentGoal: 'g', currentStep: 's', eventCount: 1, updatedAt: ago(10_000), ...run };
  return runSummary(info, nodes, NOW);
}
const node = (id: string, parent: string, o: Partial<ViewNode>): ViewNode => ({ id, type: 'activity', parent, children: [], title: id, status: 'done', ...o });

test('working, quiet, and in trouble', () => {
  assert.equal(setup({}).state, 'work');
  assert.equal(setup({ updatedAt: ago(QUIET_MS + 1000) }).state, 'quiet');
  assert.equal(setup({}, [node('b', 's', { type: 'blocker', status: 'open' })]).state, 'bad');
  assert.equal(setup({}, [], {}, { stats: { actions: 3, errors: 2, recovered: 1 } }).state, 'bad');
  assert.equal(setup({}, [], {}, { stats: { actions: 3, errors: 1, recovered: 1 } }).state, 'work');
});

test('your turn: an open question, or last words that asked', () => {
  const open = setup({ status: 'waiting' }, [node('q', 'g', { kind: 'ask', status: 'active', title: 'Ask: Which colour?' })]);
  assert.deepEqual([open.state, open.question], ['you', 'Which colour?']);
  const asked = setup({ status: 'waiting' }, [], { status: 'done', asked: true, question: 'Ship it?' });
  assert.deepEqual([asked.state, asked.question], ['you', 'Ship it?']);
});

test('finished, recently or long ago, and interrupted', () => {
  assert.equal(setup({ status: 'waiting' }, [], { status: 'done' }).state, 'done');
  assert.equal(setup({ status: 'waiting', updatedAt: ago(60 * 60 * 1000) }, [], { status: 'done' }).state, 'rest');
  assert.equal(setup({ status: 'waiting' }, [], { status: 'waiting' }).state, 'paused');
});

test('running subagents are counted, also after the turn ended, but not once quiet', () => {
  const sub = (id: string, status: ViewNode['status']) => node(id, 's', { type: 'subtask', origin: 'subagent', status });
  assert.equal(setup({ status: 'waiting' }, [sub('a1', 'active'), sub('a2', 'active'), sub('a3', 'done')], { status: 'done' }).agents, 2);
  assert.equal(setup({ updatedAt: ago(QUIET_MS + 1000) }, [sub('a1', 'active')]).agents, 0);
});
