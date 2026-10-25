/** Actual server-owned Goal composition. Private launch/bootstrap supplies provisioning; never HTTP input. */
import type { CompanyService } from './company-service.js';
import type { SessionManager } from './session-manager.js';
import type { ChatroomService } from './chatroom-service.js';
import type { OwnerAuthService } from './owner-auth/service.js';
import { GoalAccessError, type GoalAuthentication } from './goal-access.js';
import { GoalCanonicalAuthority } from './goal-canonical-authority.js';
import { GoalBrokerAuthentication, registerGoalBrokerBoundary, type GoalBrokerPorts } from './goal-broker-auth.js';
import { GoalNonceStore, type GoalNonceStoreOptions } from './goal-nonce-store.js';
import { createGoalServerBoundary, type GoalServerPorts } from './goal-server-integration.js';
import { CanonicalHealthMetadataReader } from './health-canonical-reader.js';
import { CanonicalRestMetadataReader } from './rest-canonical-metadata.js';
import type { CanonicalHealthBindingReader } from './session-health-provider.js';

/** Trusted in-process operator composition only; never parsed from HTTP, environment or company JSON.
 * Supplying these ports does not establish custody or authorize deployment. No test constants/default trust. */
export interface GoalServerProvisioning {
  readonly kind: 'canonical-goal-provisioning';
  /** Explicit trusted provisioning, never inferred from a request or a failed employee proof. */
  readonly mode: 'owner-only' | 'owner-and-employee';
  readonly issuer: GoalBrokerPorts['issuer'];
  readonly custody: Pick<GoalAuthentication, 'assertPrivateCustody'>;
  /** Pre-existing private ledger+lock; employee mode constructs the real backend. Owner-only retains namespace custody. */
  readonly nonce: GoalNonceStoreOptions;
  readonly now?: () => number;
  /** Release private bootstrap transport on server stop/start failure; grants no authority. */
  readonly close?: () => void;
}

/** Existing low-level trusted embedding/test injection is retained; the new production assembly uses provisioning.
 * Neither form is read from caller input. The ordinary launcher uses the explicit private bootstrap only. */
export type GoalServerInput = GoalServerProvisioning | GoalServerPorts;

export function createGoalServerAssembly(
  owner: Pick<OwnerAuthService, 'session'>,
  canonicalFile: string,
  input?: GoalServerInput
) {
  if (input && 'employee' in input) {
    if ('kind' in input) throw new GoalAccessError('Ambiguous Goal integration configuration');
    return {
      ...createGoalServerBoundary(owner, canonicalFile, input),
      metadataReader: undefined,
      restMetadataReader: new CanonicalRestMetadataReader(),
      attach: () => {},
    };
  }
  if (input && input.kind !== 'canonical-goal-provisioning')
    throw new GoalAccessError('Unsupported Goal integration configuration');
  const provisioning = input;
  if (provisioning && provisioning.mode !== 'owner-only' && provisioning.mode !== 'owner-and-employee')
    throw new GoalAccessError('Unsupported Goal integration mode');
  let authority: GoalCanonicalAuthority | undefined,
    attached = false;
  let metadata: CanonicalHealthMetadataReader | undefined;
  let restMetadata = new CanonicalRestMetadataReader();
  const restMetadataReader = {
    observe: (ownerId: string | undefined, employeeId: string) => restMetadata.observe(ownerId, employeeId),
    recoveryRead: (_ownerId: string, _employeeId: string) => null,
  };
  const metadataReader: CanonicalHealthBindingReader = {
    metadataBinding: (sessionId) => metadata?.metadataBinding(sessionId),
  };
  // Owner-only never constructs the employee verifier or touches issuer/nonce ports.
  // Custody remains the SAME mandatory private canonical/namespace projection.
  const employee: GoalAuthentication =
    provisioning?.mode === 'owner-only'
      ? {
          authenticate: async () => {
            throw new GoalAccessError('Employee Goal authentication disabled');
          },
          assertCurrent: () => {
            throw new GoalAccessError('Employee Goal authentication disabled');
          },
          assertPrivateCustody: (file) => provisioning.custody.assertPrivateCustody(file),
        }
      : new GoalBrokerAuthentication(
          provisioning?.mode === 'owner-and-employee'
            ? {
                canonicalFile,
                issuer: provisioning.issuer,
                binding: (sessionId) => authority?.binding(sessionId),
                assertPrivateCustody: (file) => provisioning.custody.assertPrivateCustody(file),
                nonces: new GoalNonceStore(provisioning.nonce),
                now: provisioning.now,
              }
            : undefined
        );
  const boundary = createGoalServerBoundary(
    owner,
    canonicalFile,
    provisioning
      ? {
          employee,
          registerEmployeeBoundary: (app) => {
            if (employee instanceof GoalBrokerAuthentication) registerGoalBrokerBoundary(app, employee);
            else
              app.addHook('onRequest', async (request, reply) => {
                if (Object.keys(request.headers).some((name) => name.startsWith('x-reverie-goal-')))
                  await reply
                    .code(403)
                    .send({ success: false, errorCode: 'GOAL_FORBIDDEN', error: 'Goal request refused' });
              });
          },
          assertAction: (action, principal, request) => {
            if (!authority) throw new GoalAccessError('Canonical Goal services not attached');
            authority.assertAction(action, principal, request);
          },
        }
      : undefined
  );
  return {
    ...boundary,
    metadataReader,
    restMetadataReader,
    attach(
      company: CompanyService,
      sessions: Pick<SessionManager, 'getSession'> & Partial<Pick<SessionManager, 'restSessionMetadata'>>,
      retirement: Pick<ChatroomService, 'isRetired'>
    ): void {
      if (attached || company.store.file !== canonicalFile)
        throw new GoalAccessError('Canonical Goal service attachment refused');
      attached = true;
      if (provisioning) {
        if (sessions.restSessionMetadata) {
          restMetadata = new CanonicalRestMetadataReader({
            company,
            sessions: { restSessionMetadata: (id) => sessions.restSessionMetadata!(id) },
            custody: provisioning.custody,
          });
        }
        authority = new GoalCanonicalAuthority({ company, sessions, retirement, owner, custody: provisioning.custody });
        metadata = new CanonicalHealthMetadataReader({
          store: company.store,
          sessions,
          retirement,
          custody: provisioning.custody,
        });
      }
    },
  };
}
