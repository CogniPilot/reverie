/**
 * `reverie agent chat say --if-latest` / `--if-no-newer-than <id>`: ask the server to refuse the post when someone
 * else posted after the point the caller read. A refusal stores nothing, exits "refused" and lists the newer messages,
 * so the caller reads them before deciding again. Without the flags the request body is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { agentChatSay, EXIT, registerAgentCommands, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const READ = '00000007-0007-4000-8000-000000000007';
const LATE = '0000000b-000b-4000-8000-00000000000b';

function deps(json: boolean, answer?: { status: number; json: unknown }) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
    json,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.method === 'GET' && options.path === '/api/v1/chatrooms') {
        return { status: 200, text: '', json: { success: true, data: { rooms: [{ id: 'room-1', name: 'Reverie', members: [] }] } } };
      }
      if (answer) return { status: answer.status, text: '', json: answer.json as never };
      return { status: 200, text: '', json: { success: true, data: { message: { id: 'm2' } } } };
    },
  };
  return { d, calls, out, err };
}

const crossed = {
  status: 409,
  json: {
    success: false,
    errorCode: 'CHAT_NEWER_MESSAGES',
    error: '1 newer message arrived since you read; read them, then post again',
    data: { newer: [{ id: LATE, from: 'bravo', at: 2_000, excerpt: 'never mind, already fixed' }], more: false },
  },
};

describe('agent chat say --if-latest / --if-no-newer-than', () => {
  it('sends the body unchanged without the flags', async () => {
    const { d, calls } = deps(false);
    expect(await agentChatSay(d, { text: 'hello' })).toBe(EXIT.ok);
    expect(calls.at(-1)!.body).toEqual({ text: 'hello' });
  });

  it('sends ifLatest or ifNoNewerThan with the message', async () => {
    const a = deps(false);
    expect(await agentChatSay(a.d, { text: 'hi', ifLatest: true })).toBe(EXIT.ok);
    expect(a.calls.at(-1)!.body).toEqual({ text: 'hi', ifLatest: true });
    const b = deps(false);
    expect(await agentChatSay(b.d, { text: 'hi', ifNoNewerThan: READ })).toBe(EXIT.ok);
    expect(b.calls.at(-1)!.body).toEqual({ text: 'hi', ifNoNewerThan: READ });
  });

  it('refuses a bad id, or both flags, before sending anything', async () => {
    for (const options of [{ ifNoNewerThan: 'm-12' }, { ifLatest: true, ifNoNewerThan: READ }]) {
      const { d, calls, err } = deps(false);
      expect(await agentChatSay(d, { text: 'x', ...options })).toBe(EXIT.refused);
      expect(calls).toEqual([]);
      expect(err.join('\n')).toMatch(/--if-no-newer-than needs a message id|not both/);
    }
  });

  it('a crossing exits refused and lists the newer messages', async () => {
    const { d, out, err } = deps(false, crossed);
    expect(await agentChatSay(d, { text: 'stale', ifNoNewerThan: READ })).toBe(EXIT.refused);
    expect(out).toEqual([]);
    expect(err[0]).toBe('not posted: CHAT_NEWER_MESSAGES: 1 newer message arrived since you read; read them, then post again (HTTP 409)');
    expect(err).toContain('  0000000b "bravo": "never mind, already fixed"');
    expect(err.at(-1)).toBe('read them with: reverie agent chat read');
  });

  it('--json prints the refusal and the newer messages on stdout', async () => {
    const { d, out } = deps(true, crossed);
    expect(await agentChatSay(d, { text: 'stale', ifLatest: true })).toBe(EXIT.refused);
    expect(JSON.parse(out[0])).toEqual({ success: false, errorCode: 'CHAT_NEWER_MESSAGES', error: crossed.json.error, data: crossed.json.data });
  });

  it('no read mark yet is a refusal too', async () => {
    const { d, err } = deps(false, { status: 409, json: { success: false, errorCode: 'CHAT_NO_READ_MARK', error: 'No read position in this room yet; read it, then post again' } });
    expect(await agentChatSay(d, { text: 'x', ifLatest: true })).toBe(EXIT.refused);
    expect(err[0]).toContain('CHAT_NO_READ_MARK');
  });

  it('other failures keep the old error path', async () => {
    const { d, err } = deps(false, { status: 409, json: { success: false, errorCode: 'CONFLICT', error: 'something else' } });
    expect(await agentChatSay(d, { text: 'x', ifLatest: true })).toBe(EXIT.error);
    expect(err.join('\n')).toContain('CONFLICT: something else');
  });

  it.each([
    [['--if-latest'], { ifLatest: true }],
    [['--if-no-newer-than', READ], { ifNoNewerThan: READ }],
  ])('parses %j from argv', async (flags, options) => {
    const program = new Command().exitOverride();
    const agent = registerAgentCommands(program);
    const say = agent.commands.find((c) => c.name() === 'chat')!.commands.find((c) => c.name() === 'say')!;
    const got: Array<Record<string, unknown>> = [];
    say.action((_words: string[], parsed: Record<string, unknown>) => void got.push(parsed));
    await program.parseAsync(['agent', 'chat', 'say', ...flags, '--', 'hi'], { from: 'user' });
    expect(got).toEqual([options]);
  });
});
