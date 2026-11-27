import type { DockerWorkerReattachHelper } from '../../docker-worker-reattach-helper.js';
import type { DockerPoolReconciliation } from '../../docker-pool-reconciliation.js';
import type { DockerLaptopLimitUpkeep } from '../../docker-laptop-limit-upkeep.js';
import { dockerReprovisionHoldDetail, type DockerAbsentReprovision } from '../../docker-absent-reprovision.js';
import type { DockerPolicyProposal } from '../../docker-employee-policy-import.js';
/** Thin transport for the shared boxed recovery decision owner. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { CompanyError, CompanyService } from '../../company-service.js';
import {
  DockerEmployeeContinuation,
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
  type DockerContinuationResult,
} from '../../docker-employee-continuation.js';
import { describeDockerProviderExit } from '../../docker-provider-exit.js';
import {
  DockerEmployeeContinuationRequest,
  DockerEmployeeResourcePolicy,
} from '../../docker-employee-continuation-data.js';
import { CompanyDockerContinuationStore } from '../../docker-employee-store.js';
import { sameOrigin } from '../../owner-auth/policy.js';
import { dockerRecoveryGuidance } from '../../docker-recovery-guidance.js';
const uuid = z
  .string()
  .uuid()
  .refine((v) => v === v.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const policyApproval = z
  .object({
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    expectedSourceDigest: digest,
    policy: DockerEmployeeResourcePolicy,
  })
  .strict();
const start = z
  .object({ request: DockerEmployeeContinuationRequest, policyApproval: policyApproval.optional() })
  .strict();
/** A hold whose provider is known to have exited says so in a sentence. The
 * code stays the contract; the sentence is for the person reading it. */
function described(result: DockerContinuationResult): DockerContinuationResult {
  return result.providerExit && !result.message
    ? { ...result, message: describeDockerProviderExit(result.providerExit) }
    : result;
}
export interface DockerContinuationVerifiedWorker {
  readonly owner: string | undefined;
  readonly sessionId: string;
  require(): void;
}
export interface DockerContinuationRouteAuthentication {
  verifiedOwner(request: FastifyRequest): boolean;
  /** Actual request-bound private worker credential proof; a parent header is not identity. */
  worker(request: FastifyRequest): DockerContinuationVerifiedWorker | undefined;
  owner(request: FastifyRequest): string | undefined;
}
export function registerDockerEmployeeContinuationRoutes(
  app: FastifyInstance,
  company: CompanyService,
  store: CompanyDockerContinuationStore,
  service: DockerEmployeeContinuation,
  auth: DockerContinuationRouteAuthentication,
  proposal?: (employeeId: string) => DockerPolicyProposal | undefined,
  pool?: DockerPoolReconciliation,
  recoveryHelper?: DockerWorkerReattachHelper,
  absent?: DockerAbsentReprovision,
  limits?: DockerLaptopLimitUpkeep
): void {
  const human = (req: FastifyRequest) =>
    req.headers['x-reverie-parent-session'] === undefined &&
    req.headers['x-reverie-worker-identity'] === undefined &&
    req.headers['x-reverie-service-token'] === undefined &&
    auth.verifiedOwner(req);
  const capture = (req: FastifyRequest, employeeId: string): DockerContinuationAuthority => {
    const worker = auth.worker(req),
      owner = worker ? worker.owner : auth.owner(req);
    if (!worker && !human(req))
      throw new CompanyError('Verified owner or scoped worker recovery permission required', 403);
    const recovery = company.recoveryAction(employeeId, owner, worker?.sessionId);
    const requireIdentity = () => {
      if (worker) worker.require();
      else if (!human(req)) throw new CompanyError('Owner authorization changed', 403);
    };
    requireIdentity();
    recovery.require();
    return {
      owner,
      require() {
        requireIdentity();
        recovery.require();
      },
      requireOffice() {
        requireIdentity();
        company.officeAction(employeeId, owner, worker?.sessionId).require();
      },
    };
  };
  const run = async (reply: import('fastify').FastifyReply, body: () => Promise<unknown>) => {
    try {
      return { success: true, data: await body() };
    } catch (error) {
      if (error instanceof DockerEmployeeContinuationError) {
        // The code stays the contract; a sentence and the next step ride along
        // for the refusals a person or managing agent has to act on.
        const guidance = dockerRecoveryGuidance(error.code),
          detail = error.cause as
            | { networkCandidates?: unknown; pendingOperationId?: unknown; foreignHelpers?: unknown }
            | undefined,
          candidates = detail?.networkCandidates,
          pending = detail?.pendingOperationId,
          helpers = detail?.foreignHelpers;
        return reply.code(error.status).send({
          success: false,
          error: {
            code: error.code,
            ...(guidance ? { message: guidance.message, allowedActions: guidance.allowedActions } : {}),
            ...(Array.isArray(candidates) && candidates.every((name) => typeof name === 'string')
              ? { networkCandidates: candidates }
              : {}),
            ...(typeof pending === 'string' && /^[0-9a-f-]{36}$/.test(pending) ? { pendingOperationId: pending } : {}),
            ...(Array.isArray(helpers) && helpers.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))
              ? { foreignHelpers: helpers }
              : {}),
            // A refusal before anything was recorded names the same two facts a hold does.
            ...dockerReprovisionHoldDetail(error),
          },
        });
      }
      if (error instanceof CompanyError)
        return reply
          .code(error.status)
          .send({ success: false, error: { code: 'DOCKER_CONTINUATION_REFUSED', message: error.message } });
      if (error instanceof ZodError)
        return reply.code(400).send({ success: false, error: { code: 'DOCKER_CONTINUATION_INVALID_INPUT' } });
      return reply
        .code(409)
        .send({ success: false, error: { code: 'DOCKER_CONTINUATION_UNCONFIRMED', allowedActions: ['observe'] } });
    }
  };
  if (recoveryHelper) {
    app.post('/api/company/employees/:id/docker-storage/device-approval', async (req, reply) =>
      run(reply, async () => {
        if (!human(req) || !sameOrigin(req)) throw new CompanyError('A signed-in owner is required', 403);
        const id = uuid.parse((req.params as { id: string }).id);
        const authority = capture(req, id);
        const employee = company.store.snapshot().employees.find(member => member.id === id);
        const row = store.record(id);
        if (!row || !employee || employee.owner !== authority.owner || row.owner !== authority.owner ||
            employee.sessionId !== row.request.sessionId || employee.sessionGeneration !== row.request.sessionGeneration ||
            employee.dockerBinding?.containerId !== row.destination?.containerId || !row.destination ||
            !employee.desiredRunning || employee.onVacation) throw new CompanyError('Current worker binding required', 409);
        authority.require();
        recoveryHelper.approveStorage(row, req.body);
        return { state: 'approved', operationId: row.request.operationId };
      })
    );
  }
  if (absent) {
    // Owner only. A worker identity, parent session or service token never
    // retires a record or defines a laptop, whatever its recovery permission.
    const owner = (req: FastifyRequest) => {
      if (!human(req) || !sameOrigin(req))
        throw new CompanyError('Verified same-origin owner required to reprovision an absent laptop', 403);
      const id = uuid.parse((req.params as { id: string }).id);
      return { id, authority: capture(req, id) };
    };
    app.post('/api/company/employees/:id/docker-absent/preview', async (req, reply) =>
      run(reply, async () => {
        const { id, authority } = owner(req);
        const body = z.object({ template: z.unknown() }).strict().parse(req.body);
        const preview = await absent.preview(id, body.template, authority);
        // A preview that offers no action says why and where to go instead.
        const guidance = preview.code ? dockerRecoveryGuidance(preview.code) : undefined;
        return guidance ? { ...preview, message: guidance.message, nextActions: guidance.allowedActions } : preview;
      })
    );
    app.post('/api/company/employees/:id/docker-absent/reprovision', async (req, reply) =>
      run(reply, async () => {
        const { id, authority } = owner(req);
        const result = await absent.reprovision(id, req.body, authority);
        // A held operation says why, as the rebuild below does.
        const guidance = result.code ? dockerRecoveryGuidance(result.code) : undefined;
        return guidance ? { ...result, message: guidance.message, nextActions: guidance.allowedActions } : result;
      })
    );
    // "Rebuild laptop": the same owner-only authentication, on its own routes so
    // that nothing sent to the absent-laptop workflow above can ever select the
    // authority to stop a running laptop or discard a live terminal.
    app.post('/api/company/employees/:id/docker-rebuild/preview', async (req, reply) =>
      run(reply, async () => {
        const { id, authority } = owner(req);
        const body = z.object({ template: z.unknown() }).strict().parse(req.body);
        const preview = await absent.previewRebuild(id, body.template, authority);
        const guidance = 'code' in preview && preview.code ? dockerRecoveryGuidance(preview.code) : undefined;
        return {
          ...preview,
          message:
            guidance?.message ??
            'Rebuilding discards the listed containers and the conversation in the laptop terminal. The employee, ' +
              'their home directory, shared Nix store, scratch space, memories and session identity are kept, and a ' +
              'fresh laptop source is created on their current plan. Confirm with the scope digest, then continue ' +
              'the laptop until it is ready.',
        };
      })
    );
    app.post('/api/company/employees/:id/docker-rebuild/apply', async (req, reply) =>
      run(reply, async () => {
        const { id, authority } = owner(req);
        const result = await absent.rebuild(id, req.body, authority);
        const guidance = result.code ? dockerRecoveryGuidance(result.code) : undefined;
        return {
          ...result,
          message:
            result.state === 'ready'
              ? 'The old laptop is discarded and a fresh source exists. Read the resource policy, then continue the ' +
                'laptop until it reports ready.'
              : (guidance?.message ??
                'The rebuild is recorded but not finished. Send the same request again to continue it.'),
          allowedActions: result.state === 'ready' ? ['continue'] : (guidance?.allowedActions ?? ['retry']),
        };
      })
    );
  }
  if (pool) {
    app.get('/api/company/employees/:id/docker-pool/cold-preview', async (req, reply) =>
      run(reply, async () => {
        if (!human(req)) throw new CompanyError('Verified owner required for shared pool recovery', 403);
        const id = uuid.parse((req.params as { id: string }).id);
        return pool.coldPreview(id, capture(req, id));
      })
    );
    app.post('/api/company/employees/:id/docker-pool/cold-recover', async (req, reply) =>
      run(reply, async () => {
        if (!human(req) || !sameOrigin(req))
          throw new CompanyError('Verified same-origin owner required for shared pool recovery', 403);
        const id = uuid.parse((req.params as { id: string }).id);
        const input = z.object({
          operationId: uuid,
          sessionId: uuid,
          sessionGeneration: z.number().int().positive().safe(),
          expectedScopeDigest: digest,
        }).strict().parse(req.body);
        return pool.coldRecover(id, input, capture(req, id));
      })
    );
    // Finishes a recovery that was issued and has not finished, as itself. It
    // takes nothing: what is left to do is decided from the journal and from
    // fresh reads. With no unfinished recovery it answers with the pool status.
    app.post('/api/company/employees/:id/docker-pool/cold-resume', async (req, reply) =>
      run(reply, async () => {
        if (!human(req) || !sameOrigin(req))
          throw new CompanyError('Verified same-origin owner required for shared pool recovery', 403);
        const id = uuid.parse((req.params as { id: string }).id);
        z.object({}).strict().parse(req.body ?? {});
        return pool.coldResume(id, capture(req, id));
      })
    );
    // Removes the pool's anchor while the Engine reports it dead, which the
    // supervisor also does. It takes nothing: every fact is read again.
    app.post('/api/company/employees/:id/docker-pool/remove-dead-anchor', async (req, reply) =>
      run(reply, async () => {
        if (!human(req) || !sameOrigin(req))
          throw new CompanyError('Verified same-origin owner required for shared pool recovery', 403);
        const id = uuid.parse((req.params as { id: string }).id);
        z.object({}).strict().parse(req.body ?? {});
        return pool.removeDeadAnchor(id, capture(req, id));
      })
    );
    app.get('/api/company/employees/:id/docker-pool/status', async (req, reply) =>
      run(reply, async () => {
        const id = uuid.parse((req.params as { id: string }).id);
        return pool.status(id, capture(req, id));
      })
    );
    // Puts the already approved limits of the running pool back in place. It
    // takes no policy: the only thing a caller chooses is to confirm the hold
    // that the status read named. The same recovery permission as reconcile.
    app.post('/api/company/employees/:id/docker-pool/repair', async (req, reply) =>
      run(reply, async () => {
        const id = uuid.parse((req.params as { id: string }).id);
        const input = z
          .object({
            sessionId: uuid,
            sessionGeneration: z.number().int().positive().safe(),
            expectedScopeDigest: digest,
          })
          .strict()
          .parse(req.body);
        return pool.repair(id, input, capture(req, id));
      })
    );
    app.post('/api/company/employees/:id/docker-pool/reconcile', async (req, reply) =>
      run(reply, async () => {
        const id = uuid.parse((req.params as { id: string }).id);
        const input = z
          .object({
            sessionId: uuid,
            sessionGeneration: z.number().int().positive().safe(),
            expectedScopeDigest: digest,
          })
          .strict()
          .parse(req.body);
        return pool.reconcile(id, input, capture(req, id));
      })
    );
  }
  app.get('/api/company/employees/:id/docker-policy', async (req, reply) =>
    run(reply, async () => {
      const employeeId = uuid.parse((req.params as { id: string }).id),
        authority = capture(req, employeeId);
      const selection = await service.selection(employeeId, authority);
      const approved = company.store
        .snapshot()
        .employees.find(
          (employee) => employee.id === employeeId && employee.owner === authority.owner
        )?.dockerResourcePolicy;
      const policy = approved ? store.policy(employeeId) : undefined;
      const rawProposal = policy ? undefined : proposal?.(employeeId);
      const proposedPolicy = rawProposal ? store.newPolicy(employeeId, rawProposal.policy) : undefined;
      const proposed =
        rawProposal && proposedPolicy
          ? { ...rawProposal, policy: proposedPolicy, policyDigest: dockerContinuationDigest(proposedPolicy) }
          : undefined;
      authority.require();
      return {
        ...selection,
        ...(proposed
          ? {
              proposedPolicy: proposed.policy,
              proposedPolicyDigest: proposed.policyDigest,
              proposalSourceDigest: proposed.sourceDigest,
            }
          : {}),
        policy: policy ?? null,
        policyDigest: policy ? dockerContinuationDigest(policy) : null,
        enforcement: 'unverified',
        allowedActions: selection.operationId
          ? ['observe']
          : policy
            ? ['continue']
            : human(req)
              ? ['approve-policy']
              : [],
        canApprovePolicy: human(req) && selection.operationId === null,
        ...(policy ? {} : { code: 'DOCKER_CONTINUATION_OWNER_POLICY_REQUIRED' }),
      };
    })
  );
  app.put('/api/company/employees/:id/docker-policy', async (req, reply) =>
    run(reply, async () => {
      if (!human(req)) throw new CompanyError('Only the verified owner may approve resource policy', 403);
      const employeeId = uuid.parse((req.params as { id: string }).id),
        approval = policyApproval.parse(req.body),
        authority = capture(req, employeeId);
      const current = () => {
        if (!human(req)) throw new CompanyError('Owner authorization changed', 403);
        authority.require();
        const subject = store.subject(employeeId);
        if (
          !subject ||
          subject.sessionId !== approval.sessionId ||
          subject.sessionGeneration !== approval.sessionGeneration ||
          subject.sourceDigest !== approval.expectedSourceDigest
        )
          throw new CompanyError('Original employee runtime changed', 409);
      };
      current();
      await store.savePolicy(employeeId, authority.owner, approval.policy, current);
      current();
      return {
        policy: approval.policy,
        policyDigest: dockerContinuationDigest(approval.policy),
        state: 'desired-policy-saved',
        enforcement: 'unverified',
      };
    })
  );
  app.post('/api/company/employees/:id/docker-continuation', async (req, reply) =>
    run(reply, async () => {
      const employeeId = uuid.parse((req.params as { id: string }).id),
        body = start.parse(req.body),
        authority = capture(req, employeeId);
      if (body.policyApproval) {
        if (!human(req)) throw new CompanyError('Recovery permission does not authorize resource policy edits', 403);
        const approval = body.policyApproval;
        if (
          approval.sessionId !== body.request.sessionId ||
          approval.sessionGeneration !== body.request.sessionGeneration ||
          dockerContinuationDigest(approval.policy) !== body.request.expectedPolicyDigest
        )
          throw new CompanyError('Policy approval differs from continuation', 409);
        const current = () => {
          authority.require();
          if (!human(req)) throw new CompanyError('Owner authorization changed', 403);
          const subject = store.subject(employeeId);
          if (
            !subject ||
            subject.sourceDigest !== approval.expectedSourceDigest ||
            subject.sessionId !== approval.sessionId ||
            subject.sessionGeneration !== approval.sessionGeneration
          )
            throw new CompanyError('Original employee runtime changed', 409);
        };
        current();
        if (body.request.enterOffice) authority.requireOffice();
        await store.savePolicy(employeeId, authority.owner, approval.policy, current);
        current();
      }
      return described(await service.begin(employeeId, body.request, authority));
    })
  );
  // Re-applies the already approved limits of one running laptop in place. The set-up service answers every step
  // for an employee who is out of the office or stopped with DOCKER_CONTINUATION_OFFICE_CHANGED before it reads the
  // laptop, so for such an employee the repair that does not ask about attendance answers: `{ operationId, limits }`
  // with `unchanged` or `restored`. It attaches nothing, starts nothing and changes no attendance.
  app.post('/api/company/employees/:id/docker-continuation/repair', async (req, reply) =>
    run(reply, async () => {
      const employeeId = uuid.parse((req.params as { id: string }).id),
        body = z.object({ operationId: uuid }).strict().parse(req.body),
        authority = capture(req, employeeId),
        employee = company.store
          .snapshot()
          .employees.find((member) => member.id === employeeId && member.owner === authority.owner);
      if (limits && employee && (employee.onVacation || employee.desiredRunning !== true))
        return limits.restore(employeeId, body.operationId, authority);
      return described(await service.repair(employeeId, body.operationId, authority));
    })
  );
  app.post('/api/company/employees/:id/docker-continuation/observe', async (req, reply) =>
    run(reply, async () => {
      const employeeId = uuid.parse((req.params as { id: string }).id),
        body = z.object({ operationId: uuid }).strict().parse(req.body);
      return described(await service.observe(employeeId, body.operationId, capture(req, employeeId)));
    })
  );
}
