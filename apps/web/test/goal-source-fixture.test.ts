import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { goalFixtureRepository } from './goal-source-fixture.js';

it('resolves the explicitly supplied flattened fixture and refuses an incomplete source', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'goal-layout-control-'));
  const test = join(root, 'source/test');
  const fixture = join(test, 'fixtures/goal-source');
  try {
    fs.mkdirSync(join(fixture, 'python/reverie'), { recursive: true });
    fs.mkdirSync(join(fixture, 'tests'), { recursive: true });
    expect(() => goalFixtureRepository(test)).toThrow(/not supplied/);
    for (const file of [
      'python/reverie/goal_bootstrap.py',
      'tests/goal_private_fixture.py',
      'tests/goal_broker_fixture.py',
    ])
      fs.writeFileSync(join(fixture, file), 'synthetic source locator marker');
    expect(goalFixtureRepository(test)).toBe(fixture);
    fs.unlinkSync(join(fixture, 'tests/goal_private_fixture.py'));
    expect(() => goalFixtureRepository(test)).toThrow(/not supplied/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
