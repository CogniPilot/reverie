/** Current process-local receipt behavior, plus bounded legacy client compatibility. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {Session} from '../src/session.js';
import {TerminalInputReceipts} from '../src/terminal-input-outcome.js';
import {TerminalInputService} from '../src/web/terminal-input-service.js';

const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

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

describe('legacy client watermark compatibility only; not current server delivery proof', () => {
  const handler = appSource.slice(
    appSource.indexOf('_onWsInputAck(seq, msg, sessionId'),
    appSource.indexOf('/** Called from ws.onopen')
  );

  it('raises the counter to the watermark it was handed', () => {
    expect(handler).toMatch(/_seqCounters\.set\(sessionId, watermark\)/);
  });

  it('re-queues a FIRST-attempt frame, whose input was genuinely lost', () => {
    expect(handler).toMatch(/rec\.tries <= 1/);
    expect(handler).toMatch(/this\._reliableSend\(sessionId, lost/);
  });

  it('does NOT re-queue a retry, which the dedup correctly suppressed', () => {
    // A retry called a duplicate means the original DID land; re-sending it would
    // type the same thing twice — the exact thing exactly-once delivery prevents.
    expect(handler).toMatch(/const lost = rec && rec\.tries <= 1 \? rec\.data : null;/);
  });

  it('persists the raised counter immediately, not on the debounce', () => {
    expect(handler).toContain('this._persistReliableNow()');
  });
});

describe('the seq counter is persisted synchronously on every send', () => {
  it('_reliableSend uses the immediate writer, never the debounced one', () => {
    // The counter is precisely what must survive a crash, so it cannot ride the
    // path most likely to be lost. (The queue PAYLOAD may still be debounced.)
    const send = appSource.slice(appSource.indexOf('_reliableSend(sessionId, data, useMux)'));
    const body = send.slice(0, send.indexOf('_nextSeq(sessionId) {'));
    expect(body).toContain('this._persistReliableNow();');
    expect(body).not.toMatch(/list\.push\(rec\);\s*\n\s*this\._persistReliableState\(\);/);
  });
});
