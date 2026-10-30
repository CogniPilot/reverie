import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type PowerAction = 'stop-laptops' | 'shutdown' | 'restart-website';
export async function laptopPower(action: PowerAction | 'status' | 'provider-health', caller?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const args = ['--control', action, ...(caller ? ['--caller-session', caller] : [])];
  const { stdout } = await execute('reverie-worker-exec', args, { timeout: action === 'provider-health' ? 25_000 : 120_000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) });
  return JSON.parse(stdout);
}

/**
 * Stop one laptop's agent: the broker kills its inner pane's process group and leaves a dead pane for recovery. After
 * notAfter (epoch ms) the signal is not sent. fence names this stop so that settleLaptopStop can settle it if the answer
 * is lost. `{dispatched: false}` is a definitive refusal; a thrown error (timeout, lost connection, a failure after the
 * signal) leaves the outcome unknown.
 */
export async function stopLaptopAgent(sessionId: string, notAfter: number, fence: string, run: typeof execute = execute): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await run('reverie-worker-exec',
      ['--control', 'stop-agent', '--session-id', sessionId, '--not-after', String(Math.trunc(notAfter)), '--fence', fence],
      { timeout: 30_000, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // Refusals made while reading the request, before any engine call: definitive, nothing was stopped. An older laptop
    // manager refuses the deadline itself (its client has no --not-after; its broker accepts only {action, sessionId}).
    const { code, stderr } = (error ?? {}) as { code?: unknown; stderr?: unknown };
    const said = typeof stderr === 'string' ? stderr : '';
    if ((code === 2 && /unrecognized arguments:.*--(not-after|fence)/.test(said)) || /\bInvalid stop-agent request\b/.test(said))
      return { action: 'stop-agent', success: false, dispatched: false,
        error: 'the laptop manager refused the stop request before signalling anything; it may be older than this website ' +
          '(stop deadlines need the updated laptop manager)' };
    throw error;
  }
}

/**
 * Settle a stop whose answer was lost. In the laptop, the stop's fence goes to whichever comes first: its signal, or this
 * settle. `{signalled: false}` means that stop never signals from now on, and `{signalled: true}` that it already has.
 * A thrown error means the laptop has not answered yet.
 */
export async function settleLaptopStop(sessionId: string, fence: string, run: typeof execute = execute): Promise<Record<string, unknown>> {
  const { stdout } = await run('reverie-worker-exec', ['--control', 'settle-stop', '--session-id', sessionId, '--fence', fence],
    { timeout: 30_000, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout);
}

export const laptopAgentStop = { stop: stopLaptopAgent, settle: settleLaptopStop };

export function registerLaptopPowerRoutes(app: FastifyInstance, deps: {
  verifiedOwner?: OwnerVerifier;
  stopIntent: () => Promise<void>;
  power?: typeof laptopPower;
}) {
  const power = deps.power ?? laptopPower;
  app.get('/api/system/laptops', async (req, reply) => {
    if (!(deps.verifiedOwner ?? NO_OWNER)(req)) return reply.code(403).send({ success: false, error: 'Only the verified owner may read laptop controls.' });
    if (!process.env.REVERIE_WORKER_SOCKET) return { success: true, data: { available: false } };
    try { return { success: true, data: { available: true, ...await power('status') } }; }
    catch { return reply.code(503).send({ success: false, error: 'The laptop manager is unavailable.' }); }
  });
  const run = async (action: PowerAction, req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const caller = req.headers['x-reverie-parent-session'];
    if (caller !== undefined && (action !== 'restart-website' || typeof caller !== 'string'))
      return reply.code(403).send({ success: false, error: 'Only the owner may stop laptops or shut down Reverie.' });
    if (!(deps.verifiedOwner ?? NO_OWNER)(req) && (caller === undefined || req.headers['x-reverie-service-token'] !== undefined))
      return reply.code(403).send({ success: false, error: 'Verified owner or maintenance agent session required.' });
    if (!process.env.REVERIE_WORKER_SOCKET)
      return reply.code(503).send({ success: false, error: 'Laptop power controls require the host laptop manager.' });
    if ((req.body as { confirmed?: unknown } | undefined)?.confirmed !== true)
      return reply.code(400).send({ success: false, error: 'Confirm the selected power action.' });
    try {
      if (action !== 'restart-website') await deps.stopIntent();
      const result = await power(action, typeof caller === 'string' ? caller : undefined);
      return { success: true, data: result };
    } catch {
      return reply.code(503).send({ success: false, error: 'The power action did not complete. Check the laptop manager; the website has been kept online.' });
    }
  };
  app.post('/api/system/stop-laptops', (req, reply) => run('stop-laptops', req, reply));
  app.post('/api/system/shutdown', (req, reply) => run('shutdown', req, reply));
  app.post('/api/system/restart-website', (req, reply) => run('restart-website', req, reply));
}
