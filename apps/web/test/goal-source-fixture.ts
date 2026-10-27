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
      existsSync(resolve(candidate, 'tests/goal_private_fixture.py')) &&
      existsSync(resolve(candidate, 'tests/goal_broker_fixture.py'))
    )
      return candidate;
  }
  throw Error('Trusted Goal test source fixture was not supplied');
}
