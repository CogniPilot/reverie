import { describe, it, expect } from 'vitest';
import { proposeLegacyDockerPolicy } from '../src/docker-employee-policy-import.js';
const eid = '10000000-0000-4000-8000-000000000001';
function fixture() {
  return {
    employeeResources: {
      [eid]: {
        budgetMode: 'pool',
        memoryMiB: 49152,
        pidsLimit: 512,
        poolMemoryMiB: 49152,
        poolTasksMax: 8192,
        cpus: 0,
      },
    },
    employeeMemoryPolicies: { [eid]: { memoryHighMiB: 16384, swapMiB: 0 } },
    workerPoolProvider: { policy: { memoryMaxMiB: 49152, poolTasksMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] } },
  };
}
describe('legacy resource proposal is desired DATA only', () => {
  it('projects configured48 shared pool/16 soft pressure/zero swap without importing old16 hard drift or grants', () => {
    const proposal = proposeLegacyDockerPolicy(JSON.stringify(fixture()), eid)!;
    expect(proposal.approved).toBe(false);
    expect(proposal.policy).toMatchObject({
      memoryMaxBytes: 51539607552,
      memoryHighBytes: 17179869184,
      swapMaxBytes: 0,
      pidsMax: 512,
      pool: { memoryMaxBytes: 51539607552, pidsMax: 8192 },
    });
    expect(proposal).not.toHaveProperty('permission');
    expect(proposal).not.toHaveProperty('nativeAcknowledgment');
  });
  it('proposes24GiB soft RAM only when the selected employee has no explicit soft override', () => {
    const value = { ...fixture(), employeeMemoryPolicies: {} };
    const proposal = proposeLegacyDockerPolicy(JSON.stringify(value), eid)!;
    expect(proposal.approved).toBe(false);
    expect(proposal.policy).toEqual({
      memoryHighBytes: 25769803776,
      memoryMaxBytes: 51539607552,
      swapMaxBytes: 0,
      pidsMax: 512,
      cpuWeight: 100,
      allowedCpus: [0, 1],
      pool: { memoryMaxBytes: 51539607552, swapMaxBytes: 0, pidsMax: 8192, cpuWeight: 100, allowedCpus: [0, 1] },
    });
  });
  it('refuses an incomplete configuration rather than inventing a missing policy map', () => {
    const value = { ...fixture(), employeeMemoryPolicies: undefined };
    expect(() => proposeLegacyDockerPolicy(JSON.stringify(value), eid)).toThrow();
  });
  it.each([8192, 16384, 40960])('preserves an explicit %iMiB soft RAM choice', (memoryHighMiB) => {
    const value = fixture();
    value.employeeMemoryPolicies[eid].memoryHighMiB = memoryHighMiB;
    expect(proposeLegacyDockerPolicy(JSON.stringify(value), eid)!.policy.memoryHighBytes).toBe(memoryHighMiB * 1048576);
  });
  it('preserves a selected pool-member override when no legacy soft override exists', () => {
    const value = {
      ...fixture(),
      employeeMemoryPolicies: {},
      workerPoolProvider: {
        ...fixture().workerPoolProvider,
        memberOverrides: { [eid]: { memoryHighMiB: 12288, cpuWeight: 250 } },
      },
    };
    expect(proposeLegacyDockerPolicy(JSON.stringify(value), eid)!.policy).toMatchObject({
      memoryHighBytes: 12884901888,
      cpuWeight: 250,
    });
  });
  it('refuses a default above the selected hard ceiling instead of raising that ceiling', () => {
    const value = { ...fixture(), employeeMemoryPolicies: {} };
    value.employeeResources[eid].memoryMiB = 16384;
    expect(() => proposeLegacyDockerPolicy(JSON.stringify(value), eid)).toThrow();
  });
  it('missing employee has no invented default policy', () => {
    expect(
      proposeLegacyDockerPolicy(JSON.stringify(fixture()), '20000000-0000-4000-8000-000000000002')
    ).toBeUndefined();
  });
  it('rejects inconsistent aggregate hard limits instead of treating a role as capacity', () => {
    const value = fixture();
    value.employeeResources[eid].poolMemoryMiB = 65536;
    expect(() => proposeLegacyDockerPolicy(JSON.stringify(value), eid)).toThrow('inconsistent');
  });
  it('rejects duplicate decoded keys, including escaped-key aliasing', () => {
    const raw = JSON.stringify(fixture());
    expect(() =>
      proposeLegacyDockerPolicy(raw.replace('"employeeResources":', '"employeeResources":{},"employeeResources":'), eid)
    ).toThrow('Ambiguous');
  });
  it('rejects malformed/nonfinite/zero-high policy data at the typed projection', () => {
    const value = fixture();
    value.employeeMemoryPolicies[eid].memoryHighMiB = 0;
    expect(() => proposeLegacyDockerPolicy(JSON.stringify(value), eid)).toThrow();
  });
});
