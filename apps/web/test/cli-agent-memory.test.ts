/**
 * @fileoverview `reverie agent memory` answers as python's `memory_cli` (the `reverie-memory` it replaces) did. Two
 * references from the unmodified python: the legacy recall fixture (27 synthetic stores and what memory_cli printed
 * outside a session) and memory-cli-reference.json (validation, remember, and in-session journal handling with the
 * `reverie agent journal` call stubbed; it records the exact journal argv python ran).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sqlite } from '../src/chat-db.js';
import { registerAgentCommands, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';
import { agentJournalRecall, agentJournalSave, type JournalSaveOptions } from '../src/cli-agent-journal.js';
import { agentMemory, budgeted, JOURNAL_BUDGET_MS, JOURNAL_RESPONSE_MAX, MEMORY_INPUT_MAX, readInput, sessionJournal, type MemoryCliDeps } from '../src/cli-agent-memory.js';
import { legacyRecall } from '../src/legacy-recall.js';
import type { JournalPort } from '../src/mcp-memory-tools.js';
import { fakeEmbeddingService, fixture, stage } from './legacy-store-fixture.js';

interface Answer {
  rc: number;
  stdout: string;
  stderr: string;
}
interface CliCase {
  id: string;
  argv?: string[];
  stdin: string;
  names?: string;
  journal?: Answer;
  expect: { code: number; stdout: string; stderr: string };
  argvCalls: string[][];
}
const reference = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'memory-cli-reference.json'), 'utf8')
) as { cases: CliCase[] };
const INSTANCE = { id: 'a1', agent_name: 'Agent', owner_name: 'Owner', data_dir: '../state', persona: 'p' };

/** Deps whose requests are recorded and answered as a journal server that accepts everything would answer. */
function recorder(requests: RequestOptions[]): AgentDeps {
  return {
    ctx: { apiUrl: 'http://journal.invalid', selfId: 'self-session' },
    json: true,
    io: { out: () => {}, err: () => {} },
    request: async (_ctx, options) => {
      requests.push(options);
      return { status: 200, text: '', json: { success: true, data: { entries: [], entryId: 1, turnId: 't', replayed: false, payloadSha256: 'x' } } };
    },
  };
}

/** The journal as python's stub answered it, recording every request the verb would have sent. */
function stubJournal(answer: Answer, requests: RequestOptions[]): JournalPort {
  return async (verb) => {
    await verb(recorder(requests));
    return { code: answer.rc, out: answer.stdout ? [answer.stdout.replace(/\n$/, '')] : [], err: answer.stderr ? [answer.stderr] : [] };
  };
}

/** The requests the real `reverie agent journal ... --json` would send for an argv python ran. */
async function requestsFor(argv: string[]): Promise<RequestOptions[]> {
  const requests: RequestOptions[] = [];
  const [, , , verb, ...rest] = argv;
  expect(rest.at(-1)).toBe('--json');
  const args = rest.slice(0, -1);
  if (verb === 'recall') {
    const project = args.indexOf('--project');
    await agentJournalRecall(recorder(requests), [args[0]], undefined, project >= 0 ? args[project + 1] : undefined);
    return requests;
  }
  expect(verb).toBe('save');
  const options: Record<string, string | string[]> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2);
    options[key] = ['tag', 'source', 'quote', 'ref'].includes(key) ? [...((options[key] as string[]) ?? []), args[i + 1]] : args[i + 1];
  }
  await agentJournalSave(recorder(requests), options as unknown as JournalSaveOptions);
  return requests;
}

async function inRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-')));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** One run of the verb, printed the way the process prints (a newline after each line), the root masked. */
async function cli(deps: Omit<MemoryCliDeps, 'out' | 'err'>, root: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await agentMemory({ ...deps, out: (line) => out.push(line), err: (line) => err.push(line) });
  const text = (lines: string[]) => lines.map((line) => line + '\n').join('').replaceAll(root, '<root>');
  return { code, stdout: text(out), stderr: text(err) };
}

/** A root laid out as python's reference laid it out: home, the default instance, an empty state directory. */
function layout(root: string, names?: string) {
  const home = path.join(root, 'home');
  const config = path.join(root, 'config', 'agent.json');
  fs.mkdirSync(home);
  fs.mkdirSync(path.dirname(config));
  fs.mkdirSync(path.join(root, 'state'));
  fs.writeFileSync(config, JSON.stringify(INSTANCE));
  if (names !== undefined) {
    const file = path.join(home, 'reverie', 'companies', 'default', 'data', 'protected-people.txt');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, names);
  }
  return { home, config };
}

let serviceUrl = '';
let closeService = async () => {};
beforeAll(async () => {
  ({ url: serviceUrl, close: closeService } = await fakeEmbeddingService());
});
afterAll(() => closeService());

describe('recall outside a session, as memory_cli printed it for the legacy recall reference', () => {
  for (const c of fixture.cases.filter((x) => !x.refuses)) {
    it(c.id, () =>
      inRoot(async (root) => {
        const { home, config } = await stage(c, root);
        const embedUrl = c.embed === 'service' ? serviceUrl : c.embed === 'down' ? 'http://127.0.0.1:1/v1' : '';
        const scope = c.request.project !== undefined ? { project: c.request.project } : { private: true };
        const got = await cli({
          input: JSON.stringify({ action: 'recall', query: c.request.query, ...scope }),
          instance: config,
          env: { HOME: home },
          recall: (instance, request) => legacyRecall(instance, request, { home, embedUrl, now: () => fixture.now }),
        }, root);
        expect(got).toEqual(c.expect);
      }));
  }
});

/** Python's json module words syntax errors its own way; the code and the error envelope still match. */
const JSON_SYNTAX = new Set(['malformed-json', 'empty-input']);
/** Where python turned a null or a number into text ("None", "5"), the verb refuses. */
const NOT_TEXT: Record<string, string> = {
  'recall-null-query': '{"error": "query must be text"}\n',
  'recall-number-query': '{"error": "query must be text"}\n',
  'remember-null-text': '{"error": "text must be text"}\n',
};

describe('the memory_cli reference: validation, remember, and the journal inside a session', () => {
  for (const c of reference.cases) {
    it(c.id, () =>
      inRoot(async (root) => {
        const { home } = layout(root, c.names);
        const argv = (c.argv ?? ['--instance', '<root>/config/agent.json']).map((a) => a.replace('<root>', root));
        const requests: RequestOptions[] = [];
        const got = await cli({
          input: c.stdin,
          instance: argv[1],
          env: { HOME: home },
          journal: c.journal ? stubJournal(c.journal, requests) : undefined,
        }, root);
        if (c.id in NOT_TEXT) {
          expect(got).toEqual({ code: 1, stdout: '', stderr: NOT_TEXT[c.id] });
          expect(c.expect.stderr).not.toBe(NOT_TEXT[c.id]);
        } else if (JSON_SYNTAX.has(c.id)) {
          expect(got.code).toBe(c.expect.code);
          expect(got.stdout).toBe('');
          expect(got.stderr).toMatch(/^\{"error": "Expecting [^"]+"\}\n$/);
        } else expect(got).toEqual(c.expect);
        const expected: RequestOptions[] = [];
        for (const call of c.argvCalls) expected.push(...(await requestsFor(call)));
        expect(requests).toEqual(expected);
      }));
  }

  it('covers recall, remember, both scopes and every journal outcome', () => {
    const ids = reference.cases.map((c) => c.id);
    expect(ids.length).toBe(42);
    expect(reference.cases.filter((c) => c.argvCalls.length).length).toBe(12);
  });
});

describe('named differences', () => {
  const remember = (fields: Record<string, unknown>) => JSON.stringify({ action: 'remember', private: true, ...fields });

  it('refuses a text field that is not text, where python used its repr', () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      for (const [key, value] of [['query', 5], ['text', ['a']], ['room', true], ['project', 1]] as const) {
        const input = key === 'query' || key === 'project'
          ? JSON.stringify({ action: 'recall', query: 'q', ...(key === 'project' ? {} : { private: true }), [key]: value })
          : remember({ text: 't', [key]: value });
        expect(await cli({ input, instance: config, env: { HOME: home } }, root)).toEqual({
          code: 1, stdout: '', stderr: `{"error": "${key} must be text"}\n`,
        });
      }
    }));

  it("keeps the memory tools' lengths: a query up to 500 characters, a memory text up to 2000", () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      const recall = async () => '[]';
      const run = (input: string) => cli({ input, instance: config, env: { HOME: home }, recall }, root);
      expect((await run(JSON.stringify({ action: 'recall', private: true, query: 'é'.repeat(500) }))).code).toBe(0);
      expect(await run(JSON.stringify({ action: 'recall', private: true, query: 'é'.repeat(501) }))).toEqual({
        code: 1, stdout: '', stderr: '{"error": "query must be at most 500 characters"}\n',
      });
      expect((await run(remember({ text: 'x'.repeat(2001) }))).stderr).toBe('{"error": "text must be at most 2000 characters"}\n');
      expect((await run(remember({ text: 'x'.repeat(2000) }))).stderr).toMatch(/^\{"error": "remember saves to your office journal/);
    }));

  it('refuses a save when the hard-floor check cannot run, instead of failing with its cause', () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      const screen = () => {
        throw new Error('names unreadable');
      };
      expect(await cli({ input: remember({ text: 'fine' }), instance: config, env: { HOME: home }, screen }, root)).toEqual({
        code: 1, stdout: '', stderr: '{"error": "the hard-floor check did not run; nothing was saved"}\n',
      });
    }));

  it('never creates or writes the old store, where python opened it before either action', () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      await cli({ input: remember({ text: 'fine' }), instance: config, env: { HOME: home } }, root);
      await cli({ input: JSON.stringify({ action: 'recall', private: true, query: 'q' }), instance: config, env: { HOME: home } }, root);
      expect(fs.readdirSync(path.join(root, 'state'))).toEqual([]);
    }));

  it('reads standard input as strict UTF-8 and only up to its bound', async () => {
    expect(await readInput(Readable.from([Buffer.from('{"a": "é"}')]))).toBe('{"a": "é"}');
    await expect(readInput(Readable.from([Buffer.from([0xff])]))).rejects.toThrow();
    await expect(readInput(Readable.from([Buffer.alloc(MEMORY_INPUT_MAX + 1, 0x20)]))).rejects.toThrow(/too large/);
  });
});

describe('the session journal', () => {
  it('is absent without a session id, as python tested', () => {
    expect(sessionJournal({})).toBeUndefined();
  });

  it("answers recall from the old store, with the guard's reason, when the session cannot be proven", () =>
    inRoot(async (root) => {
      const { home, config } = layout(root);
      const env = { HOME: home, REVERIE_SESSION_ID: 'abc12345' };
      const got = await cli({
        input: JSON.stringify({ action: 'recall', private: true, query: 'q' }), instance: config, env, journal: sessionJournal(env),
      }, root);
      expect(got).toEqual({
        code: 0,
        stdout: '{"journal": [], "legacy": [], "note": "journal lookup failed (Not inside a Reverie-managed session (REVERIE_MUX is not 1); refusing to act.); these are only older, read-only results from the old store"}\n',
        stderr: '',
      });
    }));
});

const WEB = path.join(import.meta.dirname, '..');
const REPO = path.join(WEB, '..', '..');

/** nix/package.nix: the copy the Nix build supplies (it sees only apps/web), or else this checkout's, as the partition test reads it. */
function nixPackageSource(): string {
  const packaged = path.join(import.meta.dirname, 'fixtures', 'nix-package', 'package.nix');
  if (fs.existsSync(packaged)) return fs.readFileSync(packaged, 'utf8');
  return fs.readFileSync(path.join(REPO, 'nix', 'package.nix'), 'utf8');
}
const byId = (id: string) => reference.cases.find((c) => c.id === id)!;

/** The real command as a process: node on the console entry, the request on standard input, a bare environment. */
function processRun(root: string, args: string[], input: string, extra: Record<string, string> = {}) {
  const done = spawnSync(process.execPath, ['--import', path.join(WEB, 'node_modules/tsx/dist/loader.mjs'), path.join(WEB, 'src/index.ts'),
    'agent', 'memory', ...args], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: path.join(root, 'home'), ...extra }, timeout: 60_000 });
  const mask = (text: string) => text.replaceAll(root, '<root>');
  return { code: done.status, stdout: mask(done.stdout), stderr: mask(done.stderr) };
}

describe('the command as a process', () => {
  it('prints exactly what python printed, on stdout and stderr, with its exit code', () =>
    inRoot(async (root) => {
      const { config } = layout(root);
      for (const id of ['private-missing-store', 'unknown-action', 'remember-outside-session-full']) {
        const c = byId(id);
        expect(processRun(root, ['--instance', config], c.stdin), id).toEqual(c.expect);
      }
      expect(processRun(root, [], byId('no-instance').stdin)).toEqual(byId('no-instance').expect);
      expect(processRun(root, [], byId('private-missing-store').stdin, { REVERIE_INSTANCE_CONFIG: config }))
        .toEqual(byId('private-missing-store').expect);
    }), 120_000);

  it("keeps node:sqlite's experimental notice off standard error when it opens a store", () =>
    inRoot(async (root) => {
      const { config } = layout(root);
      const db = new (sqlite().DatabaseSync)(path.join(root, 'state', 'memory.sqlite'));
      db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.close();
      // Python answered an empty store as it answered a missing one.
      expect(processRun(root, ['--instance', config], byId('private-missing-store').stdin)).toEqual(byId('private-missing-store').expect);
    }), 60_000);
});

describe('the command', () => {
  it('is `reverie agent memory`, with --instance', () => {
    const program = new Command();
    registerAgentCommands(program);
    const memory = program.commands.find((c) => c.name() === 'agent')!.commands.find((c) => c.name() === 'memory')!;
    expect(memory.options.map((o) => o.long)).toEqual(['--instance']);
  });

  it('is installed as reverie-memory by the package, which runs it when it is built', () => {
    const nix = nixPackageSource();
    expect(nix).toContain('makeWrapper ${console}/bin/reverie "$out/bin/reverie-memory" --add-flags "agent memory"');
    // The package build itself runs the installed command and fails unless it refuses as below.
    expect(nix).toContain('smoke \x27{}\x27 \x27{"error": "select an instance with --instance or REVERIE_INSTANCE_CONFIG"}\x27');
  });

  // The Nix build of the console sees only apps/web, so the python side is checked where the whole checkout is.
  it.skipIf(!fs.existsSync(path.join(REPO, 'python', 'pyproject.toml')))('is no longer provided by python', () => {
    const pyproject = fs.readFileSync(path.join(REPO, 'python', 'pyproject.toml'), 'utf8');
    expect(pyproject).not.toMatch(/^reverie-memory\s*=/m);
    expect(fs.existsSync(path.join(REPO, 'python', 'reverie', 'memory_cli.py'))).toBe(false);
  });
});

describe('the journal budget: one absolute deadline per journal command and a response cap', () => {
  const ROOM_ID = '11111111-2222-4333-8444-555555555555';
  type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

  /** A local journal server; `closed` records each request path whose connection the client dropped before the end. */
  async function journalServer(handlers: Record<string, Handler>) {
    const closed: string[] = [];
    const seen: Array<{ path: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const route = (req.url ?? '').split('?')[0];
        seen.push({ path: route, body });
        res.on('close', () => { if (!res.writableFinished) closed.push(route); });
        (handlers[route] ?? ((_q, r) => r.end('{"success":false,"error":"no route"}')))(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, closed, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
  }

  async function timed(budgetMs: number, url: string, input: string) {
    return inRoot(async (root) => {
      const { home, config } = layout(root);
      const env = { HOME: home, REVERIE_MUX: '1', REVERIE_API_URL: url, REVERIE_SESSION_ID: 'abc12345' };
      const started = Date.now();
      const got = await cli({ input, instance: config, env, recall: async () => '[]',
        journal: sessionJournal(env, { budgetMs, envFile: () => ({}) }) }, root);
      return { ...got, elapsed: Date.now() - started };
    });
  }
  const recallInput = JSON.stringify({ action: 'recall', private: true, query: 'q' });
  const unavailable = '{"journal": [], "legacy": [], "note": "journal lookup failed (Journal recall unavailable.); these are only older, read-only results from the old store"}\n';

  it('abandons a journal that never answers at the budget and closes the request', async () => {
    const s = await journalServer({ '/api/agent/journal/recall': () => {} });
    try {
      const got = await timed(300, s.url, recallInput);
      expect({ code: got.code, stdout: got.stdout }).toEqual({ code: 0, stdout: unavailable });
      expect(got.elapsed).toBeLessThan(1500);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(s.closed).toEqual(['/api/agent/journal/recall']);
    } finally {
      await s.close();
    }
  }, 10_000);

  it('abandons a response that keeps dripping bytes, which an inactivity timeout never would', async () => {
    const s = await journalServer({
      '/api/agent/journal/recall': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const drip = setInterval(() => res.write(' '), 20);
        res.on('close', () => clearInterval(drip));
      },
    });
    try {
      const got = await timed(300, s.url, recallInput);
      expect({ code: got.code, stdout: got.stdout }).toEqual({ code: 0, stdout: unavailable });
      expect(got.elapsed).toBeLessThan(1500);
    } finally {
      await s.close();
    }
  }, 10_000);

  it('stops reading a response past the cap before it is complete', async () => {
    let written = 0;
    const total = 8 * 1024 * 1024;
    const s = await journalServer({
      '/api/v1/chatrooms': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        const pump = () => {
          while (written < total) {
            written += chunk.length;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        pump();
      },
      '/api/agent/journal/save': (_req, res) => res.end('{"success":false,"error":"refused"}'),
    });
    try {
      const got = await timed(5_000, s.url, JSON.stringify({ action: 'remember', private: true, text: 'fine', room: 'general',
        turn: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', tag: 'lesson', quote: 'q' }));
      expect(s.closed).toContain('/api/v1/chatrooms');
      expect(written).toBeLessThan(total);
      // As before, a room name that cannot be resolved is passed on unchanged for the server to judge.
      expect(JSON.parse(s.seen.find((r) => r.path === '/api/agent/journal/save')!.body).roomId).toBe('general');
      expect(got.code).toBe(1);
    } finally {
      await s.close();
    }
  }, 20_000);

  it('counts room resolution against the same budget as the save', async () => {
    const slow = (body: string): Handler => (_req, res) => { setTimeout(() => res.end(body), 250); };
    const s = await journalServer({
      '/api/v1/chatrooms': slow(JSON.stringify({ success: true, data: { rooms: [{ id: ROOM_ID, name: 'general' }] } })),
      '/api/agent/journal/save': slow(JSON.stringify({ success: true, data: { entryId: 1, turnId: 't', replayed: false, payloadSha256: 'x' } })),
    });
    try {
      // Each request alone fits a 400 ms budget; the two together do not.
      const got = await timed(400, s.url, JSON.stringify({ action: 'remember', private: true, text: 'fine', room: 'general',
        turn: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', tag: 'lesson', quote: 'q' }));
      expect(got.code).toBe(1);
      expect(got.stderr).toMatch(/^\{"error": "Journal save outcome unknown/);
      expect(got.elapsed).toBeLessThan(480);
      expect(JSON.parse(s.seen.find((r) => r.path === '/api/agent/journal/save')!.body).roomId).toBe(ROOM_ID);
    } finally {
      await s.close();
    }
  }, 10_000);

  it('refuses a request once the budget is spent, and never widens a tighter bound the caller set', async () => {
    let now = 0;
    const calls: RequestOptions[] = [];
    const transport = budgeted(async (_ctx, options) => {
      calls.push(options);
      return { status: 200, text: '' };
    }, 1000, () => now);
    const ctx = { apiUrl: 'http://journal.invalid', selfId: 's' };
    await transport(ctx, { method: 'GET', path: '/a' });
    now = 400;
    await transport(ctx, { method: 'GET', path: '/b', bounds: { maxBytes: 10, deadlineMs: 100 } });
    now = 1000;
    await expect(transport(ctx, { method: 'GET', path: '/c' })).rejects.toThrow(/took longer than 1000 ms/);
    expect(calls.map((c) => c.bounds)).toEqual([{ maxBytes: JOURNAL_RESPONSE_MAX, deadlineMs: 1000 }, { maxBytes: 10, deadlineMs: 100 }]);
    expect(JOURNAL_BUDGET_MS).toBe(60_000);
  });
});

describe('the journal budget clock', () => {
  const ctx = { apiUrl: 'http://journal.invalid', selfId: 's' };
  const ok = { status: 200, text: '' };

  it('runs on a monotonic clock, so a wall-clock step neither stretches nor cuts it', async () => {
    const calls: RequestOptions[] = [];
    let wall = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => wall);
    try {
      const transport = budgeted(async (_ctx, options) => {
        calls.push(options);
        return ok;
      }, 100);
      wall -= 1000; // the wall clock steps back a second
      await transport(ctx, { method: 'GET', path: '/a' });
      wall += 5000; // and forward five
      await transport(ctx, { method: 'GET', path: '/b' });
    } finally {
      spy.mockRestore();
    }
    expect(calls.map((c) => c.bounds!.deadlineMs).every((ms) => ms > 0 && ms <= 100)).toBe(true);
  });

  it('refuses a response that arrives after the deadline, and accepts one within it', async () => {
    let now = 0;
    const answerAt = (at: number) => budgeted(async () => {
      now = at;
      return ok;
    }, 100, () => now);
    now = 0;
    await expect(answerAt(101)(ctx, { method: 'GET', path: '/late' })).rejects.toThrow(/took longer than 100 ms/);
    now = 0;
    await expect(answerAt(100)(ctx, { method: 'GET', path: '/edge' })).resolves.toEqual(ok);
    now = 0;
    await expect(answerAt(50)(ctx, { method: 'GET', path: '/soon' })).resolves.toEqual(ok);
  });
});
