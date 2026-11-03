/**
 * `agent chat say` prints the server's heads-ups (a name no one in the room goes by) after the post went out, and never decides
 * them itself; and `--room` finds a direct message by its label ("Direct message"), since a direct message has no name of its own.
 */
import { describe, expect, it } from 'vitest';
import { agentChatSay, resolveChatRoom, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const member = (name: string) => ({ sessionId: `${name}-id`, name, role: '', goal: '', progress: '' });
const ROOMS = [
  { id: 'room-aaaa', name: 'Platform', members: [member('Abe'), member('Grace')] },
  { id: '00000047-005b-4000-8000-00000000008c', name: '', kind: 'dm' as const, dm: ['user', 'x'], members: [] },
];

function deps(json = false, warnings?: unknown[]) {
  const calls: RequestOptions[] = [];
  const err: string[] = [];
  const out: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
    json,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.method === 'GET') return { status: 200, text: '', json: { success: true, data: { rooms: ROOMS } } };
      return { status: 200, text: '', json: { success: true, data: { message: {}, ...(warnings ? { warnings } : {}) } } };
    },
  };
  return { d, calls, err, out };
}
const plain = (lines: string[]) => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
const WARNING = { code: 'stray-mention', names: ['Linus'], text: '@Linus is not in "Platform", so they will not see this; ask a coordinator to add them, or post where they are' };

describe('agent chat say', () => {
  it('posts, then prints each heads-up the server sent, without deciding any itself', async () => {
    const { d, calls, err, out } = deps(false, [WARNING, { code: 'x', text: 'second line' }]);
    expect(await agentChatSay(d, { room: 'Platform', text: 'hi @Linus' })).toBe(0);
    expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/messages'))).toBe(true);
    expect(plain(out)).toContain('posted to "Platform"');
    expect(plain(err)).toContain('@Linus is not in "Platform"');
    expect(plain(err)).toContain('second line');
  });

  it('prints nothing when the server sent none, even for an @name the CLI could not place', async () => {
    const quiet = deps();
    await agentChatSay(quiet.d, { room: 'Platform', text: 'hi @Linus' });
    expect(quiet.err).toEqual([]);
  });

  it('stays silent on stderr under --json, which carries the warnings in the data', async () => {
    const json = deps(true, [WARNING]);
    expect(await agentChatSay(json.d, { room: 'Platform', text: 'hi @Linus' })).toBe(0);
    expect(json.err).toEqual([]);
    expect(json.out.join('')).toContain('stray-mention');
  });
});

describe('--room for a direct message', () => {
  it('finds a nameless direct message by its label, and by id prefix as before', async () => {
    const { d } = deps();
    expect(await resolveChatRoom(d, 'Direct message')).toEqual({ room: ROOMS[1] });
    expect(await resolveChatRoom(d, 'direct MESSAGE')).toEqual({ room: ROOMS[1] });
    expect(await resolveChatRoom(d, '00000047')).toEqual({ room: ROOMS[1] });
  });
});
