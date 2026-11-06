import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPlan, intentTitle, isSubstantivePrompt, issueSummary, matchStep, hasDeviationCue } from '../src/core/text.ts';

test('intentTitle picks the intent sentence and strips the cue', () => {
  assert.equal(intentTitle('Good. Now let me run the tests.'), 'Run the tests');
  assert.equal(
    intentTitle('Node 24 is available. Let me check whether it can run TypeScript directly.'),
    'Check whether it can run TypeScript directly',
  );
  assert.equal(intentTitle('The build passes'), 'The build passes');
});

test('intentTitle ignores code blocks and list lines', () => {
  assert.equal(intentTitle('```\nlet me crash\n```\nI\'ll update the config.'), 'Update the config');
});

test('extractPlan reads numbered lists', () => {
  const p = extractPlan('Here is the plan:\n\n1. Scaffold the project\n2. **Core engine**: reducer and tests\n3. Web UI\n\nStarting now.');
  assert.ok(p);
  assert.deepEqual(p.items, ['Scaffold the project', 'Core engine: reducer and tests', 'Web UI']);
});

test('extractPlan shortens long items at a separator', () => {
  const p = extractPlan(
    '1. Core engine — the reducer that folds events into the run state and all the plan heuristics\n2. Adapter — Claude Code transcript records into normalized events and more words here',
  );
  assert.deepEqual(p?.items, ['Core engine', 'Adapter']);
});

test('extractPlan requires a cue for bullets', () => {
  assert.equal(extractPlan('Findings:\n- foo is broken\n- bar is slow'), null);
  assert.ok(extractPlan("I'll do this:\n- fix foo\n- speed up bar"));
});

test('extractPlan ignores lists not starting at 1 and single items', () => {
  assert.equal(extractPlan('3. something\n4. else'), null);
  assert.equal(extractPlan('1. only one'), null);
});

test('extractPlan with requireCue rejects plain numbered lists', () => {
  assert.equal(extractPlan('Key facts:\n1. a thing\n2. another thing', true), null);
  assert.ok(extractPlan('New plan:\n1. a thing\n2. another thing', true));
});

test('matchStep finds the referenced step and prefers forward progress', () => {
  const steps = [
    { title: 'Scaffold the project', done: true },
    { title: 'Core engine and unit tests', done: false },
    { title: 'Claude Code adapter', done: false },
    { title: 'Web UI', done: false },
  ];
  assert.equal(matchStep('Now the Claude Code adapter: parse transcript records.', steps, 1), 2);
  assert.equal(matchStep('Moving on to step 4.', steps, 1), 3);
  assert.equal(matchStep('Let me look at this output.', steps, 1), -1);
});

test('issueSummary finds the telling line of a failure', () => {
  assert.equal(
    issueSummary('Exit code 1\nTraceback (most recent call last):\n  File "x.py", line 3, in <module>\n    f()\nValueError: expected a positive input'),
    'exit 1 · ValueError: expected a positive input',
  );
  assert.equal(issueSummary('Exit code 127\n/usr/bin/bash: line 1: gh: command not found'), 'exit 127 (command not found) · /usr/bin/bash: line 1: gh: command not found');
  assert.equal(issueSummary('Exit code 1\nbuilding...\nwrote 3 files\nsomething broke at the end'), 'exit 1 · something broke at the end');
  assert.equal(issueSummary('Exit code 2'), 'exit 2');
  assert.equal(issueSummary(''), 'Failed');
});

test('prompt and deviation heuristics', () => {
  assert.equal(isSubstantivePrompt('yes'), false);
  assert.equal(isSubstantivePrompt('go ahead'), false);
  assert.equal(isSubstantivePrompt('Please add a dark mode toggle to the settings page'), true);
  assert.equal(hasDeviationCue('The test failed, let me fix the import.'), true);
  assert.equal(hasDeviationCue('Now let me write the docs.'), false);
});

test('bullets that each open with a bold label describe things: not a plan', () => {
  const described = "I'll replace the bottom section with the task wheel. Plan:\n- **Rows:** the spotlight always sits in the third row.\n- **Sliding:** rows slide to their new places.\n- **The rest:** the orb returns to the live task.";
  assert.equal(extractPlan(described), null);
  const steps = 'Plan:\n- Add the parser\n- Wire it into the adapter\n- Write the tests';
  assert.deepEqual(extractPlan(steps)?.items.length, 3);
  const numbered = 'Plan:\n1. **Engine:** record rounds\n2. **Page:** draw them';
  assert.equal(extractPlan(numbered)?.items.length, 2);
});
