/** Wire consistency controls, without fabricated host authority or effects. */
import { expect, it } from 'vitest';
import { EmployeePolicyEditApproval, EmployeeResourceStatus } from '../src/resource-employee-data.js';
const requested = {
  memoryHighMiB: 8192,
  memoryMaxMiB: 49152,
  cpuWeight: 100,
  allowedCpus: [0, 1],
  perfPolicy: 'task-v2',
};
const observation = {
  containerId: 'a'.repeat(64),
  pid: 42,
  processStart: '1234',
  leafDevice: '30',
  leafInode: '400',
  memoryHighBytes: '8589934592',
  memoryMaxBytes: '51539607552',
  memoryCurrentBytes: '123456',
  memorySwapMaxBytes: '0',
  cpuWeight: 100,
  cpuMax: 'max 100000',
  allowedCpus: [0, 1],
};
function status() {
  return {
    version: 1,
    employeeId: '11111111-2222-4333-8444-555555555555',
    sessionId: '77777777-2222-4333-8444-555555555555',
    revision: 'b'.repeat(64),
    state: 'running',
    requested: { ...requested },
    observed: { ...observation },
    perfObserved: null,
    perfObservationReason: 'OWN_PROCESS_PROBE_REQUIRED',
    capabilities: {
      softMemoryLive: false,
      cpuWeightLive: false,
      hardMemoryReplacement: false,
      perfReplacement: false,
      gpuReplacement: false,
    },
    readOnly: true,
  };
}
it('keeps requested soft policy distinct from observed enforcement and untested perf', () => {
  const value = status();
  value.observed.memoryHighBytes = '4294967296';
  expect(EmployeeResourceStatus.parse(value).requested?.memoryHighMiB).toBe(8192);
  expect(EmployeeResourceStatus.parse(value).observed?.memoryHighBytes).toBe('4294967296');
  expect(EmployeeResourceStatus.parse(value).perfObserved).toBeNull();
});
it('refuses invented running observations, capability promotion and malformed native counters', () => {
  for (const changed of [
    { ...status(), observed: null },
    { ...status(), requested: null },
    { ...status(), state: 'stopped' },
    { ...status(), perfObserved: true },
    { ...status(), capabilities: { ...status().capabilities, hardMemoryReplacement: true } },
    { ...status(), state: 'stopped', observed: null, capabilities: { ...status().capabilities, softMemoryLive: true } },
    { ...status(), observed: { ...observation, cpuWeight: 0 } },
    { ...status(), observed: { ...observation, memoryCurrentBytes: '18446744073709551616' } },
    { ...status(), observed: { ...observation, allowedCpus: [0, 0] } },
  ])
    expect(EmployeeResourceStatus.safeParse(changed).success).toBe(false);
  expect(
    EmployeeResourceStatus.parse({ ...status(), state: 'uninstalled', requested: null, observed: null }).observed
  ).toBeNull();
});

it('decodes native live capabilities without making the GET observation an edit', () => {
  const value = status();
  value.capabilities.softMemoryLive = true;
  value.capabilities.cpuWeightLive = true;
  expect(EmployeeResourceStatus.parse(value)).toMatchObject({
    capabilities: { softMemoryLive: true, cpuWeightLive: true },
    readOnly: true,
  });
});

it('freezes the exact five approval fields and refuses extra data', () => {
  const value = {
    sessionId: status().sessionId,
    operationId: status().employeeId,
    expectedRevision: status().revision,
    memoryHighMiB: 49152,
    cpuWeight: 10000,
  };
  expect(EmployeePolicyEditApproval.parse(value)).toEqual(value);
  expect(Object.isFrozen(EmployeePolicyEditApproval.parse(value))).toBe(true);
  expect(EmployeePolicyEditApproval.safeParse({ ...value, memoryMaxMiB: 49152 }).success).toBe(false);
});
