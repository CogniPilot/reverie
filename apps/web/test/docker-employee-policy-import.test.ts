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
