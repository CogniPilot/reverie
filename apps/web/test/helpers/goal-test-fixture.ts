/** Explicit synthetic authenticated/custody adapter for local Goal tests only. Never a runtime adapter. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanyStore } from '../../src/company-store.js';
import { EmployeeSchema, type GoalRecord, type GoalState } from '../../src/company-types.js';
import { GoalLifecycle, goalDigest } from '../../src/goal-lifecycle.js';
import { GoalAccessError, type GoalAuthentication, type GoalPrincipal } from '../../src/goal-access.js';

export async function goalFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goal-r2-'));
  const file = join(directory, 'company.json');
  const store = new CompanyStore(file);
  await store.init();
  await store.update((state) => {
    for (const [id, sessionId, owner] of [
      ['w', 's', 'a'],
      ['v', 'vs', 'a'],
      ['r', 'rs', 'a'],
      ['x', 'xs', 'b'],
    ])
      state.employees.push(
        EmployeeSchema.parse({
          id,
          owner,
          name: id,
          icon: 'W',
          position: 'Engineer',
          expertise: ['delivery'],
          sessionId,
          createdAt: 1,
        })
      );
  });
  const clock = { now: 1000 };
  const principals: Record<string, GoalPrincipal> = {
    owner: { kind: 'owner', owner: 'a' },
    otherOwner: { kind: 'owner', owner: 'b' },
    worker: { kind: 'employee', owner: 'a', employeeId: 'w', sessionId: 's', sessionGeneration: 1 },
    verifier: { kind: 'employee', owner: 'a', employeeId: 'v', sessionId: 'vs', sessionGeneration: 1 },
    reader: { kind: 'employee', owner: 'a', employeeId: 'r', sessionId: 'rs', sessionGeneration: 1 },
  };
  const revoked = new Set<string>();
  const custody = { ready: true };
  const token = (context: unknown): string | undefined =>
    typeof context === 'string'
      ? context
      : (context as { headers?: Record<string, string> })?.headers?.authorization?.replace(/^Bearer synthetic-/, '');
  const auth: GoalAuthentication = {
    authenticate: async (context) => {
      const key = token(context);
      return key && !revoked.has(key) && principals[key] ? structuredClone(principals[key]) : undefined;
    },
    assertCurrent: (principal, context) => {
      const key = token(context);
      if (!key || !principals[key] || revoked.has(key) || goalDigest(principals[key]) !== goalDigest(principal))
        throw new GoalAccessError('Synthetic credential revoked');
    },
    assertPrivateCustody: (path) => {
      if (!custody.ready || path !== file) throw new GoalAccessError('Synthetic custody unavailable');
    },
  };
  const goals = new GoalLifecycle(store, () => clock.now, auth);
  let sequence = 0;
  const createInput = {
    createId: 'create',
    employeeId: 'w',
    sessionId: 's',
    sessionGeneration: 1,
    objective: 'Synthetic Goal',
    nextAction: 'Accept',
    inputDigests: ['a'.repeat(64)],
  };
  const create = () => goals.create(createInput, 'worker');
  type FencedGoal = Pick<
    GoalRecord,
    'id' | 'generation' | 'state' | 'transitionSequence' | 'sessionId' | 'sessionGeneration'
  >;
  const fence = (goal: FencedGoal) => ({
    goalId: goal.id,
    generation: goal.generation,
    expectedState: goal.state,
    expectedSequence: goal.transitionSequence,
    sessionId: goal.sessionId,
    sessionGeneration: goal.sessionGeneration,
  });
  const command = (goal: FencedGoal, to: GoalState, extra: object = {}) => ({
    ...fence(goal),
    transitionId: 't-' + ++sequence,
    to,
    nextAction: 'Continue',
    ...extra,
  });
  // Chaining setup needs canonical worker fields; use an explicit owner read after verifier-only decisions.
  // Response privacy tests exercise transition() directly, never this fixture convenience.
  const move = async (goal: FencedGoal, to: GoalState, context = 'worker', extra: object = {}) => {
    const result = await goals.transition(command(goal, to, extra), context);
    return result.visibility === 'full' ? result.goal : goals.get(goal.id, 'owner');
  };
  const active = async () => move(await move(await create(), 'ASSIGNED'), 'ACTIVE');
  const review = async () => move(await active(), 'REVIEW');
  const grant = async (goal: GoalRecord, extra: object = {}) =>
    goals.issueGrant(
      {
        kind: 'VERIFY',
        employeeId: 'v',
        targetEmployeeId: 'w',
        goalId: goal.id,
        generation: goal.generation,
        expectedSequence: goal.transitionSequence,
        expiresAt: clock.now + 1000,
        ...extra,
      },
      'owner'
    );
  return {
    directory,
    file,
    store,
    clock,
    principals,
    revoked,
    custody,
    auth,
    goals,
    createInput,
    create,
    fence,
    command,
    move,
    active,
    review,
    grant,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
