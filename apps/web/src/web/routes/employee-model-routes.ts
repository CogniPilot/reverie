/**
 * @fileoverview Read and choose an employee's Claude model.
 *
 * - `GET /api/company/employees/:id/model`: the recorded choice, the model the CLI reports, whether
 *   the choice is applied, pending (and why) or failed, and any fallback in force.
 * - `PUT /api/company/employees/:id/model` `{ model, effort? }`: record a choice and apply it
 *   (employee-model-service.ts); the reply says applied, pending or failed.
 *
 * Who may: the verified owner (no agent header), or an agent whose employee holds the owner-set
 * `manageModels` grant, for any employee of the same company including itself, through the same
 * exact revocable actor/target check as office and recovery actions (`CompanyService.modelAction`).
 * A title, an admin-list entry or a service token grants nothing here. An employee may always READ
 * its own model.
 *
 * @module web/routes/employee-model-routes
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CompanyError, type CompanyService } from '../../company-service.js';
import type { CompanyEmployee } from '../../company-types.js';
import { EmployeeModelError, type EmployeeModelService, type ModelEmployee } from '../../employee-model-service.js';
import { MODEL_EFFORTS } from '../../employee-model-store.js';
import { NO_OWNER, type OwnerVerifier } from '../../owner-auth/marks.js';
import { SESSION_MODEL_ID_PATTERN } from '../../types/session.js';
import { appendAdminAudit } from '../admin-audit.js';
import type { SessionPort } from '../ports/session-port.js';
import { ownerFor, parseBody, resolveParentSessionId } from '../route-helpers.js';

const ChoiceSchema = z
  .object({
    model: z.string().max(100).regex(SESSION_MODEL_ID_PATTERN, 'Give a Claude model id such as claude-opus-5-5'),
    effort: z.enum(MODEL_EFFORTS).optional(),
  })
  .strict();

export interface EmployeeModelRouteDeps {
  ctx: Pick<SessionPort, 'sessions'>;
  company: Pick<CompanyService, 'view' | 'modelAction'>;
  models: Pick<EmployeeModelService, 'status' | 'choose'>;
  verifiedOwner?: OwnerVerifier;
  /** The audit trail; defaults to the admin audit log. */
  audit?: typeof appendAdminAudit;
}

/** The fields the model service reads off a company employee. */
export function modelEmployee(employee: CompanyEmployee): ModelEmployee {
  return {
    id: employee.id,
    name: employee.name,
    owner: employee.owner,
    sessionId: employee.sessionId,
    onVacation: employee.onVacation,
    desiredRunning: employee.desiredRunning,
    mode: employee.runtimeRecipe?.mode,
  };
}

export function registerEmployeeModelRoutes(app: FastifyInstance, deps: EmployeeModelRouteDeps): void {
  const verifiedOwner = deps.verifiedOwner ?? NO_OWNER;
  const audit = deps.audit ?? appendAdminAudit;
  const run = async <T>(reply: { code(code: number): unknown }, work: () => Promise<T>) => {
    try {
      return { success: true, data: await work() };
    } catch (error) {
      if (!(error instanceof CompanyError) && !(error instanceof EmployeeModelError)) throw error;
      reply.code(error.status);
      return { success: false, error: error.message };
    }
  };

  /** The caller and a closure that rechecks its authority; throws 403/404 otherwise. */
  const authority = (req: FastifyRequest, id: string, read: boolean) => {
    const owner = ownerFor(req);
    const target = deps.company.view(owner).employees.find((e) => e.id === id);
    if (!target) throw new CompanyError('Unknown company employee', 404);
    const agentHeader = req.headers['x-reverie-parent-session'] !== undefined;
    const service = req.headers['x-reverie-service-token'] !== undefined;
    if (verifiedOwner(req) && !agentHeader && !service) return { target, by: 'owner', current: () => true };
    const self = service ? undefined : resolveParentSessionId(deps.ctx, req, undefined, owner);
    if (!self) throw new CompanyError('Employee model permission is required', 403);
    const actor = deps.company.view(owner).employees.find((e) => e.sessionId === self);
    if (read && target.sessionId === self) return { target, by: `employee ${target.name}`, current: () => true };
    const action = deps.company.modelAction(id, owner, self);
    return { target, by: `employee ${actor?.name ?? self}`, current: () => action.current() };
  };

  app.get('/api/company/employees/:id/model', async (req, reply) =>
    run(reply, async () => {
      const { target } = authority(req, (req.params as { id: string }).id, true);
      return deps.models.status(modelEmployee(target));
    })
  );

  app.put('/api/company/employees/:id/model', async (req, reply) =>
    run(reply, async () => {
      const id = (req.params as { id: string }).id;
      const { target, by, current } = authority(req, id, false);
      const choice = parseBody(ChoiceSchema, req.body);
      if (!current()) throw new CompanyError('Model permission or employee binding changed', 409);
      const status = await deps.models.choose(modelEmployee(target), choice, by);
      void audit({
        admin: by,
        action: 'employee_model',
        target: target.name,
        ip: req.ip,
        detail: { id, ...choice, state: status.state },
      });
      return status;
    })
  );
}
