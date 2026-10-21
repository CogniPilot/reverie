/** `agent chat rooms --all`, `join` and `leave`: thin clients of the public-channel routes. */
import { describe, expect, it } from 'vitest';
import { agentChatJoin, agentChatLeave, agentChatRooms, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const SELF = '0000002d-0035-4000-8000-000000000047';
const NEWS = { id: '00000009-0009-4000-8000-000000000009', name: 'News', topic: 'Daily digest', memberCount: 4, joined: false };
const OPS = { id: '0000000c-000f-4000-8000-000000000012', name: 'Ops', memberCount: 2, joined: true };

function harness(respond: (o: RequestOptions) => { status: number; json: unknown }, json = false) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: SELF },
    json,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    request: async (_ctx, options) => {
      calls.push(options);
      const r = respond(options);
      return { status: r.status, text: '', json: r.json } as never;
    },
  };
  return { deps, calls, out, err };
}
const ok = (data: unknown) => ({ status: 200, json: { success: true, data } });
const refuse = (status: number, error: string) => ({ status, json: { success: false, error } });
const mine = { id: '0000000f-0013-4000-8000-000000000019', name: 'Fleet', visibility: 'private', members: [{ sessionId: SELF, role: 'agent' }] };

describe('agent chat rooms', () => {
  it('lists the rooms you are in with their visibility, and only those', async () => {
    const { deps, calls, out } = harness(() => ok({ rooms: [mine] }));
    expect(await agentChatRooms(deps)).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out[0]).toContain('private');
    expect(out[0]).toContain('Fleet');
  });

  it('--all also lists the public channels you are not in, with a way to join, and none you already are in', async () => {
    const { deps, calls, out } = harness((o) => (o.path.endsWith('/public') ? ok({ rooms: [NEWS, OPS] }) : ok({ rooms: [mine] })));
    expect(await agentChatRooms(deps, { all: true })).toBe(0);
    expect(calls.map((c) => c.path)).toEqual(['/api/v1/chatrooms', '/api/v1/chatrooms/public']);
    const text = out.join('\n');
    expect(text).toContain('News');
    expect(text).toContain('Daily digest');
    expect(text).toContain('join with: reverie agent chat join "News"');
    expect(text).not.toContain('Ops');
  });

  it('--json carries each room with its visibility and members, and with --all the channels you could join', async () => {
    const { deps, out } = harness((o) => (o.path.endsWith('/public') ? ok({ rooms: [NEWS] }) : ok({ rooms: [mine] })), true);
    await agentChatRooms(deps, { all: true });
    const parsed = JSON.parse(out.join(''));
    expect(parsed.rooms[0].visibility).toBe('private');
    expect(parsed.rooms[0].members[0].sessionId).toBe(SELF);
    expect(parsed.available.map((c: { name: string }) => c.name)).toEqual(['News']);
  });
});

describe('agent chat join and leave', () => {
  it('joins a public channel by name, id prefix or case-insensitively, and says how to post there', async () => {
    for (const wanted of ['News', 'news', NEWS.id, NEWS.id.slice(0, 8)]) {
      const { deps, calls, out } = harness((o) => (o.path.endsWith('/public') ? ok({ rooms: [NEWS] }) : ok({ joined: true })));
      expect(await agentChatJoin(deps, { room: wanted }), wanted).toBe(0);
      expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/chatrooms/${NEWS.id}/join` });
      expect(out.join('\n')).toContain('joined "News"');
    }
  });

  it('says so when you are already in it, and joins nothing', async () => {
    const { deps, calls, out } = harness(() => ok({ rooms: [OPS] }));
    expect(await agentChatJoin(deps, { room: 'Ops' })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(out.join('\n')).toContain('already in "Ops"');
  });

  it('a channel that is not public, or not there, says to ask the owner or the coordinator', async () => {
    const { deps, calls, err } = harness(() => ok({ rooms: [NEWS] }));
    expect(await agentChatJoin(deps, { room: 'general' })).not.toBe(0);
    expect(calls).toHaveLength(1); // nothing was posted
    expect(err.join(' ')).toContain('no public channel matches "general"');
    expect(err.join(' ')).toContain('owner or its coordinator');
  });

  it('shows the server’s refusal', async () => {
    const { deps, err } = harness((o) => (o.path.endsWith('/public') ? ok({ rooms: [NEWS] }) : refuse(403, "This channel is private: ask the owner or the room's coordinator to add you")));
    expect(await agentChatJoin(deps, { room: 'News' })).not.toBe(0);
    expect(err.join(' ')).toContain('private');
  });

  it('leaves the room by removing itself', async () => {
    const { deps, calls, out } = harness((o) => (o.method === 'DELETE' ? ok({}) : ok({ rooms: [mine] })));
    expect(await agentChatLeave(deps, { room: 'Fleet' })).toBe(0);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/api/v1/chatrooms/${mine.id}/members/${SELF}` });
    expect(out.join('\n')).toContain('left "Fleet"');
  });
});
