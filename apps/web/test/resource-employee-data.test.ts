/** Wire consistency controls, without fabricated host authority or effects. */
import { expect, it } from 'vitest';
import {
  EmployeePolicyEditApproval,
  EmployeeResourceStatus,
  EmployeeMemoryDiagnostics,
  EmployeeMemoryAdvisory,
  memoryPressureAdvisory,
} from '../src/resource-employee-data.js';
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

it('keeps memory metric unavailability separate from current resource binding and cumulative counters', async () => {
  const { EmployeeMemoryDiagnostics } = await import('../src/resource-employee-data.js');
  const resources = status();
  const value = {
    version: 1,
    purpose: 'employee-memory-diagnostics-v1',
    employeeId: resources.employeeId,
    sessionId: resources.sessionId,
    sessionGeneration: '9007199254740992',
    state: 'observed',
    readOnly: true,
    resources,
    observation: {
      binding: {
        containerId: observation.containerId,
        initPid: observation.pid,
        initProcessStart: observation.processStart,
        leafDevice: observation.leafDevice,
        leafInode: observation.leafInode,
      },
      sampledAtEpochMs: 1800000000000,
      sampleDurationUs: '5',
      pressure: { state: 'unavailable', reason: 'missing' },
      events: {
        state: 'available',
        low: '0',
        high: '9007199254740993',
        max: '0',
        oom: '0',
        oomKill: '0',
        oomGroupKill: null,
      },
    },
  };
  expect(EmployeeMemoryDiagnostics.parse(value).sessionGeneration).toBe('9007199254740992');
  value.observation.sampledAtEpochMs = Number.MAX_SAFE_INTEGER;
  expect(EmployeeMemoryDiagnostics.parse(value).observation?.sampledAtEpochMs).toBe(Number.MAX_SAFE_INTEGER);
  for (const changed of [
    { ...value, unexpected: true },
    { ...value, sessionGeneration: '01' },
    { ...value, observation: { ...value.observation, binding: { ...value.observation.binding, initPid: 999 } } },
    {
      ...value,
      observation: { ...value.observation, pressure: { state: 'available', some: { avg10Hundredths: 10001 } } },
    },
    { ...value, observation: { ...value.observation, events: { ...value.observation.events, high: '-1' } } },
  ])
    expect(EmployeeMemoryDiagnostics.safeParse(changed).success).toBe(false);
});

function advisorySnapshot() {
  const resources = EmployeeResourceStatus.parse(status());
  return EmployeeMemoryDiagnostics.parse({
    version: 1,
    purpose: 'employee-memory-diagnostics-v1',
    employeeId: resources.employeeId,
    sessionId: resources.sessionId,
    sessionGeneration: '1',
    state: 'observed',
    readOnly: true,
    resources,
    observation: {
      binding: {
        containerId: observation.containerId,
        initPid: observation.pid,
        initProcessStart: observation.processStart,
        leafDevice: observation.leafDevice,
        leafInode: observation.leafInode,
      },
      sampledAtEpochMs: 1_800_000_000_000,
      sampleDurationUs: '50',
      pressure: {
        state: 'available',
        some: { avg10Hundredths: 5000, avg60Hundredths: 0, avg300Hundredths: 0, totalUs: '0' },
        full: { avg10Hundredths: 0, avg60Hundredths: 0, avg300Hundredths: 0, totalUs: '0' },
      },
      events: {
        state: 'available',
        low: '0',
        high: '18446744073709551615',
        max: '999',
        oom: '999',
        oomKill: '999',
        oomGroupKill: null,
      },
    },
  });
}
it('bounds the high-stall heuristic to fresh recent PSI, including exact thresholds, without treating historical counters as recent cause', () => {
  const value = advisorySnapshot(),
    sample = value.observation!;
  const now = sample.sampledAtEpochMs;
  expect(memoryPressureAdvisory(value, now + 30_000).state).toBe('warning');
  if (sample.pressure.state !== 'available') throw Error('Expected available fixture pressure');
  sample.pressure.some.avg10Hundredths = 4999;
  expect(memoryPressureAdvisory(value, now).state).toBe('not-observed');
  sample.pressure.full.avg10Hundredths = 5000;
  expect(memoryPressureAdvisory(value, now).state).toBe('warning');
  sample.pressure.some.avg10Hundredths = sample.pressure.full.avg10Hundredths = 0;
  sample.pressure.some.avg60Hundredths = sample.pressure.some.avg300Hundredths = 10000;
  expect(memoryPressureAdvisory(value, now)).toEqual({
    state: 'not-observed',
    sampledAtEpochMs: now,
    evaluatedAtEpochMs: now,
  });
  expect(value.observation?.events).toMatchObject({ oomKill: '999', high: '18446744073709551615' });
});
it('projects missing, stale, future and unusable-clock samples as unknown without throwing or changing native data', () => {
  const value = advisorySnapshot(),
    sample = value.observation!,
    now = sample.sampledAtEpochMs;
  for (const [at, reason] of [
    [now + 30001, 'stale-sample'],
    [now - 1, 'future-sample'],
    [NaN, 'server-clock-unavailable'],
    [Infinity, 'server-clock-unavailable'],
    [-1, 'server-clock-unavailable'],
    [Number.MAX_SAFE_INTEGER, 'server-clock-unavailable'],
  ] as const) {
    const result = memoryPressureAdvisory(value, at);
    expect(result).toMatchObject({ state: 'unknown', reason });
    expect(EmployeeMemoryAdvisory.safeParse(result).success).toBe(true);
  }
  sample.sampledAtEpochMs = Number.MAX_SAFE_INTEGER;
  expect(memoryPressureAdvisory(value, now)).toMatchObject({
    state: 'unknown',
    reason: 'sample-time-unavailable',
    sampledAtEpochMs: null,
  });
  sample.sampledAtEpochMs = now;
  sample.pressure = { state: 'unavailable', reason: 'missing' };
  expect(memoryPressureAdvisory(value, now)).toMatchObject({ state: 'unknown', reason: 'pressure-unavailable' });
  expect(memoryPressureAdvisory(null, now)).toMatchObject({
    state: 'unknown',
    reason: 'native-observation-unconfirmed',
  });
  const stopped = EmployeeMemoryDiagnostics.parse({
    ...value,
    state: 'stopped',
    observation: null,
    resources: { ...value.resources, state: 'stopped', observed: null },
  });
  expect(memoryPressureAdvisory(stopped, now)).toMatchObject({ state: 'unknown', reason: 'no-sample' });
  expect(EmployeeMemoryDiagnostics.safeParse({ ...value, advisory: memoryPressureAdvisory(value, now) }).success).toBe(
    false
  );
});
