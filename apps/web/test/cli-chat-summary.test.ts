import { describe, expect, it } from 'vitest';
import { agentChatSummary, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';
function client(data: unknown, success = true) {
  const out: string[] = [],
    err: string[] = [],
    calls: RequestOptions[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://fixture', selfId: '11111111-1111-4111-8111-111111111111' },
    json: false,
    io: { out: (text) => out.push(text), err: (text) => err.push(text) },
    request: async (_ctx, req) => {
      calls.push(req);
      return { status: success ? 200 : 503, text: '', json: { success, data } };
    },
  };
  return { deps, out, err, calls };
}
describe('read-only summary client', () => {
  it('fetches own bounded summary and prints model context without API envelope', async () => {
    const c = client({ text: 'pending excerpt', total: 1 });
    expect(await agentChatSummary(c.deps, 'UserPromptSubmit')).toBe(0);
    expect(c.calls).toEqual([{ method: 'GET', path: '/api/chatrooms/turn-summary', timeoutMs: 2000 }]);
    expect(JSON.parse(c.out[0])).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'pending excerpt' },
    });
  });
  it('returns empty hook context so the adapter can clear a previously shown snapshot', async () => {
    const c = client({ text: '' });
    expect(await agentChatSummary(c.deps, 'PostToolUse')).toBe(0);
    expect(JSON.parse(c.out[0]).hookSpecificOutput.additionalContext).toBe('');
  });
  it.each([undefined, { text: 'x'.repeat(3001) }, { text: 3 }])(
    'refuses malformed or over-budget data: %s',
    async (data) => {
      const c = client(data);
      expect(await agentChatSummary(c.deps, 'SessionStart')).not.toBe(0);
      expect(c.out).toEqual([]);
    }
  );
  it('does not turn an unavailable endpoint into no-pending context', async () => {
    const c = client({ text: '' }, false);
    expect(await agentChatSummary(c.deps, 'PostToolUse')).not.toBe(0);
    expect(c.out).toEqual([]);
  });
  it('rejects unsupported names before requesting and supports Admin JSON', async () => {
    const c = client({ text: 'pending', phoneMode: 'silent', total: 1 });
    expect(await agentChatSummary(c.deps, 'Stop')).not.toBe(0);
    expect(c.calls).toHaveLength(0);
    c.deps.json = true;
    expect(await agentChatSummary(c.deps)).toBe(0);
    expect(JSON.parse(c.out[0])).toEqual({ text: 'pending', phoneMode: 'silent', total: 1 });
  });
});
