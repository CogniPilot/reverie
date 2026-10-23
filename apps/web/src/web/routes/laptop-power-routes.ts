import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type PowerAction = 'stop-laptops' | 'shutdown' | 'restart-website';
export async function laptopPower(action: PowerAction | 'status', caller?: string): Promise<Record<string, unknown>> {
  const args = ['--control', action, ...(caller ? ['--caller-session', caller] : [])];
  const { stdout } = await execute('reverie-worker-exec', args, { timeout: 120_000, maxBuffer: 64 * 1024 });
  return JSON.parse(stdout);
}

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
