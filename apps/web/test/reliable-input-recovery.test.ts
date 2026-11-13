/** Current process-local receipt behavior, plus bounded legacy client compatibility. */
import {afterEach, describe, it, expect, vi} from 'vitest';
import {browserInputFixture} from './helpers/browser-input-fixture.js';
import {Session} from '../src/session.js';
import {TerminalInputReceipts} from '../src/terminal-input-outcome.js';
import {TerminalInputService} from '../src/web/terminal-input-service.js';


describe('current original-subject receipt contract', () => {
  function harness(service = new TerminalInputService()) {
    const writes: string[] = [];
    const session = new Session({id: 'receipt-contract', workingDir: process.env.HOME!, useMux: false});
    Object.assign(session, {ptyProcess: {pid: 999_999_970, write: (data: string) => writes.push(data), kill: vi.fn()}});
    const sessions = new Map([[session.id, session]]);
    const report = {sessions, persistSessionStateNow: vi.fn(), getSessionStateWithRespawn: (value: Session) => value.toState(), broadcast: vi.fn()};
    return {service, session, writes, report, current: () => sessions.get(session.id) === session};
  }
  it('confirms only the exact original receipt without issuing a second input', async () => {
    const h = harness(), intent = {input: 'original text', clientId: 'browser', seq: 1, useMux: false};
    try {
      const first = h.service.begin(h.session, intent, h.current);
      expect(first.state).toBe('admitted'); if (first.state !== 'admitted') throw new Error('Expected owned input');
      expect(await first.operation.dispatch(h.report)).toBe('confirmed');
      expect(h.service.begin(h.session, intent, h.current).state).toBe('duplicate');
      expect(h.service.begin(h.session, {...intent, input: 'other text'}, h.current).state).toBe('held');
      expect(h.writes).toEqual(['original text']);
    } finally {await h.session.stop(false);}
  });
  it('holds missing, evicted and successor proof rather than deriving delivery from a watermark', async () => {
    const h = harness(new TerminalInputService(new TerminalInputReceipts(1, 1)));
    let successor: Session | undefined;
    try {
      h.session.shouldApplyInput('missing', 1);
      expect(h.service.begin(h.session, {input: 'missing proof', clientId: 'missing', seq: 1}, h.current).state).toBe('held');
      for (const seq of [1, 2]) {
        const operation = h.service.begin(h.session, {input: `owned ${seq}`, clientId: 'browser', seq, useMux: false}, h.current);
        if (operation.state !== 'admitted') throw new Error('Expected original reservation');
        expect(await operation.operation.dispatch(h.report)).toBe('confirmed');
      }
      expect(h.service.begin(h.session, {input: 'owned 1', clientId: 'browser', seq: 1, useMux: false}, h.current).state).toBe('held');
      successor = new Session({id: h.session.id, owner: 'successor', workingDir: process.env.HOME!, useMux: false});
      h.report.sessions.set(successor.id, successor);
      expect(h.service.begin(successor, {input: 'owned 2', clientId: 'browser', seq: 2, useMux: false}, () => true).state).toBe('held');
      expect(h.writes).toEqual(['owned 1', 'owned 2']);
    } finally {await h.session.stop(false); await successor?.stop(false);}
  });
  it('keeps an exact pending request distinct from unknown and confirms it only after its original dispatch', async () => {
    const h = harness(), intent = {input: 'pending text', clientId: 'browser', seq: 1, useMux: true};
    const original = h.session.writeViaMux.bind(h.session); let release!: () => void;
    vi.spyOn(h.session, 'writeViaMux').mockImplementation(async (data, options) => {
      await new Promise<void>(resolve => {release = resolve;}); return original(data, options);
    });
    try {
      const first = h.service.begin(h.session, intent, h.current);
      if (first.state !== 'admitted') throw new Error('Expected original reservation');
      expect(h.session.lastInputSeq('browser')).toBe(0);
      expect(h.service.begin(h.session, intent, h.current).state).toBe('pending');
      const writing = first.operation.dispatch(h.report);
      expect(h.session.lastInputSeq('browser')).toBe(1);
      expect(h.service.begin(h.session, intent, h.current).state).toBe('pending');
      release(); expect(await writing).toBe('confirmed');
      expect(h.service.begin(h.session, intent, h.current).state).toBe('duplicate');
      expect(h.writes).toEqual(['pending text']); expect(h.session.terminalInputHeld).toBe(false);
    } finally {release?.(); await h.session.stop(false);}
  });
});

let fixture: ReturnType<typeof browserInputFixture>;
afterEach(async () => {await fixture?.close();});
describe('legacy counters and watermarks never establish current browser custody', () => {
  it('a saved high counter cannot rebase a fresh page issuer or overwrite the old snapshot', async () => {
    fixture = browserInputFixture();
    const raw = JSON.stringify({pending: {}, seqCounters: {'session-1': 9000}});
    fixture.storage.set('reverie:clientId', 'legacy-device'); fixture.storage.set('reverie:pendingInput', raw);
    const app = await fixture.page(), frames: {seq: number; cid: string}[] = [];
    app._ws = {readyState: 1, send: data => frames.push(JSON.parse(data))}; app._wsSessionId = 'session-1';
    await app._sendInputAsync('session-1', 'current explicit action'); await expect.poll(() => frames.length).toBe(1);
    expect(frames[0]).toMatchObject({seq: 1, cid: app._inputJournal.issuer}); expect(app._inputJournal.issuer).not.toBe('legacy-device');
    expect(fixture.storage.get('reverie:pendingInput')).toBe(raw);
    await app._onWsInputAck(1, {t: 'ia', seq: 1, confirmed: true}, 'session-1');
  });
  it.each([false, true])('a watermark cannot requeue or retag a possibly-issued frame, prior known-refusal=%s', async retry => {
    fixture = browserInputFixture(); const app = await fixture.page(), frames: {seq: number; cid: string; d: string}[] = [];
    app._ws = {readyState: 1, send: data => frames.push(JSON.parse(data))}; app._wsSessionId = 'session-1';
    await app._sendInputAsync('session-1', 'possibly issued'); await expect.poll(() => frames.length).toBe(1);
    if (retry) {
      await app._onWsInputRefusal(1, {t: 'ir', seq: 1, retryable: true, reason: 'capacity'}, 'session-1');
      app._inputRetryAt.set('session-1', 0); await app._drainSession('session-1');
      expect(frames).toHaveLength(2); expect(frames[1]).toEqual(frames[0]);
    }
    await app._onWsInputAck(1, {t: 'ia', seq: 1, lastSeq: 9000, dup: true}, 'session-1');
    app._redeliverSweep(); await app._drainSession('session-1');
    expect(app._inputRecoveryHolds?.has('session-1')).toBe(true); expect(frames).toHaveLength(retry ? 2 : 1);
    const rows = await app._inputJournal.snapshot();
    expect([...rows.records, ...rows.retained]).toMatchObject([{seq: 1, issuer: frames[0].cid, data: 'possibly issued', phase: 'unconfirmed'}]);
  });
  it('a pending receipt is not settled by a bare ACK and later positive metadata cannot clear its hold', async () => {
    fixture = browserInputFixture(); const app = await fixture.page(), frames: object[] = [];
    app._ws = {readyState: 1, send: data => frames.push(JSON.parse(data))}; app._wsSessionId = 'session-1';
    await app._sendInputAsync('session-1', 'pending'); await expect.poll(() => frames.length).toBe(1);
    await (app as unknown as {_onWsInputPending(seq: number, msg: object, sid: string): Promise<void>})._onWsInputPending(1, {t: 'ip', seq: 1}, 'session-1');
    await app._onWsInputAck(1, {t: 'ia', seq: 1}, 'session-1');
    await app._onWsInputAck(1, {t: 'ia', seq: 1, confirmed: true, lastSeq: 9000}, 'session-1');
    expect(app._inputRecoveryHolds?.has('session-1')).toBe(true); expect(frames).toHaveLength(1);
  });
  it('a transaction abort allocates neither records nor counters; a component retry keeps the original next sequence', async () => {
    fixture = browserInputFixture(); let effects = 0;
    const app = await fixture.page(async () => {effects++; return Response.json({success: true, data: {}});});
    fixture.abortWrites();
    expect((await app._inputJournal.accept('session-1', ['first', 'second'])).kind).toBe('not-queued');
    expect((await app._inputJournal.snapshot()).records).toEqual([]);
    // This changes only the synthetic IDB fault. It neither clears a UI hold
    // nor grants recovery: direct journal component acceptance causes no effect.
    fixture.abortWrites(false);
    const committed = await app._inputJournal.accept('session-1', ['first', 'second']);
    expect(committed.kind).toBe('accepted'); expect(committed.records?.map(row => row.seq)).toEqual([1, 2]); expect(effects).toBe(0);
  });
});
