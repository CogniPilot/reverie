/**
 * `agent chat` verbs with no --room: the one room, else (in several rooms) the room the last prompt came from, but only when it came
 * from exactly one. A prompt that bundled several rooms is not guessed: the error lists them. --room always wins.
 */
import { describe, expect, it } from 'vitest';
import { agentChatSay, resolveChatRoom, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const ROOMS = [
  { id: 'room-aaaa', name: 'Break Room', members: [] },
  { id: 'room-bbbb', name: 'Slam Web', members: [] },
  { id: 'room-cccc', name: 'Platform', members: [] },
];

function deps(lastDelivery: { roomIds: string[] } | null | undefined, rooms = ROOMS) {
  const calls: RequestOptions[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: 'aaaaaaaa-0000-4000-8000-000000000001' },
    json: false,
    io: { out: () => {}, err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.method === 'GET' && options.path === '/api/v1/chatrooms') {
        return { status: 200, text: '', json: { success: true, data: { rooms, ...(lastDelivery === undefined ? {} : { lastDelivery }) } } };
      }
      return { status: 200, text: '', json: { success: true, data: { message: {} } } };
    },
  };
  return { d, calls, err };
}
const plain = (lines: string[]) => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

describe('chat verbs with no --room', () => {
  it('replies in the room the last prompt came from, and says which, when it came from exactly one', async () => {
    const { d, err } = deps({ roomIds: ['room-bbbb'] });
    const target = await resolveChatRoom(d, undefined);
    expect(target).toEqual({ room: ROOMS[1] });
    expect(plain(err)).toContain('using "Slam Web", the room you were last addressed in');
  });

  it('a prompt that bundled several rooms is not guessed: it asks for --room and lists the bundle and all the rooms', async () => {
    const { d } = deps({ roomIds: ['room-aaaa', 'room-bbbb'] });
    const target = await resolveChatRoom(d, undefined);
    expect('error' in target && target.error).toContain('3 chatrooms');
    expect('error' in target && target.error).toContain('bundled messages from "Break Room" and "Slam Web"');
    expect('error' in target && target.error).toContain('pick one with --room ("Break Room", "Slam Web", "Platform")');
  });

  it('with no delivery yet, or one from a room the session is no longer in, it keeps the plain error', async () => {
    for (const last of [undefined, null, { roomIds: [] }, { roomIds: ['room-gone'] }]) {
      const { d } = deps(last as never);
      const target = await resolveChatRoom(d, undefined);
      expect('error' in target && target.error).toBe('this session is in 3 chatrooms; pick one with --room ("Break Room", "Slam Web", "Platform")');
    }
  });

  it('an explicit --room always wins over the last prompt, and asks the server for nothing extra', async () => {
    const { d, calls, err } = deps({ roomIds: ['room-bbbb'] });
    const target = await resolveChatRoom(d, 'platform');
    expect(target).toEqual({ room: ROOMS[2] });
    expect(err).toEqual([]);
    expect(calls[0].query).toEqual({ member: undefined });
  });

  it('a delivered DM header name (DM:<roomId>) resolves to exactly that direct message, never by its shared label', async () => {
    const dms = [
      { id: 'dddddddd-0000-4000-8000-0000000000d1', name: '', kind: 'dm', dm: ['user', 'x'], members: [] },
      { id: 'dddddddd-0000-4000-8000-0000000000d2', name: '', kind: 'dm', dm: ['user', 'y'], members: [] },
    ];
    const { d } = deps(null, [...ROOMS, ...dms] as never);
    expect(await resolveChatRoom(d, 'DM:dddddddd-0000-4000-8000-0000000000d2')).toEqual({ room: dms[1] });
    expect(await resolveChatRoom(d, 'dm:dddddddd-0000-4000-8000-0000000000d1')).toEqual({ room: dms[0] });
    expect(await resolveChatRoom(d, 'Direct message')).toMatchObject({ error: expect.stringMatching(/matches 2 chatrooms/) });
  });

  it('a room literally named "DM:ops" is still found by that name', async () => {
    const named = { id: 'room-dmops', name: 'DM:ops', members: [] };
    const ops = { id: 'room-ops', name: 'ops', members: [] };
    const { d } = deps(null, [...ROOMS, named, ops] as never);
    expect(await resolveChatRoom(d, 'DM:ops')).toEqual({ room: named });
  });

  it('one room is still just that room, with no notice', async () => {
    const { d, err } = deps({ roomIds: ['room-bbbb'] }, [ROOMS[0]]);
    expect(await resolveChatRoom(d, undefined)).toEqual({ room: ROOMS[0] });
    expect(err).toEqual([]);
  });

  it('`chat say` posts to the defaulted room and still names it in its own confirmation; --json stays clean', async () => {
    const out: string[] = [];
    const { d, calls, err } = deps({ roomIds: ['room-cccc'] });
    d.io.out = (m: string) => void out.push(m);
    expect(await agentChatSay(d, { text: 'recovered' })).toBe(0);
    expect(calls.at(-1)!.path).toBe('/api/v1/chatrooms/room-cccc/messages');
    expect(plain(out)).toContain('posted to "Platform"');
    expect(plain(err)).toContain('last addressed in');
    const quiet = deps({ roomIds: ['room-cccc'] });
    quiet.d.json = true;
    await agentChatSay(quiet.d, { text: 'again' });
    expect(quiet.err).toEqual([]);
  });
});
