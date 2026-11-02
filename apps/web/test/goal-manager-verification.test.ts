/** Synthetic transaction-state revocation after real temp sync. Ordinary writers remain serialized by the store flock. */
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyState } from '../src/company-types.js';
import { goalFixture } from './helpers/goal-test-fixture.js';
describe('independent manager plus VERIFY final visibility fence', () => {
  let f: Awaited<ReturnType<typeof goalFixture>>;
  beforeEach(async () => {
    f = await goalFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.cleanup();
  });
  async function setup() {
    await f.store.update((state) => {
      state.employees.find((e) => e.id === 'v')!.permissions.manageGoals = true;
    });
    const reviewed = await f.review();
    const grant = await f.grant(reviewed);
    return f.command(reviewed, 'DONE', { verifierGrantId: grant.id });
  }
  it('valid combined manager VERIFY remains exact verifier attribution', async () => {
    const command = await setup();
    const result = await f.goals.transition(command, 'verifier');
    expect(result.visibility).toBe('full');
    expect(result.receipt.actorKind).toBe('verifier');
    expect(result.receipt.authorityId).toBe(command.verifierGrantId);
    expect(result.goal.state).toBe('DONE');
  });
  it.each(['transition', 'replay'])(
    'refuses full response when management is revoked at temp sync for %s',
    async (mode) => {
      const command = await setup();
      if (mode === 'replay') await f.goals.transition(command, 'verifier');
      const before = await fs.readFile(f.file, 'utf8');
      let pending: CompanyState | undefined;
      let synced = false;
      const update = f.store.update.bind(f.store);
      vi.spyOn(f.store, 'update').mockImplementation((mutate, validate, beforeSave) =>
        update(
          (state) => {
            pending = state;
            return mutate(state);
          },
          validate,
          beforeSave
        )
      );
      const open = fs.open.bind(fs);
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('.tmp')) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            expect(pending).toBeDefined();
            pending!.employees.find((e) => e.id === 'v')!.permissions.manageGoals = false;
            synced = true;
          };
        }
        return handle;
      });
      let result: unknown;
      let error: unknown;
      try {
        result = await f.goals.transition(command, 'verifier');
      } catch (e) {
        error = e;
      }
      expect(synced).toBe(true);
      expect(error).toMatchObject({ code: 'GOAL_FORBIDDEN' });
      expect(result).toBeUndefined();
      expect(await fs.readFile(f.file, 'utf8')).toBe(before);
    }
  );
});
