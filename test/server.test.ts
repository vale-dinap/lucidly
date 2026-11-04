import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LucidlyServer } from '../src/server/server.ts';

const fixture = fileURLToPath(new URL('./fixtures/claude-session.jsonl', import.meta.url));
let server: LucidlyServer;

before(async () => {
  server = new LucidlyServer({ port: 0, cwd: process.cwd() });
  await server.listen();
});
after(async () => {
  await server.close();
});

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((ok, fail) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method,
        path,
        headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
      },
      (res) => {
        let s = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (s += c));
        res.on('end', () => ok({ status: res.statusCode!, body: s, headers: res.headers }));
      },
    );
    req.on('error', fail);
    if (data) req.write(data);
    req.end();
  });
}

function firstSse(path: string): Promise<{ event: string; data: any }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port: server.port, path }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        const m = /event: (\w+)\ndata: (.*)\n\n/.exec(buf);
        if (m) {
          req.destroy();
          ok({ event: m[1], data: JSON.parse(m[2]) });
        }
      });
    });
    req.on('error', (e) => (String(e).includes('socket hang up') ? undefined : fail(e)));
    req.end();
  });
}

test('serves the UI and rejects foreign hosts', async () => {
  const ok = await call('GET', '/');
  assert.equal(ok.status, 200);
  assert.match(ok.body, /<html/i);
  const bad = await call('GET', '/', undefined, { host: 'evil.example:80' });
  assert.equal(bad.status, 403);
  const trav = await call('GET', '/..%2f..%2fpackage.json');
  assert.notEqual(trav.status, 200);
});

test('open → stream snapshot → raw → save → load round trip', async () => {
  const opened = await call('POST', '/api/open', { path: fixture });
  assert.equal(opened.status, 200);
  const id = JSON.parse(opened.body).run.id;

  const again = await call('POST', '/api/open', { path: fixture });
  assert.equal(JSON.parse(again.body).run.id, id, 'same source reuses the run');

  const snap = await firstSse(`/api/s/${id}/stream`);
  assert.equal(snap.event, 'snapshot');
  assert.equal(snap.data.run.title, 'Signup form validation');
  const goalId = snap.data.run.goals[0];
  assert.equal(snap.data.nodes[goalId].type, 'goal');

  const raw = await call('GET', `/api/s/${id}/raw/${goalId}`);
  const chunks = JSON.parse(raw.body).chunks;
  assert.ok(chunks.length > 5);
  assert.equal(chunks[0].kind, 'prompt');

  const acts = JSON.parse((await call('GET', `/api/s/${id}/actions`)).body).actions;
  assert.equal(acts.length, 5);
  assert.equal(acts.filter((a: { status: string }) => a.status === 'failed').length, 1);

  const saved = await call('GET', `/api/s/${id}/save`);
  assert.match(String(saved.headers['content-disposition']), /signup-form-validation\.lucidly\.json/);
  const loaded = await call('POST', '/api/load', JSON.parse(saved.body));
  assert.equal(loaded.status, 200);
  const id2 = JSON.parse(loaded.body).run.id;
  const snap2 = await firstSse(`/api/s/${id2}/stream`);
  assert.deepEqual(Object.keys(snap2.data.nodes).length, Object.keys(snap.data.nodes).length);
});

test('live: appending to a transcript pushes a patch to subscribers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lucidly-live-'));
  const file = join(dir, 'live.jsonl');
  const rec = (o: object) => JSON.stringify(o) + '\n';
  writeFileSync(file, rec({ type: 'user', uuid: 'l1', cwd: dir, sessionId: 'live', message: { content: 'Build the feature and run all the tests' } }));
  const opened = await call('POST', '/api/open', { path: file });
  const id = JSON.parse(opened.body).run.id;

  const got = await new Promise<any>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('no patch within 5s')), 5000);
    const req = request({ host: '127.0.0.1', port: server.port, path: `/api/s/${id}/stream` }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('event: snapshot') && !buf.includes('appended')) {
          buf += 'appended';
          appendFileSync(file, rec({ type: 'assistant', uuid: 'l2', message: { content: [{ type: 'text', text: 'Let me write the feature module.' }] } }));
        }
        const m = /event: patch\ndata: (.*)\n\n/.exec(buf);
        if (m) {
          clearTimeout(timer);
          req.destroy();
          ok(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', () => {});
    req.end();
  });
  const titles = Object.values(got.nodes).filter(Boolean).map((n: any) => n.title);
  assert.ok(titles.includes('Write the feature module'), `patch had: ${titles.join(', ')}`);
  assert.equal(got.run.status, 'working');
});

test('writes require JSON and same origin', async () => {
  const noJson = await call('POST', '/api/load', undefined, { 'content-type': 'text/plain' });
  assert.equal(noJson.status, 415);
  const cross = await call('POST', '/api/load', {}, { origin: 'http://evil.example' });
  assert.equal(cross.status, 403);
  const badFile = await call('POST', '/api/load', { hello: 1 });
  assert.equal(badFile.status, 400);
});
