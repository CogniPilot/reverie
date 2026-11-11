/**
 * @fileoverview WebSocket terminal I/O route.
 *
 * Provides a low-latency bidirectional channel for terminal input/output,
 * bypassing the HTTP POST + SSE path that adds per-request middleware overhead.
 * Auth is checked once on the WebSocket upgrade handshake (cookies are included
 * automatically by the browser). After upgrade, the connection is raw — no
 * per-message middleware processing.
 *
 * Additive: the existing HTTP POST /api/sessions/:id/input and SSE session:terminal
 * paths remain fully functional. The frontend opts into WS when available and
 * falls back transparently.
 *
 * Terminal output is micro-batched at 8ms to group Ink's rapid cursor-up redraws
 * into single frames, preventing flicker from split ANSI sequences. This matches
 * the SSE path's server-side batching (16-50ms) but at a shorter interval since
 * WS has no Traefik buffering overhead.
 *
 * Protocol (all JSON text frames):
 *   Server -> Client:
 *     {"t":"o","d":"..."} — terminal output
 *     {"t":"c"}           — clear terminal
 *     {"t":"r"}           — needs refresh (reload buffer)
 *     {"t":"ia","seq":N,"confirmed":true} — original accepted input or its exact confirmed receipt; drop only that frame
 *     {"t":"ia","seq":N,"unconfirmed":true} — possible effect; hold input, never replay
 *     {"t":"ia","seq":N,"held":true} — no new effect; original proof/barrier is unresolved
 *     {"t":"ie","unconfirmed":true} — untagged input uncertainty (held uses the same shape)
 *     {"t":"ir","seq":N,"retryable":true,"reason":"capacity"|"unavailable"} — known not issued; retain the exact seq and back off
 *     {"t":"ip","seq":N} — exact original operation remains pending; no delivery ACK
 *     {"t":"ia","seq":N,"typedUnsent":true,"delivered":false} — text retained, no replay; never a confirmed delivery
 *     {"t":"zc","c":N,"r":N} — resize confirm: the geometry the PTY now holds, which
 *                          is NOT always the one requested (see Session.resize
 *                          arbitration). Clients adopt it — issue #464.
 *   Client -> Server:
 *     {"t":"i","d":"...","seq":N,"cid":"...","useMux":bool} — input (keystroke or paste). seq+cid are
 *                          optional reliable-delivery tags: the server applies each
 *                          (cid,seq) at-most-once and ACKs with {"t":"ia","seq":N}.
 *     {"t":"z","c":N,"r":N,"f":bool} — resize terminal (f=true forces SIGWINCH even if dims unchanged)
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { EventPort } from '../ports/event-port.js';
import type { SessionPort } from '../ports/session-port.js';
import { MAX_INPUT_LENGTH } from '../../config/terminal-limits.js';
import { isAllowedRequestHost, isAllowedRequestOrigin, type HostPolicy } from '../network-auth-policy.js';
import { WsConnectionRegistry } from '../ws-connection-registry.js';
import { canAccessOwned, getAuthUser } from '../route-helpers.js';

/** Micro-batch interval for terminal output (ms). Short enough for low latency,
 *  long enough to group Ink's rapid cursor-up redraw sequences into single frames. */
const WS_BATCH_INTERVAL_MS = 8;

/** Flush immediately when batch exceeds this size (bytes) for responsiveness. */
const WS_BATCH_FLUSH_THRESHOLD = 16384;

/** How often to ping each WebSocket client (ms). Detects stale connections that
 *  TCP keepalive won't catch for minutes, especially through tunnels/proxies. */
const WS_PING_INTERVAL_MS = 30_000;

/** If pong isn't received within this window after a ping, terminate the socket. */
const WS_PONG_TIMEOUT_MS = 10_000;

/** DEC 2026 synchronized update markers. Wrapping output in these tells xterm.js
 *  to buffer all content and render atomically in a single frame — eliminates
 *  flicker from cursor-up redraws that Ink sends without its own sync markers
 *  (DA capability negotiation fails through the PTY→server→WS proxy chain). */
const DEC_2026_START = '\x1b[?2026h';
const DEC_2026_END = '\x1b[?2026l';

/** Max concurrent WS connections per session. Prevents listener/bandwidth multiplication. */
const MAX_WS_PER_SESSION = 5;
/** Bound only deferred input. Ordinary raw keystrokes have no queue or await. */
const MAX_WS_INPUT_QUEUE_SLOTS = 256;
const MAX_WS_INPUT_QUEUE_BYTES = 1024 * 1024;

/**
 * Track live WS connections per session, keyed by clientId (COD-137).
 * Replaces a bare counter that over-counted across the async-close gap on
 * reconnect (spurious 4008). A same-`cid` reconnect supersedes its own socket
 * (reclaims the slot) instead of consuming a new one; cid-less upgrades are
 * admitted anonymously up to the cap. See ws-connection-registry.ts.
 */
const sessionWsRegistry = new WsConnectionRegistry<WebSocket>(MAX_WS_PER_SESSION);

export function registerWsRoutes(app: FastifyInstance, ctx: SessionPort & Pick<EventPort, 'broadcast'>, getHostPolicy: () => HostPolicy): void {
  app.get<{ Params: { id: string }; Querystring: { cid?: string } }>(
    '/ws/sessions/:id/terminal',
    { websocket: true },
    (socket: WebSocket, req) => {
      // Reject cross-site WebSocket hijacking (CSWSH) and DNS-rebinding before doing
      // anything: the upgrade must come from an allowed Host and (when the browser
      // sends one — it always does for WS) a same-site Origin. Writing to this socket
      // injects keystrokes into a --dangerously-skip-permissions agent, so this gate
      // matters even on the default no-password install. See security review H5.
      const policy = getHostPolicy();
      if (!isAllowedRequestHost(req.headers.host, policy) || !isAllowedRequestOrigin(req.headers.origin, policy)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      const { id } = req.params;
      const session = ctx.sessions.get(id);

      if (!session) {
        socket.close(4004, 'Session not found');
        return;
      }

      // Multi-user owner gate: writing to this socket injects keystrokes into the
      // agent, so a non-admin may only attach to their OWN session. The global auth
      // hook already ran on the upgrade request and decorated req.authUser (an
      // unauthenticated upgrade never reaches here — the hook 401s the handshake).
      // findSessionOrFail throws an HTTP-shaped error, so the check is inlined here
      // as a 4003 close. No-op in single-user mode (canAccessOwned returns true).
      if (!canAccessOwned(getAuthUser(req), session.owner)) {
        socket.close(4003, 'Forbidden');
        return;
      }

      // Structured transport logging — surfaces WS open/close/timeout churn so the
      // tunnel-flap behavior (COD-134) is observable in the server logs. Fastify is
      // configured logger:false, so we log via console (→ journald under systemd).

      // Enforce per-session connection limit, scoped by clientId. A same-cid
      // reconnect reclaims its own slot (registry evicts the stale socket), so a
      // drop+reconnect burst can no longer over-count across the async-close gap
      // and trip a spurious 4008. cid-less upgrades are admitted anonymously.
      const cid = typeof req.query?.cid === 'string' && req.query.cid.length > 0 ? req.query.cid : null;
      const { admitted, evictedSocket } = sessionWsRegistry.register(id, cid, socket);
      if (!admitted) {
        console.warn('[ws] terminal rejected: too many connections', {
          sessionId: id,
          wsCount: sessionWsRegistry.liveCount(id),
        });
        socket.close(4008, 'Too many connections');
        return;
      }
      if (evictedSocket) {
        // Same client reconnected; retire the stale socket so it doesn't linger.
        console.info('[ws] terminal superseded by reconnect', { sessionId: id });
        try {
          evictedSocket.close(4010, 'Superseded by reconnect');
        } catch {
          /* socket may already be closing */
        }
      }
      console.info('[ws] terminal open', { sessionId: id, wsCount: sessionWsRegistry.liveCount(id) });

      // Eagerly free the slot on error/terminate — don't wait for the async
      // 'close' (idempotent with the 'close' handler below). This is what kills
      // the reconnect over-count: the slot is released the instant the socket dies.
      let inputActive = true;
      const originalOwner = session.owner;
      const currentInput = () => inputActive && socket.readyState === 1 && ctx.sessions.get(id) === session
        && session.owner === originalOwner && canAccessOwned(getAuthUser(req), originalOwner);
      socket.on('error', () => {
        inputActive = false;
        sessionWsRegistry.unregister(id, socket);
      });

      // Per-connection micro-batch state
      let batchChunks: string[] = [];
      let batchSize = 0;
      let batchTimer: ReturnType<typeof setTimeout> | null = null;

      const flushBatch = () => {
        batchTimer = null;
        if (batchChunks.length === 0 || socket.readyState !== 1) {
          batchChunks = [];
          batchSize = 0;
          return;
        }
        const data = batchChunks.join('');
        batchChunks = [];
        batchSize = 0;
        socket.send(`{"t":"o","d":${JSON.stringify(DEC_2026_START + data + DEC_2026_END)}}`);
      };

      // Per-connection desktop sizing claim — registered on the first
      // desktop-typed resize and released on socket close, so Session.resize()
      // can ignore small-viewport resizes only while a desktop is actually
      // connected (see Session._desktopSizeClaims).
      const sizingToken = Symbol('ws-desktop-sizing');
      let holdsDesktopClaim = false;

      let inputTail: Promise<void> | undefined;
      let queuedInputSlots = 0, queuedInputBytes = 0;

      // Attach message handler synchronously BEFORE any async work
      // (@fastify/websocket requirement to avoid dropped messages).
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.t === 'i' && typeof msg.d === 'string') {
            if (msg.d.length > MAX_INPUT_LENGTH) {
              // Refused for good, so say so: a silent return left the frame
              // unACKed and the client redelivered it every few seconds forever
              // (issue #484). A client that predates `err` reads this as a plain
              // ACK and drops the frame, which is also the right outcome.
              if (Number.isInteger(msg.seq) && socket.readyState === 1) {
                socket.send(`{"t":"ia","seq":${msg.seq as number},"err":"too_large","max":${MAX_INPUT_LENGTH}}`);
              }
              return;
            }
            const cid = typeof msg.cid === 'string' && msg.cid.length <= 128 ? msg.cid : undefined;
            const seq = Number.isSafeInteger(msg.seq) && msg.seq >= 0 ? msg.seq as number : undefined;
            const answer = (state: 'confirmed' | 'held' | 'unconfirmed') => {
              if (socket.readyState !== 1 || (seq === undefined && state === 'confirmed')) return;
              try {socket.send(JSON.stringify(seq === undefined ? {t: 'ie', [state]: true}
                : {t: 'ia', seq, [state]: true}));}
              catch { /* Original receipt remains authoritative when its ACK is lost. */ }
            };
            if ((msg.cid !== undefined && cid === undefined) || (msg.seq !== undefined && seq === undefined)) {
              answer('held'); return;
            }
            const typedUnsent = () => {
              if (socket.readyState !== 1) return;
              try {socket.send(JSON.stringify(seq === undefined ? {t: 'ie', typedUnsent: true, delivered: false}
                : {t: 'ia', seq, typedUnsent: true, delivered: false}));} catch { /* retained text is never replayed */ }
            };
            const useMux = msg.useMux === undefined ? undefined : msg.useMux;
            if (useMux !== undefined && typeof useMux !== 'boolean') {answer('held'); return;}
            const data = msg.d as string;
            const bytes = Buffer.byteLength(data, 'utf8');
            const retryKnownNone = (reason: 'capacity' | 'unavailable') => {
              if (socket.readyState !== 1) return;
              try {socket.send(JSON.stringify({t: 'ir', ...(seq === undefined ? {} : {seq}), retryable: true, reason}));} catch { /* no input was issued */ }
            };
            const capacityAvailable = () => !inputTail || (queuedInputSlots < MAX_WS_INPUT_QUEUE_SLOTS && queuedInputBytes + bytes <= MAX_WS_INPUT_QUEUE_BYTES);
            const admission = ctx.terminalInput.begin(session, {input: data, clientId: cid, seq, useMux}, currentInput, capacityAvailable,
              () => ctx.sessions.get(id) === session && session.id === id && session.owner === originalOwner && canAccessOwned(getAuthUser(req), originalOwner));
            if (admission.state === 'duplicate') {answer('confirmed'); return;}
            if (admission.state === 'pending') {
              if (socket.readyState === 1) {try {socket.send(JSON.stringify({t: 'ip', ...(seq === undefined ? {} : {seq})}));} catch { /* original receipt remains pending */ }}
              return;
            }
            if (admission.state === 'capacity') {retryKnownNone('capacity'); return;}
            if (admission.state === 'typed-unsent') {typedUnsent(); return;}
            if (admission.state !== 'admitted') {answer('held'); return;}
            const operation = admission.operation;
            const disposition = (state: string) => {
              if (state === 'typed-unsent') {typedUnsent(); return;}
              if (state === 'confirmed' && holdsDesktopClaim && currentInput()) {
                try {session.noteDesktopActivity();} catch {
                  try {ctx.broadcast('session:error', {id, error: 'Desktop sizing activity could not be recorded.'});} catch { /* delivery receipt remains confirmed */ }
                }
              }
              if (state === 'confirmed' || state === 'held' || state === 'unconfirmed') answer(state);
              if (state === 'refused') retryKnownNone('unavailable');
            };
            const deliver = (): void | Promise<void> => {
              const outcome = operation.dispatch(ctx);
              if (typeof outcome === 'string') return disposition(outcome);
              return outcome.then(disposition);
            };
            const failed = (cause: unknown) => {
              try {operation.unconfirmed(cause, ctx);} catch { /* the original pending/unknown receipt remains held */ }
              answer('unconfirmed');
            };
            if (!inputTail && !operation.useMux) {
              try {deliver();} catch (cause) {failed(cause);}
            } else {
              queuedInputSlots++; queuedInputBytes += bytes;
              const task = (inputTail ?? Promise.resolve()).then(deliver).catch(failed).finally(() => {
                queuedInputSlots--; queuedInputBytes -= bytes;
              });
              inputTail = task;
              void task.then(() => {if (inputTail === task) inputTail = undefined;});
            }
          } else if (
            currentInput() && msg.t === 'z' &&
            Number.isInteger(msg.c) &&
            Number.isInteger(msg.r) &&
            msg.c >= 1 &&
            msg.c <= 500 &&
            msg.r >= 1 &&
            msg.r <= 200
          ) {
            const viewportType = msg.v === 'mobile' || msg.v === 'tablet' || msg.v === 'desktop' ? msg.v : undefined;
            if (viewportType === 'desktop') {
              session.claimDesktopSizing(sizingToken);
              holdsDesktopClaim = true;
            } else if (viewportType) {
              // The connection's viewport can change (e.g. browser window
              // narrowed past the tablet breakpoint) — drop a stale claim.
              session.releaseDesktopSizing(sizingToken);
              holdsDesktopClaim = false;
            }
            const force = msg.f === true;
            session.resize(msg.c, msg.r, { viewportType, force });
            // Report the geometry that actually took. Resize used to be
            // write-only, so a client whose request was declined by the
            // arbitration above — or floored, or overridden by another device
            // — had no way to find out, and went on rendering a CLI's repaints
            // against a screen shape that did not exist (issue #464). Sent
            // unconditionally: it is ~30 bytes on a debounced, rare message,
            // and always-send means the client needs no "did it take?" state.
            // A session with no pane sends nothing at all: its `_ptyCols`/
            // `_ptyRows` are constructor defaults no process was ever told.
            const applied = session.ptyGeometry;
            if (applied && socket.readyState === 1) {
              socket.send(`{"t":"zc","c":${applied.cols},"r":${applied.rows}}`);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });

      // Terminal output -> micro-batched WS send
      const onTerminal = (data: string) => {
        if (socket.readyState !== 1) return;
        batchChunks.push(data);
        batchSize += data.length;

        // Flush immediately for large batches (responsiveness during bulk output)
        if (batchSize > WS_BATCH_FLUSH_THRESHOLD) {
          if (batchTimer) {
            clearTimeout(batchTimer);
          }
          flushBatch();
          return;
        }

        // Start timer if not already running
        if (!batchTimer) {
          batchTimer = setTimeout(flushBatch, WS_BATCH_INTERVAL_MS);
        }
      };

      const onClearTerminal = () => {
        if (socket.readyState === 1) {
          socket.send('{"t":"c"}');
        }
      };

      const onNeedsRefresh = () => {
        if (socket.readyState === 1) {
          socket.send('{"t":"r"}');
        }
      };

      // Close WS when session exits (deleted, respawned, or crashed) — prevents
      // orphaned listeners and stale writes to a dead PTY.
      const onSessionExit = () => {
        socket.close(4009, 'Session terminated');
      };

      session.on('terminal', onTerminal);
      session.on('clearTerminal', onClearTerminal);
      session.on('needsRefresh', onNeedsRefresh);
      session.on('exit', onSessionExit);

      // Heartbeat: detect stale connections (especially through tunnels where
      // TCP RST can take minutes to propagate).
      let pongTimeout: ReturnType<typeof setTimeout> | null = null;

      socket.on('pong', () => {
        if (pongTimeout) {
          clearTimeout(pongTimeout);
          pongTimeout = null;
        }
      });

      const pingInterval = setInterval(() => {
        if (socket.readyState !== 1) return;
        socket.ping();
        pongTimeout = setTimeout(() => {
          console.warn('[ws] terminal ping timeout — terminating', { sessionId: id });
          // Free the slot eagerly — terminate()'s 'close' may lag, and a client
          // reconnecting after a stale-connection drop must not be over-counted.
          sessionWsRegistry.unregister(id, socket);
          socket.terminate();
        }, WS_PONG_TIMEOUT_MS);
      }, WS_PING_INTERVAL_MS);

      socket.on('close', (code: number, reason: Buffer) => {
        inputActive = false;
        clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        if (batchTimer) clearTimeout(batchTimer);
        batchChunks = [];
        session.off('terminal', onTerminal);
        session.off('clearTerminal', onClearTerminal);
        session.off('needsRefresh', onNeedsRefresh);
        session.off('exit', onSessionExit);
        session.releaseDesktopSizing(sizingToken);

        // Release this socket's slot. Idempotent and identity-matched: if this
        // socket was already superseded (a same-cid reconnect took its slot) or
        // eagerly unregistered on terminate/error, this is a no-op and the
        // reconnected socket keeps the slot.
        sessionWsRegistry.unregister(id, socket);
        console.info('[ws] terminal close', {
          sessionId: id,
          code,
          reason: String(reason),
          wsCount: sessionWsRegistry.liveCount(id),
        });
      });
    }
  );
}
