import { expect, it } from 'vitest';
import { MemoryScopeCatalog, MemoryScopeConfigSchema } from '../src/memory-scope-config.js';

const issuer = { principal: 'memory', epoch: 'e1' };
const path = [47, 55296, 56320, 47, 105];
const configuration = (configured = true) => ({
  principal: 'memory',
  instances: [
    {
      instanceRef: 'a',
      instanceId: 'default',
      ...(configured ? { guestConfigPathCodepoints: path } : {}),
      resources: [{ resourceId: 'private-a', scope: { kind: 'private' as const } }],
    },
    {
      instanceRef: 'b',
      instanceId: 'default',
      guestConfigPathCodepoints: [47, 98],
      resources: [{ resourceId: 'private-b', scope: { kind: 'private' as const } }],
    },
  ],
});
const grant = { ...issuer, resources: ['private-a'], employeeIds: ['employee-a'] };

it('retains separate instance references with unchanged duplicate legacy IDs and exact immutable guest codepoints', () => {
  const source = configuration();
  const catalog = MemoryScopeCatalog.configured(source, issuer);
  source.instances[0]!.guestConfigPathCodepoints![1] = 65;
  const first = catalog.installation('a')!;
  expect(first.instanceId).toBe('default');
  expect(catalog.installation('b')!.instanceId).toBe('default');
  expect(first.guestConfigPathCodepoints).toEqual([47, 55296, 56320, 47, 105]);
  expect(Object.isFrozen(first.guestConfigPathCodepoints)).toBe(true);
  expect(catalog.acceptsGrant(grant)).toBe(true);
});

it('keeps absent installation mapping disabled and refuses Cartesian employee/resource selection', () => {
  const disabled = MemoryScopeCatalog.configured(configuration(false), issuer);
  expect(disabled.installation('a')).toBeUndefined();
  expect(disabled.resource('private-a')?.instanceId).toBe('default');
  expect(disabled.acceptsGrant(grant)).toBe(false);
  const active = MemoryScopeCatalog.configured(configuration(), issuer);
  for (const delta of [
    { employeeIds: [] },
    { employeeIds: ['a', 'b'] },
    { resources: [] },
    { resources: ['unknown'] },
    { resources: ['private-a', 'private-b'] },
    { epoch: 'stale' },
    { principal: 'foreign' },
  ])
    expect(active.acceptsGrant({ ...grant, ...delta })).toBe(false);
});

it('refuses ambiguous IDs/scopes, invalid codepoints and request-style permission/program fields', () => {
  for (const points of [[], [97], [47, 0], [47, -1], [47, 0x110000]]) {
    const input = configuration();
    input.instances[0]!.guestConfigPathCodepoints = points;
    expect(MemoryScopeConfigSchema.safeParse(input).success).toBe(false);
  }
  expect(MemoryScopeConfigSchema.safeParse({ ...configuration(), allow: true }).success).toBe(false);
  expect(MemoryScopeConfigSchema.safeParse({ ...configuration(), executable: '/bin/anything' }).success).toBe(false);
  const duplicate = configuration();
  duplicate.instances[1]!.instanceRef = 'a';
  expect(MemoryScopeConfigSchema.safeParse(duplicate).success).toBe(false);
});
