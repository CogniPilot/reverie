/**
 * `reverie board track …`: what each verb sends, the body digest computed from --body-file, refusals before any request,
 * and `applied` exiting 4 when the body is not the one a current text GO approved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardTrackApplied, boardTrackGate, boardTrackHead, boardTrackReview } from '../src/cli-board.js';
import { EXIT, type AgentDeps, type RequestOptions } from '../src/cli-agent.js';

const HEAD = 'a'.repeat(40);
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'cli-track-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deps(approved = true) {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const d: AgentDeps = {
    ctx: { apiUrl: 'http://127.0.0.1:3000', selfId: '0000002d-0035-4000-8000-000000000047' },
    json: false,
    io: { out: (m: string) => void out.push(m), err: (m: string) => void err.push(m) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.path === '/api/v1/chatrooms')
        return { status: 200, text: '', json: { success: true, data: { rooms: [{ id: 'room-1', name: 'Work', members: [] }] } } };
      const track = {
        heads: [{ sha: HEAD, at: 1, by: 'Author', gates: [] }],
        reviews: [],
        applied: [{ head: HEAD, bodySha256: '1'.repeat(64), approved, at: 2, by: 'Lead' }],
      };
      return { status: 200, text: '', json: { success: true, data: { rev: 7, item: { id: 'i-1', track } } } };
    },
  };
  return { d, calls, out, err };
}

describe('board track', () => {
  it('passes a late write refusal through as an error', async () => {
    const { d, err } = deps();
    d.request = async () => ({
      status: 409,
      text: '',
      json: { success: false, error: `The latest head is ${'b'.repeat(40)}, not ${HEAD}; checking a gate is for an older head` },
    });
    expect(await boardTrackGate(d, { id: 'i-1', head: HEAD, name: 'nix', state: 'covered' })).toBe(EXIT.error);
    expect(err.join('\n')).toContain('older head');
  });

  it('a text review sends the sha256 of --body-file and the resolved --from room', async () => {
    const file = join(dir, 'PR-BODY.md');
    writeFileSync(file, '## Branch Naming\n\n`feature`\n');
    const { d, calls } = deps();
    expect(
      await boardTrackReview(d, { id: 'i-1', head: HEAD, kind: 'text', verdict: 'go', bodyFile: file, from: 'Work:m-9' })
    ).toBe(EXIT.ok);
    expect(calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/board/issues/i-1/track',
      body: {
        op: 'review',
        head: HEAD,
        kind: 'text',
        verdict: 'GO',
        bodySha256: createHash('sha256').update('## Branch Naming\n\n`feature`\n').digest('hex'),
        source: { roomId: 'room-1', messageId: 'm-9' },
      },
    });
  });

  it('refuses before any request: a text review with no body, a source review with one, bad kind, verdict or state', async () => {
    for (const run of [
      (d: AgentDeps) => boardTrackReview(d, { id: 'i-1', head: HEAD, kind: 'text', verdict: 'GO' }),
      (d: AgentDeps) => boardTrackReview(d, { id: 'i-1', head: HEAD, kind: 'source', verdict: 'GO', bodySha: '1'.repeat(64) }),
      (d: AgentDeps) => boardTrackReview(d, { id: 'i-1', head: HEAD, kind: 'style', verdict: 'GO' }),
      (d: AgentDeps) => boardTrackReview(d, { id: 'i-1', head: HEAD, kind: 'source', verdict: 'maybe' }),
      (d: AgentDeps) => boardTrackApplied(d, { id: 'i-1', head: HEAD, bodySha: 'abc' }),
      (d: AgentDeps) => boardTrackApplied(d, { id: 'i-1', head: HEAD, bodySha: '1'.repeat(64), bodyFile: 'x' }),
      (d: AgentDeps) => boardTrackGate(d, { id: 'i-1', head: HEAD, name: 'nix', state: 'done' }),
    ]) {
      const { d, calls } = deps();
      expect(await run(d)).toBe(EXIT.error);
      expect(calls).toHaveLength(0);
    }
  });

  it('applied exits 4 when the body is not the approved one, 0 when it is', async () => {
    const unapproved = deps(false);
    expect(await boardTrackApplied(unapproved.d, { id: 'i-1', head: HEAD, bodySha: '1'.repeat(64) })).toBe(EXIT.refused);
    expect(unapproved.err.join('\n')).toContain('is not the body a current text GO approved');
    const approved = deps(true);
    expect(await boardTrackApplied(approved.d, { id: 'i-1', head: HEAD, bodySha: '1'.repeat(64) })).toBe(EXIT.ok);
    expect(approved.out).toContain('  body applied 11111111: approved when applied');
    expect(approved.calls.at(-1)!.body).toEqual({ op: 'applied', head: HEAD, bodySha256: '1'.repeat(64) });
  });

  it('head and gate send their fields', async () => {
    const { d, calls } = deps();
    expect(await boardTrackHead(d, { id: 'i-1', sha: HEAD.toUpperCase(), branch: 'feature' })).toBe(EXIT.ok);
    expect(calls.at(-1)!.body).toEqual({ op: 'head', sha: HEAD, branch: 'feature' });
    expect(
      await boardTrackGate(d, { id: 'i-1', head: HEAD.toUpperCase(), name: 'nix test registration', state: 'covered', note: 'green' })
    ).toBe(EXIT.ok);
    expect(calls.at(-1)!.body).toEqual({ op: 'gate', head: HEAD, name: 'nix test registration', state: 'covered', note: 'green' });
  });
});
