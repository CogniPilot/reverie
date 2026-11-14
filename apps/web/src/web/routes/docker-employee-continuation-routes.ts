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
} from '../../docker-employee-continuation.js';
import {
  DockerEmployeeContinuationRequest,
  DockerEmployeeResourcePolicy,
} from '../../docker-employee-continuation-data.js';
import { CompanyDockerContinuationStore } from '../../docker-employee-store.js';
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
  proposal?: (employeeId: string) => DockerPolicyProposal | undefined
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
      if (error instanceof DockerEmployeeContinuationError)
        return reply.code(error.status).send({ success: false, error: { code: error.code } });
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
  app.get('/api/company/employees/:id/docker-policy', async (req, reply) =>
    run(reply, async () => {
      const employeeId = uuid.parse((req.params as { id: string }).id),
        authority = capture(req, employeeId);
      const selection = await service.selection(employeeId, authority);
      const policy = company.store
        .snapshot()
        .employees.find(
          (employee) => employee.id === employeeId && employee.owner === authority.owner
        )?.dockerResourcePolicy;
      const proposed = policy ? undefined : proposal?.(employeeId);
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
      return service.begin(employeeId, body.request, authority);
    })
  );
  app.post('/api/company/employees/:id/docker-continuation/observe', async (req, reply) =>
    run(reply, async () => {
      const employeeId = uuid.parse((req.params as { id: string }).id),
        body = z.object({ operationId: uuid }).strict().parse(req.body);
      return service.observe(employeeId, body.operationId, capture(req, employeeId));
    })
  );
}
