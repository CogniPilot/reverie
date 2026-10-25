/** R2-G7-RESULT regression: all mutation/replay outputs obey full-read custody. No live sockets. */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { GoalLifecycle, type GoalCommandResult } from '../src/goal-lifecycle.js';
import { registerGoalRoutes } from '../src/web/routes/goal-routes.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

describe('Goal mutation and replay response privacy', () => {
  let f: Awaited<ReturnType<typeof goalFixture>>;
  const apps: FastifyInstance[] = [];
  beforeEach(async () => {
    f = await goalFixture();
    f.createInput.objective = 'PRIVATE_OBJECTIVE_SENTINEL';
    f.createInput.nextAction = 'PRIVATE_CREATION_SENTINEL';
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    await f.cleanup();
  });
  const headers = (actor: string) => ({ authorization: 'Bearer synthetic-' + actor });
  const restricted = (result: GoalCommandResult) => {
    expect(result.visibility).toBe('verification');
    expect(Object.keys(result.goal).sort()).toEqual(
      ['id', 'generation', 'sessionId', 'sessionGeneration', 'state', 'transitionSequence', 'updatedAt'].sort()
    );
    expect(Object.keys(JSON.parse(JSON.stringify(result.receipt))).sort()).toEqual(
      [
        'transitionId',
        'sequence',
        'generation',
        'from',
        'to',
        'actorKind',
        'actorEmployeeId',
        'actorSessionId',
        'actorSessionGeneration',
        'authorityId',
        'operation',
        'at',
      ].sort()
    );
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_|objective|nextAction|creation|transitions|evidence|inputDigests|requestDigest|after|blocker|owner/
    );
  };

  for (const transport of ['core', 'http'] as const)
    it.each(['DONE', 'NO_GO', 'ACTIVE'] as const)(`${transport}: scopes %s decisions and every replay`, async (to) => {
      const active = await f.active();
      const progressed = await f.move(active, 'ACTIVE', 'worker', {
        nextAction: 'PRIVATE_HISTORY_SENTINEL',
        evidenceRefs: ['evidence:sha256:' + 'b'.repeat(64)],
      });
      const reviewed = await f.move(progressed, 'REVIEW', 'worker', { nextAction: 'PRIVATE_REVIEW_SENTINEL' });
      const grant = await f.grant(reviewed);
      const command = f.command(reviewed, to, {
        verifierGrantId: grant.id,
        nextAction: 'PRIVATE_DECISION_SENTINEL',
        evidenceRefs: ['evidence:sha256:' + 'c'.repeat(64)],
      });
      const app = Fastify();
      apps.push(app);
      registerGoalRoutes(app, f.store, f.auth, () => f.clock.now);
      const call = async () => {
        if (transport === 'core') return f.goals.transition(command, 'verifier');
        const { goalId, ...payload } = command;
        const response = await app.inject({
          method: 'POST',
          url: `/api/goals/${goalId}/transitions`,
          headers: headers('verifier'),
          payload,
        });
        expect(response.statusCode).toBe(200);
        return response.json().data as GoalCommandResult;
      };
      await expect(f.goals.get(reviewed.id, 'verifier')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
      expect((await app.inject({ url: `/api/goals/${reviewed.id}`, headers: headers('verifier') })).statusCode).toBe(
        403
      );
      expect((await app.inject({ url: '/api/goals', headers: headers('verifier') })).json().data).toEqual([]);
      const result = await call();
      restricted(result);
      expect(result.goal.state).toBe(to);
      expect(await call()).toEqual(result);
      const reopenedStore = new CompanyStore(f.file);
      await reopenedStore.init();
      const reopened = new GoalLifecycle(reopenedStore, () => f.clock.now, f.auth);
      expect(await reopened.transition(command, 'verifier')).toEqual(result);
      const worker = await f.goals.get(reviewed.id, 'worker');
      expect(worker).toMatchObject({ objective: 'PRIVATE_OBJECTIVE_SENTINEL', state: to });
      expect(worker.creation.nextAction).toBe('PRIVATE_CREATION_SENTINEL');
      expect(worker.transitions).toHaveLength(5);
      expect(worker.evidenceRefs).toHaveLength(2);
      expect((await app.inject({ url: `/api/goals/${reviewed.id}`, headers: headers('worker') })).json().data).toEqual(
        worker
      );
      expect(await f.goals.get(reviewed.id, 'owner')).toEqual(worker);
      // Metadata authority is not full-read authority and cannot enlarge a mutation/replay response.
      await f.goals.issueGrant(
        { kind: 'METADATA_READ', employeeId: 'v', targetEmployeeId: 'w', expiresAt: 2000 },
        'owner'
      );
      restricted(await call());
      if (to === 'ACTIVE') {
        await f.move(worker, 'REVIEW');
        expect(await call()).toEqual(result); // original closed view, not current-state or history data
      } else {
        const reopenedResult = await f.goals.transition(f.command(worker, 'ACTIVE'), 'owner');
        expect(reopenedResult.visibility).toBe('full');
        if (reopenedResult.visibility !== 'full') throw new Error('Owner must retain full-read authority');
        expect(reopenedResult.goal.objective).toBe('PRIVATE_OBJECTIVE_SENTINEL');
        await expect(f.goals.transition(command, 'verifier')).rejects.toMatchObject({ code: 'GOAL_CONFLICT' });
      }
    });

  it('retains coherent full worker/owner historical replies and denies revoked verifier replays', async () => {
    const initial = await f.create();
    const assign = f.command(initial, 'ASSIGNED');
    const first = await f.goals.transition(assign, 'worker');
    expect(first.visibility).toBe('full');
    if (first.visibility !== 'full') throw new Error('Worker response unexpectedly restricted');
    expect(first.goal.objective).toBe('PRIVATE_OBJECTIVE_SENTINEL');
    expect(first.receipt.after.nextAction).toBe('Continue');
    const active = await f.move(first.goal, 'ACTIVE');
    expect(await f.goals.transition(assign, 'worker')).toEqual(first);
    const reviewed = await f.move(active, 'REVIEW');
    const grant = await f.grant(reviewed);
    const decision = f.command(reviewed, 'DONE', { verifierGrantId: grant.id });
    restricted(await f.goals.transition(decision, 'verifier'));
    await f.goals.revokeGrant(grant.id, 'owner');
    await expect(f.goals.transition(decision, 'verifier')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    const app = Fastify();
    apps.push(app);
    registerGoalRoutes(app, f.store, f.auth, () => f.clock.now);
    const { goalId, ...payload } = decision;
    const denied = await app.inject({
      method: 'POST',
      url: `/api/goals/${goalId}/transitions`,
      headers: headers('verifier'),
      payload,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toMatch(/PRIVATE_|objective|nextAction|creation|evidence/);
    f.revoked.add('verifier');
    await expect(f.goals.transition(decision, 'verifier')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  });
});
