/** Human-only independent laptop terminal. No agent-session input or shell API. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OwnerLedgerBridge } from '../../owner-ledger-bridge.js';
import { OwnerLaptopTerminalAuthority } from '../../owner-laptop-terminal-authority.js';
import type { TerminalRequest } from '../../owner-terminal-runtime.js';
import { sameOrigin } from '../../owner-auth/policy.js';
import type { OfficeAuthService } from '../../owner-auth/office.js';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const Size = z.object({cols: z.number().int().min(2).max(300), rows: z.number().int().min(2).max(120)}).strict();
type Request = FastifyRequest & TerminalRequest;
export function registerOwnerTerminalRoutes(app: FastifyInstance,
  verifyOwner: (request: FastifyRequest) => boolean,
  visibleEmployee: (request: FastifyRequest, employeeId: string) => boolean,
  auth: Pick<OfficeAuthService, 'track'>,
  runtime?: {authority: OwnerLaptopTerminalAuthority<Request>; bridge: OwnerLedgerBridge<Request>}
): void {
  const issued = new Map<string, {employeeId: string; cookieDigest: string; expires: number}>();
  let active: WebSocket | undefined;
  const cookieDigest = (request: FastifyRequest) => createHash('sha256').update(request.cookies?.reverie_owner ?? '').digest('hex');
  const owner = (request: FastifyRequest) => verifyOwner(request) === true
    && sameOrigin(request)
    && request.headers['x-reverie-parent-session'] === undefined
    && request.headers['x-reverie-service-token'] === undefined;
  const current = (request: FastifyRequest, reference: string) => {
    const record = issued.get(reference);
    if (!owner(request) || !record || Date.now() >= record.expires || cookieDigest(request) !== record.cookieDigest
      || !visibleEmployee(request, record.employeeId)) throw new Error('Owner terminal authority unavailable');
    return record;
  };
  app.post('/api/company/employees/:id/human-terminal', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!owner(request)) return reply.code(403).send({success: false, error: 'Use your unrestricted owner login'});
    const id = (request.params as {id: string}).id, parsed = Size.safeParse(request.body);
    if (!UUID.test(id) || !parsed.success) return reply.code(400).send({success: false, error: 'Invalid terminal size or employee'});
    if (!visibleEmployee(request, id)) return reply.code(404).send({success: false, error: 'Unknown employee'});
    if (!runtime) return reply.code(503).send({success: false, error: 'Owner terminal is not installed for this website'});
    for (const [key, record] of issued) if (Date.now() >= record.expires) issued.delete(key);
    if (active || issued.size >= 4) return reply.code(409).send({success: false, error: 'Close the current human terminal first'});
    let completed = false;
    const cancelled = () => { if (!completed && !reply.raw.writableFinished) runtime.bridge.close(); };
    reply.raw.once('close', cancelled);
    try {
      const result = await runtime.bridge.issue(request as Request, id, parsed.data.cols, parsed.data.rows, 300);
      if (reply.raw.destroyed) { runtime.bridge.close(); throw new Error('Owner terminal request cancelled'); }
      issued.set(result.authorizationRef, {employeeId: id, cookieDigest: cookieDigest(request), expires: result.expiresAtEpochMs});
      completed = true;
      return {success: true, data: result};
    } catch {
      return reply.code(503).send({success: false, error: 'Terminal request refused or unconfirmed; it was not retried'});
    } finally { reply.raw.off('close', cancelled); }
  });
  app.get('/ws/owner-terminals/:reference', {websocket: true}, (socket: WebSocket, request) => {
    const reference = (request.params as {reference: string}).reference;
    try { if (!runtime || active || !UUID.test(reference)) throw new Error(); current(request, reference); }
    catch { socket.close(4003, 'Owner terminal unavailable'); return; }
    // Explicit even when general owner policy is off. Actual physical socket,
    // never a JSON object or browser-provided connection/session identity.
    auth.track(request.cookies!.reverie_owner!, request.raw.socket);
    active = socket;
    let ended = false, queued = 0, bytes = 0, timer: NodeJS.Timeout | undefined;
    let tail = Promise.resolve();
    const failure = () => {
      if (ended) return;
      ended = true; runtime!.bridge.close(); issued.delete(reference);
      if (timer) clearTimeout(timer);
      socket.close(1011, 'Terminal outcome unconfirmed; no reconnect');
    };
    const perform = (action: 'open' | 'input' | 'resize' | 'poll' | 'end', payload: string | [number, number] | null = null) => {
      if (ended) return;
      if (++queued > 16) { failure(); return; }
      tail = tail.then(async () => {
        if (ended) return;
        current(request, reference);
        const value = await runtime!.bridge.terminal(request as Request, reference, action, payload);
        if (socket.bufferedAmount > 65536) throw new Error('Terminal output backpressure');
        if (value.output) socket.send(JSON.stringify({kind: 'output', data: value.output}));
        if (action === 'end' || value.state === 'SETTLED') {
          if (action !== 'end') await runtime!.bridge.terminal(request as Request, reference, 'end');
          ended = true; issued.delete(reference);
          if (timer) clearTimeout(timer);
          socket.send(JSON.stringify({kind: 'closed', settled: true})); socket.close(1000, 'Terminal settled');
        } else if (action === 'poll' || action === 'open') {
          timer = setTimeout(() => perform('poll'), 1000);
        }
      }).catch(failure).finally(() => { queued--; });
    };
    socket.on('message', (raw, binary) => {
      try {
        if (binary || !Buffer.isBuffer(raw) || raw.length > 8192) throw new Error();
        bytes += raw.length;
        if (bytes > 16 * 1024**2) throw new Error();
        const value = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (value.kind === 'input' && Object.keys(value).length === 2 && typeof value.data === 'string'
          && value.data.length <= 5464) perform('input', value.data);
        else if (value.kind === 'resize' && Object.keys(value).length === 3) {
          const size = Size.parse({cols: value.cols, rows: value.rows}); perform('resize', [size.cols, size.rows]);
        } else if (value.kind === 'close' && Object.keys(value).length === 1) perform('end');
        else throw new Error();
      } catch { failure(); }
    });
    socket.on('error', failure);
    socket.on('close', () => {
      if (active === socket) active = undefined;
      if (timer) clearTimeout(timer);
      if (!ended) {
        // Real server-side transport loss, never a browser owner=true flag.
        // Attempt a bounded close with the still-current captured owner. If
        // revoked or uncertain, channel EOF invokes native physical cleanup.
        tail = tail.then(async () => {
          current(request, reference);
          await runtime!.bridge.terminal(request as Request, reference, 'end');
          ended = true; issued.delete(reference);
        }).catch(failure);
      }
    });
    perform('open');
  });
  app.addHook('onClose', async () => {
    if (active) active.close(1012, 'Website shutting down');
    runtime?.authority.shutdown(); runtime?.bridge.close(); issued.clear();
  });
}
