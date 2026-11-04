/** Purpose-authenticated recovery of one recorded move. No session effects are delegated. */
import type { RecoveryAuthority } from './worker-recovery-auth.js';
import { expertRuntimeRecipe } from './expert-runtime-recipe.js';
import { planMoveExecutor, type PlanMoveRuntime } from './plan-move-runtime.js';
import { PlanMoveError, type PlanMoveExecutor, type PlanMoveRecord } from './plan-move.js';
import { isMultiUserMode } from './config/multiuser.js';

export interface PlanJournalRecovery {
  readonly owner: string | undefined;
  readonly employeeId: string;
  readonly sessionId: string;
  assertCurrent(): void;
  inspect(record: Readonly<PlanMoveRecord>): PlanMoveExecutor;
}
export function agentPlanJournalRecovery(
  authority: RecoveryAuthority,
  employeeId: string,
  runtime: Omit<PlanMoveRuntime, 'authorized' | 'request'>
): PlanJournalRecovery | undefined {
  if (isMultiUserMode()) return undefined;
  const owner = authority.owner;
  const employees = () => runtime.company.view(owner).employees;
  const caller = runtime.sessions.get(authority.sessionId);
  const target = employees().find((e) => e.id === employeeId);
  const targetSession = target && runtime.sessions.get(target.sessionId);
  if (!caller || !target) return undefined;
  const bindingKey = (employee: typeof target) =>
    JSON.stringify([
      employee.sessionId,
      employee.sessionGeneration,
      employee.runtimeRecipe,
      employee.desiredRunning,
      employee.onVacation,
      employee.bindingMigration,
    ]);
  const binding = bindingKey(target);
  const recipe = targetSession && JSON.stringify(expertRuntimeRecipe(targetSession));
  const assertCurrent = () => {
    authority.assertCurrent();
    const delegate = employees().find((e) => e.id === authority.employeeId);
    const current = employees().find((e) => e.id === employeeId);
    if (
      runtime.sessions.get(authority.sessionId) !== caller ||
      caller.owner !== owner ||
      !delegate ||
      !current ||
      current.owner !== owner ||
      bindingKey(current) !== binding ||
      runtime.sessions.get(current.sessionId) !== targetSession ||
      (targetSession &&
        (targetSession.owner !== owner || JSON.stringify(expertRuntimeRecipe(targetSession)) !== recipe)) ||
      !(delegate.permissions.managePlans || (delegate.id === employeeId && delegate.permissions.moveOwnPlan))
    )
      throw new PlanMoveError('The delegated move permission or exact employee binding changed', 403);
  };
  try {
    assertCurrent();
  } catch {
    return undefined;
  }
  return {
    owner,
    employeeId: authority.employeeId,
    sessionId: authority.sessionId,
    assertCurrent,
    inspect(record) {
      assertCurrent();
      if (
        !targetSession ||
        record.employeeId !== employeeId ||
        record.owner !== owner ||
        record.newSession !== target.sessionId
      )
        throw new PlanMoveError('Recovery requires the exact recorded current destination', 403);
      const fixed = JSON.stringify(record);
      const authorized = () => {
        try {
          assertCurrent();
          return true;
        } catch {
          return false;
        }
      };
      const unavailable = async (): Promise<never> => {
        throw new PlanMoveError('Journal recovery cannot launch, stop or write to a provider', 403);
      };
      const executor = planMoveExecutor(
        {
          ...runtime,
          authorized,
          actor: authority.sessionId,
          request: unavailable,
          cleanup: unavailable,
          resourceReplacement: undefined,
        },
        owner
      );
      // Expose only native inspection and audit. Neither route can accidentally gain
      // the full executor's create/start/cleanup authority through this adapter.
      return {
        ...executor,
        create: unavailable,
        start: unavailable,
        stop: unavailable,
        beforeStop: unavailable,
        rebind: unavailable,
        ready: unavailable,
        snapshot: unavailable,
        verifyRecovery: async (row) => {
          assertCurrent();
          if (JSON.stringify(row) !== fixed) throw new PlanMoveError('The recorded recovery changed', 403);
          const fence = await executor.verifyRecovery!(row);
          assertCurrent();
          return () => {
            assertCurrent();
            fence();
          };
        },
        audit: async (row) => {
          assertCurrent();
          await executor.audit(row);
          assertCurrent();
        },
      };
    },
  };
}
