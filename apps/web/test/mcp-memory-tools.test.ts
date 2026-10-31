/**
 * @fileoverview The opt-in memory tools of `reverie mcp`: off unless the server's own environment names an
 * instance, the caller can never pick another store, requests go to the bridge on stdin with a minimal
 * environment, and every failure is an isError result.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createMcpServer, type McpConfig } from '../src/mcp-server.js';
import {
  createMemoryTools,
  resolveMemoryToolsConfig,
  type BridgeRunner,
  type MemoryToolsConfig,
} from '../src/mcp-memory-tools.js';

const ON: MemoryToolsConfig = { instance: '/instances/x/config/experts/a.json', python: '/py/python3', source: '/src/python' };

function recorder(reply: { stdout?: string; stderr?: string; code?: number } = {}) {
  const calls: Array<{ python: string; args: string[]; env: NodeJS.ProcessEnv; input: string }> = [];
  const runner: BridgeRunner = async (python, args, options) => {
    calls.push({ python, args, env: options.env, input: options.input });
    return { stdout: reply.stdout ?? '[{"text":"a memory"}]', stderr: reply.stderr ?? '', code: reply.code ?? 0 };
  };
  return { calls, runner };
}

const mcpConfig: McpConfig = { allowAnySession: false, version: 'test' };

function server(memory: MemoryToolsConfig, runner: BridgeRunner) {
  const out: Array<Record<string, unknown>> = [];
  const srv = createMcpServer({ config: mcpConfig, write: (m) => out.push(m), modes: ['shell'], memory, memoryRunner: runner });
  const send = async (message: unknown) => srv.handleLine(JSON.stringify(message));
  return { out, send };
}

afterEach(() => {
  delete process.env.REVERIE_SESSION_ID;
  delete process.env.REVERIE_HOOK_SECRET_FILE;
});

describe('opt-in', () => {
  it('is off unless the environment names an absolute instance path', () => {
    expect(resolveMemoryToolsConfig({}).instance).toBeUndefined();
    expect(resolveMemoryToolsConfig({ REVERIE_MCP_MEMORY_INSTANCE: 'relative.json' }).instance).toBeUndefined();
    expect(resolveMemoryToolsConfig({ REVERIE_MCP_MEMORY_INSTANCE: ' /abs/a.json ' }).instance).toBe('/abs/a.json');
    expect(createMemoryTools({ ...ON, instance: undefined }).definitions()).toEqual([]);
  });

  it('lists the two tools after the session tools only when on, and refuses them when off', async () => {
    const on = server(ON, recorder().runner);
    await on.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = ((on.out[0].result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(names.slice(-2)).toEqual(['memory_recall', 'memory_remember']);
    const off = server({ ...ON, instance: undefined }, recorder().runner);
    await off.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(JSON.stringify(off.out[0])).not.toContain('memory_recall');
    await off.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'x' } } });
    expect((off.out[1].error as { message: string }).message).toContain('Unknown tool');
  });
});

describe('requests', () => {
  it('recalls privately by default and from a project when named, on stdin, with a minimal environment', async () => {
    process.env.REVERIE_SESSION_ID = 'room-session-secret';
    process.env.REVERIE_HOOK_SECRET_FILE = '/secret';
    const { calls, runner } = recorder();
    const tools = createMemoryTools(ON, runner);
    const result = await tools.run('memory_recall', { query: '  baseline numbers ' });
    expect(result).toEqual({ text: '[{"text":"a memory"}]' });
    expect(calls[0].python).toBe('/py/python3');
    expect(calls[0].args).toEqual(['-m', 'reverie.memory_cli']);
    expect(JSON.parse(calls[0].input)).toEqual({ action: 'recall', query: 'baseline numbers', private: true });
    expect(calls[0].env.REVERIE_INSTANCE_CONFIG).toBe(ON.instance);
    expect(calls[0].env.PYTHONPATH).toBe('/src/python');
    expect(calls[0].env.REVERIE_SESSION_ID).toBeUndefined();
    expect(calls[0].env.REVERIE_HOOK_SECRET_FILE).toBeUndefined();
    await tools.run('memory_recall', { query: 'q', project: 'slam-web' });
    expect(JSON.parse(calls[1].input)).toEqual({ action: 'recall', query: 'q', project: 'slam-web' });
  });

  it('never lets an argument choose another store', async () => {
    const { calls, runner } = recorder();
    await createMemoryTools(ON, runner).run('memory_recall', {
      query: 'q', instance: '/other.json', channel: 'work', private: false, data_dir: '/x',
    } as Record<string, unknown>);
    expect(calls[0].env.REVERIE_INSTANCE_CONFIG).toBe(ON.instance);
    expect(JSON.parse(calls[0].input)).toEqual({ action: 'recall', query: 'q', private: true });   // stray keys stripped
  });

  it('refuses to remember outside a session, showing the journal command and calling nothing', async () => {
    const { calls, runner } = recorder();
    const result = await createMemoryTools(ON, runner).run('memory_remember', {
      text: "The baseline is 305/566; don't drop it.", room: 'r-1', turn: 'm-1', tag: 'lesson', quote: '305/566', project: 'rumoca' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not running inside one. Nothing was saved.');
    expect(result.text).toContain(
      `run: reverie agent journal save --room r-1 --turn m-1 --text 'The baseline is 305/566; don'\\''t drop it.' --tag lesson --source m-1 --quote 305/566 --project rumoca`);
    expect(calls).toEqual([]);
  });

  it('refuses bad arguments as isError results without calling the bridge', async () => {
    const { calls, runner } = recorder();
    const tools = createMemoryTools(ON, runner);
    for (const [name, args] of [
      ['memory_recall', {}],
      ['memory_recall', { query: '   ' }],
      ['memory_recall', { query: 'x'.repeat(501) }],
      ['memory_recall', { query: 'q', project: '../escape' }],
      ['memory_recall', { query: 'q', project: 'Mixed.Case' }],
      ['memory_remember', { text: '' }],
      ['memory_remember', { text: 'x'.repeat(2001) }],
    ] as const) {
      expect((await tools.run(name, args as Record<string, unknown>)).isError, JSON.stringify(args)).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it('never echoes a filesystem path in an error, even the caller\'s own', async () => {
    const tools = createMemoryTools(ON, recorder({ code: 1, stderr: '{"error": "[Errno 13] Permission denied: \'/instances/x/memory/agents/a/memory.sqlite\'"}' }).runner);
    const result = await tools.run('memory_recall', { query: 'q' });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('/instances');
    expect(result.text).toContain('Permission denied');
  });

  it('turns a bridge failure into a readable isError result', async () => {
    const tools = createMemoryTools(ON, recorder({ code: 1, stderr: '{"error": "private recall is unavailable in a shared work channel"}' }).runner);
    const result = await tools.run('memory_recall', { query: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Memory lookup failed: private recall is unavailable in a shared work channel');
  });

  it('answers through tools/call as text content', async () => {
    const { out, send } = server(ON, recorder().runner);
    await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'q' } } });
    expect(out[0].result).toMatchObject({ content: [{ type: 'text', text: '[{"text":"a memory"}]' }], isError: false });
  });
});

describe('inside a Reverie session: the office journal', () => {
  const MINE = 'sess-mine-0001';
  function journalServer(bridge: { stdout?: string; stderr?: string; code?: number }, reply: Record<string, unknown>, session: 'mine' | 'none' = 'mine') {
    const selfId = session === 'mine' ? MINE : undefined;
    const out: Array<Record<string, unknown>> = [];
    const requests: Array<{ selfId: string; method?: string; path: string; body?: unknown; query?: unknown }> = [];
    const { calls, runner } = recorder(bridge);
    const srv = createMcpServer({
      config: { ...mcpConfig, apiUrl: 'http://office.test', selfId },
      write: (m) => out.push(m), modes: ['shell'], memory: ON, memoryRunner: runner,
      request: async (ctx, options) => {
        requests.push({ selfId: ctx.selfId, method: options.method, path: options.path, body: options.body, query: options.query });
        return { status: 200, json: { success: true, data: reply } as never, text: '' };
      },
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      out.length = 0;
      await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
      const result = out[0].result as { content: Array<{ text: string }>; isError: boolean };
      return { text: result.content[0].text, isError: result.isError };
    };
    return { call, calls, requests };
  }
  const SAVE = { text: 'The baseline is 305/566.', room: 'r-1', turn: 'm-1', tag: 'lesson', quote: '305/566', source: 'commit abc123' };

  it("saves to the calling session's own journal, screened by the hard floors first, with the caller's room and turn", async () => {
    const s = journalServer({ stdout: '{"floor":""}' }, { entryId: 5, turnId: 'm-1', replayed: false, payloadSha256: 'ab' });
    const result = await s.call('memory_remember', SAVE);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ entryId: 5, turnId: 'm-1' });
    expect(s.calls.map((c) => JSON.parse(c.input))).toEqual([{ action: 'screen', text: 'The baseline is 305/566.' }]);
    expect(s.calls[0].env.REVERIE_SESSION_ID).toBeUndefined(); // the bridge env stays stripped
    expect(s.requests).toEqual([{ selfId: MINE, method: 'POST', path: '/api/agent/journal/save', query: undefined, body: {
      roomId: 'r-1', turnId: 'm-1', draft: { text: 'The baseline is 305/566.', tags: ['lesson'],
        sources: [{ roomId: 'r-1', id: 'm-1', quote: '305/566' }, { ref: 'commit abc123' }] } } }]);
  });

  it('refuses without a session, and never guesses a missing room or turn', async () => {
    const outside = journalServer({ stdout: '{"floor":""}' }, {}, 'none');
    const outsideResult = await outside.call('memory_remember', SAVE);
    expect(outsideResult.isError).toBe(true);
    expect(outsideResult.text).toContain('not running inside one. Nothing was saved.');
    const inside = journalServer({ stdout: '{"floor":""}' }, {});
    for (const drop of ['turn', 'room', 'tag'] as const) {
      const { [drop]: _gone, ...rest } = SAVE;
      const result = await inside.call('memory_remember', rest);
      expect(result.isError, drop).toBe(true);
      expect(result.text).toContain('Nothing was saved. To save it to your journal, run: reverie agent journal save');
    }
    const noSource = await inside.call('memory_remember', { ...SAVE, quote: undefined, source: undefined });
    expect(noSource.text).toContain('needs quote or source');
    for (const s of [outside, inside]) expect([s.calls, s.requests]).toEqual([[], []]);
  });

  it('saves nothing when a hard floor is crossed or the check did not run', async () => {
    for (const bridge of [{ stdout: '{"floor":"configured output policy"}' }, { code: 1, stderr: 'boom' }, { stdout: 'not json' }]) {
      const s = journalServer(bridge, {});
      const result = await s.call('memory_remember', SAVE);
      expect(result.isError, JSON.stringify(bridge)).toBe(true);
      expect(result.text).toMatch(/hard floor|did not run/);
      expect(s.requests).toEqual([]);
    }
  });

  it('recalls from the journal as this session, with the old store as labelled read-only history', async () => {
    const s = journalServer({ stdout: '[{"text":"an old reflection"}]' }, { entries: [{ entryId: 3, text: 'baseline' }] });
    const result = await s.call('memory_recall', { query: 'baseline', project: 'rumoca' });
    expect(JSON.parse(result.text)).toEqual({ journal: [{ entryId: 3, text: 'baseline' }], legacy: [{ text: 'an old reflection' }],
      note: 'journal entries are your store of record; legacy results are older, read-only history' });
    expect(s.requests).toEqual([{ selfId: MINE, method: 'GET', path: '/api/agent/journal/recall', body: undefined,
      query: { q: 'baseline', roomId: undefined, project: 'rumoca' } }]);
  });
});
