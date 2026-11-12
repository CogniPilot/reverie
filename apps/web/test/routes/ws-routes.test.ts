/**
 * @fileoverview Tests for WebSocket terminal I/O route.
 *
 * Unlike other route tests that use app.inject(), WebSocket testing requires
 * a real listening server since inject() doesn't support upgrade requests.
 * Uses the `ws` package (transitive dep of @fastify/websocket) as the client.
 *
 * @dependency test/mocks/mock-route-context.ts (createMockRouteContext)
 * @dependency src/web/routes/ws-routes.ts (registerWsRoutes)
 * Port: ephemeral (`listen({ port: 0 })`)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import {Session} from '../../src/session.js';
import {TerminalInputReceipts} from '../../src/terminal-input-outcome.js';
import {TerminalInputService} from '../../src/web/terminal-input-service.js';
import {registerSessionRoutes} from '../../src/web/routes/session-routes.js';
import {installResponseEnvelope} from '../../src/web/response-envelope.js';
import {installRouteErrorHandler} from '../../src/web/route-error-handler.js';
import {trustedFixtureOwner} from '../helpers/trusted-owner-fixture.js';
import WebSocket from 'ws';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerWsRoutes } from '../../src/web/routes/ws-routes.js';
import { MAX_INPUT_LENGTH } from '../../src/config/terminal-limits.js';

/** Assigned by the OS on every listen (`port: 0`); see beforeEach. */
let PORT = 0;

/** Helper: open a WebSocket connection and wait for it to reach OPEN state. */
function connectWs(path: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS connection timeout')), timeoutMs);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Helper: wait for the next WS message, parsed as JSON. */
function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)));
    });
  });
}

/** Collect only input disposition; a held real Session also emits refresh telemetry. */
function inputReply(ws: WebSocket, frame: Record<string, unknown>, timeoutMs = 2000, ignorePending = false): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {clearTimeout(timer); ws.off('message', receive);};
    const timer = setTimeout(() => {cleanup(); reject(new Error('Input reply timeout'));}, timeoutMs);
    const receive = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (ignorePending && message.t === 'ip') return;
      if ((message.t === 'ia' || message.t === 'ir' || message.t === 'ie' || message.t === 'ip')
        && (frame.seq === undefined || message.seq === frame.seq)) {cleanup(); resolve(message);}
    };
    ws.on('message', receive); ws.send(JSON.stringify(frame));
  });
}

/** Helper: wait for WS close event and return { code, reason }. */
function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Helper: collect N messages from a WebSocket. */
function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Only received ${msgs.length}/${count} messages`)), timeoutMs);
    const msgs: unknown[] = [];
    const onMessage = (raw: WebSocket.RawData) => {
      msgs.push(JSON.parse(String(raw)));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msgs);
      }
    };
    ws.on('message', onMessage);
  });
}

describe('ws-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    await app.register(fastifyCookie);

    ctx = createMockRouteContext({ sessionId: 'ws-test-session' });
    registerWsRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
    registerSessionRoutes(app, ctx as never, {verifiedOwner: trustedFixtureOwner});
    installResponseEnvelope(app, ''); installRouteErrorHandler(app);

    await app.listen({ port: 0, host: '127.0.0.1' });
    PORT = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
  });

  // ========== Session not found ==========

  describe('session not found', () => {
    it('closes with 4004 when session does not exist', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/nonexistent/terminal`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('Session not found');
    });
  });

  // ========== Terminal output ==========

  describe('terminal output', () => {
    it('receives terminal output via WS with DEC 2026 sync markers', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit terminal data from mock session
        session.emit('terminal', 'hello world');

        // Wait for the micro-batched message (8ms batch interval + margin)
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        // Should contain DEC 2026 sync markers wrapping the data
        expect(msg.d).toContain('hello world');
        expect(msg.d.startsWith('\x1b[?2026h')).toBe(true); // starts with DEC 2026 start
        expect(msg.d.endsWith('\x1b[?2026l')).toBe(true); // ends with DEC 2026 end
      } finally {
        ws.close();
      }
    });

    it('sends clearTerminal event as {"t":"c"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('clearTerminal');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('c');
      } finally {
        ws.close();
      }
    });

    it('sends needsRefresh event as {"t":"r"}', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ctx._session.emit('needsRefresh');

        const msg = (await nextMessage(ws)) as { t: string };
        expect(msg.t).toBe('r');
      } finally {
        ws.close();
      }
    });

    it('coalesces rapid terminal emissions into a single frame', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit multiple small chunks in rapid succession (within the 8ms batch window)
        session.emit('terminal', 'chunk1');
        session.emit('terminal', 'chunk2');
        session.emit('terminal', 'chunk3');

        // Should arrive as a single coalesced message
        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('chunk1chunk2chunk3');
      } finally {
        ws.close();
      }
    });

    it('flushes immediately when batch exceeds size threshold', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Emit data larger than WS_BATCH_FLUSH_THRESHOLD (16384)
        const largeData = 'X'.repeat(17000);
        session.emit('terminal', largeData);

        // Should flush immediately (no 8ms wait) — use a tight timeout
        const msg = (await nextMessage(ws, 500)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain(largeData);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Client input ==========

  describe('client input', () => {
    function installRealSession(write: (data: string) => void, owner?: string): Session {
      const session = new Session({id: 'ws-test-session', workingDir: process.env.HOME!, useMux: false, owner});
      Object.assign(session, {ptyProcess: {pid: 999_999_971, write, kill: vi.fn(), resize: vi.fn()}, _pid: 999_999_971});
      ctx.sessions.set(session.id, session as never); return session;
    }
    const postInput = (payload: Record<string, unknown>) => app.inject({method: 'POST', url: '/api/sessions/ws-test-session/input', payload});
    const frame = (d = 'same input', cid = 'shared-client', seq = 1) => ({t: 'i', d, cid, seq});

    it('reports known missing-PTY refusal without submit bookkeeping and retries the exact original tag after attachment', async () => {
      const writes: string[] = [];
      const session = new Session({id: 'ws-test-session', workingDir: process.env.HOME!, useMux: false});
      ctx.sessions.set(session.id, session as never);
      const submitted = vi.fn(); session.on('promptSubmitted', submitted);
      const dialog = vi.spyOn(session as never as {_recheckPaneDialogSoon(): void}, '_recheckPaneDialogSoon');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const request = frame('known request\r');
      const payload = {input: request.d, clientId: request.cid, seq: request.seq, useMux: false};
      try {
        const before = {lastSubmitAt: session.lastSubmitAt, isWorking: session.isWorking, status: session.status, name: session.name};
        const refused = await postInput(payload);
        expect(refused.statusCode).toBe(409); expect(refused.json().errorCode).toBe('SESSION_BUSY');
        expect(refused.json().data).toEqual({delivered: false}); expect(refused.json().recoveryRequired).toBeUndefined();
        expect(await inputReply(ws, {...request, useMux: false}))
          .toEqual({t: 'ir', seq: 1, retryable: true, reason: 'unavailable'});
        expect({lastSubmitAt: session.lastSubmitAt, isWorking: session.isWorking, status: session.status, name: session.name}).toEqual(before);
        expect(session.inputSeqSpent(request.cid, request.seq)).toBe(false);
        expect(submitted).not.toHaveBeenCalled(); expect(dialog).not.toHaveBeenCalled();
        expect(session.terminalInputHeld).toBe(false);
        Object.assign(session, {ptyProcess: {pid: 999_999_971, write: (data: string) => writes.push(data), kill: vi.fn(), resize: vi.fn()}, _pid: 999_999_971});
        const retried = await postInput(payload);
        expect(retried.statusCode).toBe(200);
        expect(await inputReply(ws, {...request, useMux: false})).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(writes).toEqual([request.d]); expect(session.inputSeqSpent(request.cid, request.seq)).toBe(true);
      } finally {ws.close(); await session.stop(false);}
    });

    it('keeps original tag settlement private when a caller changes its intent object', async () => {
      const session = installRealSession(() => {});
      const intent = {input: 'original input', clientId: 'original-client', seq: 1};
      try {
        const admitted = ctx.terminalInput.begin(session, intent, () => true);
        expect(admitted.state).toBe('admitted'); if (admitted.state !== 'admitted') throw new Error('Expected owned operation');
        const mux = vi.spyOn(session, 'writeViaMux').mockResolvedValue(false);
        expect(await admitted.operation.writeMux()).toBe(false);
        session.shouldApplyInput('unrelated-client', 9);
        intent.clientId = 'unrelated-client'; intent.seq = 9;
        admitted.operation.refuse();
        expect(session.lastInputSeq('original-client')).toBe(0); expect(session.lastInputSeq('unrelated-client')).toBe(9);
        const uncertain = ctx.terminalInput.begin(session, {input: 'next input', clientId: 'original-client', seq: 1}, () => true);
        expect(uncertain.state).toBe('admitted'); if (uncertain.state !== 'admitted') throw new Error('Expected original retry');
        mux.mockRejectedValue(new Error('synthetic uncertain dispatch'));
        await expect(uncertain.operation.writeMux()).rejects.toMatchObject({name: 'TerminalInputUnconfirmedError'});
        uncertain.operation.unconfirmed(new Error('synthetic uncertain dispatch'), ctx as never);
        uncertain.operation.refuse();
        expect(await uncertain.operation.writeMux()).toBe(false);
        expect(session.lastInputSeq('original-client')).toBe(1); expect(session.terminalInputHeld).toBe(true);
        expect(ctx.terminalInput.begin(session, {input: 'next input', clientId: 'original-client', seq: 1}, () => true).state).toBe('held');
      } finally {await session.stop(false);}
    });

    it('consumes one operation and cannot redispatch, refund confirmation or regress its receipt', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      try {
        const intent = {input: 'owned input', clientId: 'original-client', seq: 1, useMux: false};
        const admission = ctx.terminalInput.begin(session, intent, () => true);
        expect(admission.state).toBe('admitted'); if (admission.state !== 'admitted') throw new Error('Expected operation');
        const operation = admission.operation; expect(Object.isFrozen(operation)).toBe(true);
        expect(await operation.dispatch(ctx as never)).toBe('confirmed');
        expect(await operation.dispatch(ctx as never)).toBe('confirmed');
        expect(operation.writeRaw()).toBe(false); expect(await operation.writeMux()).toBe(false);
        operation.refuse(); expect(session.lastInputSeq('original-client')).toBe(1);
        expect('record' in operation).toBe(false);
        expect(ctx.terminalInput.begin(session, intent, () => true).state).toBe('duplicate');
        expect(writes).toEqual(['owned input']);
      } finally {await session.stop(false);}
    });

    it('accepts an unseen sequence zero once and never treats its spent watermark as missing history', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(session.inputSeqSpent('zero-client', 0)).toBe(false);
        expect(await inputReply(ws, frame('zero input', 'zero-client', 0))).toEqual({t: 'ia', seq: 0, confirmed: true});
        expect(session.inputSeqSpent('zero-client', 0)).toBe(true);
        expect((await postInput({input: 'zero input', clientId: 'zero-client', seq: 0})).statusCode).toBe(200);
        expect(writes).toEqual(['zero input']);
      } finally {ws.close(); await session.stop(false);}
    });

    it('keeps a confirmed input receipt when post-write desktop telemetry fails', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const claim = vi.spyOn(session, 'claimDesktopSizing');
      const note = vi.spyOn(session, 'noteDesktopActivity').mockImplementation(() => {throw new Error('synthetic observer failure');});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({t: 'z', c: 120, r: 40, v: 'desktop'}));
        await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(note).toHaveBeenCalledOnce(); expect(session.terminalInputHeld).toBe(false);
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(writes).toEqual(['same input']); expect(ctx.broadcast.mock.calls.some(([event]) => event === 'session:error')).toBe(true);
      } finally {ws.close(); await session.stop(false);}
    });

    it('shares confirmed original receipts across WS and HTTP without duplicate/resequence ACKs', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, confirmed: true});
        const http = await postInput({input: 'same input', clientId: 'shared-client', seq: 1});
        expect(http.statusCode).toBe(200); expect(http.json().success).toBe(true); expect(writes).toEqual(['same input']);
        expect((await postInput({input: 'second input', clientId: 'shared-client', seq: 2})).statusCode).toBe(200);
        expect(await inputReply(ws, frame('second input', 'shared-client', 2))).toEqual({t: 'ia', seq: 2, confirmed: true});
        expect(writes).toEqual(['same input', 'second input']);
      } finally {ws.close(); await session.stop(false);}
    });
    it('preserves the browser useMux:true intent across lost-ACK fallback in both directions', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const mux = vi.spyOn(session, 'writeViaMux'), raw = vi.spyOn(session, 'write');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const selected = {...frame('selected prompt\r'), useMux: true};
        expect(await inputReply(ws, selected)).toEqual({t: 'ia', seq: 1, confirmed: true});
        // Simulate the browser ignoring/loss of its first WS ACK, then posting its unchanged queue record.
        expect((await postInput({input: selected.d, clientId: selected.cid, seq: selected.seq, useMux: true})).statusCode).toBe(200);
        expect(mux).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled();
        expect((await postInput({input: 'second selected prompt\r', clientId: 'shared-client', seq: 2, useMux: true})).statusCode).toBe(200);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(await inputReply(ws, {...frame('second selected prompt\r', 'shared-client', 2), useMux: true})).toEqual({t: 'ia', seq: 2, confirmed: true});
        expect(mux).toHaveBeenCalledTimes(2); expect(writes).toEqual(['selected prompt\r', 'second selected prompt\r']);
        expect(await inputReply(ws, {...selected, useMux: false})).toEqual({t: 'ia', seq: 1, held: true});
        expect((await postInput({input: selected.d, clientId: selected.cid, seq: selected.seq, useMux: false})).statusCode).toBe(422);
        expect(mux).toHaveBeenCalledTimes(2); expect(raw).not.toHaveBeenCalled();
      } finally {ws.close(); await session.stop(false);}
    });
    it('observes an exact in-flight WS mux request as pending over both transports, then confirms its original effect', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const original = session.writeViaMux.bind(session); let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => {entered = resolve;});
      const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (data, options) => {
        entered(); await new Promise<void>(resolve => {release = resolve;}); return original(data, options);
      });
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const request = {...frame('pending selected prompt\r'), useMux: true};
        const first = inputReply(ws, request, 2000, true); await started;
        const pending = await postInput({input: request.d, clientId: request.cid, seq: request.seq, useMux: true});
        expect(pending.json().data).toEqual({pending: true});
        expect(await inputReply(ws, request)).toEqual({t: 'ip', seq: 1});
        expect(mux).toHaveBeenCalledOnce(); expect(session.terminalInputHeld).toBe(false);
        release(); expect(await first).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(await inputReply(ws, request)).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect((await postInput({input: request.d, clientId: request.cid, seq: request.seq, useMux: true})).json().data).toEqual({});
        expect(mux).toHaveBeenCalledOnce(); expect(writes).toEqual(['pending selected prompt\r']);
      } finally {release?.(); ws.close(); await session.stop(false);}
    });
    it('cancels unstarted queued frames without phantom spent tags while an original dispatch settles after disconnect', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const original = session.writeViaMux.bind(session); let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => {entered = resolve;});
      const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (data, options) => {
        entered(); await new Promise<void>(resolve => {release = resolve;}); return original(data, options);
      });
      const begin = vi.spyOn(ctx.terminalInput, 'begin');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        ws.send(JSON.stringify({...frame('first\r'), useMux: true}));
        ws.send(JSON.stringify(frame('following', 'shared-client', 2)));
        await started; await vi.waitFor(() => expect(begin.mock.calls.some(([, intent]) => intent.seq === 2)).toBe(true));
        const closed = waitForClose(ws); ws.close(); await closed;
        release(); await vi.waitFor(() => expect(writes).toEqual(['first\r']));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(session.lastInputSeq('shared-client')).toBe(1); expect(session.terminalInputHeld).toBe(false);
        mux.mockRestore();
        expect((await postInput({input: 'first\r', clientId: 'shared-client', seq: 1, useMux: true})).statusCode).toBe(200);
        expect((await postInput({input: 'following', clientId: 'shared-client', seq: 2})).statusCode).toBe(200);
        expect(writes).toEqual(['first\r', 'following']); expect(session.lastInputSeq('shared-client')).toBe(2);
      } finally {release?.(); ws.close(); await session.stop(false);}
    });
    it('retains a subject fence for queued requests when the original Session is replaced before their effects', async () => {
      const writes: string[] = [], successorWrites: string[] = [];
      const originalSession = installRealSession(data => {writes.push(data);});
      const originalWrite = originalSession.writeViaMux.bind(originalSession); let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => {entered = resolve;});
      vi.spyOn(originalSession, 'writeViaMux').mockImplementation(async (data, options) => {
        entered(); await new Promise<void>(resolve => {release = resolve;}); return originalWrite(data, options);
      });
      const begin = vi.spyOn(ctx.terminalInput, 'begin');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal'); let successor: Session | undefined;
      try {
        const first = inputReply(ws, {...frame('first\r'), useMux: true});
        const second = inputReply(ws, frame('following', 'shared-client', 2));
        await started; await vi.waitFor(() => expect(begin.mock.calls.some(([, intent]) => intent.seq === 2)).toBe(true));
        successor = installRealSession(data => {successorWrites.push(data);}, 'successor'); release();
        expect(await first).toEqual({t: 'ia', seq: 1, held: true}); expect(await second).toEqual({t: 'ia', seq: 2, held: true});
        const response = await postInput({input: 'following', clientId: 'shared-client', seq: 2});
        expect(response.statusCode).toBe(422); expect(response.json().recoveryRequired).toBe(true);
        expect(writes).toEqual([]); expect(successorWrites).toEqual([]);
      } finally {release?.(); ws.close(); await originalSession.stop(false); await successor?.stop(false);}
    });

    it('publishes known typed-unsent callbacks consistently across WS and HTTP without retyping or confirmation', async () => {
      const retained: string[] = []; const session = installRealSession(() => {});
      const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (data, options) => {
        retained.push(data); options?.onTypedUnsent?.(); return false;
      });
      const raw = vi.spyOn(session, 'write'); const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const request = {...frame('retained text\r'), useMux: true};
        const negative = {t: 'ia', seq: 1, typedUnsent: true, delivered: false};
        expect(await inputReply(ws, request)).toEqual(negative);
        expect(await inputReply(ws, request)).toEqual(negative);
        const http = await postInput({input: request.d, clientId: request.cid, seq: 1, useMux: true});
        expect(http.statusCode).toBe(409); expect(http.json().data).toEqual({typedUnsent: true, delivered: false});
        expect(session.terminalInputHeld).toBe(false); expect(mux).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled();
        await postInput({input: 'other retained text\r', clientId: 'shared-client', seq: 2, useMux: true});
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(await inputReply(ws, {...frame('other retained text\r', 'shared-client', 2), useMux: true}))
          .toEqual({t: 'ia', seq: 2, typedUnsent: true, delivered: false});
        expect(retained).toEqual(['retained text\r', 'other retained text\r']);
        expect(await inputReply(ws, frame('\r', 'shared-client', 3))).toEqual({t: 'ia', seq: 3, confirmed: true});
        expect(raw).toHaveBeenCalledOnce(); expect(session.lastInputSeq('shared-client')).toBe(3);
      } finally {ws.close(); await session.stop(false);}
    });
    it('keeps an HTTP terminal callback pending until its writer settles, so later uncertainty dominates', async () => {
      const session = installRealSession(() => {}); Object.assign(session, {_workerBacked: true});
      const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(async (_data, options) => {
        options?.onTypedUnsent?.(); throw new Error('synthetic terminal result lost after callback');
      });
      try {
        const first = await postInput({input: 'retained or sent\r', clientId: 'shared-client', seq: 1, useMux: true});
        expect(first.json().data?.typedUnsent).not.toBe(true);
        expect(first.json().data?.pending === true || first.json().recoveryRequired === true).toBe(true);
        await new Promise<void>(resolve => setImmediate(resolve));
        const next = await postInput({input: 'retained or sent\r', clientId: 'shared-client', seq: 1, useMux: true});
        expect(next.json().recoveryRequired).toBe(true); expect(next.json().data?.typedUnsent).not.toBe(true);
        expect(session.terminalInputHeld).toBe(true); expect(mux).toHaveBeenCalledOnce();
      } finally {await session.stop(false);}
    });

    it('lets explicit uncertainty dominate an earlier typed-unsent callback', async () => {
      const session = installRealSession(() => {});
      vi.spyOn(session, 'writeViaMux').mockImplementation(async (_data, options) => {
        options?.onTypedUnsent?.(); throw new Error('synthetic terminal outcome lost after callback');
      });
      const raw = vi.spyOn(session, 'write'); const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(await inputReply(ws, {...frame('retained or sent\r'), useMux: true})).toEqual({t: 'ia', seq: 1, unconfirmed: true});
        const http = await postInput({input: 'retained or sent\r', clientId: 'shared-client', seq: 1, useMux: true});
        expect(http.json().recoveryRequired).toBe(true); expect(http.json().data?.typedUnsent).not.toBe(true);
        expect(session.terminalInputHeld).toBe(true); expect(raw).not.toHaveBeenCalled();
      } finally {ws.close(); await session.stop(false);}
    });

    it('does not issue raw fallback after a selected mux write may have reached the PTY', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data); throw new Error('synthetic mux completion lost');});
      const mux = vi.spyOn(session, 'writeViaMux'), raw = vi.spyOn(session, 'write');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(await inputReply(ws, {...frame('selected prompt\r'), useMux: true})).toEqual({t: 'ia', seq: 1, unconfirmed: true});
        expect(mux).toHaveBeenCalledOnce(); expect(raw).not.toHaveBeenCalled(); expect(writes).toEqual(['selected prompt\r']);
        expect(session.terminalInputHeld).toBe(true);
      } finally {ws.close(); await session.stop(false);}
    });
    it('keeps raw input behind an earlier async mux owner in the same ordered stream', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const original = session.writeViaMux.bind(session); let started!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => {started = resolve;});
      vi.spyOn(session, 'writeViaMux').mockImplementation(async (data, options) => {
        started(); await new Promise<void>(resolve => {release = resolve;}); return original(data, options);
      });
      const begin = vi.spyOn(ctx.terminalInput, 'begin');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const first = inputReply(ws, {...frame('first\r'), useMux: true});
        const second = inputReply(ws, {...frame('following', 'shared-client', 2), useMux: false});
        await entered; await vi.waitFor(() => expect(begin.mock.calls.some(([, intent]) => intent.seq === 2)).toBe(true));
        expect(session.lastInputSeq('shared-client')).toBe(1);
        expect(writes).toEqual([]); release();
        expect(await first).toEqual({t: 'ia', seq: 1, confirmed: true}); expect(await second).toEqual({t: 'ia', seq: 2, confirmed: true});
        expect(writes).toEqual(['first\r', 'following']);
      } finally {release?.(); ws.close(); await session.stop(false);}
    });
    it.each(['bytes', 'slots'] as const)('refuses deferred WS %s capacity without spending a seq or declaring an unknown effect', async limit => {
      ctx.terminalInput = new TerminalInputService(new TerminalInputReceipts(512, 512));
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      let release!: (sent: boolean) => void;
      const pending = new Promise<boolean>(resolve => {release = resolve;});
      const mux = vi.spyOn(session, 'writeViaMux').mockReturnValue(pending);
      const begin = vi.spyOn(ctx.terminalInput, 'begin');
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const data = limit === 'bytes' ? 'é'.repeat(32_768) : 'x';
      const count = limit === 'bytes' ? 16 : 256;
      try {
        for (let seq = 1; seq <= count; seq++) ws.send(JSON.stringify({...frame(data, 'queue-client', seq), useMux: true}));
        await vi.waitFor(() => expect(begin.mock.calls.some(([, intent]) => intent.seq === count)).toBe(true));
        const response = await inputReply(ws, {...frame(data, 'queue-client', count + 1), useMux: true});
        expect(response).toEqual({t: 'ir', seq: count + 1, retryable: true, reason: 'capacity'});
        expect(session.lastInputSeq('queue-client')).toBe(1); expect(mux).toHaveBeenCalledOnce();
        expect(session.terminalInputHeld).toBe(false); expect(writes).toEqual([]);
        release(true); await vi.waitFor(() => expect(mux).toHaveBeenCalledTimes(count));
      } finally {release(true); ws.close(); await session.stop(false);}
    });

    it('does not transfer confirmed proof to a different payload or explicit raw/mux intent', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(await inputReply(ws, frame('different input'))).toEqual({t: 'ia', seq: 1, held: true});
        for (const payload of [{input: 'different input'}, {input: 'same input', useMux: false}, {input: 'same input', useMux: true}]) {
          const response = await postInput({...payload, clientId: 'shared-client', seq: 1});
          expect(response.statusCode).toBe(422); expect(response.json().recoveryRequired).toBe(true);
        }
        expect(writes).toEqual(['same input']);
      } finally {ws.close(); await session.stop(false);}
    });
    it.each([false, true])('reports a real partial WS write as unknown and blocks HTTP replay (persistence failure=%s)', async persistenceFailure => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data); throw new Error('synthetic PTY completion lost');});
      if (persistenceFailure) ctx.persistSessionStateNow.mockImplementation(() => {throw new Error('synthetic disk failure');});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, unconfirmed: true});
        expect(session.terminalInputHeld).toBe(true); expect(session.providerDispatchHeld).toBe(false);
        expect(ctx.persistSessionStateNow).toHaveBeenCalledWith(session);
        expect(ctx.broadcast.mock.calls.some(([event]) => event === 'session:updated')).toBe(true);
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, held: true});
        expect(await inputReply(ws, frame('new input', 'new-client'))).toEqual({t: 'ia', seq: 1, held: true});
        for (const clientId of ['shared-client', 'new-http-client']) {
          const http = await postInput({input: 'same input', clientId, seq: 1});
          expect(http.statusCode).toBe(409); expect(http.json().recoveryRequired).toBe(true);
        }
        expect(writes).toEqual(['same input']);
      } finally {ws.close(); await session.stop(false);}
    });
    it('keeps HTTP uncertainty visible to WS, including an untagged diagnostic frame', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data); throw new Error('synthetic failed write');});
      try {
        const http = await postInput({input: 'same input', clientId: 'shared-client', seq: 1});
        expect(http.statusCode).toBe(422); expect(http.json().recoveryRequired).toBe(true);
        const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
        try {
          expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, held: true});
          expect(await inputReply(ws, {t: 'i', d: 'untagged retry'})).toEqual({t: 'ie', held: true});
        } finally {ws.close();}
        expect(writes).toEqual(['same input']);
      } finally {await session.stop(false);}
    });
    it('shares a pending HTTP reservation with WS and confirms only its settled original input', async () => {
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      let started!: () => void, settle!: (value: boolean) => void;
      const entered = new Promise<void>(resolve => {started = resolve;});
      const mux = vi.spyOn(session, 'writeViaMux').mockImplementation(() => {started(); return new Promise(resolve => {settle = resolve;});});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const pending = postInput({input: 'same input\r', clientId: 'shared-client', seq: 1}).then(result => result);
      try {
        await entered;
        expect(await inputReply(ws, frame('same input\r'))).toEqual({t: 'ip', seq: 1});
        settle(true); expect((await pending).statusCode).toBe(200);
        expect(await inputReply(ws, frame('same input\r'))).toEqual({t: 'ia', seq: 1, confirmed: true});
        expect(mux).toHaveBeenCalledOnce(); expect(writes).toEqual([]);
      } finally {settle?.(true); ws.close(); await session.stop(false);}
    });
    it.each(['owner', 'registry'] as const)('refuses an existing socket after its original %s changes', async change => {
      const writes: string[] = [], successorWrites: string[] = [];
      const original = installRealSession(data => {writes.push(data);});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      let successor: Session | undefined;
      try {
        if (change === 'owner') original.owner = 'successor';
        else successor = installRealSession(data => {successorWrites.push(data);});
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, held: true});
        expect(writes).toEqual([]); expect(successorWrites).toEqual([]);
      } finally {ws.close(); await original.stop(false); await successor?.stop(false);}
    });
    it('keeps the original unknown barrier across same-SID successor objects without leaking predecessor proof', async () => {
      const writes: string[] = [], successorWrites: string[] = [];
      const original = installRealSession(data => {writes.push(data); throw new Error('private predecessor error');});
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      let successor: Session | undefined;
      try {
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, unconfirmed: true});
        successor = installRealSession(data => {successorWrites.push(data);}, 'successor');
        const next = await connectWs('/ws/sessions/ws-test-session/terminal');
        try {
          const answer = await inputReply(next, frame('new input', 'successor-client'));
          expect(answer).toEqual({t: 'ia', seq: 1, held: true}); expect(JSON.stringify(answer)).not.toContain('private');
          expect((await postInput({input: 'new input', clientId: 'successor-client', seq: 2})).statusCode).toBe(422);
        } finally {next.close();}
        expect(writes).toEqual(['same input']); expect(successorWrites).toEqual([]);
      } finally {ws.close(); await original.stop(false); await successor?.stop(false);}
    });
    it('retains unknown custody without persisting the predecessor over a replacement during physical input', async () => {
      const originalWrites: string[] = [], successorWrites: string[] = [];
      let successor: Session | undefined;
      const original = installRealSession(data => {
        originalWrites.push(data); successor = installRealSession(value => {successorWrites.push(value);}, 'successor');
      });
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect(await inputReply(ws, frame())).toEqual({t: 'ia', seq: 1, unconfirmed: true});
        expect(ctx.persistSessionStateNow).not.toHaveBeenCalled(); expect(ctx.broadcast).not.toHaveBeenCalled();
        expect(original.terminalInputHeld).toBe(true); expect(successor?.terminalInputHeld).toBe(false);
        const next = await connectWs('/ws/sessions/ws-test-session/terminal');
        try {expect(await inputReply(next, frame('new input', 'successor-client'))).toEqual({t: 'ia', seq: 1, held: true});}
        finally {next.close();}
        expect(originalWrites).toEqual(['same input']); expect(successorWrites).toEqual([]);
      } finally {ws.close(); await original.stop(false); await successor?.stop(false);}
    });

    it('refuses WS input before effects or seq spend when unresolved HTTP capacity is full', async () => {
      ctx.terminalInput = new TerminalInputService(new TerminalInputReceipts(1, 1));
      const writes: string[] = []; const session = installRealSession(data => {writes.push(data);});
      let settle!: (value: boolean) => void;
      vi.spyOn(session, 'writeViaMux').mockReturnValue(new Promise(resolve => {settle = resolve;}));
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        expect((await postInput({input: 'pending', useMux: true, clientId: 'http-client', seq: 1})).statusCode).toBe(200);
        expect(await inputReply(ws, frame())).toEqual({t: 'ir', seq: 1, retryable: true, reason: 'capacity'});
        expect(session.lastInputSeq('shared-client')).toBe(0); expect(writes).toEqual([]);
      } finally {settle(true); ws.close(); await session.stop(false);}
    });

    it('forwards input messages to session.write()', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'i', d: 'ls -la\r' }));

        // Give the message handler time to process
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ls -la\r');
        });
      } finally {
        ws.close();
      }
    });

    it('ACKs a delivered input and burns its seq', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        ws.send(JSON.stringify({ t: 'i', d: 'ok\r', cid: 'c1', seq: 1 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 1, confirmed: true });
        expect(session.shouldApplyInput('c1', 1)).toBe(false);
      } finally {
        ws.close();
      }
    });

    it('reports a known not-issued refusal and re-opens the seq when the write did not land', async () => {
      // A session whose PTY is gone swallows the write. ACKing anyway told the
      // client to drop the frame from its durable queue while the seq stayed
      // burnt, so the retry that reliable delivery exists for was rejected as a
      // duplicate — the input was lost for good.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.failWrites = true;

        ws.send(JSON.stringify({ t: 'i', d: 'lost\r', cid: 'c1', seq: 1 }));

        expect(await nextMessage(ws, 600)).toEqual({t: 'ir', seq: 1, retryable: true, reason: 'unavailable'});
        expect(session.shouldApplyInput('c1', 1)).toBe(true);
      } finally {
        ws.close();
      }
    });

    it('holds a spent seq with no original delivery receipt instead of minting a duplicate ACK', async () => {
      // A seq watermark alone is not original-subject delivery proof.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        session.shouldApplyInput('c1', 7); // pretend seq 7 already landed

        ws.send(JSON.stringify({ t: 'i', d: 'again\r', cid: 'c1', seq: 7 }));

        // A held reply neither claims delivery nor mints a new seq for replay.
        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 7, held: true });
        expect(session.writeBuffer).not.toContain('again\r');
      } finally {
        ws.close();
      }
    });

    it('ignores input exceeding MAX_INPUT_LENGTH', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        const hugeInput = 'x'.repeat(MAX_INPUT_LENGTH + 1);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput }));

        // Send a valid message after to confirm the connection still works
        ws.send(JSON.stringify({ t: 'i', d: 'ok' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('ok');
        });

        // The oversized input should not have been written
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('refuses an oversized sequenced frame with an error ACK, so the client can drop it', async () => {
      // Issue #484: a silent return left the frame unACKed, and the client's
      // durable queue re-sent it every few seconds forever.
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;
        const hugeInput = 'y'.repeat(MAX_INPUT_LENGTH + 1);
        ws.send(JSON.stringify({ t: 'i', d: hugeInput, cid: 'c1', seq: 3 }));

        expect(await nextMessage(ws)).toEqual({ t: 'ia', seq: 3, err: 'too_large', max: MAX_INPUT_LENGTH });
        expect(session.writeBuffer).not.toContain(hugeInput);
      } finally {
        ws.close();
      }
    });

    it('ignores malformed JSON messages', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send('not-json{{{');

        // Send valid input to verify connection still alive
        ws.send(JSON.stringify({ t: 'i', d: 'after-bad' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('after-bad');
        });

        // Only 'after-bad' should be in the buffer
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });

    it('ignores unknown message types without breaking the connection', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        // Send unknown type
        ws.send(JSON.stringify({ t: 'x', d: 'mystery' }));

        // Connection should still work
        ws.send(JSON.stringify({ t: 'i', d: 'still-alive' }));

        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('still-alive');
        });

        // Unknown type should not have been written
        expect(session.writeBuffer).toHaveLength(1);
      } finally {
        ws.close();
      }
    });
  });

  // ========== Resize validation ==========

  describe('resize validation', () => {
    it('accepts valid resize within bounds', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('passes viewport type through for resize arbitration', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'mobile' }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(48, 28, { viewportType: 'mobile', force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('passes force resize through for redraw requests', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 120, r: 40, f: true }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: true });
        });
      } finally {
        ws.close();
      }
    });

    it('claims desktop sizing on a desktop resize and releases it on close', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      const session = ctx._session;
      try {
        ws.send(JSON.stringify({ t: 'z', c: 160, r: 48, v: 'desktop' }));

        await vi.waitFor(() => {
          expect(session.claimDesktopSizing).toHaveBeenCalledTimes(1);
        });
        const token = session.claimDesktopSizing.mock.calls[0][0];

        // A later small-viewport resize on the SAME connection drops the claim
        // (window narrowed past the breakpoint).
        ws.send(JSON.stringify({ t: 'z', c: 48, r: 28, v: 'tablet' }));
        await vi.waitFor(() => {
          expect(session.releaseDesktopSizing).toHaveBeenCalledWith(token);
        });
      } finally {
        ws.close();
      }

      // Socket close releases the claim again (idempotent set delete).
      await vi.waitFor(() => {
        expect(session.releaseDesktopSizing.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('accepts resize at minimum bounds (1x1)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 1, r: 1 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(1, 1, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('accepts resize at maximum bounds (500x200)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 500, r: 200 }));

        await vi.waitFor(() => {
          expect(session.resize).toHaveBeenCalledWith(500, 200, { viewportType: undefined, force: false });
        });
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols out of bounds (0 cols)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 0, r: 40 }));

        // Send a valid message to confirm processing continues
        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with cols exceeding 500', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 501, r: 40 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with rows exceeding 200', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80, r: 201 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with non-integer values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: 80.5, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });

    it('rejects resize with negative values', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        const session = ctx._session;

        ws.send(JSON.stringify({ t: 'z', c: -1, r: 24 }));

        ws.send(JSON.stringify({ t: 'i', d: 'sentinel' }));
        await vi.waitFor(() => {
          expect(session.writeBuffer).toContain('sentinel');
        });

        expect(session.resize).not.toHaveBeenCalled();
      } finally {
        ws.close();
      }
    });
  });

  // ========== Connection limit ==========

  describe('connection limit', () => {
    it('closes with 4008 when too many connections per session', async () => {
      const connections: WebSocket[] = [];
      try {
        // Open 5 connections (the max)
        for (let i = 0; i < 5; i++) {
          connections.push(await connectWs('/ws/sessions/ws-test-session/terminal'));
        }

        // 6th connection should be rejected
        const ws6 = new WebSocket(`ws://127.0.0.1:${PORT}/ws/sessions/ws-test-session/terminal`);
        const { code, reason } = await waitForClose(ws6);
        expect(code).toBe(4008);
        expect(reason).toBe('Too many connections');
      } finally {
        for (const ws of connections) ws.close();
      }
    });

    it('reconnecting client (same cid) is admitted at the cap instead of 4008 (COD-137)', async () => {
      const connections: WebSocket[] = [];
      try {
        // Fill all 5 slots with DISTINCT clients, one of which is "alice".
        for (const c of ['alice', 'b', 'c', 'd', 'e']) {
          connections.push(await connectWs(`/ws/sessions/ws-test-session/terminal?cid=${c}`));
        }

        // Alice reconnects WHILE her old socket is still registered (the
        // over-count window). This must reclaim her slot, not hit the cap.
        const aliceNew = await connectWs('/ws/sessions/ws-test-session/terminal?cid=alice');
        connections.push(aliceNew);

        // Sanity: the reconnected socket is live and usable.
        ctx._session.emit('terminal', 'reconnected-ok');
        const msg = (await nextMessage(aliceNew)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('reconnected-ok');
      } finally {
        for (const ws of connections) ws.close();
      }
    });
  });

  // ========== Heartbeat ==========

  describe('heartbeat', () => {
    it('responds to server ping with pong (connection stays alive)', async () => {
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');
      try {
        // The ws library automatically responds to pings with pongs.
        // Verify the connection survives by sending data after a brief delay.
        const session = ctx._session;
        session.emit('terminal', 'heartbeat-test');

        const msg = (await nextMessage(ws)) as { t: string; d: string };
        expect(msg.t).toBe('o');
        expect(msg.d).toContain('heartbeat-test');
      } finally {
        ws.close();
      }
    });
  });

  // ========== readyState guards ==========

  describe('readyState guards', () => {
    it('does not throw when clearTerminal fires after close', async () => {
      const session = ctx._session;
      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      ws.close();
      await waitForClose(ws);

      // These should be no-ops, not throw
      expect(() => session.emit('clearTerminal')).not.toThrow();
      expect(() => session.emit('needsRefresh')).not.toThrow();
    });
  });

  // ========== Connection cleanup ==========

  describe('connection cleanup', () => {
    it('removes session event listeners on close', async () => {
      const session = ctx._session;
      const listenersBefore = session.listenerCount('terminal');

      const ws = await connectWs('/ws/sessions/ws-test-session/terminal');

      // A listener was added for 'terminal'
      expect(session.listenerCount('terminal')).toBe(listenersBefore + 1);
      expect(session.listenerCount('clearTerminal')).toBeGreaterThanOrEqual(1);
      expect(session.listenerCount('needsRefresh')).toBeGreaterThanOrEqual(1);

      // Close the WS connection
      ws.close();
      await waitForClose(ws);

      // Wait for server-side close handler
      await vi.waitFor(() => {
        expect(session.listenerCount('terminal')).toBe(listenersBefore);
      });

      expect(session.listenerCount('clearTerminal')).toBe(0);
      expect(session.listenerCount('needsRefresh')).toBe(0);
    });
  });
});
