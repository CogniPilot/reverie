import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { GoalLifecycle, goalDigest } from '../src/goal-lifecycle.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

describe('authenticated durable Goal lifecycle acceptance', () => {
  let f: Awaited<ReturnType<typeof goalFixture>>;
  beforeEach(async () => {
    f = await goalFixture();
  });
  afterEach(async () => {
    await f.cleanup();
  });

  it('persists canonical state and coherent immutable replay through restart and later progress', async () => {
    const initial = await f.create();
    const assign = f.command(initial, 'ASSIGNED');
    const first = await f.goals.transition(assign, 'worker');
    const active = await f.move(first.goal, 'ACTIVE');
    expect(await f.goals.transition(assign, 'worker')).toEqual(first);
    expect(await f.create()).toEqual(initial);
    const restarted = new CompanyStore(f.file);
    await restarted.init();
    const goals = new GoalLifecycle(restarted, () => f.clock.now, f.auth);
    expect(await goals.transition(assign, 'worker')).toEqual(first);
    expect((await goals.get(initial.id, 'owner')).state).toBe(active.state);
    expect(JSON.parse(await readFile(f.file, 'utf8')).goals).toHaveLength(1);
  });

  it('migrates legacy company data without another status store', async () => {
    const old = JSON.parse(await readFile(f.file, 'utf8'));
    delete old.goals;
    delete old.goalGrants;
    delete old.employees[0].sessionGeneration;
    await writeFile(f.file, JSON.stringify(old));
    const store = new CompanyStore(f.file);
    await store.init();
    expect(store.snapshot().goals).toEqual([]);
    expect(store.snapshot().goalGrants).toEqual([]);
    expect(store.snapshot().employees[0].sessionGeneration).toBe(1);
  });

  it('defaults inaccessible and rejects caller-supplied owner/verifier actors or grant objects', async () => {
    const unavailable = new GoalLifecycle(f.store);
    await expect(unavailable.create(f.createInput, { kind: 'owner', owner: 'a' })).rejects.toMatchObject({
      code: 'GOAL_FORBIDDEN',
    });
    await expect(
      f.goals.create({ ...f.createInput, actor: { kind: 'owner', owner: 'a' } }, 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_INVALID' });
    const reviewed = await f.review();
    await expect(
      f.goals.transition(
        {
          ...f.command(reviewed, 'DONE'),
          actor: { kind: 'verifier', grant: { goalId: reviewed.id, goalGeneration: 1 } },
        },
        'worker'
      )
    ).rejects.toMatchObject({ code: 'GOAL_INVALID' });
    await expect(
      f.goals.transition(f.command(reviewed, 'DONE', { verifierGrantId: 'invented' }), 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    await expect(
      f.goals.issueGrant(
        {
          kind: 'VERIFY',
          employeeId: 'w',
          targetEmployeeId: 'w',
          goalId: reviewed.id,
          generation: 1,
          expectedSequence: 3,
          expiresAt: 2000,
        },
        'worker'
      )
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    await expect(f.grant(reviewed, { employeeId: 'w' })).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    expect((await f.goals.get(reviewed.id, 'owner')).state).toBe('REVIEW');
  });

  it('freezes every worker REVIEW edge including same-state updates; independent verifier can request changes', async () => {
    const reviewed = await f.review();
    for (const to of ['READY', 'ASSIGNED', 'ACTIVE', 'HOLD', 'REVIEW', 'DONE', 'NO_GO', 'CANCELLED'] as const)
      await expect(f.goals.transition(f.command(reviewed, to), 'worker')).rejects.toMatchObject({
        code: 'GOAL_FORBIDDEN',
      });
    const grant = await f.grant(reviewed);
    const revised = await f.move(reviewed, 'ACTIVE', 'verifier', { verifierGrantId: grant.id });
    expect(revised.state).toBe('ACTIVE');
    expect((await f.move(revised, 'REVIEW')).state).toBe('REVIEW');
    await expect(
      f.goals.transition(
        f.command(await f.goals.get(reviewed.id, 'owner'), 'DONE', { verifierGrantId: grant.id }),
        'verifier'
      )
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  });

  it.each(['DONE', 'NO_GO'] as const)('allows exact-current independent verification to close %s', async (to) => {
    const reviewed = await f.review();
    const grant = await f.grant(reviewed);
    const request = f.command(reviewed, to, { verifierGrantId: grant.id });
    const closed = await f.goals.transition(request, 'verifier');
    expect(closed.goal.state).toBe(to);
    expect(closed.receipt).toMatchObject({ actorKind: 'verifier', actorEmployeeId: 'v', authorityId: grant.id });
    expect(await f.goals.transition(request, 'verifier')).toEqual(closed);
  });

  it.each(['revoked', 'expired', 'wrong-reader', 'rebound-verifier'] as const)(
    'refuses %s verification authority',
    async (mode) => {
      const reviewed = await f.review();
      const grant = await f.grant(reviewed);
      let actor = 'verifier';
      if (mode === 'revoked') await f.goals.revokeGrant(grant.id, 'owner');
      if (mode === 'expired') f.clock.now = grant.expiresAt;
      if (mode === 'wrong-reader') actor = 'reader';
      if (mode === 'rebound-verifier')
        await f.store.update((state) => {
          const e = state.employees.find((e) => e.id === 'v')!;
          e.sessionId = 'vs2';
          e.sessionGeneration++;
        });
      await expect(
        f.goals.transition(f.command(reviewed, 'DONE', { verifierGrantId: grant.id }), actor)
      ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
      expect((await f.goals.get(reviewed.id, 'owner')).state).toBe('REVIEW');
    }
  );

  it('fences changed idempotency, wrong generation/state/sequence/session and cross-company writes', async () => {
    const active = await f.active();
    const request = f.command(active, 'REVIEW');
    await f.goals.transition(request, 'worker');
    await expect(f.goals.transition({ ...request, nextAction: 'Changed' }, 'worker')).rejects.toMatchObject({
      code: 'GOAL_IDEMPOTENCY_REUSE',
    });
    for (const change of [
      { generation: 99 },
      { expectedState: 'READY' },
      { expectedSequence: 99 },
      { sessionId: 'wrong' },
      { sessionGeneration: 99 },
    ])
      await expect(
        f.goals.transition({ ...request, transitionId: 'new-' + Object.keys(change)[0], ...change }, 'owner')
      ).rejects.toMatchObject({ code: 'GOAL_CONFLICT' });
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'otherOwner')).rejects.toMatchObject({
      code: 'GOAL_NOT_FOUND',
    });
    await expect(
      f.goals.create({ ...f.createInput, employeeId: 'v', sessionId: 'vs', createId: 'cross-worker' }, 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  });

  it('creates a new generation on owner reopen and refuses exact old-generation replay', async () => {
    const reviewed = await f.review();
    const prior = f.command(reviewed, 'DONE');
    const closed = await f.goals.transition(prior, 'owner');
    const reopened = await f.move(closed.goal, 'ACTIVE', 'owner');
    expect(reopened.generation).toBe(2);
    await expect(f.goals.transition(prior, 'owner')).rejects.toMatchObject({ code: 'GOAL_CONFLICT' });
    await expect(f.create()).rejects.toMatchObject({ code: 'GOAL_CONFLICT' });
    expect((await f.goals.get(reviewed.id, 'owner')).transitions).toHaveLength(5);
  });

  it('requires typed, exact, current owner-attested HOLD proof rather than a worker boolean', async () => {
    const active = await f.active();
    const blocker = {
      category: 'OWNER_DECISION',
      summary: 'Human-facing private detail',
      unblocker: { kind: 'OWNER_DECISION', id: 'decision-1' },
    };
    const held = await f.move(active, 'HOLD', 'worker', { blocker });
    await expect(
      f.goals.transition(f.command(held, 'ACTIVE', { unblockerSatisfied: true }), 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_INVALID' });
    await expect(f.goals.transition(f.command(held, 'ACTIVE'), 'worker')).rejects.toMatchObject({
      code: 'GOAL_FORBIDDEN',
    });
    const input = {
      ...f.fence(held),
      blockerDigest: goalDigest(held.blocker),
      evidenceRef: 'evidence:sha256:' + 'b'.repeat(64),
      expiresAt: 2000,
    };
    await expect(f.goals.attestUnblocker(input, 'worker')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    await expect(f.goals.attestUnblocker({ ...input, blockerDigest: 'a'.repeat(64) }, 'owner')).rejects.toMatchObject({
      code: 'GOAL_FORBIDDEN',
    });
    const proof = await f.goals.attestUnblocker(input, 'owner');
    const resumed = await f.move(held, 'ACTIVE', 'worker', { unblockProofId: proof.id });
    expect(resumed.blocker).toBeUndefined();
    expect(resumed.transitions.at(-1)?.unblockProofId).toBe(proof.id);
  });

  it.each(['revoked', 'expired', 'changed-hold'] as const)('refuses %s unblocker evidence', async (mode) => {
    let held = await f.move(await f.active(), 'HOLD', 'worker', {
      blocker: { category: 'POLICY', summary: 'Await owner review', unblocker: { kind: 'POLICY', id: 'policy-1' } },
    });
    const proof = await f.goals.attestUnblocker(
      {
        ...f.fence(held),
        blockerDigest: goalDigest(held.blocker),
        evidenceRef: 'evidence:sha256:' + 'b'.repeat(64),
        expiresAt: 2000,
      },
      'owner'
    );
    if (mode === 'revoked') await f.goals.revokeUnblockProof(proof.id, 'owner');
    if (mode === 'expired') f.clock.now = 2000;
    if (mode === 'changed-hold')
      held = await f.move(held, 'HOLD', 'owner', { blocker: { ...held.blocker!, summary: 'Owner changed hold' } });
    await expect(
      f.goals.transition(f.command(held, 'ACTIVE', { unblockProofId: proof.id }), 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  });

  it('gates full reads and metadata grants, returning only fixed ID/enum/time metadata', async () => {
    const active = await f.active();
    const held = await f.move(active, 'HOLD', 'worker', {
      nextAction: 'PRIVATE_PROMPT_NEXT',
      blocker: { category: 'INPUT', summary: 'PRIVATE_PROMPT_SUMMARY', unblocker: { kind: 'INPUT', id: 'input-1' } },
    });
    await expect(f.goals.forEmployee('w', 'reader')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    await expect(f.goals.get(held.id, 'reader')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    const grant = await f.goals.issueGrant(
      { kind: 'METADATA_READ', employeeId: 'r', targetEmployeeId: 'w', expiresAt: 2000 },
      'owner'
    );
    const projection = await f.goals.forEmployee('w', 'reader', grant.id);
    expect(JSON.stringify(projection)).not.toMatch(/PRIVATE_PROMPT|nextAction|summary|unblocker|objective|evidence/);
    expect(Object.keys(projection[0]).sort()).toEqual(
      [
        'id',
        'generation',
        'employeeId',
        'sessionId',
        'sessionGeneration',
        'state',
        'blockerCategory',
        'bindingState',
        'deadlineAt',
        'semanticProgressAt',
        'updatedAt',
        'transitionSequence',
      ].sort()
    );
    await f.goals.revokeGrant(grant.id, 'owner');
    await expect(f.goals.forEmployee('w', 'reader', grant.id)).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
  });

  it('refuses old-session create/transition replay and requires explicit owner Goal adoption', async () => {
    const active = await f.active();
    const request = f.command(active, 'REVIEW');
    await f.goals.transition(request, 'worker');
    await f.store.update((state) => {
      const e = state.employees.find((e) => e.id === 'w')!;
      e.sessionId = 's2';
      e.sessionGeneration++;
    });
    await expect(f.goals.transition(request, 'worker')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    await expect(f.create()).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    f.principals.newWorker = { kind: 'employee', owner: 'a', employeeId: 'w', sessionId: 's2', sessionGeneration: 2 };
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'newWorker')).rejects.toMatchObject({
      code: 'GOAL_CONFLICT',
    });
    const current = await f.goals.get(active.id, 'owner');
    await expect(
      f.goals.adopt({ ...f.fence(current), transitionId: 'adopt', nextAction: 'Reviewed adoption' }, 'newWorker')
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    const adopted = await f.goals.adopt(
      { ...f.fence(current), transitionId: 'adopt', nextAction: 'Reviewed adoption' },
      'owner'
    );
    expect(adopted.goal).toMatchObject({ generation: 2, sessionId: 's2', sessionGeneration: 2, state: 'REVIEW' });
    expect(adopted.receipt.operation).toBe('ADOPT');
  });

  it('rejects unsupported content/reference fields and unavailable custody without changing state', async () => {
    await expect(f.goals.create({ ...f.createInput, transcript: 'private' }, 'worker')).rejects.toMatchObject({
      code: 'GOAL_INVALID',
    });
    const active = await f.active();
    await expect(
      f.goals.transition(f.command(active, 'REVIEW', { evidenceRefs: ['/private/terminal.txt'] }), 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_INVALID' });
    f.custody.ready = false;
    await expect(f.goals.get(active.id, 'owner')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'worker')).rejects.toMatchObject({
      code: 'GOAL_FORBIDDEN',
    });
  });

  it('serializes two distinct CompanyStore instances against the same CAS', async () => {
    const active = await f.active();
    const store = new CompanyStore(f.file);
    await store.init();
    const other = new GoalLifecycle(store, () => f.clock.now, f.auth);
    const results = await Promise.allSettled([
      f.goals.transition(f.command(active, 'REVIEW'), 'worker'),
      other.transition(f.command(active, 'REVIEW'), 'worker'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('GOAL_CONFLICT');
    expect((await other.get(active.id, 'owner')).transitions).toHaveLength(3);
  });
});
