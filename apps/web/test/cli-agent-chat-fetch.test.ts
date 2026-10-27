/** Synthetic only: no server, attachment, credential lookup or network connection. */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, symlink, mkdir, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentChatFetch,
  agentChatRead,
  formatChatMessage,
  httpRequest,
  registerAgentCommands,
  type AgentDeps,
  type ApiResponse,
  type RequestOptions,
} from '../src/cli-agent.js';
import { chatAttachmentDestinationRefusal, saveChatAttachment } from '../src/cli-chat-attachment.js';

const ROOM = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const SELF = '00000004-0004-4000-8000-000000000004';
const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
const ctx = {
  apiUrl: 'http://example.invalid',
  selfId: SELF,
  auth: { username: 'synthetic', password: 'fixture-only' },
};
const room = { id: ROOM, name: 'reverie', members: [{ sessionId: SELF, name: 'Fixture', role: 'member' }] };
const ok = (data: unknown): ApiResponse => ({ status: 200, text: '', json: { success: true, data } });
function deps(
  answer: ApiResponse = { status: 200, text: '', bytes: bytes }
): AgentDeps & { calls: RequestOptions[]; out: string[]; err: string[] } {
  const calls: RequestOptions[] = [],
    out: string[] = [],
    err: string[] = [];
  return {
    ctx,
    json: false,
    now: Date.now,
    calls,
    out,
    err,
    io: { out: (x) => out.push(x), err: (x) => err.push(x) },
    request: async (_ctx, options) => {
      calls.push(options);
      return calls.length === 1 ? ok({ rooms: [room] }) : answer;
    },
  };
}

describe('explicit scoped chat fetch and output', () => {
  let original: string, dir: string;
  beforeEach(async () => {
    original = process.cwd();
    dir = await mkdtemp(join(tmpdir(), 'chat-fetch-'));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(original);
    vi.restoreAllMocks();
  });

  it('preserves exact binary bytes, scoped GET, fixed bounds and private new-file mode', async () => {
    const d = deps();
    expect(await agentChatFetch(d, { room: 'reverie', fileId: FILE, output: 'DIAGNOSIS.txt' })).toBe(0);
    expect(await readFile('DIAGNOSIS.txt')).toEqual(bytes);
    expect((await stat('DIAGNOSIS.txt')).mode & 0o777).toBe(0o600);
    expect(d.calls[1]).toEqual({
      method: 'GET',
      path: `/api/v1/chatrooms/${ROOM}/files/${FILE}`,
      binary: { maxBytes: 8 * 1024 * 1024, deadlineMs: 30_000 },
      timeoutMs: 30_000,
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' },
    });
    expect(d.out.join()).not.toContain('fixture-only');
  });
  it.each(['../escape', '/tmp/escape', 'sub/file', 'sub\\file', '..', '.', '', '-option', 'a\nfile', 'a'.repeat(201)])(
    'refuses unsafe destination %j before any API request',
    async (output) => {
      const d = deps();
      expect(await agentChatFetch(d, { room: 'reverie', fileId: FILE, output })).toBe(4);
      expect(d.calls).toHaveLength(0);
      expect(await readdir(dir)).toEqual([]);
    }
  );
  it('requires full UUID, not paths or foreign URLs', async () => {
    for (const fileId of ['../private', 'https://elsewhere.invalid', '92905711', '']) {
      const d = deps();
      expect(await agentChatFetch(d, { room: 'reverie', fileId, output: 'safe.txt' })).toBe(4);
      expect(d.calls).toHaveLength(0);
    }
  });
  it('does not infer a room from an empty explicit operand', async () => {
    const d = deps();
    expect(await agentChatFetch(d, { room: '  ', fileId: FILE, output: 'safe.txt' })).toBe(4);
    expect(d.calls).toHaveLength(0);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 67108865])(
    'refuses invalid download ceiling %s before requests',
    async (maxBytes) => {
      const d = deps();
      expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt', maxBytes })).toBe(4);
      expect(d.calls).toHaveLength(0);
    }
  );
  it.each([0, -1, 1.5, NaN, Infinity, 120001])('refuses invalid deadline %s before requests', async (timeoutMs) => {
    const d = deps();
    expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt', timeoutMs })).toBe(4);
    expect(d.calls).toHaveLength(0);
  });
  it('accepts explicit hard-ceiling options with tiny synthetic data, not a large allocation', async () => {
    const d = deps();
    expect(
      await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt', maxBytes: 67108864, timeoutMs: 120000 })
    ).toBe(0);
    expect(d.calls[0].bounds).toEqual({ maxBytes: 1048576, deadlineMs: 5000 });
    expect(d.calls[1].binary).toEqual({ maxBytes: 67108864, deadlineMs: 120000 });
  });
  it.each([401, 403, 404, 429, 302, 206, 500])('refuses HTTP %i without body leakage or a file', async (status) => {
    const d = deps({ status, text: 'private error body', bytes });
    expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt' })).toBe(1);
    expect(await readdir(dir)).toEqual([]);
    expect(d.err.join()).not.toContain('private error');
    expect(d.calls).toHaveLength(2);
  });
  it('does not fall back to decoded text or accept oversized injected bytes', async () => {
    for (const response of [
      { status: 200, text: 'not binary' },
      { status: 200, text: '', bytes: Buffer.alloc(8 * 1024 * 1024 + 1) },
    ]) {
      expect(await agentChatFetch(deps(response), { room: ROOM, fileId: FILE, output: 'safe.txt' })).toBe(1);
    }
    expect(await readdir(dir)).toEqual([]);
  });
  it('retains existing room-list denial, without a file GET or write', async () => {
    const d = deps();
    d.request = async (_c, o) => {
      d.calls.push(o);
      return { status: 403, text: 'Forbidden' };
    };
    expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt' })).toBe(1);
    expect(d.calls).toHaveLength(1);
    expect(await readdir(dir)).toEqual([]);
  });
  it('refuses an unavailable/unjoined room without a file GET or automatic join', async () => {
    const d = deps();
    d.request = async (_c, o) => {
      d.calls.push(o);
      return ok({ rooms: [] });
    };
    expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt' })).toBe(1);
    expect(d.calls).toHaveLength(1);
  });
  it('never overwrites regular files, directories or symlinks, including dangling links', async () => {
    await writeFile('existing', 'keep');
    await mkdir('directory');
    await symlink('existing', 'link');
    await symlink('absent', 'dangling');
    for (const output of ['existing', 'directory', 'link', 'dangling']) {
      expect(await agentChatFetch(deps(), { room: ROOM, fileId: FILE, output })).toBe(1);
    }
    expect(await readFile('existing', 'utf8')).toBe('keep');
    await expect(stat('absent')).rejects.toThrow();
  });
  it('direct output helper also rejects traversal', async () => {
    expect(chatAttachmentDestinationRefusal('x.txt')).toBeUndefined();
    await expect(saveChatAttachment('../other', bytes)).rejects.toThrow('no paths');
  });
  it('transport errors are generic, not credential/URL/exception echoes', async () => {
    const d = deps();
    let n = 0;
    d.request = async () => {
      if (++n === 1) return ok({ rooms: [room] });
      throw new Error('https://secret:password@private/path');
    };
    expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt' })).toBe(1);
    expect(d.err.join()).not.toMatch(/secret|password|private\/path/);
    expect(await readdir(dir)).toEqual([]);
  });
  it('has machine metadata only, not file content or credentials', async () => {
    const d = deps();
    d.json = true;
    expect(await agentChatFetch(d, { room: ROOM, fileId: FILE, output: 'safe.txt' })).toBe(0);
    expect(JSON.parse(d.out[0])).toEqual({ roomId: ROOM, fileId: FILE, output: 'safe.txt', bytes: bytes.length });
  });
});

const message = {
  id: FILE,
  at: 1,
  from: { kind: 'agent', name: 'Fixture' },
  to: 'all' as const,
  text: '',
  attachments: [{ id: FILE, name: 'DIAGNOSIS\n.txt', path: '/private/server/path', type: 'text/plain', size: 6 }],
};
describe('attachment text links and documented syntax', () => {
  it('uses fixed scoped API links, quoted names and no server filesystem path', () => {
    const output = formatChatMessage(message, [], ROOM);
    expect(output).toContain(`/api/v1/chatrooms/${ROOM}/files/${FILE}`);
    expect(output).not.toContain('/private/server');
    expect(output).not.toContain('\n');
    expect(output).toContain('(attachment only)');
  });
  it('does not invent links for malformed IDs or expose deleted attachments', () => {
    expect(
      formatChatMessage({ ...message, attachments: [{ ...message.attachments[0], id: '../../secret' }] }, [], ROOM)
    ).not.toContain('/api/');
    expect(formatChatMessage({ ...message, deleted: { at: 2 } }, [], ROOM)).not.toContain('attached');
  });
  it('system attachment messages also retain the scoped link', () => {
    expect(formatChatMessage({ ...message, from: { kind: 'system', name: 'system' } }, [], ROOM)).toContain(
      `/api/v1/chatrooms/${ROOM}/files/${FILE}`
    );
  });
  it('normal and exact-message read both supply the resolved room', async () => {
    for (const exact of [false, true]) {
      const d = deps(ok(exact ? { message, readToken: 'fixture' } : { messages: [message], members: [] }));
      expect(await agentChatRead(d, { room: 'reverie', limit: 1, ...(exact ? { message: FILE } : {}) })).toBe(0);
      expect(d.out.join()).toContain(`/api/v1/chatrooms/${ROOM}/files/${FILE}`);
      expect(d.calls.every((c) => c.method === 'GET')).toBe(true);
    }
  });
  it('help requires explicit output and the ROOM FILE_ID operands', () => {
    const program = new Command();
    registerAgentCommands(program);
    const chat = program.commands.find((c) => c.name() === 'agent')!.commands.find((c) => c.name() === 'chat')!;
    const fetch = chat.commands.find((c) => c.name() === 'fetch')!;
    expect(fetch.helpInformation()).toContain('fetch [options] <room> <file-id>');
    expect(fetch.options.find((o) => o.long === '--output')?.mandatory).toBe(true);
  });
});

describe('real ordinary transport, mocked sockets only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  function mock(
    body: (res: PassThrough & { statusCode: number; headers: Record<string, string> }) => void,
    status = 200,
    headers: Record<string, string> = { 'content-length': String(bytes.length) }
  ) {
    let opts: unknown;
    const request = vi.spyOn(http, 'request').mockImplementation(((
      options: unknown,
      callback: (r: unknown) => void
    ) => {
      opts = options;
      const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e: Error) => void };
      req.destroy = (e) => {
        queueMicrotask(() => req.emit('error', e));
      };
      req.end = () =>
        queueMicrotask(() => {
          const res = Object.assign(new PassThrough(), { statusCode: status, headers });
          callback(res);
          body(res);
        });
      return req;
    }) as typeof http.request);
    return { request, options: () => opts };
  }
  it('sends normal parent/session auth and preserves raw non-UTF8 bytes', async () => {
    const m = mock((res) => res.end(bytes));
    const result = await httpRequest(ctx, {
      method: 'GET',
      path: `/api/v1/chatrooms/${ROOM}/files/${FILE}`,
      binary: { maxBytes: 99, deadlineMs: 1000 },
    });
    expect(result.bytes).toEqual(bytes);
    expect(result.text).toBe('');
    expect(m.options()).toMatchObject({
      hostname: 'example.invalid',
      headers: { 'X-Reverie-Parent-Session': SELF, Authorization: expect.stringMatching(/^Basic /) },
    });
  });
  it.each([true, false])('refuses oversized response with content-length=%s', async (announced) => {
    mock((res) => res.end(Buffer.alloc(11)), 200, announced ? { 'content-length': '11' } : { 'content-length': '10' });
    await expect(
      httpRequest(ctx, { method: 'GET', path: '/fixed', binary: { maxBytes: 10, deadlineMs: 1000 } })
    ).rejects.toThrow('byte limit');
  });
  it('returns a redirect once without following Location or sending credentials elsewhere', async () => {
    const m = mock((res) => res.end(), 302, { location: 'https://foreign.invalid/private' });
    expect(
      (await httpRequest(ctx, { method: 'GET', path: '/fixed', binary: { maxBytes: 10, deadlineMs: 1000 } })).status
    ).toBe(302);
    expect(m.request).toHaveBeenCalledTimes(1);
  });
  it('rejects cross-origin URLs before transport, including protocol-relative URLs', async () => {
    const m = mock((res) => res.end());
    for (const path of ['https://foreign.invalid/file', '//foreign.invalid/file']) {
      await expect(
        httpRequest(ctx, { method: 'GET', path, binary: { maxBytes: 10, deadlineMs: 1000 } })
      ).rejects.toThrow('invalid');
    }
    expect(m.request).not.toHaveBeenCalled();
  });
  it('whole-request deadline refuses a trickling body, not just socket inactivity', async () => {
    vi.useFakeTimers();
    mock((res) => {
      res.write('a');
      setTimeout(() => res.write('b'), 10);
    });
    const result = httpRequest(ctx, { method: 'GET', path: '/fixed', binary: { maxBytes: 10, deadlineMs: 20 } });
    const assertion = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });
  it('mid-body errors refuse instead of saving a truncated response', async () => {
    mock((res) => {
      res.write('partial');
      res.destroy(new Error('broken socket'));
    });
    await expect(
      httpRequest(ctx, { method: 'GET', path: '/fixed', binary: { maxBytes: 99, deadlineMs: 1000 } })
    ).rejects.toThrow('broken socket');
  });
  it.each([{}, { 'content-length': '-1' }, { 'content-length': '1', 'content-encoding': 'gzip' }])(
    'refuses uncertain or encoded binary length %j',
    async (headers) => {
      mock((res) => res.end('a'), 200, headers);
      await expect(
        httpRequest(ctx, { method: 'GET', path: '/fixed', binary: { maxBytes: 99, deadlineMs: 1000 } })
      ).rejects.toThrow('declared length');
    }
  );
  it('refuses a clean-looking short response, including an Office-sized prefix', async () => {
    mock((res) => res.end('abc'), 200, { 'content-length': '4' });
    await expect(
      httpRequest(ctx, { method: 'GET', path: '/fixed', binary: { maxBytes: 99, deadlineMs: 1000 } })
    ).rejects.toThrow('length mismatch');
  });
  it('bounded room JSON uses its own finite ceiling but preserves normal JSON decoding', async () => {
    mock((res) => res.end(JSON.stringify({ success: true, data: { rooms: [] } })));
    const response = await httpRequest(ctx, {
      method: 'GET',
      path: '/api/v1/chatrooms',
      bounds: { maxBytes: 1024, deadlineMs: 1000 },
    });
    expect(response.json).toEqual({ success: true, data: { rooms: [] } });
    expect(response.bytes).toBeUndefined();
  });
  it('existing unbounded-option JSON requests retain response shape and decoding', async () => {
    mock((res) => res.end(JSON.stringify({ success: true, data: 'unchanged' })));
    const response = await httpRequest(ctx, { method: 'GET', path: '/api/v1/chatrooms' });
    expect(response).toEqual({
      status: 200,
      text: '{"success":true,"data":"unchanged"}',
      json: { success: true, data: 'unchanged' },
    });
  });
});
