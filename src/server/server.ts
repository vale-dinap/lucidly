/**
 * Local HTTP server: static web UI, JSON API, and Server-Sent Events for live updates.
 * Binds to 127.0.0.1 only and rejects foreign Host headers (DNS rebinding) and
 * cross-site writes (POST bodies must be JSON, which forces a CORS preflight we never answer).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunSession } from './session.ts';
import type { Source } from '../sources/source.ts';
import { ClaudeSessionSource, LIVE_MS, findSession, listSessions } from '../sources/claude-sessions.ts';

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const SRC_DIR = fileURLToPath(new URL('../', import.meta.url));
const STARTED = Date.now();

/**
 * Whether the server's own code changed on disk since it started. The web UI is read from
 * disk on every request, so a running server can serve a newer page than its engine knows
 * about: the page says so, rather than quietly missing data.
 */
async function codeChangedSince(t: number): Promise<boolean> {
  try {
    const files = await readdir(SRC_DIR, { recursive: true });
    for (const f of files) {
      if (!String(f).endsWith('.ts')) continue;
      if ((await stat(resolve(SRC_DIR, String(f)))).mtimeMs > t) return true;
    }
  } catch {
    // Installed without sources nearby: nothing to compare.
  }
  return false;
}
const MAX_BODY = 512 * 1024 * 1024;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface LucidlyServerOptions {
  port: number;
  /** Project directory whose sessions are listed first. */
  cwd: string;
}

export class LucidlyServer {
  readonly runs = new Map<string, RunSession>();
  private byKey = new Map<string, string>();
  private seq = 0;
  private server: Server | null = null;
  port = 0;
  readonly cwd: string;
  private readonly wantPort: number;

  constructor(opts: LucidlyServerOptions) {
    this.wantPort = opts.port;
    this.cwd = opts.cwd;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/`;
  }

  /** Listen on the requested port, or the next free one. */
  async listen(): Promise<void> {
    for (let p = this.wantPort; p < this.wantPort + 20; p++) {
      try {
        await new Promise<void>((ok, fail) => {
          const s = createServer((req, res) => void this.handle(req, res));
          s.once('error', fail);
          s.listen(p, '127.0.0.1', () => {
            s.off('error', fail);
            this.server = s;
            this.port = (s.address() as { port: number }).port;
            ok();
          });
        });
        return;
      } catch (e: any) {
        if (e?.code !== 'EADDRINUSE' || this.wantPort === 0) throw e;
      }
    }
    throw new Error(`No free port from ${this.wantPort}`);
  }

  async close(): Promise<void> {
    for (const r of this.runs.values()) r.close();
    this.server?.closeAllConnections?.();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  /** Open (or reuse) a run for a source. */
  async open(source: Source): Promise<RunSession> {
    const existing = this.byKey.get(source.key);
    if (existing && this.runs.has(existing)) return this.runs.get(existing)!;
    const run = new RunSession(`r${++this.seq}`, source);
    this.runs.set(run.id, run);
    this.byKey.set(run.key, run.id);
    await run.start();
    return run;
  }

  addRun(make: (id: string) => RunSession): RunSession {
    const run = make(`r${++this.seq}`);
    this.runs.set(run.id, run);
    this.byKey.set(run.key, run.id);
    return run;
  }

  closeRun(id: string): boolean {
    const r = this.runs.get(id);
    if (!r) return false;
    r.close();
    this.runs.delete(id);
    this.byKey.delete(r.key);
    return true;
  }

  // ───────────────────────────── HTTP

  private hostOk(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.hostOk(req)) return send(res, 403, { error: 'forbidden host' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (req.method === 'POST' || req.method === 'DELETE') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: 'forbidden origin' });
        if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return send(res, 415, { error: 'JSON body required' });
        }
      }
      if (path.startsWith('/api/')) return await this.api(req, res, path, url);
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      return await this.static(res, path);
    } catch (e: any) {
      if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) });
      else res.end();
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    const m = /^\/api\/s\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?$/.exec(path);
    if (m) {
      const run = this.runs.get(m[1]);
      if (!run) return send(res, 404, { error: 'no such run' });
      const [, , action, arg] = m;
      if (!action && req.method === 'DELETE') return send(res, 200, { closed: this.closeRun(run.id) });
      if (action === 'stream') return this.stream(req, res, run);
      if (action === 'raw' && arg) {
        if (!run.engine.nodes.has(arg)) return send(res, 404, { error: 'no such node' });
        return send(res, 200, { node: arg, chunks: run.engine.raw(arg, url.searchParams.get('own') === '1') });
      }
      if (action === 'actions') {
        const cap = Math.min(Number(url.searchParams.get('cap')) || 1200, 20000);
        return send(res, 200, { actions: run.engine.actions(cap) });
      }
      if (action === 'save') {
        const name = slug(run.engine.run.title ?? run.label) + '.lucidly.json';
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${name}"`,
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(run.save()));
        return;
      }
      return send(res, 404, { error: 'unknown action' });
    }

    if (path === '/api/health' && req.method === 'GET') {
      return send(res, 200, { startedAt: new Date(STARTED).toISOString(), outdated: await codeChangedSince(STARTED) });
    }
    if (path === '/api/runs' && req.method === 'GET') {
      return send(res, 200, { runs: [...this.runs.values()].map((r) => r.info()) });
    }
    if (path === '/api/sessions' && req.method === 'GET') {
      const all = url.searchParams.get('scope') === 'all';
      const sessions = await listSessions({ cwd: all ? undefined : this.cwd, limit: all ? 60 : 30 });
      const now = Date.now();
      return send(res, 200, {
        cwd: this.cwd,
        scope: all ? 'all' : 'project',
        sessions: sessions.map((s) => ({
          ...s,
          live: now - s.mtime < LIVE_MS,
          run: this.byKey.get(new ClaudeSessionSource(s.path).key),
        })),
      });
    }
    if (path === '/api/open' && req.method === 'POST') {
      const body = (await readJson(req)) as { path?: string; id?: string };
      const target = body.path ?? (body.id ? await findSession(body.id) : null);
      if (!target || !target.endsWith('.jsonl')) return send(res, 400, { error: 'session not found' });
      try {
        await stat(target);
      } catch {
        return send(res, 404, { error: 'session file not found' });
      }
      const run = await this.open(new ClaudeSessionSource(target));
      return send(res, 200, { run: run.info() });
    }
    if (path === '/api/load' && req.method === 'POST') {
      const data = await readJson(req);
      try {
        const run = this.addRun((id) => RunSession.fromSave(id, data));
        return send(res, 200, { run: run.info() });
      } catch (e: any) {
        return send(res, 400, { error: String(e?.message ?? e) });
      }
    }
    return send(res, 404, { error: 'not found' });
  }

  private stream(req: IncomingMessage, res: ServerResponse, run: RunSession): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const unsubscribe = run.subscribe((event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  private async static(res: ServerResponse, path: string): Promise<void> {
    const rel = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const full = resolve(WEB_DIR, normalize(rel));
    if (!full.startsWith(resolve(WEB_DIR) + sep) && full !== resolve(WEB_DIR)) return send(res, 403, { error: 'forbidden' });
    let body: Buffer;
    try {
      body = await readFile(full);
    } catch {
      return send(res, 404, { error: 'not found' });
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(full)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    });
    res.end(body);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'run'
  );
}

export { WEB_DIR };
