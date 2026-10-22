/**
 * @fileoverview Unit tests for the TUI's IO layer: discovery, credentials, the
 * typed API surface and degraded-mode tmux enumeration.
 *
 * The API calls run against a real loopback HTTP server that answers in the
 * shapes the routes really produce (the `{success,data}` envelope, plus
 * away-digest's legacy top-level `digest`), so an envelope change breaks these
 * tests rather than the dashboard. tmux is never executed: the exec function is
 * injected, and `test/setup.ts` gives this file its own HOME, so the state file
 * it reads is a fixture of its own making.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../../src/config/instance.js';
import {
  TuiApiError,
  TuiClient,
  basicAuthHeader,
  enumerateTmuxSessions,
  parseEnvFile,
  arrayOptionBase,
  parseSessionOptions,
  parseDetachKey,
  parsePrefixBinding,
  ATTACH_BANNER_MARKER,
  parseTmuxSessionList,
  parseWindowSizing,
  readReverieCredentials,
  tuiServerCandidates,
  type TuiExecFile,
} from '../../src/tui/tui-client.js';

/**
 * A port nothing listens on: bind 0, read what the OS handed out, close. Free at the
 * moment of use, unlike "the server's port + 1", which anything may hold.
 */
async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port: free } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return free;
}

let port: number;
/** A port nothing listens on (`closedPort()`): the "no server" path. */
let deadPort: number;
let baseUrl: string;

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const recorded: Recorded[] = [];
type Responder = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** Per-test override; falls back to `defaultResponder`. */
let responder: Responder | null = null;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const defaultResponder: Responder = (req, res) => {
  const url = req.url ?? '';
  if (url.startsWith('/api/status')) {
    return sendJson(res, 200, {
      success: true,
      data: { version: '9.9.9', planUsage: { fiveHour: { usedPercentage: 32, resetAt: 1000 } } },
    });
  }
  if (url.startsWith('/api/sessions/unified')) {
    return sendJson(res, 200, {
      success: true,
      data: { sessions: [{ sessionId: 'abc', name: 'w1-reverie', sources: ['live'] }], total: 1 },
    });
  }
  if (url === '/api/sessions' || url.startsWith('/api/sessions?')) {
    // The light state, plus the two rows the narrowing has to discard.
    return sendJson(res, 200, {
      success: true,
      data: [
        { id: 'abc', lastSubmitAt: 4000, inputTokens: 900, outputTokens: 100, status: 'busy' },
        { id: '', lastSubmitAt: 7000 },
        { id: 'zzz', lastSubmitAt: '5', inputTokens: null },
      ],
    });
  }
  if (url.startsWith('/api/approvals')) {
    return sendJson(res, 200, {
      success: true,
      data: { approvals: [{ id: 'abc:1', sessionId: 'abc', sessionName: 'w1', kind: 'permission', createdAt: 5 }] },
    });
  }
  if (url.includes('/terminal')) {
    return sendJson(res, 200, { success: true, data: { terminalBuffer: 'tail bytes', status: 'idle' } });
  }
  if (url.endsWith('/input')) {
    return sendJson(res, 200, { success: true, data: {} });
  }
  if (url.startsWith('/api/quick-start')) {
    return sendJson(res, 200, { success: true, data: { sessionId: 'new-1', casePath: '/cases/x', caseName: 'x' } });
  }
  if (url.startsWith('/api/cases')) {
    return sendJson(res, 200, { success: true, data: [{ name: 'x', path: '/cases/x', location: 'local' }] });
  }
  if (url.startsWith('/api/search')) {
    return sendJson(res, 200, {
      success: true,
      data: { query: 'foo', groups: [], totalResults: 0, truncated: false },
    });
  }
  if (url.startsWith('/api/away-digest')) {
    // Legacy shape: the payload sits at the TOP level, not under `data`.
    return sendJson(res, 200, { success: true, digest: { totals: { activeSessions: 2 } } });
  }
  if (req.method === 'DELETE') {
    return sendJson(res, 200, { success: true, data: {} });
  }
  return sendJson(res, 404, { success: false, error: 'no route', errorCode: 'NOT_FOUND' });
};

function client(overrides: Record<string, unknown> = {}): TuiClient {
  return new TuiClient({ baseUrl, timeoutMs: 4000, ...overrides });
}

let server: http.Server;
const originalApiUrl = process.env.REVERIE_API_URL;
const originalPort = process.env.REVERIE_PORT;

beforeAll(async () => {
  // This suite runs inside a Reverie-managed session, which exports
  // REVERIE_API_URL pointing at the LIVE server. Discovery consults it, so it
  // has to be out of the way before any test calls connect().
  delete process.env.REVERIE_API_URL;
  delete process.env.REVERIE_PORT;

  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      recorded.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      (responder ?? defaultResponder)(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  deadPort = await closedPort();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalApiUrl !== undefined) process.env.REVERIE_API_URL = originalApiUrl;
  if (originalPort !== undefined) process.env.REVERIE_PORT = originalPort;
});

beforeEach(() => {
  recorded.length = 0;
  responder = null;
});

describe('parseEnvFile', () => {
  it('reads plain assignments and skips comments and blanks', () => {
    expect(parseEnvFile('# comment\n\nREVERIE_USERNAME=bob\nREVERIE_PASSWORD=hunter2\n')).toEqual({
      REVERIE_USERNAME: 'bob',
      REVERIE_PASSWORD: 'hunter2',
    });
  });

  it('strips one layer of matching quotes', () => {
    expect(parseEnvFile('A="quoted"\nB=\'single\'\nC="mismatched\'')).toEqual({
      A: 'quoted',
      B: 'single',
      C: '"mismatched\'',
    });
  });

  it('ignores lines that are not assignments', () => {
    expect(parseEnvFile('not an assignment\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });
});

describe('readReverieCredentials', () => {
  it('falls back to the data dir .env when the environment has nothing', () => {
    const envPath = dataPath('.env');
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, 'REVERIE_USERNAME=fileuser\nREVERIE_PASSWORD=filepass\n', 'utf-8');
    expect(readReverieCredentials()).toEqual({ username: 'fileuser', password: 'filepass' });
  });

  it('lets the environment win over the file', () => {
    const envPath = dataPath('.env');
    writeFileSync(envPath, 'REVERIE_USERNAME=fileuser\nREVERIE_PASSWORD=filepass\n', 'utf-8');
    process.env.REVERIE_PASSWORD = 'envpass';
    try {
      expect(readReverieCredentials()).toEqual({ username: 'fileuser', password: 'envpass' });
    } finally {
      delete process.env.REVERIE_PASSWORD;
    }
  });

  it('reports admin with no password when nothing is configured', () => {
    expect(readReverieCredentials('/nonexistent/reverie/.env')).toEqual({ username: 'admin' });
  });
});

describe('basicAuthHeader', () => {
  it('is absent without a password and base64 with one', () => {
    expect(basicAuthHeader({ username: 'admin' })).toBeUndefined();
    expect(basicAuthHeader({ username: 'admin', password: 's3cret' })).toBe(
      `Basic ${Buffer.from('admin:s3cret').toString('base64')}`
    );
  });
});

describe('tuiServerCandidates', () => {
  it('prefers an explicit API url and trims its trailing slash', () => {
    expect(tuiServerCandidates({ apiUrl: 'https://box:8443/' })).toEqual(['https://box:8443']);
  });

  it('probes both schemes on loopback, https first', () => {
    expect(tuiServerCandidates({ port: 5000 })).toEqual(['https://127.0.0.1:5000', 'http://127.0.0.1:5000']);
  });

  it('falls back to port 3000 for junk', () => {
    expect(tuiServerCandidates({ port: 'not-a-port' })).toEqual(['https://127.0.0.1:3000', 'http://127.0.0.1:3000']);
  });
});

describe('TuiClient envelope handling', () => {
  it('unwraps the sessions list', async () => {
    const sessions = await client().fetchUnifiedSessions(10);
    expect(sessions).toEqual([{ sessionId: 'abc', name: 'w1-reverie', sources: ['live'] }]);
    expect(recorded[0].url).toBe('/api/sessions/unified?limit=10');
  });

  it('unwraps pending approvals', async () => {
    const approvals = await client().fetchApprovals();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].id).toBe('abc:1');
  });

  it('turns a success:false envelope into a typed error carrying the code', async () => {
    responder = (_req, res) =>
      sendJson(res, 404, { success: false, error: 'Session not found', errorCode: 'NOT_FOUND' });
    await expect(client().fetchTerminalTail('gone', 1000)).rejects.toMatchObject({
      name: 'TuiApiError',
      status: 404,
      errorCode: 'NOT_FOUND',
      message: 'Session not found',
    });
  });

  it('turns a non-JSON failure into a typed error too', async () => {
    responder = (_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('bad gateway');
    };
    const err = await client()
      .fetchApprovals()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TuiApiError);
    expect((err as TuiApiError).status).toBe(502);
  });

  it('sends Basic auth when a password is configured, and none when it is not', async () => {
    await client({ username: 'admin', password: 's3cret' }).fetchApprovals();
    expect(recorded[0].headers.authorization).toBe(`Basic ${Buffer.from('admin:s3cret').toString('base64')}`);

    recorded.length = 0;
    await client({ envFilePath: '/nonexistent/reverie/.env' }).fetchApprovals();
    expect(recorded[0].headers.authorization).toBeUndefined();
  });
});

describe('TuiClient.answerApproval', () => {
  it('reports success', async () => {
    responder = (_req, res) =>
      sendJson(res, 200, { success: true, data: { id: 'abc:1', sessionId: 'abc', action: 'approve' } });
    await expect(client().answerApproval('abc:1', { action: 'approve' })).resolves.toEqual({
      ok: true,
      id: 'abc:1',
      sessionId: 'abc',
      action: 'approve',
    });
  });

  it('reports a 409 as a typed "gone" result, not an exception', async () => {
    responder = (_req, res) =>
      sendJson(res, 409, { success: false, error: 'The dialog is no longer on screen', errorCode: 'CONFLICT' });
    const result = await client().answerApproval('abc:1', { action: 'option', option: 2 });
    expect(result).toEqual({ ok: false, reason: 'gone', message: 'The dialog is no longer on screen' });
  });

  it('separates "already resolved" from "digit rejected"', async () => {
    responder = (_req, res) => sendJson(res, 404, { success: false, error: 'gone', errorCode: 'NOT_FOUND' });
    expect((await client().answerApproval('x', { action: 'deny' })).ok).toBe(false);
    expect(await client().answerApproval('x', { action: 'deny' })).toMatchObject({ reason: 'not-found' });

    responder = (_req, res) => sendJson(res, 400, { success: false, error: 'bad option', errorCode: 'INVALID_INPUT' });
    expect(await client().answerApproval('x', { action: 'option', option: 9 })).toMatchObject({ reason: 'rejected' });
  });

  it('posts the answer body verbatim', async () => {
    responder = (_req, res) => sendJson(res, 200, { success: true, data: { id: 'a', sessionId: 'b', action: 'text' } });
    await client().answerApproval('a b/c', { action: 'text', text: 'yes please' });
    expect(recorded[0].method).toBe('POST');
    expect(recorded[0].url).toBe('/api/approvals/a%20b%2Fc/answer');
    expect(JSON.parse(recorded[0].body)).toEqual({ action: 'text', text: 'yes please' });
  });
});

describe('TuiClient.sendInput', () => {
  it('always terminates with a carriage return and never sends a bare newline', async () => {
    await client().sendInput('abc', 'hello world');
    expect(JSON.parse(recorded[0].body)).toMatchObject({ input: 'hello world\r', useMux: true });
  });

  it('collapses embedded newlines into spaces (multi-line breaks Ink)', async () => {
    await client().sendInput('abc', 'echo A\necho B\r\nline three  ');
    expect(JSON.parse(recorded[0].body).input).toBe('echo A echo B line three\r');
  });

  it('tags every send with a stable clientId and a monotonic seq', async () => {
    const c = client();
    await c.sendInput('abc', 'one');
    await c.sendInput('abc', 'two');
    await c.sendInput('def', 'three');
    const bodies = recorded.map((entry) => JSON.parse(entry.body) as { clientId: string; seq: number });
    expect(bodies.map((b) => b.seq)).toEqual([1, 2, 3]);
    expect(new Set(bodies.map((b) => b.clientId)).size).toBe(1);
    expect(bodies[0].clientId).toMatch(/^reverie-tui-\d+$/);
    expect(c.lastInputSeq).toBe(3);
  });
});

describe('TuiClient remaining API surface', () => {
  it('fetches a terminal tail by byte count', async () => {
    await expect(client().fetchTerminalTail('abc', 4096)).resolves.toBe('tail bytes');
    expect(recorded[0].url).toBe('/api/sessions/abc/terminal?tail=4096');
  });

  it('reads the turn stamp and token counters off the light session state', async () => {
    const metrics = await client().fetchLiveSessionMetrics();
    expect(recorded[0].url).toBe('/api/sessions');
    // Narrowed to the three fields, keyed by id: a row with no usable id is
    // dropped rather than folded in under an empty key, and a field of the
    // wrong type is left absent rather than merged as a string.
    expect(metrics).toEqual([
      { sessionId: 'abc', lastSubmitAt: 4000, inputTokens: 900, outputTokens: 100 },
      { sessionId: 'zzz' },
    ]);
  });

  it('reports an unreadable session list as empty rather than throwing', async () => {
    responder = (_req, res) => sendJson(res, 200, { success: true, data: { sessions: 'not an array' } });
    await expect(client().fetchLiveSessionMetrics()).resolves.toEqual([]);
  });

  it('starts sessions through quick-start', async () => {
    const result = await client().quickStart({ caseName: 'x', mode: 'claude', parentSessionId: 'abc' });
    expect(result.sessionId).toBe('new-1');
    expect(recorded[0].url).toBe('/api/quick-start');
    expect(JSON.parse(recorded[0].body)).toEqual({ caseName: 'x', mode: 'claude', parentSessionId: 'abc' });
  });

  it('lists cases', async () => {
    await expect(client().fetchCases()).resolves.toEqual([{ name: 'x', path: '/cases/x', location: 'local' }]);
  });

  it('deletes a session by exact id', async () => {
    await client().deleteSession('abc');
    expect(recorded[0].method).toBe('DELETE');
    expect(recorded[0].url).toBe('/api/sessions/abc');
  });

  it('searches with an encoded query', async () => {
    await client().search('a b', 5);
    expect(recorded[0].url).toBe('/api/search?q=a+b&limit=5');
  });

  it('reads the away digest from its legacy top-level shape', async () => {
    await expect(client().fetchAwayDigest('24h')).resolves.toEqual({ totals: { activeSessions: 2 } });
    expect(recorded[0].url).toBe('/api/away-digest?range=24h');
  });

  it('reads plan usage off the status snapshot', async () => {
    await expect(client().fetchPlanUsage()).resolves.toEqual({ fiveHour: { usedPercentage: 32, resetAt: 1000 } });
  });

  it('reports a missing plan-usage snapshot as null rather than throwing', async () => {
    responder = (_req, res) => sendJson(res, 200, { success: true, data: { version: '1.0.0', planUsage: null } });
    await expect(client().fetchPlanUsage()).resolves.toBeNull();
  });
});

describe('TuiClient.connect', () => {
  it('discovers the loopback server and reports its identity', async () => {
    const info = await new TuiClient({ port, probeTimeoutMs: 1000 }).connect();
    expect(info?.baseUrl).toBe(baseUrl);
    expect(info?.version).toBe('9.9.9');
    expect(info?.hostname).toBeTruthy();
    expect(info?.authRequired).toBeUndefined();
  });

  it('reports a server that rejects our credentials instead of calling it down', async () => {
    responder = (_req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="reverie"' });
      res.end('Unauthorized');
    };
    const info = await new TuiClient({ port, probeTimeoutMs: 1000 }).connect();
    expect(info?.baseUrl).toBe(baseUrl);
    expect(info?.authRequired).toBe(true);
  });

  it('returns null when nothing answers', async () => {
    await expect(new TuiClient({ port: deadPort, probeTimeoutMs: 500 }).connect()).resolves.toBeNull();
  });

  it('refuses to talk to an unconnected client', async () => {
    await expect(new TuiClient({ port: deadPort }).fetchApprovals()).rejects.toThrow(/not connected/);
  });
});

describe('degraded-mode tmux enumeration', () => {
  const listing = [
    'reverie-0000000b\t1\t1700000000\t1',
    'reverie-deadbeef\t0\t1700000100\t2',
    'claudeman-cafe0001\t0\t1700000200\t1',
    'my-own-tmux-session\t1\t1700000300\t1',
    'reverie-ssh-abc\t0\t1700000400\t1',
  ].join('\n');

  it('parses the list format and keeps only Reverie-owned names', () => {
    const rows = parseTmuxSessionList(listing);
    expect(rows.map((row) => row.muxName)).toEqual(['reverie-0000000b', 'reverie-deadbeef', 'claudeman-cafe0001']);
    expect(rows[0]).toMatchObject({ sessionIdPrefix: '0000000b', attached: true, createdAt: 1_700_000_000_000 });
    expect(rows[1]).toMatchObject({ attached: false, windows: 2 });
  });

  it('never shells out: the tmux call is an argv array on the instance socket', async () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const exec: TuiExecFile = async (file, args) => {
      calls.push({ file, args });
      return { stdout: listing, stderr: '' };
    };
    await enumerateTmuxSessions({ exec, socket: 'reverie-beta', statePath: '/nonexistent/state.json' });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('tmux');
    expect(calls[0].args.slice(0, 4)).toEqual(['-L', 'reverie-beta', 'list-sessions', '-F']);
  });

  it('decorates rows with names and dirs from state.json, matching on the id prefix', async () => {
    const statePath = dataPath('state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        sessions: {
          '0000000b-000e-4000-8000-000000000011': {
            name: 'w1-reverie',
            workingDir: '/home/dev/reverie',
            mode: 'claude',
          },
        },
      }),
      'utf-8'
    );
    const exec: TuiExecFile = async () => ({ stdout: listing, stderr: '' });
    const rows = await enumerateTmuxSessions({ exec, statePath });
    expect(rows[0]).toMatchObject({
      sessionId: '0000000b-000e-4000-8000-000000000011',
      name: 'w1-reverie',
      workingDir: '/home/dev/reverie',
      mode: 'claude',
    });
    // No state entry: the row still exists, it just has no decoration.
    expect(rows[1].sessionId).toBeUndefined();
    expect(rows[1].name).toBeUndefined();
  });

  it('refuses to guess when two ids share a prefix', async () => {
    const statePath = dataPath('ambiguous-state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        sessions: {
          '0000000b-aaaa': { name: 'first' },
          '0000000b-bbbb': { name: 'second' },
        },
      }),
      'utf-8'
    );
    const exec: TuiExecFile = async () => ({ stdout: 'reverie-0000000b\t0\t1700000000\t1', stderr: '' });
    const rows = await enumerateTmuxSessions({ exec, statePath });
    expect(rows[0].name).toBeUndefined();
  });

  it('treats a dead tmux server as an empty list', async () => {
    const exec: TuiExecFile = async () => {
      throw new Error('no server running on /tmp/tmux-1000/reverie');
    };
    await expect(enumerateTmuxSessions({ exec })).resolves.toEqual([]);
  });
});

describe('attach window sizing', () => {
  /** A client that only ever needs its injected exec: none of this talks to a server. */
  function sizingClient(exec: TuiExecFile): TuiClient {
    return new TuiClient({ baseUrl, socket: 'reverie-beta', exec });
  }

  it('parses the sizing format, and rejects a window tmux could not measure', () => {
    expect(parseWindowSizing('183\t38\tmanual\n')).toEqual({ cols: 183, rows: 38, mode: 'manual' });
    expect(parseWindowSizing('120\t40\tlatest')).toEqual({ cols: 120, rows: 40, mode: 'latest' });
    // No mode reported (an ancient tmux) still yields a usable size.
    expect(parseWindowSizing('120\t40\t')).toEqual({ cols: 120, rows: 40, mode: 'manual' });
    expect(parseWindowSizing('')).toBeNull();
    expect(parseWindowSizing("can't find window\n")).toBeNull();
  });

  it('reads the sizing with an argv array on the client socket', async () => {
    const calls: Array<readonly string[]> = [];
    const client = sizingClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '120\t40\tmanual', stderr: '' };
    });
    await expect(client.readWindowSizing('reverie-0000000b')).resolves.toEqual({
      cols: 120,
      rows: 40,
      mode: 'manual',
    });
    expect(calls[0].slice(0, 6)).toEqual(['-L', 'reverie-beta', 'display-message', '-p', '-t', 'reverie-0000000b']);
  });

  it('hands the window to the attaching client with window-size latest', async () => {
    const calls: Array<readonly string[]> = [];
    const client = sizingClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await expect(client.followAttachingClient('reverie-0000000b')).resolves.toBe(true);
    expect(calls[0]).toEqual([
      '-L',
      'reverie-beta',
      'set-window-option',
      '-t',
      'reverie-0000000b',
      'window-size',
      'latest',
    ]);
  });

  it('restores a manual window with resize-window alone, which re-pins the mode itself', async () => {
    const calls: Array<readonly string[]> = [];
    const client = sizingClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await client.restoreWindowSizing('reverie-0000000b', { cols: 120, rows: 40, mode: 'manual' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      '-L',
      'reverie-beta',
      'resize-window',
      '-t',
      'reverie-0000000b',
      '-x',
      '120',
      '-y',
      '40',
    ]);
  });

  it('restores a non-manual window by putting its mode back', async () => {
    const calls: Array<readonly string[]> = [];
    const client = sizingClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await client.restoreWindowSizing('reverie-0000000b', { cols: 120, rows: 40, mode: 'latest' });
    expect(calls).toEqual([
      ['-L', 'reverie-beta', 'set-window-option', '-t', 'reverie-0000000b', 'window-size', 'latest'],
    ]);
  });

  it('never targets a name Reverie does not own', async () => {
    const calls: Array<readonly string[]> = [];
    const client = sizingClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '120\t40\tmanual', stderr: '' };
    });
    await expect(client.readWindowSizing('reverie-ssh-prod')).resolves.toBeNull();
    await expect(client.followAttachingClient('other-session')).resolves.toBe(false);
    await client.restoreWindowSizing('reverie-dkr-box', { cols: 80, rows: 24, mode: 'manual' });
    expect(calls).toEqual([]);
  });

  it('swallows a dead tmux: an attach must never fail over cosmetics', async () => {
    const client = sizingClient(async () => {
      throw new Error('no server running on /tmp/tmux-1000/reverie-beta');
    });
    await expect(client.readWindowSizing('reverie-0000000b')).resolves.toBeNull();
    await expect(client.followAttachingClient('reverie-0000000b')).resolves.toBe(false);
    await expect(
      client.restoreWindowSizing('reverie-0000000b', { cols: 120, rows: 40, mode: 'manual' })
    ).resolves.toBeUndefined();
  });
});

describe('TuiClient.bindSwitchKey', () => {
  it('escapes the command separator, or tmux runs the second command instead of binding it', () => {
    // ⚠️ A bare `;` argument is a command separator to tmux's OWN parser: it
    // ends the bind-key and executes what follows immediately. That bound only
    // `switch-client` and ran `window-size latest` against every session at
    // attach time, which is why sessions were left on `latest` after a detach —
    // the sizing snapshot was taken from already-corrupted state. Verified
    // against real tmux both ways before this test was written.
    const calls: string[][] = [];
    const exec: TuiExecFile = async (_file, args) => {
      calls.push([...args]);
      return { stdout: '', stderr: '' };
    };
    const client = new TuiClient({ baseUrl, socket: 'reverie-beta', exec });
    return client.bindSwitchKey('M-2', 'reverie-aaaa1111').then(() => {
      const bind = calls.find((args) => args.includes('bind-key'));
      expect(bind).toBeDefined();
      expect(bind).toContain('\\;');
      expect(bind).not.toContain(';');
      // Both commands have to be in the ONE binding.
      expect(bind?.join(' ')).toContain('switch-client -t reverie-aaaa1111');
      expect(bind?.join(' ')).toContain('window-size latest');
    });
  });
});

describe('parsePrefixBinding', () => {
  const REAL = [
    'bind-key    -T prefix d       detach-client',
    'bind-key    -T prefix D       choose-client -Z',
    'bind-key    -T prefix C-b     send-prefix',
  ].join('\n');

  it('reports what a key is bound to, verbatim', () => {
    expect(parsePrefixBinding(REAL, 'd')).toBe('detach-client');
    expect(parsePrefixBinding(REAL, 'D')).toBe('choose-client -Z');
  });

  it('is null for a key nothing claims, which is what makes it safe to claim', () => {
    expect(parsePrefixBinding(REAL, 'C-d')).toBeNull();
  });

  it('is case-sensitive, like tmux itself', () => {
    expect(parsePrefixBinding('bind-key -T prefix D choose-client', 'd')).toBeNull();
  });

  it('reads the prefix-less root table too, where the one-key exit lives', () => {
    const root = ['bind-key -T root MouseDown1Pane select-pane -t =', 'bind-key -T root F12 detach-client'].join('\n');
    expect(parsePrefixBinding(root, 'F12', 'root')).toBe('detach-client');
    // Stock tmux has no F12 there, which is what makes it safe to claim.
    expect(parsePrefixBinding('bind-key -T root MouseDown1Pane select-pane -t =', 'F12', 'root')).toBeNull();
    // A prefix binding must not be mistaken for a root one.
    expect(parsePrefixBinding('bind-key -T prefix F12 detach-client', 'F12', 'root')).toBeNull();
  });
});

describe('TuiClient.clearLeakedAttachBanners', () => {
  const OURS = `#[align=left] press #[bold]Ctrl+B then d#[nobold] to detach, ${ATTACH_BANNER_MARKER} #[default]`;

  function sweeper(formats: Record<string, string>): { client: TuiClient; calls: string[][] } {
    const calls: string[][] = [];
    const exec: TuiExecFile = async (_file, args) => {
      calls.push([...args]);
      if (args.includes('list-sessions')) return { stdout: Object.keys(formats).join('\n'), stderr: '' };
      if (args.includes('show-options')) {
        const name = args[args.indexOf('-t') + 1] ?? '';
        return { stdout: formats[name] ?? '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    return { client: new TuiClient({ baseUrl, socket: 'reverie-beta', exec }), calls };
  }

  it('takes down a bar a killed TUI left behind, and puts status back off', async () => {
    // The case that produced this: the tester closed the terminal window while
    // attached, so restore() never ran and the bar stayed pinned.
    const { client, calls } = sweeper({ 'reverie-aaaa1111': OURS });
    expect(await client.clearLeakedAttachBanners()).toBe(1);
    const sets = calls.filter((args) => args.includes('set-option'));
    // The array whole, never one index: unsetting `status-format[0]` alone
    // leaves an EMPTY array, which renders as a blank bar.
    expect(sets.some((args) => args.includes('-u') && args.includes('status-format'))).toBe(true);
    expect(sets.some((args) => args.includes('-u') && args.includes('status-style'))).toBe(true);
    // ⚠️ Every option the banner writes must be undone by the pass that
    // recognises it. `status-position` was missing, so a sweep removed the
    // marker and left the position behind — and with no marker the leftover
    // stopped matching, making it permanently unsweepable.
    expect(sets.some((args) => args.includes('-u') && args.includes('status-position'))).toBe(true);
    expect(sets.some((args) => args.join(' ').endsWith('status off'))).toBe(true);
    expect(sets.every((args) => !args.includes('status-format[0]'))).toBe(true);
  });

  it('never touches a status bar that is not ours', async () => {
    const { client, calls } = sweeper({ 'reverie-bbbb2222': '#[align=right] my own bar ' });
    expect(await client.clearLeakedAttachBanners()).toBe(0);
    expect(calls.filter((args) => args.includes('set-option'))).toEqual([]);
  });

  it('sweeps only the sessions that leaked, leaving the rest alone', async () => {
    const { client } = sweeper({
      'reverie-aaaa1111': OURS,
      'reverie-bbbb2222': '',
      'reverie-cccc3333': OURS,
    });
    expect(await client.clearLeakedAttachBanners()).toBe(2);
  });

  it('reports nothing rather than throwing when there is no tmux server', async () => {
    const exec: TuiExecFile = async () => {
      throw new Error('no server running on /tmp/tmux-1000/reverie-beta');
    };
    const client = new TuiClient({ baseUrl, socket: 'reverie-beta', exec });
    await expect(client.clearLeakedAttachBanners()).resolves.toBe(0);
  });
});

describe('parseDetachKey', () => {
  // Verbatim from `tmux -L reverie list-keys -T prefix` on tmux 3.4, trimmed to
  // the two lines that matter. They differ only by case, which is the whole
  // point: `D` is choose-client and advertising it leaves the tester attached.
  const REAL_TMUX_34 = [
    'bind-key    -T prefix C-b     send-prefix',
    'bind-key    -T prefix d       detach-client',
    'bind-key    -T prefix D       choose-client -Z',
    'bind-key    -T prefix x       confirm-before -p "kill-pane #P? (y/n)" kill-pane',
  ].join('\n');

  it('picks the lowercase detach-client binding out of real tmux output', () => {
    expect(parseDetachKey(REAL_TMUX_34)).toBe('d');
  });

  it('follows a rebound detach key rather than assuming d', () => {
    expect(parseDetachKey('bind-key -T prefix Q detach-client')).toBe('Q');
  });

  it('tolerates the -r repeat flag ahead of -T', () => {
    expect(parseDetachKey('bind-key -r -T prefix d detach-client')).toBe('d');
  });

  it('ignores detach-client bindings that carry arguments', () => {
    // `-a` detaches OTHER clients and `-P` kills the pane's process; neither is
    // what the bar promises, so a socket with only those reports nothing.
    expect(parseDetachKey('bind-key -T prefix X detach-client -a')).toBeNull();
    expect(parseDetachKey('bind-key -T prefix Y detach-client -P')).toBeNull();
  });

  it('prefers a single-character binding over a named key', () => {
    const both = 'bind-key -T prefix F1 detach-client\nbind-key -T prefix d detach-client';
    expect(parseDetachKey(both)).toBe('d');
  });

  it('is null when nothing detaches, so the caller can fall back', () => {
    expect(parseDetachKey('')).toBeNull();
    expect(parseDetachKey('bind-key -T prefix D choose-client -Z')).toBeNull();
  });
});

describe('attach status bar options', () => {
  function optionsClient(exec: TuiExecFile): TuiClient {
    return new TuiClient({ baseUrl, socket: 'reverie-beta', exec });
  }

  const SHOW = [
    'history-limit 100000',
    'mouse off',
    'status off',
    'status-format[0] "#[reverse] left "',
    'status-format[1] "#[align=right] second line "',
    'status-left " plain #[bold]value\\" quoted "',
  ].join('\n');

  it('reads session-level options, unquoting what tmux quoted', () => {
    const parsed = parseSessionOptions(SHOW, ['status', 'status-left', 'status-right']);
    expect(parsed.status).toBe('off');
    expect(parsed['status-left']).toBe(' plain #[bold]value" quoted ');
    // Not set on this session: restoring must UNSET it, not write a value back.
    expect(parsed['status-right']).toBeNull();
  });

  it('captures a whole array when one index is asked for', () => {
    const parsed = parseSessionOptions(SHOW, ['status-format[0]']);
    expect(parsed['status-format[0]']).toBe('#[reverse] left ');
    // The second status line the user configured comes along, or the restore
    // would silently delete it.
    expect(parsed['status-format[1]']).toBe('#[align=right] second line ');
  });

  it('knows an array element from a plain option', () => {
    expect(arrayOptionBase('status-format[0]')).toBe('status-format');
    expect(arrayOptionBase('status')).toBeNull();
  });

  it('reads the prefix from the session, falling back to the global one', () => {
    const calls: Array<readonly string[]> = [];
    const client = optionsClient(async (_file, args) => {
      calls.push(args);
      // Session level says nothing; the global answer is the real one.
      return { stdout: args.includes('-gv') ? 'C-a\n' : '\n', stderr: '' };
    });
    return expect(client.readPrefixKey('reverie-0000000b'))
      .resolves.toBe('C-a')
      .then(() => {
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('-gv');
      });
  });

  it('restores an array by dropping it FIRST, then writing the captured indices', async () => {
    const calls: Array<readonly string[]> = [];
    const client = optionsClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await client.restoreSessionOptions('reverie-0000000b', {
      status: 'off',
      'status-format[0]': null,
      'status-format[1]': '#[align=right] second ',
    });
    // Unsetting one index leaves an EMPTY array (a blank status bar), so the
    // base option goes first and the survivors are written back on top.
    expect(calls[0].slice(2)).toEqual(['set-option', '-u', '-t', 'reverie-0000000b', 'status-format']);
    expect(calls.map((args) => args.slice(2))).toContainEqual([
      'set-option',
      '-t',
      'reverie-0000000b',
      'status',
      'off',
    ]);
    expect(calls.map((args) => args.slice(2))).toContainEqual([
      'set-option',
      '-t',
      'reverie-0000000b',
      'status-format[1]',
      '#[align=right] second ',
    ]);
    // The null index is covered by the array drop; it never gets its own unset.
    expect(calls.some((args) => args.includes('status-format[0]'))).toBe(false);
  });

  it('unsets a plain option that was not set on the session', async () => {
    const calls: Array<readonly string[]> = [];
    const client = optionsClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await client.restoreSessionOptions('reverie-0000000b', { status: null });
    expect(calls[0].slice(2)).toEqual(['set-option', '-u', '-t', 'reverie-0000000b', 'status']);
  });

  it('writes the banner one option at a time, and never at a foreign session', async () => {
    const calls: Array<readonly string[]> = [];
    const client = optionsClient(async (_file, args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    });
    await client.applySessionOptions('reverie-0000000b', { status: 'on', 'status-format[0]': 'x' });
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(2)).toEqual(['set-option', '-t', 'reverie-0000000b', 'status', 'on']);
    calls.length = 0;
    await client.applySessionOptions('reverie-ssh-prod', { status: 'on' });
    await client.restoreSessionOptions('reverie-dkr-box', { status: null });
    await expect(client.readPrefixKey('other-thing')).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps going when tmux rejects one option', async () => {
    let seen = 0;
    const client = optionsClient(async (_file, args) => {
      seen += 1;
      if (args.includes('status-format[0]')) throw new Error('unknown option');
      return { stdout: '', stderr: '' };
    });
    await client.applySessionOptions('reverie-0000000b', { 'status-format[0]': 'x', status: 'on' });
    expect(seen).toBe(2);
  });
});

describe('resumeSession', () => {
  it('creates with resumeSessionId and then starts the pane', async () => {
    recorded.length = 0;
    responder = (req, res) => {
      if (req.url === '/api/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { session: { id: 'new-session-id' } } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: {} }));
    };
    const id = await client().resumeSession({
      workingDir: '/home/dev/reverie',
      resumeSessionId: '00000038-0045-4000-8000-000000000064',
      sessionName: 'w7-reverie',
    });
    expect(id).toBe('new-session-id');
    expect(recorded.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'POST /api/sessions',
      // Creating a session gives it no pane; without this the resumed row would
      // sit in the list unattachable.
      'POST /api/sessions/new-session-id/interactive',
    ]);
    expect(JSON.parse(recorded[0].body)).toMatchObject({
      workingDir: '/home/dev/reverie',
      resumeSessionId: '00000038-0045-4000-8000-000000000064',
      mode: 'claude',
      name: 'w7-reverie',
    });
  });

  it('does not start a pane when creation answered without an id', async () => {
    recorded.length = 0;
    responder = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: {} }));
    };
    await expect(client().resumeSession({ workingDir: '/home/dev', resumeSessionId: 'aaaa-bbbb' })).rejects.toThrow(
      /no session id/
    );
    expect(recorded).toHaveLength(1);
  });
});
