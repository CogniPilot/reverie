/** `reverie agent chat new`: the coordinator-only create verb is a thin client of POST /api/v1/chatrooms. */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { agentChatNew, httpRequest, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const SELF = '0000002d-0035-4000-8000-000000000047';
const WORKER = '00000038-0043-4000-8000-000000000060';

function harness(respond: (o: RequestOptions) => { status: number; json: unknown }) {
  const calls: RequestOptions[] = [];
  const lines: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: SELF },
    json: false,
    io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) },
    request: async (_ctx, options) => {
      calls.push(options);
      const r = respond(options);
      return { status: r.status, text: '', json: r.json } as never;
    },
  };
  return { deps, calls, lines };
}

describe('agent chat new', () => {
  it('posts the name and resolved members, and says it coordinates the room', async () => {
    const { deps, calls, lines } = harness((o) =>
      o.method === 'GET'
        ? { status: 200, json: { success: true, data: [{ id: WORKER }] } }
        : { status: 200, json: { success: true, data: { id: 'room-9', name: 'Side', coordinatorId: SELF } } }
    );
    const code = await agentChatNew(deps, { name: 'Side', members: [WORKER] });
    expect(code).toBe(0);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/v1/chatrooms');
    expect(post.body).toEqual({ name: 'Side', members: [{ sessionId: WORKER }] });
    expect(lines.join('\n')).toContain('you coordinate it');
  });

  it('resolves an 8-character member id through the session list (an array, as the API returns)', async () => {
    const { deps, calls } = harness((o) =>
      o.method === 'GET'
        ? { status: 200, json: { success: true, data: [{ id: WORKER }, { id: SELF }] } }
        : { status: 200, json: { success: true, data: { id: 'r', name: 'S', coordinatorId: SELF } } }
    );
    expect(await agentChatNew(deps, { name: 'S', members: [WORKER.slice(0, 8)] })).toBe(0);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'S', members: [{ sessionId: WORKER }] });
  });

  it('exits non-zero when the room came back without this session as coordinator', async () => {
    for (const data of [
      { id: 'r', name: 'Orphan' },
      { id: 'r', name: 'Orphan', coordinatorId: WORKER },
    ]) {
      const { deps, lines } = harness(() => ({ status: 200, json: { success: true, data } }));
      expect(await agentChatNew(deps, { name: 'Orphan', members: [] })).not.toBe(0);
      const out = lines.join('\n');
      expect(out).toContain('not its coordinator');
      expect(out).not.toContain('you coordinate it');
    }
  });

  it('sends X-Reverie-Parent-Session over the real transport, which is what makes the server see a coordinator', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      seen = req.headers;
      req.resume();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data: { id: 'r', name: 'Wire', coordinatorId: SELF } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const lines: string[] = [];
      const deps: AgentDeps = {
        ctx: { apiUrl: `http://127.0.0.1:${port}`, selfId: SELF },
        json: false,
        io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) },
        request: httpRequest,
      };
      expect(await agentChatNew(deps, { name: 'Wire', members: [] })).toBe(0);
      expect(seen['x-reverie-parent-session']).toBe(SELF);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('omits members when none are named', async () => {
    const { deps, calls } = harness(() => ({
      status: 200,
      json: { success: true, data: { id: 'r', name: 'Solo', coordinatorId: SELF } },
    }));
    expect(await agentChatNew(deps, { name: 'Solo', members: [] })).toBe(0);
    expect(calls[0].body).toEqual({ name: 'Solo' });
  });

  it('exits non-zero and shows the server message when a non-coordinator is refused', async () => {
    const { deps, lines } = harness(() => ({
      status: 403,
      json: { success: false, error: 'Only the user or a coordinator can create chatrooms; ask the user' },
    }));
    expect(await agentChatNew(deps, { name: 'Nope', members: [] })).not.toBe(0);
    expect(lines.join('\n')).toContain('coordinator');
  });
});
