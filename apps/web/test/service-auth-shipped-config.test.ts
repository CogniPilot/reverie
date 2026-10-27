import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceAuthConfigSchema, loadServiceAuthConfig } from '../src/service-auth-config.js';
import { ServiceGrantAuthentication } from '../src/service-grant-auth.js';
import { goalFixture } from './helpers/goal-test-fixture.js';

it('bug 25: the shipped config registers only OPS; every W3 lane (MEMORY, REST, RESUME, DECISION) and LEASE stays unregistered', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'shipped-cfg-'));
  const shipped = JSON.parse(fs.readFileSync(join(import.meta.dirname, '../config/service-auth.shipped.json'), 'utf8'));
  const filled = JSON.parse(
    JSON.stringify(shipped)
      .replace('"<website uid>"', String(process.geteuid!()))
      .replaceAll('<install-time epoch id>', 'e1')
      .replaceAll('<private key directory>', dir)
  );
  fs.writeFileSync(join(dir, 'service-auth.json'), JSON.stringify(filled), { mode: 0o600 });
  const loaded = loadServiceAuthConfig(join(dir, 'service-auth.json'));
  expect(Object.keys(loaded.purposes).sort()).toEqual([
    'OPS_INSPECT',
    'OPS_PRUNE_OBSERVE',
    'OPS_SELFTEST_RUN',
    'OPS_STATUS',
    'OPS_WEBSITE_RESTART',
  ]);
  expect(loaded.config.principals.map((p) => p.principal)).toEqual(['ops']);
  const f = await goalFixture();
  const { GoalLifecycle } = await import('../src/goal-lifecycle.js');
  const goals = new GoalLifecycle(f.store, () => f.clock.now, f.auth, loaded.purposes);
  for (const purpose of [
    'MEMORY_PRIVATE_PROCESSING',
    'MEMORY_COMPANY_PROCESSING',
    'REST_PLAN_REPORT_METADATA',
    'RESUME_SERVICE',
  ]) {
    await expect(
      goals.issueServiceGrant(
        { purpose, principal: 'ops', epoch: 'e1', employeeIds: ['w'], expiresAt: f.clock.now + 1000 },
        'owner'
      )
    ).rejects.toThrow(/Unknown service purpose/);
    expect(
      await new ServiceGrantAuthentication(undefined, loaded.purposes).authenticate({ assertion: 'x.y' }, purpose)
    ).toBeNull();
  }
  for (const purpose of ['LEASE_SERVICE', 'DECISION_REQUEST'])
    await expect(
      goals.issueServiceGrant(
        { purpose, principal: 'ops', epoch: 'e1', resources: ['board'], expiresAt: f.clock.now + 1000 },
        'owner'
      )
    ).rejects.toThrow(/Unknown service purpose/);
  await f.cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});


const templatePath = join(import.meta.dirname, '../config/service-auth.shipped.json');
function template() {
  return JSON.parse(fs.readFileSync(templatePath, 'utf8'));
}
function fixtureConfig(dir: string, serviceUid = process.geteuid!()) {
  const value = template();
  value.serviceUid = serviceUid;
  value.principals[0].epoch = 'fixture-epoch';
  value.principals[0].key = join(dir, 'ops.key');
  return value;
}

it('keeps only generic unresolved identity and installation placeholders in the public template', () => {
  const value = template();
  expect(value.serviceUid).toBe('<website uid>');
  expect(value.principals).toEqual([
    { principal: 'ops', epoch: '<install-time epoch id>', key: '<private key directory>/ops.key' },
  ]);
  const employees: string[] = value.setupGrants.flatMap((row: { employees: string[] }) => row.employees);
  expect([...new Set(employees)].sort()).toEqual([
    '<employee-1>', '<employee-2>', '<employee-3>', '<employee-4>',
  ]);
  expect(employees.every((employee) => /^<employee-[1-4]>$/.test(employee))).toBe(true);
  expect(value.setupGrants.every((row: { purpose: string; principal: string }) =>
    row.purpose in value.purposes && row.principal === 'ops')).toBe(true);
  expect(ServiceAuthConfigSchema.safeParse(value).success).toBe(false);
});

it('accepts configurable non-root uids and requires the selected uid to match the actual website process', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'shipped-uid-'));
  try {
    const own = fixtureConfig(dir);
    for (const uid of [1, 1001, 4242, 4294967294])
      expect(ServiceAuthConfigSchema.parse({ ...own, serviceUid: uid }).serviceUid).toBe(uid);
    const file = join(dir, 'service-auth.json');
    fs.writeFileSync(file, JSON.stringify(own), { mode: 0o600 });
    expect(loadServiceAuthConfig(file).config.serviceUid).toBe(process.geteuid!());
    const other = process.geteuid!() === 4242 ? 4243 : 4242;
    fs.writeFileSync(file, JSON.stringify({ ...own, serviceUid: other }));
    expect(() => loadServiceAuthConfig(file)).toThrow(/does not match the running website uid/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('binds the loaded digest to rendered private bytes separately from the source-template digest', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'shipped-digest-'));
  try {
    const source = fs.readFileSync(templatePath);
    const value = fixtureConfig(dir);
    const employees = new Map([
      ['<employee-1>', 'fixture-employee-1'], ['<employee-2>', 'fixture-employee-2'],
      ['<employee-3>', 'fixture-employee-3'], ['<employee-4>', 'fixture-employee-4'],
    ]);
    for (const row of value.setupGrants)
      row.employees = row.employees.map((employee: string) => employees.get(employee));
    const rendered = Buffer.from(JSON.stringify(value));
    const file = join(dir, 'service-auth.json');
    fs.writeFileSync(file, rendered, { mode: 0o600 });
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    expect(loadServiceAuthConfig(file).digest).toBe(digest(rendered));
    expect(digest(rendered)).not.toBe(digest(source));
    expect(fs.existsSync(join(dir, 'ops.key'))).toBe(false);
    expect(Object.keys(value.purposes).sort()).toEqual(Object.keys(template().purposes).sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
