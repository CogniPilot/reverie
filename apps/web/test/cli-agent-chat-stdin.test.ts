/** Synthetic data/transport only: no shell, listener, real API or credential fixture. */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentChatSayInput,
  EXIT,
  registerAgentCommands,
  type AgentDeps,
  type RequestOptions,
} from '../src/cli-agent.js';
import { MAX_MESSAGE_CHARS } from '../src/chatroom-store.js';

const ROOM = 'room-1';
const SELF = '0000002d-0035-4000-8000-000000000047';
const REPLY = '00000007-0007-4000-8000-000000000007';
const room = { id: ROOM, name: 'Fixture', members: [] };
const literal = '  `literal code` $HOME ${value} $(not_a_command)\nsecond line \\ $ " \'\n';
const temporary: string[] = [];

async function* input(...chunks: Array<Buffer | string>) {
  yield* chunks;
}

function fixture(json = false, denied = false) {
  const calls: RequestOptions[] = [],
    out: string[] = [],
    err: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://example.invalid', selfId: SELF },
    json,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    request: async (_ctx, options) => {
      calls.push(options);
      const data =
        options.method === 'GET'
          ? { rooms: [room] }
          : options.path.endsWith('/files')
            ? { file: { id: 'uploaded-file' } }
            : { message: { id: 'posted', replyTo: REPLY } };
      return denied && options.method === 'POST'
        ? { status: 403, text: '', json: { success: false, error: 'denied' } }
        : { status: 200, text: '', json: { success: true, data } };
    },
  };
  return { deps, calls, out, err };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('explicit chat say stdin data', () => {
  it('preserves literal backticks, dollars, quotes and all multiline whitespace', async () => {
    const f = fixture();
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, input(Buffer.from(literal)))).toBe(EXIT.ok);
    expect(f.calls.at(-1)?.body).toEqual({ text: literal });
    expect([...f.out, ...f.err].join('')).not.toContain(literal);
  });
  it('decodes UTF-8 code points split across every byte boundary', async () => {
    const text = 'π🙂漢\n';
    const bytes = [...Buffer.from(text)].map((byte) => Buffer.from([byte]));
    const f = fixture();
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, input(...bytes))).toBe(EXIT.ok);
    expect(f.calls.at(-1)?.body).toEqual({ text });
  });
  it('accepts the existing exact UTF-16 message boundary including final newline', async () => {
    const f = fixture();
    const text = 'x'.repeat(MAX_MESSAGE_CHARS - 1) + '\n';
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, input(text))).toBe(EXIT.ok);
    expect(f.calls.at(-1)?.body).toEqual({ text });
  });
  it('refuses oversized stdin before any API/upload and stops reading', async () => {
    const f = fixture(true);
    let resumed = false;
    async function* tooMuch() {
      yield Buffer.from('private-stdin'.repeat(MAX_MESSAGE_CHARS));
      resumed = true;
    }
    expect(await agentChatSayInput(f.deps, [], { stdin: true, file: ['never-read'] }, tooMuch())).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
    expect(resumed).toBe(false);
    expect(f.out.join()).toContain(String(MAX_MESSAGE_CHARS));
    expect(f.out.join()).not.toContain('private-stdin');
  });
  it('refuses exactly one UTF-16 code unit over the existing bound', async () => {
    const f = fixture();
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, input('x'.repeat(MAX_MESSAGE_CHARS + 1)))).toBe(
      EXIT.refused
    );
    expect(f.calls).toEqual([]);
  });
  it('includes the decoder EOF suffix in the same existing size check', async () => {
    const f = fixture();
    expect(
      await agentChatSayInput(
        f.deps,
        [],
        { stdin: true },
        input(Buffer.from('x'.repeat(MAX_MESSAGE_CHARS)), Buffer.from([0xe2]))
      )
    ).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
  });
  it.each([0, 1])('counts non-BMP text as the server UTF-16 limit (over=%i)', async (over) => {
    const f = fixture();
    const text = '🙂'.repeat(MAX_MESSAGE_CHARS / 2 + over);
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, input(Buffer.from(text)))).toBe(
      over ? EXIT.refused : EXIT.ok
    );
    expect(f.calls.length > 0).toBe(!over);
  });
  it.each([['private argument'], [''], ['two', 'words']])(
    'refuses ambiguous positional operands %j without reading',
    async (...words) => {
      const f = fixture(true);
      async function* never() {
        yield await Promise.reject(new Error('private stream'));
      }
      expect(await agentChatSayInput(f.deps, words, { stdin: true }, never())).toBe(EXIT.refused);
      expect(f.calls).toEqual([]);
      expect(f.out.join()).not.toContain('private argument');
      expect(f.out.join()).not.toContain('private stream');
    }
  );
  it.each(['', ' \t\r\n'])('refuses empty stdin even with attachments (%j)', async (text) => {
    const f = fixture();
    expect(await agentChatSayInput(f.deps, [], { stdin: true, file: ['never-read'] }, input(text))).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
  });
  it('redacts a read failure and never posts a partial prefix', async () => {
    const f = fixture(true);
    async function* broken() {
      yield 'private prefix';
      throw new Error('private error detail');
    }
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, broken())).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
    expect(f.out.join()).toContain('could not read --stdin');
    expect(f.out.join()).not.toContain('private');
  });
  it('does not read stdin implicitly and preserves positional joining/trimming', async () => {
    const f = fixture();
    async function* never() {
      yield await Promise.reject(new Error('must not read'));
    }
    expect(await agentChatSayInput(f.deps, ['  old', 'text  '], {}, never())).toBe(EXIT.ok);
    expect(f.calls.at(-1)?.body).toEqual({ text: 'old text' });
  });
  it('keeps attachment-only positional posts and stdin+attachment/reply/JSON behavior', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chat-stdin-'));
    temporary.push(dir);
    const path = join(dir, 'note.txt');
    await writeFile(path, 'synthetic');
    const old = fixture();
    expect(await agentChatSayInput(old.deps, [], { file: [path] })).toBe(EXIT.ok);
    expect(old.calls.at(-1)?.body).toEqual({ text: '', attachments: ['uploaded-file'] });
    const f = fixture(true);
    expect(await agentChatSayInput(f.deps, [], { stdin: true, file: [path], replyTo: REPLY }, input(literal))).toBe(
      EXIT.ok
    );
    expect(f.calls.at(-1)?.body).toEqual({ text: literal, attachments: ['uploaded-file'], replyTo: REPLY });
    expect(JSON.parse(f.out[0])).toEqual({ message: { id: 'posted', replyTo: REPLY } });
    expect(f.err).toEqual([]);
  });
  it('keeps invalid-reply refusal before uploads/requests', async () => {
    const f = fixture();
    expect(
      await agentChatSayInput(f.deps, [], { stdin: true, replyTo: 'bad', file: ['never-read'] }, input(literal))
    ).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
  });
  it('does not resend or fall back when the normal server refuses', async () => {
    const f = fixture(true, true);
    expect(await agentChatSayInput(f.deps, [], { stdin: true }, input(literal))).toBe(EXIT.error);
    expect(f.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
    expect(f.out.join()).not.toContain(literal);
  });
});

describe('actual Commander say action with mocked stdin and request (no sockets)', () => {
  async function run(words: string[], text: string) {
    const calls: Array<{ method: string; body?: unknown }> = [];
    vi.stubEnv('REVERIE_MUX', '1');
    vi.stubEnv('REVERIE_API_URL', 'http://example.invalid');
    vi.stubEnv('REVERIE_SESSION_ID', SELF);
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(() => input(Buffer.from(text)));
    vi.spyOn(http, 'request').mockImplementation(((options: { method: string }, callback: (res: unknown) => void) => {
      let raw = '';
      const req = Object.assign(new EventEmitter(), {
        write: (chunk: string) => {
          raw += chunk;
        },
        end: () =>
          queueMicrotask(() => {
            const body = raw ? JSON.parse(raw) : undefined;
            calls.push({ method: options.method, body });
            const data = options.method === 'GET' ? { rooms: [room] } : { message: { id: 'posted', replyTo: REPLY } };
            const res = Object.assign(new PassThrough(), { statusCode: 200, headers: {} });
            callback(res);
            res.end(JSON.stringify({ success: true, data }));
          }),
      });
      return req;
    }) as typeof http.request);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerAgentCommands(program);
    await program.parseAsync(['agent', 'chat', 'say', ...words], { from: 'user' });
    return {
      calls,
      out: out.mock.calls.flat().join('\n'),
      err: err.mock.calls.flat().join('\n'),
      code: process.exitCode,
    };
  }
  it('wires --stdin, --room, --reply-to and --json through the real action and serializer', async () => {
    const f = await run(['--stdin', '--room', ROOM, '--reply-to', REPLY, '--json'], literal);
    expect(f.code).toBe(EXIT.ok);
    expect(f.calls.at(-1)).toEqual({ method: 'POST', body: { text: literal, replyTo: REPLY } });
    expect(JSON.parse(f.out)).toEqual({ message: { id: 'posted', replyTo: REPLY } });
    expect(f.err).toBe('');
  });
  it('retains positional flag-like literal text after -- without consuming stdin', async () => {
    const f = await run(['--room', ROOM, '--json', '--', '--literal', '$x'], 'unused');
    expect(f.code).toBe(EXIT.ok);
    expect(f.calls.at(-1)?.body).toEqual({ text: '--literal $x' });
    expect(process.stdin[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });
  it('refuses stdin+text before any mocked request and never echoes text', async () => {
    const f = await run(['--stdin', '--json', 'private-position'], literal);
    expect(f.code).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
    expect(JSON.parse(f.out).success).toBe(false);
    expect(f.out).not.toContain('private-position');
    expect(process.stdin[Symbol.asyncIterator]).not.toHaveBeenCalled();
  });
  it('refuses whitespace-only stdin through actual action without any request', async () => {
    const f = await run(['--stdin', '--json'], '\n \t');
    expect(f.code).toBe(EXIT.refused);
    expect(f.calls).toEqual([]);
    expect(JSON.parse(f.out).error).toContain('empty message');
  });
});
