/** Owner-only employee GPU requests over the fixed private broker control socket.
 * Native request/config/device observations remain separate authorities. No wake,
 * provider restart, Docker access, shell command or company-checkbox projection.
 */
import {createConnection} from 'node:net';
import {isAbsolute} from 'node:path';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import {z} from 'zod';
import {CompanyService} from './company-service.js';
import {NO_OWNER, type OwnerVerifier} from './owner-auth/marks.js';
import {ownerFor} from './web/route-helpers.js';

const UUID = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const Device = z.string().regex(/^GPU-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Current = z.object({sessionId: UUID, sessionGeneration: Revision.refine(value => value > 0),
  bindingDigest: z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const Expected = Current.extend({revision: Revision.refine(value => value < Number.MAX_SAFE_INTEGER)}).strict();
const Request = z.object({expected: Expected, enabled: z.boolean(), deviceUuid: Device.optional()}).strict()
  .refine(value => value.enabled ? value.deviceUuid !== undefined : value.deviceUuid === undefined);
export const EmployeeGpuStatus = z.object({
  version: z.literal(1), employeeId: UUID, current: Current, revision: Revision,
  choices: z.object({known: z.boolean(), devices: z.array(z.object({deviceUuid: Device,
    model: z.string().min(1).max(128)}).strict()).max(64)}).strict(),
  requested: z.object({enabled: z.boolean(), deviceUuid: Device.nullable(), revision: Revision}).strict().nullable(),
  applied: z.object({known: z.boolean(), enabled: z.boolean().nullable(), deviceUuid: Device.nullable(),
    source: z.enum(['employee', 'legacy-session', 'none', 'unknown'])}).strict(),
  active: z.object({known: z.boolean(), running: z.boolean().nullable(), enabled: z.boolean().nullable(),
    deviceUuid: Device.nullable()}).strict(),
  state: z.enum(['unchanged', 'pending', 'applied', 'reconciliation-required']),
}).strict().refine(value => new Set(value.choices.devices.map(device => device.deviceUuid)).size === value.choices.devices.length);
export type EmployeeGpuStatusValue = z.infer<typeof EmployeeGpuStatus>;

class GpuAccessError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
let activeCalls = 0;
const MAX_REPLY = 64 * 1024;
/** No request can choose a socket, command or tool. The normal server selects it. */
export class EmployeeGpuClient {
  constructor(private readonly socketPath: string | undefined) {}
  async exchange(command: {action: 'gpu-access-status'; employeeId: string} |
    ({action: 'gpu-access-request'; employeeId: string} & z.infer<typeof Request>)): Promise<EmployeeGpuStatusValue> {
    if (!this.socketPath || !isAbsolute(this.socketPath) || /[\x00-\x1f]/.test(this.socketPath))
      throw new GpuAccessError(503, 'GPU host controls are unavailable. No GPU access was changed.');
    if (activeCalls >= 4) throw new GpuAccessError(503, 'GPU host controls are busy. Refresh the status before trying again.');
    const raw = Buffer.from(JSON.stringify(command));
    if (raw.length > 2048) throw new GpuAccessError(400, 'Invalid GPU request.');
    const header = Buffer.alloc(5); header[0] = 67; header.writeUInt32BE(raw.length, 1);
    activeCalls++;
    try {
      return await new Promise<EmployeeGpuStatusValue>((resolve, reject) => {
        const socket = createConnection(this.socketPath!);
        let done = false, received = Buffer.alloc(0);
        const finish = (error?: Error, value?: EmployeeGpuStatusValue) => {
          if (done) return; done = true; clearTimeout(timer); socket.destroy();
          if (error) reject(error); else resolve(value!);
        };
        const unconfirmed = () => new GpuAccessError(503, 'GPU request or status was not confirmed. Refresh before trying again; no automatic retry was made.');
        const timer = setTimeout(() => finish(unconfirmed()), 35000);
        socket.once('error', () => finish(unconfirmed()));
        socket.once('close', () => { if (!done) finish(unconfirmed()); });
        socket.once('connect', () => { if (!done) socket.write(Buffer.concat([header, raw])); });
        socket.on('data', chunk => {
          if (done) return;
          if (received.length + chunk.length > MAX_REPLY + 5) { finish(unconfirmed()); return; }
          received = Buffer.concat([received, chunk]);
          if (received.length < 5) return;
          const size = received.readUInt32BE(1);
          if (size === 0 || size > MAX_REPLY || received.length > size + 5) { finish(unconfirmed()); return; }
          if (received.length !== size + 5) return;
          if (received[0] !== 74) { finish(unconfirmed()); return; }
          try { finish(undefined, EmployeeGpuStatus.parse(JSON.parse(received.subarray(5).toString('utf8')))); }
          catch { finish(unconfirmed()); }
        });
      });
    } finally { activeCalls--; }
  }
}

export function registerEmployeeGpuRoutes(app: FastifyInstance, company: CompanyService,
  client: EmployeeGpuClient, verifiedOwner: OwnerVerifier = NO_OWNER): void {
  const binding = (request: FastifyRequest, id: string) => {
    if (!verifiedOwner(request)) throw new GpuAccessError(403, 'Only the company owner may manage laptop GPU access.');
    const employees = company.view(ownerFor(request)).employees.filter(employee => employee.id === id);
    if (employees.length !== 1) throw new GpuAccessError(404, 'Unknown company employee.');
    return {sessionId: employees[0].sessionId, sessionGeneration: employees[0].sessionGeneration};
  };
  const run = async (request: FastifyRequest, update: boolean) => {
    const id = UUID.parse((request.params as {id: string}).id), before = binding(request, id);
    const change = update ? Request.parse(request.body) : undefined;
    if (change && (change.expected.sessionId !== before.sessionId || change.expected.sessionGeneration !== before.sessionGeneration))
      throw new GpuAccessError(409, 'This laptop binding changed. Refresh GPU status before requesting a change.');
    const status = await client.exchange(change ? {action: 'gpu-access-request', employeeId: id, ...change} :
      {action: 'gpu-access-status', employeeId: id});
    const after = binding(request, id);
    if (status.employeeId !== id || status.current.sessionId !== after.sessionId || status.current.sessionGeneration !== after.sessionGeneration ||
      before.sessionId !== after.sessionId || before.sessionGeneration !== after.sessionGeneration)
      throw new GpuAccessError(409, 'This laptop binding changed. GPU status or request is not confirmed; refresh before trying again.');
    if (change && (!status.requested || status.requested.enabled !== change.enabled ||
      status.requested.deviceUuid !== (change.deviceUuid ?? null) || status.revision !== change.expected.revision + 1 || status.requested.revision !== status.revision))
      throw new GpuAccessError(503, 'The GPU request was not confirmed. Refresh status before trying again.');
    return {success: true, data: {gpuAccess: status}};
  };
  for (const method of ['GET', 'POST'] as const) app.route({method, url: '/api/company/employees/:id/gpu-access',
    handler: async (request, reply) => {
      try { return await run(request, method === 'POST'); }
      catch (error) {
        const code = error instanceof GpuAccessError ? error.statusCode : error instanceof z.ZodError ? 400 : 503;
        const message = error instanceof GpuAccessError ? error.message : code === 400 ? 'Invalid GPU request.' : 'GPU host status is unavailable.';
        return reply.code(code).send({success: false, error: message});
      }
    }});
}
