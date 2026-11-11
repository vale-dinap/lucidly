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

/** Reads a tab stream until `want` matches a "tabs" event, then hands it back (the stream stays open). */
function tabStream(client: string, runs: string[]) {
  const events: any[] = [];
  let waiters: (() => void)[] = [];
  const req = request({ host: '127.0.0.1', port: server.port, path: `/api/tabs/stream?client=${client}&runs=${runs.join(',')}` }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let m;
      while ((m = /event: tabs\ndata: (.*)\n\n/.exec(buf))) {
        events.push(JSON.parse(m[1]));
        buf = buf.slice(m.index + m[0].length);
        for (const w of waiters) w();
      }
    });
  });
  req.on('error', () => {});
  req.end();
  const next = (pred: (e: any) => boolean) =>
    new Promise<any>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('no matching tabs event within 3s')), 3000);
      const check = () => {
        const e = events.find(pred);
        if (e) {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== check);
          ok(e);
        }
      };
      waiters.push(check);
      check();
    });
  return { next, close: () => req.destroy() };
}

test('session tabs: a live state per run, and a run closes once no tab has it', async () => {
  const opened = await call('POST', '/api/open', { path: fixture });
  const run = JSON.parse(opened.body).run;
  assert.equal(run.path, fixture, 'a session file run says where it came from');
  const id = run.id;

  const a = tabStream('page-a', [id]);
  const first = await a.next((e) => e.runs[id]);
  assert.equal(first.runs[id].title, 'Signup form validation');
  assert.ok(['work', 'you', 'bad', 'done', 'rest', 'quiet', 'paused'].includes(first.runs[id].state));

  const b = tabStream('page-b', [id]);
  await b.next((e) => e.runs[id]);
  // Page A closes its tab: page B still has it, so it stays.
  const r1 = JSON.parse((await call('DELETE', `/api/s/${id}?client=page-a`)).body);
  assert.equal(r1.closed, false);
  assert.ok(server.runs.has(id));
  // Page B closes it too: nobody has it any more.
  const r2 = JSON.parse((await call('DELETE', `/api/s/${id}?client=page-b`)).body);
  assert.equal(r2.closed, true);
  assert.ok(!server.runs.has(id));
  a.close();
  b.close();
  // Opening it again gives a new run.
  const again = JSON.parse((await call('POST', '/api/open', { path: fixture })).body).run;
  assert.notEqual(again.id, id);
});

test('session tabs: a run closed elsewhere is reported gone', async () => {
  const id = JSON.parse((await call('POST', '/api/open', { path: fixture })).body).run.id;
  const a = tabStream('page-c', [id]);
  await a.next((e) => e.runs[id]?.title);
  server.closeRun(id);
  const gone = await a.next((e) => e.runs[id]?.gone);
  assert.equal(gone.runs[id].gone, true);
  a.close();
});

test('a session file run nobody has looked at for a while is closed; a saved run is kept', async () => {
  const { IDLE_CLOSE_MS } = await import('../src/server/server.ts');
  const id = JSON.parse((await call('POST', '/api/open', { path: fixture })).body).run.id;
  const saved = await call('GET', `/api/s/${id}/save`);
  const kept = JSON.parse((await call('POST', '/api/load', JSON.parse(saved.body))).body).run.id;
  (server as any).tick(Date.now() + IDLE_CLOSE_MS / 2);
  assert.ok(server.runs.has(id), 'not idle long enough yet');
  (server as any).tick(Date.now() + IDLE_CLOSE_MS + 1000);
  assert.ok(!server.runs.has(id), 'idle: closed (it can be opened again from its file)');
  assert.ok(server.runs.has(kept), 'a loaded snapshot has no file to come back from: kept');
});
