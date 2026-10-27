import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanMoves, type PlanMovePort, type PlanMoveInput, type PlanMoveRecord } from '../src/plan-move.js';
import { PlanMoveStore } from '../src/plan-move-store.js';

const intent = () => ({ operationId: '11111111-1111-4111-8111-111111111111',
  reservationId: '22222222-2222-4222-8222-222222222222', profileVersion: '18446744073709551615',
  profileDigest: 'b'.repeat(64), previewDigest: 'c'.repeat(64) });
const input = (): PlanMoveInput => ({ id: 'resource-move', employeeId: 'employee', sessionId: 'old',
  fromAccount: 'account', toAccount: 'account', forceBusy: false, handoff: 'Durable checkpoint',
  purpose: 'runtime-refresh', runtimeDigest: 'a'.repeat(64), resourceIntent: intent() });
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };

function fixture(initial: PlanMoveRecord[] = []) {
  let saved = structuredClone(initial), current = 'old';
  const sessions = new Set(['old']), events: string[] = [];
  const port: PlanMovePort = {
    load: async () => structuredClone(saved),
    save: async records => { saved = structuredClone(records); },
    snapshot: async () => ({ sessionId: 'old', account: 'account', name: 'Employee', working: false,
      mode: 'codex', runtimeDigest: 'a'.repeat(64) }),
    idle: async () => {}, create: async () => { events.push('metadata'); sessions.add('new'); current = 'new'; return 'new'; },
    prepareResources: async record => {
      events.push('prepare'); expect(saved[0]).toMatchObject({ newSession: 'new', resourcePhase: 'preparing', resourceIntent: intent() });
      expect(record).toMatchObject(saved[0]); expect(sessions.has('old')).toBe(true);
    },
    beforeStop: async () => {},
    binding: () => current, exists: sid => sessions.has(sid),
    rebind: async (_eid, sid) => { events.push('rebind'); current = sid; },
    stop: async sid => { events.push('stop:' + sid); sessions.delete(sid); return []; },
    start: async () => { events.push('start'); }, ready: async () => { events.push('ready'); },
    verifyResources: async record => { events.push('verify'); expect(record.sourceCleanupVerified).toBe(true); return () => { events.push('fence'); }; },
    audit: async record => { events.push('audit:' + record.phase); },
  };
  return { port, events, sessions, saved: () => saved, moves: new PlanMoves(port) };
}

it.each(['prepareResources', 'verifyResources'] as const)('refuses the missing fixed %s port before creating metadata', async missing => {
  const h = fixture(); delete h.port[missing];
  await expect(h.moves.begin(input(), 'owner')).rejects.toMatchObject({ status: 503 });
  expect(h.events).toEqual([]); expect(h.saved()).toEqual([]);
});

it('persists candidate SID and preparation intent before resource effects, and verifies the replacement before completion', async () => {
  const h = fixture(); await h.moves.begin(input(), 'owner'); await flush();
  expect(h.events).toEqual(['metadata', 'prepare', 'audit:stopping', 'stop:old', 'start', 'ready', 'verify', 'fence', 'fence', 'audit:completed', 'fence']);
  expect(h.saved()[0]).toMatchObject({ newSession: 'new', resourcePhase: 'verified', phase: 'completed' });
  expect(await h.moves.get('resource-move', 'other-owner')).toBeUndefined();
});

it.each(['reserved-save', 'preparing-save', 'prepare', 'prepared-save', 'stopping-save', 'verify', 'missing-fence', 'fence', 'completed-save', 'completed-audit'])
('retains recovery and the employee fence on %s uncertainty, with no generic pre-stop rollback', async fault => {
  const h = fixture(); let fired = false;
  const save = h.port.save;
  h.port.save = async rows => {
    await save(rows); // A lost ACK can occur after the durable write.
    const row = rows[0];
    if (!fired && ((fault === 'reserved-save' && row.resourcePhase === 'reserved') ||
      (fault === 'preparing-save' && row.resourcePhase === 'preparing') ||
      (fault === 'prepared-save' && row.resourcePhase === 'prepared') ||
      (fault === 'stopping-save' && row.phase === 'stopping') ||
      (fault === 'completed-save' && row.phase === 'completed'))) { fired = true; throw Error('lost save ACK'); }
  };
  if (fault === 'prepare') h.port.prepareResources = async () => { throw Error('lost config/reload ACK'); };
  if (fault === 'verify') h.port.verifyResources = async () => { throw Error('native readback unavailable'); };
  if (fault === 'missing-fence') h.port.verifyResources = async () => undefined as never;
  if (fault === 'fence') h.port.verifyResources = async () => () => { throw Error('identity drift'); };
  if (fault === 'completed-audit') h.port.audit = async row => { if (row.phase === 'completed') throw Error('audit unavailable'); };
  await h.moves.begin(input(), 'owner'); await flush();
  expect((await h.moves.get('resource-move', 'owner'))?.phase).toBe('recovery-required');
  expect(h.events).not.toContain('rebind');
  if (['reserved-save', 'preparing-save', 'prepare', 'prepared-save'].includes(fault)) {
    expect(h.events).not.toContain('stop:old'); expect(h.events).not.toContain('stop:new'); expect(h.events).not.toContain('start');
  }
  await expect(h.moves.begin({ ...input(), id: 'unsafe-retry' }, 'owner')).rejects.toThrow('requiring recovery');
});

it('retains the lock and durable recovery intent when the first journal ACK is lost', async () => {
  const h = fixture(); const save = h.port.save; let first = true;
  h.port.save = async rows => { await save(rows); if (first) { first = false; throw Error('initial ACK lost'); } };
  await expect(h.moves.begin(input(), 'owner')).rejects.toThrow('initial ACK lost');
  expect(h.events).toEqual([]); expect(h.saved()[0].phase).toBe('recovery-required');
  await expect(h.moves.begin({ ...input(), id: 'retry' }, 'owner')).rejects.toThrow('requiring recovery');
});

it.each(['approval', 'binding'] as const)('refuses %s drift before resource preparation and retains recovery', async fault => {
  const h = fixture();
  if (fault === 'approval') h.port.beforeStop = async () => { throw Error('approval revoked'); };
  else h.port.binding = () => 'other-session';
  await h.moves.begin(input(), 'owner'); await flush();
  expect(h.events).toEqual(['metadata', 'audit:recovery-required']);
  expect(h.saved()[0].phase).toBe('recovery-required');
  expect(h.sessions.has('old')).toBe(true);
});

it('captures the resource identity before idle and binds exact idempotency to every resource reference', async () => {
  const h = fixture(); let release!: () => void;
  h.port.idle = () => new Promise<void>(resolve => { release = resolve; });
  const selected = intent(), request = { ...input(), resourceIntent: selected };
  await h.moves.begin(request, 'owner'); selected.profileDigest = 'd'.repeat(64);
  expect(h.saved()[0].resourceIntent?.profileDigest).toBe('b'.repeat(64));
  await expect(h.moves.begin(request, 'owner')).rejects.toThrow('another request');
  release(); await flush(); expect(h.saved()[0].phase).toBe('completed');
});

it('does not allow the ordinary recovery endpoint to adopt a resource transaction after restart', async () => {
  const h = fixture([{ ...input(), owner: 'owner', name: 'Employee', oldSession: 'old', newSession: 'new',
    resourcePhase: 'preparing', phase: 'creating', at: 1 }]);
  expect((await h.moves.get('resource-move', 'owner'))?.phase).toBe('recovery-required');
  await expect(h.moves.resolve('resource-move', { oldSession: 'old', newSession: 'new', toAccount: 'account' }, 'owner'))
    .rejects.toThrow('own verified recovery actor');
  expect(h.events).toEqual([]);
});

it('roundtrips the resource intent losslessly and rejects impossible terminal/SID/namespace states in the real store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-move-journal-'));
  try {
    const store = new PlanMoveStore(join(dir, 'moves.json'));
    const row: PlanMoveRecord = { id: 'resource-move', owner: 'owner', employeeId: 'employee', name: 'Employee',
      fromAccount: 'account', toAccount: 'account', purpose: 'runtime-refresh', runtimeDigest: 'a'.repeat(64),
      resourceIntent: intent(), oldSession: 'old', newSession: 'new', at: 1,
      phase: 'recovery-required', resourcePhase: 'preparing' };
    await store.save([row]); expect((await store.load())[0].resourceIntent).toEqual(intent());
    for (const change of [{ newSession: undefined }, { purpose: undefined }, { phase: 'completed' }, { phase: 'failed' },
      { resourceIntent: undefined }, { resourceIntent: { ...intent(), profileVersion: '18446744073709551616' } },
      { resourceIntent: { ...intent(), profileVersion: 'not-decimal' } }, { owner: undefined }]) {
      await expect(async () => { await store.save([{ ...row, ...change } as PlanMoveRecord]); }).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('refuses absent owner scope and malformed private references before metadata/effects', async () => {
  const h = fixture();
  await expect(h.moves.begin(input())).rejects.toMatchObject({ status: 403 });
  for (const change of [{ extra: 'https://caller.invalid' }, { profileVersion: '9'.repeat(5000) },
    { profileVersion: '01' }, { profileVersion: '-1' },
    { profileVersion: '18446744073709551616' }, { previewDigest: 'wrong' }, { operationId: 'not-an-id' }]) {
    await expect(h.moves.begin({ ...input(), resourceIntent: { ...intent(), ...change } }, 'owner')).rejects.toThrow('references');
  }
  expect(h.events).toEqual([]); expect(h.saved()).toEqual([]);
});

it('allows explicit expected version zero for a first profile, without substituting a default profile', async () => {
  const h = fixture();
  const request = input(); request.resourceIntent = { ...intent(), profileVersion: '0' };
  h.port.prepareResources = async row => {
    expect(row.resourceIntent?.profileVersion).toBe('0');
    throw Error('fixed actor must explicitly initialize or refuse missing profile');
  };
  await h.moves.begin(request, 'owner'); await flush();
  expect(h.saved()[0]).toMatchObject({ phase: 'recovery-required', resourceIntent: { profileVersion: '0' } });
  expect(h.events).not.toContain('stop:old');
});

it.each([false, null, 0, { then() {} }, 'not-a-proof'])('refuses a non-void fence value %s before success is journaled', async value => {
  const h = fixture(); h.port.verifyResources = async () => () => value;
  await h.moves.begin(input(), 'owner'); await flush();
  expect(h.saved()[0].phase).toBe('recovery-required');
  expect(h.events).not.toContain('audit:completed');
});

it('retains recovery if replacement identity drifts while the completion audit ACK is pending', async () => {
  const h = fixture(); const audit = h.port.audit;
  h.port.audit = async row => { await audit(row); if (row.phase === 'completed') h.port.binding = () => 'other'; };
  await h.moves.begin(input(), 'owner'); await flush();
  expect(h.saved()[0].phase).toBe('recovery-required');
  expect(h.events).toContain('audit:recovery-required');
  await expect(h.moves.begin({ ...input(), id: 'retry' }, 'owner')).rejects.toThrow('requiring recovery');
});

it('does not expose provisional completion through get/list/idempotent begin while audit is pending', async () => {
  const h = fixture(); let release!: () => void;
  h.port.audit = async row => { if (row.phase === 'completed') await new Promise<void>(r => { release = r; }); };
  await h.moves.begin(input(), 'owner'); await flush();
  expect(h.saved()[0].phase).toBe('completed');
  expect((await h.moves.get('resource-move', 'owner'))?.phase).toBe('checking');
  expect((await h.moves.list('owner'))[0].phase).toBe('checking');
  expect((await h.moves.begin(input(), 'owner')).phase).toBe('checking');
  release(); await flush();
  expect((await h.moves.get('resource-move', 'owner'))?.phase).toBe('completed');
});

it('holds a durable completed record on reopen if recovery persistence failed after a completion drift', async () => {
  const h = fixture(); const save = h.port.save; let committed = false;
  h.port.save = async rows => {
    if (committed && rows[0].phase === 'recovery-required') throw Error('recovery storage unavailable');
    await save(rows);
    if (rows[0].phase === 'completed') { committed = true; h.port.binding = () => 'other'; }
  };
  await h.moves.begin(input(), 'owner'); await flush();
  expect(h.saved()[0].phase).toBe('completed'); // Disk still has the earlier terminal write.
  const reopened = new PlanMoves({ ...h.port, load: async () => h.saved() });
  expect((await reopened.get('resource-move', 'owner'))?.phase).toBe('recovery-required');
  await expect(reopened.begin({ ...input(), id: 'retry' }, 'owner')).rejects.toThrow('requiring recovery');
});

it('does not let a real persisted completed resource record stand in for fresh native reconciliation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-reopen-'));
  try {
    const store = new PlanMoveStore(join(dir, 'moves.json'));
    await store.save([{ id: 'resource-move', owner: 'owner', employeeId: 'employee', name: 'Employee',
      fromAccount: 'account', toAccount: 'account', purpose: 'runtime-refresh', runtimeDigest: 'a'.repeat(64),
      resourceIntent: intent(), oldSession: 'old', newSession: 'new', at: 1,
      phase: 'completed', resourcePhase: 'verified' }]);
    expect((await store.load())[0].phase).toBe('recovery-required');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('refuses a rejected Promise fence without an unhandled rejection or success audit', async () => {
  const h = fixture(); h.port.verifyResources = async () => () => Promise.reject(Error('async observation failed'));
  await h.moves.begin(input(), 'owner'); await flush();
  expect(h.saved()[0].phase).toBe('recovery-required');
  expect(h.events).not.toContain('audit:completed');
});
