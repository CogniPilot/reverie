/** Test-only trusted source layout. No environment/request-selected source. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function goalFixtureRepository(testDirectory: string): string {
  const packaged = resolve(testDirectory, 'fixtures/goal-source');
  const repository = resolve(testDirectory, '../../..');
  for (const candidate of [packaged, repository]) {
    if (candidate === repository && resolve(candidate, 'apps/web/test') !== resolve(testDirectory)) continue;
    if (
      existsSync(resolve(candidate, 'python/reverie/goal_bootstrap.py')) &&
      existsSync(resolve(candidate, 'tests/goal_private_fixture.py'))
    )
      return candidate;
  }
  throw Error('Trusted Goal test source fixture was not supplied');
}

export function goalCustodyClientBinary(): string {
  const root = resolve(import.meta.dirname, '../../..');
  const target = resolve(root, process.env.CARGO_TARGET_DIR ?? 'target');
  const binary = process.env.NIX_TEST_GOAL_WORKER_EXEC ?? resolve(target, 'debug/reverie-worker-exec');
  if (!existsSync(binary)) {
    throw Error('Build the Goal custody client with cargo build -p reverie-worker-client --bin reverie-worker-exec');
  }
  return binary;
}
