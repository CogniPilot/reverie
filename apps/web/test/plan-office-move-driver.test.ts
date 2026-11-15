/** Pure consumer/callback tests. No Docker, native role, vendor or grant is faked as acceptance. */
import { expect, it, vi } from 'vitest';
import {
  PlanOfficeMoveScenario,
  planOfficeMoveRecord,
  runPlanOfficeMoveScenario,
  runPlanOfficeSelfSequence,
  type PlanOfficeMovePorts,
} from './helpers/plan-office-move-driver.js';
const sid = '11111111-1111-4111-8111-111111111111',
  eid = '22222222-2222-4222-8222-222222222222',
  id = '33333333-3333-4333-8333-333333333333',
  newSession = '44444444-4444-4444-8444-444444444444';
const base = {
  version: 1 as const,
  purpose: 'reverie-ci-plan-move-scenario-v1' as const,
  kind: 'self' as const,
  id,
  employeeId: eid,
  sessionId: sid,
  sessionGeneration: 2,
  fromAccount: 'ci-plan-a' as const,
  toAccount: 'ci-plan-b' as const,
};
const requestRecord = (phase = 'pending') => ({
  id,
  employeeId: eid,
  sessionId: sid,
  name: 'CI Worker',
  fromAccount: base.fromAccount,
  toAccount: base.toAccount,
  mode: 'claude',
  phase,
  createdAt: 1,
  expiresAt: 2,
  notified: true,
  ...(phase === 'completed' ? { newSession } : {}),
});
it('allocates the return only after first physical verification and receipt have completed', async () => {
  const actualProtocol = fixture();
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = { scenario: PlanOfficeMoveScenario.parse(base), record: requestRecord('completed') };
  const returned = {
    scenario: PlanOfficeMoveScenario.parse({
      ...base,
      id: '55555555-5555-4555-8555-555555555555',
      sessionId: newSession,
      sessionGeneration: 3,
      fromAccount: 'ci-plan-b',
      toAccount: 'ci-plan-a',
    }),
    record: {
      ...requestRecord('completed'),
      id: '55555555-5555-4555-8555-555555555555',
      sessionId: newSession,
      newSession: '66666666-6666-4666-8666-666666666666',
      fromAccount: 'ci-plan-b',
      toAccount: 'ci-plan-a',
    },
  };
  const move = vi.fn(async (leg, previous) => {
    if (leg === 'first') {
      actualProtocol.ports.verifyCompleted.mockImplementation(async () => {
        events.push('first-physical-verification');
        await barrier;
      });
      const record = await runPlanOfficeMoveScenario(actualProtocol.scenario, actualProtocol.ports);
      events.push('first-receipt-closed');
      return { scenario: actualProtocol.scenario, record };
    }
    expect(previous).toEqual(first);
    events.push('allocate-new-return-id');
    return returned;
  });
  const pending = runPlanOfficeSelfSequence('self-roundtrip', move);
  expect(move).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(events).toEqual(['first-physical-verification']));
  release();
  expect(await pending).toEqual({ first, returned });
  expect(move).toHaveBeenCalledTimes(2);
  expect(events).toEqual(['first-physical-verification', 'first-receipt-closed', 'allocate-new-return-id']);
  const ordinary = vi.fn(async () => first);
  expect(await runPlanOfficeSelfSequence('ordinary-self', ordinary)).toEqual({ first });
  expect(ordinary).toHaveBeenCalledTimes(1);
});
it('never allocates a return after an unknown/failed first verification or a merely pending first record', async () => {
  for (const failure of [
    'Original request outcome unknown',
    'Physical source closure unconfirmed',
    'Receipt close failed',
  ]) {
    for (const selection of ['self-roundtrip', 'self-owner-force'] as const) {
      const move = vi.fn(async () => {
        throw Error(failure);
      });
      await expect(runPlanOfficeSelfSequence(selection, move)).rejects.toThrow(failure);
      expect(move).toHaveBeenCalledTimes(1);
    }
  }
  const pending = vi.fn(async () => ({
    scenario: PlanOfficeMoveScenario.parse(base),
    record: requestRecord('pending'),
  }));
  await expect(runPlanOfficeSelfSequence('self-roundtrip', pending)).rejects.toThrow('known physical completion');
  expect(pending).toHaveBeenCalledTimes(1);
});
it('requires a new return ID, same employee and the actual next session/generation before accepting a roundtrip', async () => {
  const first = { scenario: PlanOfficeMoveScenario.parse(base), record: requestRecord('completed') };
  const scenario = PlanOfficeMoveScenario.parse({
    ...base,
    id: '55555555-5555-4555-8555-555555555555',
    sessionId: newSession,
    sessionGeneration: 3,
    fromAccount: 'ci-plan-b',
    toAccount: 'ci-plan-a',
  });
  for (const changes of [{ id }, { employeeId: newSession }, { sessionId: sid }, { sessionGeneration: 2 }]) {
    const altered = { ...scenario, ...changes };
    const move = vi.fn(async (leg) =>
      leg === 'first'
        ? first
        : {
            scenario: altered,
            record: { ...requestRecord('completed'), ...altered, newSession: '66666666-6666-4666-8666-666666666666' },
          }
    );
    await expect(runPlanOfficeSelfSequence('self-roundtrip', move)).rejects.toThrow();
  }
});
it('starts explicit owner force on the known completed self destination only, through its existing API and generation', async () => {
  const first = fixture(),
    forced = fixture('owner-force');
  const events: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  first.ports.verifyCompleted.mockImplementation(async () => {
    events.push('first-physical');
    await barrier;
  });
  const forceId = '55555555-5555-4555-8555-555555555555';
  const move = vi.fn(async (leg, previous) => {
    if (leg === 'first') {
      const record = await runPlanOfficeMoveScenario(first.scenario, first.ports);
      events.push('first-receipt-closed');
      return { scenario: first.scenario, record };
    }
    events.push('allocate-forced-id');
    const scenario = PlanOfficeMoveScenario.parse({
      ...base,
      kind: 'owner-force',
      id: forceId,
      sessionId: previous!.record.newSession,
      sessionGeneration: previous!.scenario.sessionGeneration + 1,
      fromAccount: 'ci-plan-b',
      toAccount: 'ci-plan-a',
    });
    forced.ports.ownerPost.mockImplementation(async (path) =>
      response(
        {
          id: forceId,
          employeeId: eid,
          oldSession: newSession,
          newSession: '66666666-6666-4666-8666-666666666666',
          fromAccount: 'ci-plan-b',
          toAccount: 'ci-plan-a',
          phase: path.endsWith('/status') ? 'completed' : 'waiting',
        },
        path.endsWith('/status') ? 200 : 202
      )
    );
    const record = await runPlanOfficeMoveScenario(scenario, forced.ports);
    return { scenario, record };
  });
  const pending = runPlanOfficeSelfSequence('self-owner-force', move);
  await vi.waitFor(() => expect(events).toEqual(['first-physical']));
  expect(forced.ports.ownerPost).not.toHaveBeenCalled();
  release();
  const completed = await pending;
  expect(events).toEqual(['first-physical', 'first-receipt-closed', 'allocate-forced-id']);
  expect(completed.returned?.scenario.kind).toBe('owner-force');
  expect(forced.ports.capsule).not.toHaveBeenCalled();
  expect(forced.ports.ownerPost.mock.calls[0]).toEqual([
    '/api/plans/moves/force',
    {
      id: forceId,
      employeeId: eid,
      sessionId: newSession,
      sessionGeneration: 3,
      toAccount: 'ci-plan-a',
      handoff: expect.stringContaining('generation 3, account ci-plan-b to ci-plan-a'),
    },
  ]);
  expect(forced.ports.ownerPost.mock.calls[0]?.[1]?.handoff).toContain(newSession);
  expect(forced.ports.ownerPost.mock.calls[0]?.[1]?.handoff).toContain(
    'source home, workspace, conversation/thread, memories'
  );
  expect(forced.ports.ownerPost.mock.calls[1]).toEqual(['/api/plans/moves/' + forceId + '/status', {}]);
  expect(forced.ports.verifyCompleted).toHaveBeenCalledTimes(1);
});
const forceRecord = (phase = 'waiting') => ({
  id,
  employeeId: eid,
  oldSession: sid,
  fromAccount: base.fromAccount,
  toAccount: base.toAccount,
  phase,
  ...(phase === 'completed' ? { newSession } : {}),
});
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({ success: status < 400, ...(status < 400 ? { data } : { error: 'Exact status unavailable' }) }),
    { status }
  );
function fixture(kind: PlanOfficeMoveScenario['kind'] = 'self') {
  const scenario = PlanOfficeMoveScenario.parse({ ...base, kind }),
    records: { name: string; value: unknown }[] = [],
    events: string[] = [];
  const ports = {
    assertCurrent: vi.fn(async () => {}),
    ownerPost: vi.fn(async (path: string, _body: Record<string, unknown>) => {
      events.push(path);
      const force = kind === 'owner-force';
      return response(
        path.endsWith('/status')
          ? force
            ? forceRecord('completed')
            : requestRecord('completed')
          : force
            ? forceRecord()
            : requestRecord(),
        path.endsWith('/status') ? 200 : 202
      );
    }),
    capsule: vi.fn(async (args: readonly string[]) => {
      events.push('capsule:' + args.join(' '));
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ success: true, id, phase: 'pending' }) };
    }),
    record(name: string, value: unknown) {
      records.push({ name, value });
      events.push(name);
    },
    pause: vi.fn(async () => {}),
    verifyCompleted: vi.fn(async () => {}),
  } satisfies PlanOfficeMovePorts;
  return { scenario, ports, records, events };
}
it('constructs only closed synthetic scenarios and rejects flags that could inject an endpoint, viewer or native authority', () => {
  expect(PlanOfficeMoveScenario.parse(base)).toEqual(base);
  for (const changes of [
    { toAccount: 'personal-account' },
    { toAccount: 'ci-plan-a' },
    { id: 'latest' },
    { sessionGeneration: 0 },
    { endpoint: 'http://production:3000' },
    { viewerReady: true },
    { token: 'fake' },
    { nativeReady: true },
  ])
    expect(() => PlanOfficeMoveScenario.parse({ ...base, ...changes })).toThrow();
});
it('prepares the exact self capsule request once and waits for original status plus a separate physical verification callback', async () => {
  const f = fixture();
  await runPlanOfficeMoveScenario(f.scenario, f.ports);
  expect(f.ports.capsule).toHaveBeenCalledExactlyOnceWith([
    'agent',
    'plan-move',
    'request',
    'ci-plan-b',
    '--id',
    id,
    '--json',
  ]);
  expect(f.ports.ownerPost).toHaveBeenCalledExactlyOnceWith('/api/plans/requests/' + id + '/status', {});
  expect(f.events.indexOf('request-' + id + '-intent')).toBeLessThan(
    f.events.findIndex((e) => e.startsWith('capsule:'))
  );
  expect(f.ports.verifyCompleted).toHaveBeenCalledExactlyOnceWith(f.scenario, requestRecord('completed'));
  expect(f.records.at(-1)?.name).toBe('completed-' + id);
});
it('keeps team selection explicit and owner cooperation on the existing request route', async () => {
  const team = fixture('team');
  await runPlanOfficeMoveScenario(team.scenario, team.ports);
  expect(team.ports.capsule.mock.calls[0]?.[0]).toEqual([
    'agent',
    'plan-move',
    'request',
    'ci-plan-b',
    '--id',
    id,
    '--employee',
    eid,
    '--json',
  ]);
  const owner = fixture('owner-cooperative');
  await runPlanOfficeMoveScenario(owner.scenario, owner.ports);
  expect(owner.ports.capsule).not.toHaveBeenCalled();
  expect(owner.ports.ownerPost.mock.calls[0]).toEqual([
    '/api/plans/requests',
    { id, employeeId: eid, sessionId: sid, toAccount: 'ci-plan-b' },
  ]);
});
it('uses only the ordinary force API with actual selected generation and never depends on a viewer or fake composer', async () => {
  const f = fixture('owner-force');
  await runPlanOfficeMoveScenario(f.scenario, f.ports);
  const [path, body] = f.ports.ownerPost.mock.calls[0]!;
  expect(path).toBe('/api/plans/moves/force');
  expect(body).toEqual({
    id,
    employeeId: eid,
    sessionId: sid,
    sessionGeneration: 2,
    toAccount: 'ci-plan-b',
    handoff: expect.stringContaining('Synthetic isolated CI move'),
  });
  expect(f.ports.ownerPost.mock.calls[1]).toEqual(['/api/plans/moves/' + id + '/status', {}]);
  expect(f.ports.capsule).not.toHaveBeenCalled();
});
it('preserves an unknown request through absent or delayed original publication without another request or resolve', async () => {
  const f = fixture('owner-cooperative');
  let count = 0;
  f.ports.ownerPost.mockImplementation(async (path) => {
    if (!path.endsWith('/status')) throw new DOMException('Original POST lost', 'TimeoutError');
    return ++count === 1 ? response(null, 404) : response(requestRecord(count === 2 ? 'executing' : 'completed'));
  });
  await runPlanOfficeMoveScenario(f.scenario, f.ports);
  expect(f.ports.ownerPost.mock.calls.filter(([path]) => !path.endsWith('/status'))).toHaveLength(1);
  expect(f.records.some((r) => r.name === 'request-' + id + '-unknown')).toBe(true);
  expect(f.records.some((r) => r.name === 'status-' + id + '-absent-0')).toBe(true);
  expect(f.ports.ownerPost.mock.calls.every(([path]) => !path.includes('/resolve'))).toBe(true);
});
it('bounds read timeouts and never creates another original after lost capsule submission', async () => {
  const f = fixture();
  f.ports.capsule.mockRejectedValue(new Error('Capsule result unknown'));
  f.ports.ownerPost.mockRejectedValue(new DOMException('Read timeout', 'TimeoutError'));
  await expect(runPlanOfficeMoveScenario(f.scenario, f.ports)).rejects.toThrow('outcome unconfirmed');
  expect(f.ports.capsule).toHaveBeenCalledTimes(1);
  expect(f.ports.ownerPost).toHaveBeenCalledTimes(180);
  expect(f.ports.verifyCompleted).not.toHaveBeenCalled();
});
it('holds unknown START and never promotes completed API state or fake reports to native acceptance', async () => {
  const f = fixture('owner-force');
  f.ports.ownerPost.mockImplementation(async (path) =>
    response(
      forceRecord(path.endsWith('/status') ? 'recovery-required' : 'starting'),
      path.endsWith('/status') ? 200 : 202
    )
  );
  await expect(runPlanOfficeMoveScenario(f.scenario, f.ports)).rejects.toThrow('Original plan move held');
  expect(f.ports.ownerPost).toHaveBeenCalledTimes(2);
  expect(f.ports.verifyCompleted).not.toHaveBeenCalled();
  const completed = fixture();
  completed.ports.verifyCompleted.mockRejectedValue(new Error('Actual source/principal/composer unconfirmed'));
  await expect(runPlanOfficeMoveScenario(completed.scenario, completed.ports)).rejects.toThrow(
    'Actual source/principal/composer unconfirmed'
  );
  expect(completed.records.some((r) => r.name === 'completed-' + id)).toBe(false);
});
it('refuses another original scope and private-journal leaks before requesting native completion', () => {
  const scenario = PlanOfficeMoveScenario.parse(base);
  for (const changes of [
    { id: newSession },
    { employeeId: newSession },
    { sessionId: newSession },
    { fromAccount: 'ci-plan-b' },
    { toAccount: 'ci-plan-a' },
    { phase: 'completed', newSession: sid },
    { phase: 'completed', newSession: 'not-a-sid' },
    { nonceHash: 'a'.repeat(64) },
  ])
    expect(() => planOfficeMoveRecord({ ...requestRecord(), ...changes }, scenario)).toThrow();
  const force = PlanOfficeMoveScenario.parse({ ...base, kind: 'owner-force' });
  expect(() => planOfficeMoveRecord({ ...forceRecord(), dockerReplacement: { nativeReady: true } }, force)).toThrow(
    'Private plan data'
  );
});
it('stops before dispatch on failed intent/current checks and stops status access after owner revocation', async () => {
  const intent = fixture();
  intent.ports.record = () => {
    throw Error('Durable close unknown');
  };
  await expect(runPlanOfficeMoveScenario(intent.scenario, intent.ports)).rejects.toThrow('Durable close unknown');
  expect(intent.ports.capsule).not.toHaveBeenCalled();
  const before = fixture();
  before.ports.assertCurrent.mockRejectedValue(new Error('Caller revoked'));
  await expect(runPlanOfficeMoveScenario(before.scenario, before.ports)).rejects.toThrow('Caller revoked');
  expect(before.ports.capsule).not.toHaveBeenCalled();
  const after = fixture();
  let checks = 0;
  after.ports.assertCurrent.mockImplementation(async () => {
    if (++checks === 3) throw Error('Caller revoked');
  });
  await expect(runPlanOfficeMoveScenario(after.scenario, after.ports)).rejects.toThrow('Caller revoked');
  expect(after.ports.capsule).toHaveBeenCalledTimes(1);
  expect(after.ports.ownerPost).not.toHaveBeenCalled();
  const unauthorized = fixture();
  unauthorized.ports.ownerPost.mockResolvedValue(response(null, 403));
  await expect(runPlanOfficeMoveScenario(unauthorized.scenario, unauthorized.ports)).rejects.toThrow(
    'Exact original status unavailable'
  );
  expect(unauthorized.ports.capsule).toHaveBeenCalledTimes(1);
  expect(unauthorized.ports.ownerPost).toHaveBeenCalledTimes(1);
});
