import { expect, it } from 'vitest';
import { ownCredentialStatus, OwnCredentialStatusSchema } from '../src/publication-credential-status.js';
import { agentCredentialStatus } from '../src/cli-agent-credential-status.js';
import type { AgentDeps, RequestOptions } from '../src/cli-agent.js';

const ID = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '55555555-5555-4555-8555-555555555555';
const actor = { employeeId: 'employee-one', sessionId: 'own-session', ids: [ID] };
const row = { id: ID, name: 'release', repositories: ['example/project'], createdAt: 1, updatedAt: 1 };
const report = () => ownCredentialStatus(actor, [row]);

it('projects only current own registration/grant facts without free-form/provider fields', () => {
  const status = ownCredentialStatus(actor, [
    { ...row, token: 'SECRET-SENTINEL', label: '/private/credential.token', expiresAt: 1 } as typeof row,
    { ...row, id: FOREIGN, name: 'foreign-release' },
  ]);
  expect(status.credentials).toEqual([
    {
      id: ID,
      name: 'release',
      repositories: ['example/project'],
      registration: 'registered',
      grant: 'current',
      expiry: { state: 'unknown', reason: 'not-recorded' },
      repositoryAccess: { state: 'not-verified', basis: 'owner-declared-labels' },
    },
  ]);
  expect(JSON.stringify(status)).not.toMatch(/SECRET|private|foreign-release|expiresAt|createdAt/);
});
it('distinguishes missing own registration from no own grant without enumerating other names', () => {
  expect(ownCredentialStatus(actor, []).credentials).toEqual([
    expect.objectContaining({
      id: ID,
      registration: 'missing',
      grant: 'unavailable',
      repositories: [],
    }),
  ]);
  expect(ownCredentialStatus({ ...actor, ids: [] }, [row]).credentials).toEqual([]);
});
it('does not infer expiry or repository authentication from old timestamps or registration', () => {
  const status = report();
  expect(status.credentials[0]!.expiry).toEqual({ state: 'unknown', reason: 'not-recorded' });
  expect(status.credentials[0]!.repositoryAccess.state).toBe('not-verified');
});
it.each(['duplicate-grant', 'duplicate-registration', 'bad-name', 'path-repository'])(
  'refuses invalid/ambiguous own metadata: %s',
  (mode) => {
    expect(() =>
      ownCredentialStatus(
        { ...actor, ids: mode === 'duplicate-grant' ? [ID, ID] : [ID] },
        mode === 'duplicate-registration'
          ? [row, row]
          : [
              {
                ...row,
                name: mode === 'bad-name' ? '/secret/name' : row.name,
                repositories: mode === 'path-repository' ? ['/private/token'] : row.repositories,
              },
            ]
      )
    ).toThrow();
  }
);

function fixture() {
  const calls: RequestOptions[] = [],
    output: string[] = [];
  let status = 200,
    data: unknown = report();
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://synthetic.test', selfId: actor.sessionId },
    json: true,
    io: { out: (text) => output.push(text), err: (text) => output.push(text) },
    request: async (_ctx, request) => {
      calls.push(request);
      if (request.path === '/api/board')
        return {
          status: 200,
          text: '',
          json: { success: true, data: { capabilities: { identity: { kind: 'agent', ...actor } } } },
        };
      return {
        status,
        text: 'SECRET /private/token',
        json: { success: status === 200, data, error: 'expired SECRET at /private/token', errorCode: 'SECRET' },
      };
    },
  };
  return {
    deps,
    calls,
    output,
    set: (code: number, value: unknown) => {
      status = code;
      data = value;
    },
  };
}
it('CLI performs only bounded own GETs and no material/install/probe request', async () => {
  const f = fixture();
  expect(await agentCredentialStatus(f.deps)).toBe(0);
  expect(JSON.parse(f.output[0]!)).toMatchObject({ success: true, visibility: 'current-employee-grants-only' });
  expect(f.calls.map((call) => [call.method, call.path])).toEqual([
    ['GET', '/api/board'],
    ['GET', '/api/publication/credentials/status'],
  ]);
  expect(f.calls.every((call) => !!call.bounds && call.body === undefined)).toBe(true);
  expect(f.output.join(' ')).not.toMatch(/SECRET|\/private/);
});
it.each([
  [403, 'forbidden', 4],
  [404, 'unsupported-server', 1],
  [503, 'unavailable', 1],
] as const)('CLI reports typed HTTP%s unavailability without secret-adjacent errors', async (code, reason, exit) => {
  const f = fixture();
  f.set(code, undefined);
  expect(await agentCredentialStatus(f.deps)).toBe(exit);
  expect(JSON.parse(f.output[0]!)).toMatchObject({ success: false, availability: 'unknown', reason });
  expect(f.output.join(' ')).not.toMatch(/expired|SECRET|\/private/);
});
it.each(['foreign-employee', 'foreign-session', 'extra-material', 'forged-verified', 'future-version'])(
  'CLI refuses mismatched or unsafe status: %s',
  async (mode) => {
    const f = fixture(),
      data = report();
    if (mode === 'foreign-employee') data.employeeId = 'someone-else';
    if (mode === 'foreign-session') data.sessionId = 'another-session';
    const bad: unknown =
      mode === 'extra-material'
        ? { ...data, token: 'SECRET' }
        : mode === 'future-version'
          ? { ...data, version: 2 }
          : mode === 'forged-verified'
            ? { ...data, credentials: [{ ...data.credentials[0], repositoryAccess: { state: 'verified' } }] }
            : data;
    f.set(200, bad);
    expect(await agentCredentialStatus(f.deps)).toBe(1);
    expect(f.output.join(' ')).not.toMatch(/SECRET|someone-else|another-session|\/private/);
  }
);
it('CLI empty success states its visibility limit and never claims credentials do not exist elsewhere', async () => {
  const f = fixture();
  f.set(200, ownCredentialStatus({ ...actor, ids: [] }, [row]));
  f.deps.json = false;
  expect(await agentCredentialStatus(f.deps)).toBe(0);
  expect(f.output.join(' ')).toContain('No current own publication grants');
  expect(f.output.join(' ')).toContain('does not enumerate the owner registry or credentials elsewhere');
  expect(f.output.join(' ')).not.toContain('release');
});
it('status schema cannot declare a missing registration current or claim non-expiry', () => {
  expect(
    OwnCredentialStatusSchema.safeParse({
      ...report(),
      credentials: [
        {
          ...report().credentials[0],
          registration: 'missing',
          grant: 'current',
        },
      ],
    }).success
  ).toBe(false);
  expect(
    OwnCredentialStatusSchema.safeParse({
      ...report(),
      credentials: [
        {
          ...report().credentials[0],
          expiry: { state: 'valid' },
        },
      ],
    }).success
  ).toBe(false);
});
