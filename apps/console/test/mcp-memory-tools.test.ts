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

const ON: MemoryToolsConfig = { instance: '/instances/x/config/experts/a.json', python: '/py/python3', source: '/src' };

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
  delete process.env.CODEMAN_SESSION_ID;
  delete process.env.CODEMAN_HOOK_SECRET_FILE;
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
    process.env.CODEMAN_SESSION_ID = 'room-session-secret';
    process.env.CODEMAN_HOOK_SECRET_FILE = '/secret';
    const { calls, runner } = recorder();
    const tools = createMemoryTools(ON, runner);
    const result = await tools.run('memory_recall', { query: '  baseline numbers ' });
    expect(result).toEqual({ text: '[{"text":"a memory"}]' });
    expect(calls[0].python).toBe('/py/python3');
    expect(calls[0].args).toEqual(['-m', 'cto.memory_cli']);
    expect(JSON.parse(calls[0].input)).toEqual({ action: 'recall', query: 'baseline numbers', private: true });
    expect(calls[0].env.FLEET_INSTANCE_CONFIG).toBe(ON.instance);
    expect(calls[0].env.PYTHONPATH).toBe('/src');
    expect(Object.keys(calls[0].env).filter((k) => k.startsWith('CODEMAN_'))).toEqual([]);   // no room credentials
    await tools.run('memory_recall', { query: 'q', project: 'web-app' });
    expect(JSON.parse(calls[1].input)).toEqual({ action: 'recall', query: 'q', project: 'web-app' });
  });

  it('never lets an argument choose another store', async () => {
    const { calls, runner } = recorder();
    await createMemoryTools(ON, runner).run('memory_recall', {
      query: 'q', instance: '/other.json', channel: 'work', private: false, data_dir: '/x',
    } as Record<string, unknown>);
    expect(calls[0].env.FLEET_INSTANCE_CONFIG).toBe(ON.instance);
    expect(JSON.parse(calls[0].input)).toEqual({ action: 'recall', query: 'q', private: true });   // stray keys stripped
  });

  it('saves privately, or to a project only with a verification source', async () => {
    const { calls, runner } = recorder({ stdout: '{"id":7}' });
    const tools = createMemoryTools(ON, runner);
    expect(await tools.run('memory_remember', { text: 'The baseline is 305/566.' })).toEqual({ text: '{"id":7}' });
    expect(JSON.parse(calls[0].input)).toEqual({ action: 'remember', text: 'The baseline is 305/566.', private: true });
    const missing = await tools.run('memory_remember', { text: 'x', project: 'p' });
    expect(missing.isError).toBe(true);
    expect(calls).toHaveLength(1);                                                       // refused before the bridge
    await tools.run('memory_remember', { text: 'x', project: 'p', source: 'commit abc123' });
    expect(JSON.parse(calls[1].input)).toEqual({ action: 'remember', text: 'x', project: 'p', source: 'commit abc123' });
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
    const tools = createMemoryTools(ON, recorder({ code: 1, stderr: '{"error": "memory is empty or crossed a hard floor"}' }).runner);
    const result = await tools.run('memory_remember', { text: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Memory save failed: memory is empty or crossed a hard floor');
  });

  it('answers through tools/call as text content', async () => {
    const { out, send } = server(ON, recorder().runner);
    await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'q' } } });
    expect(out[0].result).toMatchObject({ content: [{ type: 'text', text: '[{"text":"a memory"}]' }], isError: false });
  });
});
