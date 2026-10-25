/** Fresh successor invariants: synthetic custody/credentials and local app.inject only. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerGoalRoutes } from '../src/web/routes/goal-routes.js';
import { goalDigest } from '../src/goal-lifecycle.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

describe('independent successor authority and persistence edges', () => {
  let f: Awaited<ReturnType<typeof goalFixture>>;
  beforeEach(async () => {
    f = await goalFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.cleanup();
  });

  it('denies every optional command family when authentication/custody adapters are missing', async () => {
    const app = Fastify();
    registerGoalRoutes(app, f.store);
    try {
      const before = await fs.readFile(f.file, 'utf8');
      const goal = {
        goalId: 'synthetic',
        generation: 1,
        expectedState: 'ACTIVE',
        expectedSequence: 1,
        sessionId: 's',
        sessionGeneration: 1,
      };
      for (const [method, url, payload] of [
        ['GET', '/api/goals', undefined],
        ['GET', '/api/goals/synthetic', undefined],
        ['GET', '/api/goal-metadata/w', undefined],
        ['POST', '/api/goals', f.createInput],
        [
          'POST',
          '/api/goals/synthetic/transitions',
          { ...goal, goalId: undefined, transitionId: 't', to: 'REVIEW', nextAction: 'review' },
        ],
        [
          'POST',
          '/api/goals/synthetic/adopt',
          { ...goal, goalId: undefined, transitionId: 'adopt', nextAction: 'continue' },
        ],
        [
          'POST',
          '/api/goals/synthetic/unblock-proofs',
          {
            ...goal,
            goalId: undefined,
            blockerDigest: 'a'.repeat(64),
            evidenceRef: 'evidence:sha256:' + 'b'.repeat(64),
            expiresAt: 2000,
          },
        ],
        [
          'POST',
          '/api/goal-grants',
          { kind: 'METADATA_READ', employeeId: 'r', targetEmployeeId: 'w', expiresAt: 2000 },
        ],
        ['POST', '/api/goal-grants/synthetic/revoke', {}],
        ['POST', '/api/goal-unblock-proofs/synthetic/revoke', {}],
      ] as const) {
        const body = payload ? JSON.parse(JSON.stringify(payload)) : undefined;
        const response = await app.inject({
          method,
          url,
          ...(body ? { payload: body } : {}),
          headers: { authorization: 'Basic synthetic', 'x-reverie-parent-session': 's' },
        });
        expect(response.statusCode, method + ' ' + url).toBe(403);
      }
      expect(await fs.readFile(f.file, 'utf8')).toBe(before);
    } finally {
      await app.close();
    }
  });

  it('revokes a metadata target binding without exposing prose or changing canonical data', async () => {
    const active = await f.active();
    const grant = await f.goals.issueGrant(
      { kind: 'METADATA_READ', employeeId: 'r', targetEmployeeId: 'w', expiresAt: 2000 },
      'owner'
    );
    expect((await f.goals.forEmployee('w', 'reader', grant.id))[0].id).toBe(active.id);
    await f.store.update((state) => {
      const employee = state.employees.find((e) => e.id === 'w')!;
      employee.sessionId = 'replacement';
      employee.sessionGeneration++;
    });
    const before = await fs.readFile(f.file, 'utf8');
    await expect(f.goals.forEmployee('w', 'reader', grant.id)).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  it('keeps full-record worker text private when only verification authority was granted', async () => {
    f.createInput.objective = 'PRIVATE_WORKER_OBJECTIVE_SENTINEL';
    f.createInput.nextAction = 'PRIVATE_WORKER_CREATION_SENTINEL';
    const reviewed = await f.review();
    const grant = await f.grant(reviewed);
    await expect(f.goals.get(reviewed.id, 'verifier')).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    const verified = await f.goals.transition(f.command(reviewed, 'DONE', { verifierGrantId: grant.id }), 'verifier');
    expect(verified.receipt.actorKind).toBe('verifier');
    expect(JSON.stringify(verified)).not.toContain('PRIVATE_WORKER_OBJECTIVE_SENTINEL');
    expect(JSON.stringify(verified)).not.toContain('PRIVATE_WORKER_CREATION_SENTINEL');
  });

  it('refuses proof expiry after temporary sync before the canonical HOLD is cleared', async () => {
    const held = await f.move(await f.active(), 'HOLD', 'worker', {
      blocker: {
        category: 'OWNER_DECISION',
        summary: 'synthetic pending choice',
        unblocker: { kind: 'OWNER_DECISION', id: 'decision-a' },
      },
    });
    const proof = await f.goals.attestUnblocker(
      {
        ...f.fence(held),
        blockerDigest: goalDigest(held.blocker),
        evidenceRef: 'evidence:sha256:' + 'c'.repeat(64),
        expiresAt: 2000,
      },
      'owner'
    );
    const before = await fs.readFile(f.file, 'utf8');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          f.clock.now = proof.expiresAt;
        };
      }
      return handle;
    });
    await expect(
      f.goals.transition(f.command(held, 'ACTIVE', { unblockProofId: proof.id }), 'worker')
    ).rejects.toMatchObject({ code: 'GOAL_FORBIDDEN' });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  it('refuses custody revocation after temporary sync without committing a transition', async () => {
    const active = await f.active();
    const before = await fs.readFile(f.file, 'utf8');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          await sync();
          f.custody.ready = false;
        };
      }
      return handle;
    });
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'worker')).rejects.toMatchObject({
      code: 'GOAL_FORBIDDEN',
    });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  it('refuses a symlinked lock inode without changing the Goal or symlink target', async () => {
    const active = await f.active();
    const before = await fs.readFile(f.file, 'utf8');
    const sentinel = join(f.directory, 'synthetic-lock-sentinel');
    await fs.writeFile(sentinel, 'synthetic untouched');
    await fs.unlink(f.file + '.lock');
    await fs.symlink(sentinel, f.file + '.lock');
    await expect(f.goals.transition(f.command(active, 'REVIEW'), 'worker')).rejects.toMatchObject({ code: 'ELOOP' });
    expect(await fs.readFile(sentinel, 'utf8')).toBe('synthetic untouched');
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });
});
