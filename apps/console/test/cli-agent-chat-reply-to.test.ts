/**
 * `reverie agent chat say --reply-to <id>`: links a post to the message it answers. A spoken turn reads back only the
 * member's post that names its transcript, so the flag is the whole link for a typed pane, and the argv a polling
 * harness uses (`say --room R --json --reply-to ID -- TEXT`) must parse the same way. A bad id or a server refusal fails
 * the send: a post that should have been linked never goes out unlinked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Command } from 'commander';
import { agentChatSay, EXIT, registerAgentCommands, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const ASKED = '00000007-0007-4000-8000-000000000007';

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
        return {
          status: 200,
          text: '',
          json: { success: true, data: { rooms: [{ id: 'room-1', name: 'Fleet', members: [] }] } },
        };
      }
      if (answer) return { status: answer.status, text: '', json: answer.json as never };
      return { status: 200, text: '', json: { success: true, data: { message: { id: 'm2', replyTo: ASKED } } } };
    },
  };
  return { d, calls, out, err };
}

describe('agent chat say --reply-to', () => {
  it('sends the id as replyTo with the message', async () => {
    const { d, calls, out } = deps(true);
    expect(await agentChatSay(d, { text: 'It is noon.', replyTo: ASKED })).toBe(EXIT.ok);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/api/v1/chatrooms/room-1/messages' });
    expect(calls.at(-1)!.body).toEqual({ text: 'It is noon.', replyTo: ASKED });
    expect(JSON.parse(out[0])).toMatchObject({ message: { replyTo: ASKED } });
  });

  it('sends no replyTo without the flag', async () => {
    const { d, calls } = deps(false);
    expect(await agentChatSay(d, { text: 'hello' })).toBe(EXIT.ok);
    expect(calls.at(-1)!.body).toEqual({ text: 'hello' });
  });

  it.each(['', 'm-12', 'not-a-uuid', `${ASKED}x`, ` ${ASKED}`])('refuses %j before sending anything', async (bad) => {
    for (const json of [false, true]) {
      const { d, calls, out, err } = deps(json);
      expect(await agentChatSay(d, { text: 'x', replyTo: bad })).toBe(EXIT.refused);
      expect(calls).toEqual([]);
      expect([...out, ...err].join('\n')).toContain('--reply-to needs a message id');
    }
  });

  it('fails the send when the server refuses the link', async () => {
    const refused = {
      status: 400,
      json: { success: false, errorCode: 'INVALID_INPUT', error: 'No such message to reply to' },
    };
    for (const json of [false, true]) {
      const { d, out, err } = deps(json, refused);
      expect(await agentChatSay(d, { text: 'x', replyTo: ASKED })).toBe(EXIT.error);
      expect([...out, ...err].join('\n')).toContain('No such message to reply to');
      if (json) expect(JSON.parse(out[0])).toMatchObject({ success: false });
    }
  });

  it('parses the harness argv: options before --, the text after it, even text that starts with a dash', async () => {
    const program = new Command().exitOverride();
    const agent = registerAgentCommands(program);
    const chat = agent.commands.find((c) => c.name() === 'chat')!;
    const say = chat.commands.find((c) => c.name() === 'say')!;
    const got: Array<{ words: string[]; options: Record<string, unknown> }> = [];
    say.action((words: string[], options: Record<string, unknown>) => void got.push({ words, options }));
    const argv = [
      'agent',
      'chat',
      'say',
      '--room',
      'room-1',
      '--json',
      '--reply-to',
      ASKED,
      '--',
      '-- not a flag',
      'here',
    ];
    await program.parseAsync(argv, { from: 'user' });
    expect(got).toEqual([
      { words: ['-- not a flag', 'here'], options: { room: 'room-1', json: true, replyTo: ASKED } },
    ]);
    expect(say.options.find((o) => o.long === '--reply-to')?.required).toBe(true); // the flag takes a value
  });

  describe('end to end through the real action and transport', () => {
    let server: http.Server | undefined;
    afterEach(async () => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      process.exitCode = undefined;
      if (server) await new Promise((r) => server!.close(r));
      server = undefined;
    });

    async function run(argv: string[], refuse = false) {
      const posted: unknown[] = [];
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'GET') {
            res.end(JSON.stringify({ success: true, data: { rooms: [{ id: 'room-1', name: 'Fleet', members: [] }] } }));
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { replyTo?: string };
          posted.push(body);
          if (refuse) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ success: false, errorCode: 'INVALID_INPUT', error: 'No such message to reply to' })
            );
          } else res.end(JSON.stringify({ success: true, data: { message: { id: 'm2', replyTo: body.replyTo } } }));
        });
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
      vi.stubEnv('CODEMAN_MUX', '1');
      vi.stubEnv('CODEMAN_API_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      vi.stubEnv('CODEMAN_SESSION_ID', '0000002d-0035-4000-8000-000000000047');
      const out = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const program = new Command().exitOverride();
      registerAgentCommands(program);
      await program.parseAsync(argv, { from: 'user' });
      return { posted, code: process.exitCode, out: out.mock.calls.map((c) => c.join(' ')).join('\n') };
    }

    it('posts the harness argv with replyTo and exits 0', async () => {
      const { posted, code } = await run([
        'agent',
        'chat',
        'say',
        '--room',
        'room-1',
        '--json',
        '--reply-to',
        ASKED,
        '--',
        'It is noon.',
      ]);
      expect(posted).toEqual([{ text: 'It is noon.', replyTo: ASKED }]);
      expect(code).toBe(EXIT.ok);
    });

    it("takes Planner's harness argv verbatim, flag-like text included, and the --json receipt carries the link", async () => {
      // The harness passes ['say', '--room', R, '--json', '--reply-to', ID, '--', TEXT] after `reverie agent chat`.
      const harness = ['say', '--room', 'room-1', '--json', '--reply-to', ASKED, '--', '--reply-to fake'];
      const { posted, code, out } = await run(['agent', 'chat', ...harness]);
      expect(posted).toEqual([{ text: '--reply-to fake', replyTo: ASKED }]);
      expect(code).toBe(EXIT.ok);
      expect(JSON.parse(out).message.replyTo).toBe(ASKED);
    });

    it('exits non-zero when the server refuses the link, and on a bad id posts nothing', async () => {
      const refused = await run(['agent', 'chat', 'say', '--json', '--reply-to', ASKED, '--', 'x'], true);
      expect(refused.posted).toEqual([{ text: 'x', replyTo: ASKED }]);
      expect(refused.code).toBe(EXIT.error);
      await new Promise((r) => server!.close(r));
      server = undefined;
      const bad = await run(['agent', 'chat', 'say', '--reply-to', 'm-12', '--', 'x']);
      expect(bad.posted).toEqual([]);
      expect(bad.code).toBe(EXIT.refused);
    });
  });
});
