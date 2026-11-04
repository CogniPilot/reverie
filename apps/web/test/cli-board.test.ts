/**
 * `reverie board …` against a fake server: names become member ids, wall times become ms in the board's zone, tags are
 * sent whole with the rev they were read at, and --from resolves the room.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';
import { Command } from 'commander';
import { boardDecisionWrite, boardIssueAdd, boardIssueMove, boardIssueSet, boardIssueShow, boardIssueTag, boardScheduleSet, boardShow, memberRef, registerBoardCommands, wallTime } from '../src/cli-board.js';

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
      if (options.path === '/api/board/issues') return { status: 200, text: '', json: { success: true, data: { rev: 7, issues: board.issues } } };
      if (options.path === '/api/v1/chatrooms') {
        return { status: 200, text: '', json: { success: true, data: { rooms: [{ id: '08dfd0fa-1111', name: 'reverie', dm: [] }] } } };
      }
      return { status: 200, text: '', json: { success: true, data: { rev: 8, item: { id: 'i-2', ...(options.body ?? {}) } } } };
    },
  };
  return { deps, calls, out };
}

describe('reverie board', () => {
  it('reads only the exact complete issue and revision, without requesting the full Board', async () => {
    const f=fake(), item={...board.issues[0],reason:'original reason',source:{roomId:'office',messageId:'message-1'},start:100,end:200};
    f.deps.request=async(_ctx,request)=>{
      f.calls.push(request);
      if(request.path!=='/api/board/issues/i-1') throw new Error('Full Board must not be fetched');
      return {status:200,text:'',json:{success:true,data:{rev:7,item}}};
    };
    expect(await boardIssueShow(f.deps,'i-1')).toBe(0);
    expect(f.calls).toEqual([{method:'GET',path:'/api/board/issues/i-1',bounds:{maxBytes:4*1024*1024,deadlineMs:10000}}]);
    expect(JSON.parse(f.out[0])).toEqual({rev:7,item});
    f.deps.json=false;await boardIssueShow(f.deps,'i-1');expect(f.out.at(-1)).toContain('original reason');
  });
  it('registers exact issue show under both issue and card command paths', () => {
    const program=new Command().exitOverride(), boardCommand=registerBoardCommands(program);
    const issue=boardCommand.commands.find(command=>command.name()==='issue')!;
    expect(issue.aliases()).toContain('card');
    const show=issue.commands.find(command=>command.name()==='show')!;
    let seen:unknown;show.action((id:string,options:unknown)=>{seen={id,options};});
    program.parse(['board','card','show','i-1','--json'],{from:'user'});
    expect(seen).toMatchObject({id:'i-1',options:{json:true}});
  });
  it('rejects invalid ids before any request and refuses mismatched or malformed cards', async () => {
    const f=fake();
    for(const id of ['','i/1','../i-1','a'.repeat(65)]) expect(await boardIssueShow(f.deps,id)).not.toBe(0);
    expect(f.calls).toEqual([]);
    for(const data of [{rev:7,item:{...board.issues[0],id:'i-other'}},{rev:-1,item:board.issues[0]},{rev:7,item:{id:'i-1'}}]) {
      f.deps.request=async()=>({status:200,text:'',json:{success:true,data}});
      expect(await boardIssueShow(f.deps,'i-1')).not.toBe(0);
    }
    f.deps.request=async()=>({status:404,text:'',json:{success:false,error:'No issue i-1'}});
    expect(await boardIssueShow(f.deps,'i-1')).not.toBe(0);
    expect(f.out.at(-1)).toContain('No issue i-1');
  });
  it('decision choices and a named recommendation become structured fields, never question prose', async () => {
    const f = fake();
    expect(await boardDecisionWrite(f.deps, { id: 'snapshot', text: 'Publish?', option: ['Approve', 'Hold'], recommend: 'approve', reason: 'Checks passed' })).toBe(0);
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/api/board/decisions', body: { id: 'snapshot', text: 'Publish?', options: ['Approve', 'Hold'], recommendation: { option: 'Approve', reason: 'Checks passed' } } });
    expect(await boardDecisionWrite(f.deps, { id: 'snapshot', option: ['Approve', 'Hold'] }, true)).toBe(0);
    expect(f.calls[1]).toMatchObject({ method: 'PATCH', path: '/api/board/decisions/snapshot', body: { options: ['Approve', 'Hold'] } });
  });

  it('missing, repeated or invalid decision options fail with helpful guidance before a request', async () => {
    const f = fake();
    for (const input of [{}, { option: ['Approve'] }, { option: ['Approve', 'approve'] }, { option: ['Yes', 'No'], recommend: 'Maybe' }])
      expect(await boardDecisionWrite(f.deps, { text: 'Question', ...input })).not.toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.out.join('\n')).toContain('--option');
  });
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

  it('move distinguishes an omitted reason from explicit empty clearing', async () => {
    const { deps, calls } = fake();
    await boardIssueMove(deps, { id: 'i-1', status: 'doing' });
    expect(calls[0].body).toEqual({ status: 'doing' });
    await boardIssueMove(deps, { id: 'i-1', status: 'doing', reason: '' });
    expect(calls[1].body).toEqual({ status: 'doing', reason: '' });
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

  it('show without a filter is unchanged: one GET /api/board, the whole view as JSON', async () => {
    const f = fake();
    expect(await boardShow(f.deps)).toBe(0);
    expect(await boardShow(f.deps, {})).toBe(0);
    expect(f.calls).toEqual([{ method: 'GET', path: '/api/board' }, { method: 'GET', path: '/api/board' }]);
    expect(JSON.parse(f.out[0])).toEqual(board);
  });

  it('show with filters asks the server once and never fetches the whole board', async () => {
    const f = fake();
    expect(await boardShow(f.deps, { mine: true, owner: ['Kai'], status: ['doing,todo', 'blocked'], tag: ['slam'], fields: 'id,title' })).toBe(0);
    expect(f.calls).toEqual([{
      method: 'GET',
      path: '/api/board/issues',
      query: { mine: true, owner: 'Kai', status: 'doing,todo,blocked', tag: 'slam', fields: 'id,title' },
    }]);
    expect(JSON.parse(f.out[0])).toEqual({ rev: 7, issues: board.issues });
  });

  it('show refuses a bad status, and --fields without --json, before any request', async () => {
    const f = fake();
    expect(await boardShow(f.deps, { status: ['doing', 'finished'] })).not.toBe(0);
    f.deps.json = false;
    expect(await boardShow(f.deps, { mine: true, fields: 'id' })).not.toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.out.join('\n')).toContain('--json');
  });

  it('an explicitly empty --fields is refused before any request, with or without --json; never the whole board', async () => {
    for (const json of [true, false]) {
      for (const fields of ['', ' ', ',', ' , ']) {
        for (const options of [{ fields }, { mine: true, fields }]) {
          const f = fake();
          f.deps.json = json;
          expect(await boardShow(f.deps, options), JSON.stringify({ json, options })).not.toBe(0);
          expect(f.calls, JSON.stringify({ json, options })).toEqual([]);
          expect(f.out.join('\n')).toContain('--fields needs at least one field name');
        }
      }
    }
    // Absent is not empty: the unfiltered path is unchanged.
    const f = fake();
    expect(await boardShow(f.deps, { fields: undefined })).toBe(0);
    expect(f.calls).toEqual([{ method: 'GET', path: '/api/board' }]);
  });

  it('the real `board show` parser hands an empty --fields through as given, not as absent', () => {
    // A fresh program per parse: commander keeps option values between parses of one instance.
    const parsed = (args: string[]) => {
      const program = new Command().exitOverride();
      const show = registerBoardCommands(program).commands.find((c) => c.name() === 'show')!;
      let seen: Record<string, unknown> | undefined;
      show.action((o: Record<string, unknown>) => { seen = o; });
      program.parse(['board', 'show', ...args], { from: 'user' });
      return seen;
    };
    expect(parsed(['--fields', '', '--json'])).toMatchObject({ fields: '', json: true });
    expect(parsed([])?.fields).toBeUndefined();
  });

  it('filtered text output is one line per matching issue', async () => {
    const f = fake();
    f.deps.json = false;
    expect(await boardShow(f.deps, { tag: ['a'] })).toBe(0);
    expect(f.out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))).toEqual(['Board rev 7 · 1 issue', '  i-1  todo  t  · -  [a]']);
  });

  it('helpers', () => {
    expect(memberRef(board as never, 'e-reviewer')).toBe('e-reviewer');
    expect(wallTime('2026-10-17', 'start', 'America/New_York')).toBe(Date.UTC(2026, 9, 17, 11));
  });
});

describe('board issue set', () => {
  it('sends one PATCH with exactly the given fields, names and times resolved', async () => {
    const { deps, calls } = fake();
    expect(await boardIssueSet(deps, { id: 'i-1', status: 'doing', reason: 'resumed', owner: 'Builder', end: '2026-11-03T04:15' })).toBe(0);
    const writes = calls.filter((c) => c.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/api/board/issues/i-1');
    expect(writes[0].body).toEqual({ status: 'doing', reason: 'resumed', owner: 'e-builder', end: wallTime('2026-11-03T04:15', 'end', board.timeZone) });
  });

  it('reads the board only when a name or a time needs it', async () => {
    const { deps, calls } = fake();
    expect(await boardIssueSet(deps, { id: 'i-1', reason: '' })).toBe(0);
    expect(calls.map((c) => [c.method, c.path])).toEqual([['PATCH', '/api/board/issues/i-1']]);
    expect(calls[0].body).toEqual({ reason: '' });
  });

  it('refuses nothing to change, a bad status and an over-long title before any request', async () => {
    for (const options of [{ id: 'i-1' }, { id: 'i-1', status: 'in_progress' }, { id: 'i-1', title: 'x'.repeat(301) }]) {
      const { deps, calls, out } = fake();
      expect(await boardIssueSet(deps, options), JSON.stringify(options).slice(0, 60)).not.toBe(0);
      expect(calls).toHaveLength(0);
      expect(out.join('\n')).toMatch(/at least one|status is one of|301 characters/);
    }
  });

  it('refuses an over-long title on add as well, saying how long it is', async () => {
    const { deps, calls, out } = fake();
    expect(await boardIssueAdd(deps, { title: 'y'.repeat(320) })).not.toBe(0);
    expect(calls).toHaveLength(0);
    expect(out.join('\n')).toContain('320 characters; the board keeps at most 300');
  });
});
