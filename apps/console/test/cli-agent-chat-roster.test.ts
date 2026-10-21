/**
 * `agent chat who --names` (just the names, to check one before @-mentioning it), `status --away` (an away note others see in `who`),
 * and `emote` (an action line in your own name).
 */
import { describe, expect, it } from 'vitest';
import { agentChatEmote, agentChatStatus, agentChatWho, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const ME = '0000002d-0035-4000-8000-000000000047';
const member = (sessionId: string, name: string, extra: Record<string, unknown> = {}) => ({ sessionId, name, role: 'agent', goal: '', progress: '', ...extra });
const ROOMS = [
  { id: 'room-aaaa', name: 'Platform', members: [member(ME, 'Ada'), member('g-id', 'Grace', { away: 'back at 3' }), member('l-id', 'Linus')] },
];

function deps(json = false) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: ME },
    json,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.method === 'GET') return { status: 200, text: '', json: { success: true, data: { rooms: ROOMS } } };
      return { status: 200, text: '', json: { success: true, data: { message: {} } } };
    },
  };
  return { d, calls, out, err };
}
const plain = (lines: string[]) => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('agent chat who', () => {
  it('--names lists only the (quoted) names, one per line, and as a list under --json', async () => {
    const text = deps();
    expect(await agentChatWho(text.d, { room: 'Platform', names: true })).toBe(0);
    // Quoted like every name `who` prints, since a name is text another member wrote.
    expect(text.out).toEqual(['"Ada"', '"Grace"', '"Linus"']);
    const json = deps(true);
    await agentChatWho(json.d, { room: 'Platform', names: true });
    expect(JSON.parse(json.out.join(''))).toEqual({ names: ['Ada', 'Grace', 'Linus'] });
  });

  it('shows a member\'s away note, and no line for a member who is here', async () => {
    const { d, out } = deps();
    await agentChatWho(d, { room: 'Platform' });
    expect(plain(out).match(/away: /g)).toHaveLength(1);
    expect(plain(out)).toContain('away: "back at 3"');
  });
});

describe('agent chat status --away', () => {
  it('sends the note (an empty one clears it) and counts as a change on its own', async () => {
    const { d, calls } = deps();
    expect(await agentChatStatus(d, { room: 'Platform', away: 'back at 3' })).toBe(0);
    expect(calls.at(-1)?.body).toEqual({ away: 'back at 3' });
    await agentChatStatus(d, { room: 'Platform', away: '' });
    expect(calls.at(-1)?.body).toEqual({ away: '' });
    expect(await agentChatStatus(d, { room: 'Platform' })).not.toBe(0);
  });
});

describe('agent chat emote', () => {
  it('posts "* <your name> <action>" to the room', async () => {
    const { d, calls } = deps();
    expect(await agentChatEmote(d, { room: 'Platform', action: 'dances' })).toBe(0);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/v1/chatrooms/room-aaaa/messages');
    expect(post.body).toEqual({ text: '* Ada dances' });
  });

  it('refuses an empty action, and a room you are not in', async () => {
    const { d, calls } = deps();
    expect(await agentChatEmote(d, { room: 'Platform', action: '  ' })).not.toBe(0);
    expect(calls).toEqual([]);
    const stranger = deps();
    stranger.d.ctx.selfId = 'zzzzzzzz-0000-4000-8000-000000000009';
    expect(await agentChatEmote(stranger.d, { room: 'Platform', action: 'dances' })).not.toBe(0);
    expect(stranger.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
