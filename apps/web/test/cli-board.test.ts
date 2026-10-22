/**
 * `reverie board …` against a fake server: names become member ids, wall times become ms in the board's zone, tags are
 * sent whole with the rev they were read at, and --from resolves the room.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import { boardIssueAdd, boardIssueMove, boardIssueTag, boardScheduleSet, memberRef, wallTime } from '../src/cli-board.js';

const board = {
  rev: 7,
  timeZone: 'America/New_York',
  roster: [
    { id: 'e-builder', name: 'Builder', state: 'idle', coordinator: false },
    { id: 'e-reviewer', name: 'Reviewer', state: 'idle', coordinator: true },
  ],
  issues: [{ id: 'i-1', title: 't', tags: ['a'], status: 'todo', links: [], scale: 'day', createdAt: 0, updatedAt: 0 }],
};

function fake() {
  const calls: RequestOptions[] = [];
  const out: string[] = [];
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://x', selfId: 'self' },
    json: true,
    io: { out: (l) => out.push(l), err: (l) => out.push(l) },
    request: async (_ctx, options) => {
      calls.push(options);
      if (options.path === '/api/board') return { status: 200, text: '', json: { success: true, data: board } };
      if (options.path === '/api/v1/chatrooms') {
        return { status: 200, text: '', json: { success: true, data: { rooms: [{ id: '08dfd0fa-1111', name: 'reverie', dm: [] }] } } };
      }
      return { status: 200, text: '', json: { success: true, data: { rev: 8, item: { id: 'i-2', ...(options.body ?? {}) } } } };
    },
  };
  return { deps, calls, out };
}

describe('reverie board', () => {
  it('issue add resolves owner, times and --from', async () => {
    const { deps, calls } = fake();
    const code = await boardIssueAdd(deps, { title: 'Suite', owner: 'builder', start: '2026-10-17T14:00', end: '2026-10-18', tag: ['x'], from: 'reverie:m42' });
    expect(code).toBe(0);
    const write = calls.find((c) => c.path === '/api/board/issues');
    expect(write?.body).toEqual({
      title: 'Suite',
      owner: 'e-builder',
      tags: ['x'],
      start: Date.UTC(2026, 9, 17, 18),
      end: Date.UTC(2026, 9, 19, 2),
      source: { roomId: '08dfd0fa-1111', messageId: 'm42' },
    });
  });

  it('refuses an unknown owner and a bad status before writing', async () => {
    const { deps, calls } = fake();
    expect(await boardIssueAdd(deps, { title: 't', owner: 'nobody' })).not.toBe(0);
    expect(await boardIssueMove(deps, { id: 'i-1', status: 'finished' })).not.toBe(0);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('move sends PATCH with the reason', async () => {
    const { deps, calls } = fake();
    await boardIssueMove(deps, { id: 'i-1', status: 'wontdo', reason: 'dup' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/board/issues/i-1', body: { status: 'wontdo', reason: 'dup' } });
  });

  it('tag merges and sends the rev it read', async () => {
    const { deps, calls } = fake();
    await boardIssueTag(deps, { id: 'i-1', tags: ['b', 'a'] });
    expect(calls[1]).toMatchObject({ method: 'PATCH', body: { tags: ['a', 'b'], ifRev: 7 } });
    await boardIssueTag(deps, { id: 'i-1', tags: ['a'], remove: true });
    expect(calls[3].body).toEqual({ tags: [], ifRev: 7 });
  });

  it('schedule set posts the file as an import', async () => {
    const { deps, calls } = fake();
    const file = join(mkdtempSync(join(tmpdir(), 'cli-board-')), 'schedule-data.json');
    writeFileSync(file, JSON.stringify({ today: { date: '2026-10-17' } }));
    expect(await boardScheduleSet(deps, { file, dryRun: true })).toBe(0);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/board/import', body: { schedule: { today: { date: '2026-10-17' } }, dryRun: true } });
  });

  it('helpers', () => {
    expect(memberRef(board as never, 'e-reviewer')).toBe('e-reviewer');
    expect(wallTime('2026-10-17', 'start', 'America/New_York')).toBe(Date.UTC(2026, 9, 17, 11));
  });
});
