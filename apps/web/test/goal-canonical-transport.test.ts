/** Real client/HTTP serialization with explicit synthetic proof components; restricted Office refuses. */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { goalFixtureRepository } from './goal-source-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest, type AgentDeps } from '../src/cli-agent.js';
import { agentGoalMetadata, agentGoalRead, agentGoalTransition } from '../src/cli-goal.js';
import { GoalId } from '../src/goal-client-contract.js';
import { goalClientTarget } from '../src/goal-client-target.js';

const repository = goalFixtureRepository(import.meta.dirname);
function fixtureForward(mode: 'component-proof' | 'restricted-office', method: string, target: string, body = '') {
  const args = ['-m', 'tests.goal_broker_fixture'];
  if (mode === 'component-proof') args.push('--component-proof');
  const result = spawnSync('python3', args, {
    cwd: repository,
    env: { PATH: process.env.PATH, PYTHONPATH: repository + '/python', PYTHONDONTWRITEBYTECODE: '1' },
    input: JSON.stringify({ method, target, body, generation: 1, now: 100000, nonce: 'a'.repeat(32) }),
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 128 * 1024,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    target?: string;
    method?: string;
    body?: string;
    refused?: number;
    upstream?: boolean;
    environmentReads?: number;
  };
}
const componentProof = (method: string, target: string, body = '') =>
  fixtureForward('component-proof', method, target, body);
const restrictedOffice = (method: string, target: string, body = '') =>
  fixtureForward('restricted-office', method, target, body);
function networkEdge(forward = componentProof) {
  const calls: { method: string; path: string; proof: ReturnType<typeof fixtureForward> }[] = [];
  vi.spyOn(http, 'request').mockImplementation(((
    options: http.RequestOptions,
    callback: (response: http.IncomingMessage) => void
  ) => {
    const request = new EventEmitter();
    let body = '';
    Object.assign(request, {
      write: (chunk: string) => {
        body += chunk;
      },
      destroy: () => request,
      end: () => {
        const method = String(options.method),
          path = String(options.path);
        const proof = forward(method, path, body);
        calls.push({ method, path, proof });
        const response = Object.assign(new EventEmitter(), { statusCode: proof.refused ?? 200 });
        callback(response as http.IncomingMessage);
        queueMicrotask(() => {
          response.emit('data', Buffer.from(JSON.stringify({ success: !proof.refused, data: [] })));
          response.emit('end');
        });
      },
    });
    return request as http.ClientRequest;
  }) as typeof http.request);
  const deps: AgentDeps = {
    ctx: { apiUrl: 'http://synthetic-office.invalid', selfId: '11111111-2222-3333-4444-555555555555' },
    json: true,
    io: { out: () => {}, err: () => {} },
    request: httpRequest,
  };
  return { calls, deps };
}
afterEach(() => vi.restoreAllMocks());

describe('canonical client transport with explicit synthetic proof components', () => {
  it.each(['worker:sample', '.', '..', 'x:._-'.padEnd(100, 'x')])(
    'preserves exact metadata employee/grant bytes for %s',
    async (id) => {
      const { calls, deps } = networkEdge();
      expect(await agentGoalMetadata(deps, id, id)).toBe(0);
      const path = `/api/goal-metadata/${id}?grantId=${id}`;
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: 'GET', path, proof: { method: 'GET', target: path } });
    }
  );
  it.each(['goal:sample', '.', '..', 'x:._-'.padEnd(100, 'x')])(
    'preserves exact read/transition path and body bytes for %s',
    async (id) => {
      const { calls, deps } = networkEdge();
      // The synthetic response is deliberately not a Goal; these controls prove serialization/signing, not API result validation.
      expect(await agentGoalRead(deps, id)).toBe(1);
      const command = {
        generation: 1,
        expectedState: 'READY',
        expectedSequence: 0,
        sessionId: deps.ctx.selfId,
        sessionGeneration: 1,
        transitionId: 'operation:1',
        to: 'ASSIGNED',
        nextAction: 'synthetic',
      };
      expect(await agentGoalTransition(deps, id, command)).toBe(5);
      expect(calls.map(({ path }) => path)).toEqual([`/api/goals/${id}`, `/api/goals/${id}/transitions`]);
      expect(calls[0].proof).toMatchObject({ method: 'GET', target: calls[0].path });
      expect(calls[1].proof).toMatchObject({ method: 'POST', target: calls[1].path, body: JSON.stringify(command) });
    }
  );
  it.each([
    'worker%3Asample',
    'worker%2Fsample',
    'x/y',
    'x?grantId=y',
    'x#fragment',
    'x\n',
    'x\r',
    'x '.repeat(2),
    'x'.repeat(101),
  ])('refuses noncanonical client ID %j before transport', async (id) => {
    const { calls, deps } = networkEdge();
    expect(GoalId.safeParse(id).success).toBe(false);
    expect(await agentGoalMetadata(deps, id)).toBe(4);
    expect(await agentGoalMetadata(deps, 'worker', id)).toBe(4);
    expect(await agentGoalRead(deps, id)).toBe(4);
    expect(calls).toEqual([]);
  });
  it.each([
    '/api/goal-metadata/worker%3Asample',
    '/api/goals/goal%3Asample',
    '/api/goals/goal%2Fsample/transitions',
    '/api/goals/goal/extra',
    '/api/goals/goal?owner=true',
    '/api/goals/goal\n',
  ])('does not recognize or authorize arbitrary/encoded path %j', (path) => {
    expect(goalClientTarget({ method: 'GET', path })).toBeUndefined();
    for (const forward of [componentProof, restrictedOffice])
      expect(forward('GET', path)).toEqual({ refused: 403, upstream: false, environmentReads: 0 });
  });
  it.each(['worker:sample', '.', '..', 'x:._-'.padEnd(100, 'x')])(
    'actual restricted Office refuses canonical metadata %s without upstream or key lookup',
    async (id) => {
      const { calls, deps } = networkEdge(restrictedOffice);
      expect(await agentGoalMetadata(deps, id, id)).toBe(4);
      expect(calls).toHaveLength(1);
      expect(calls[0].proof).toEqual({ refused: 403, upstream: false, environmentReads: 0 });
    }
  );
  it('limits exact-target handling to the supported method/path/query tuples and preserves other transport', () => {
    expect(goalClientTarget({ method: 'GET', path: '/api/goals' })).toBe('/api/goals');
    expect(goalClientTarget({ method: 'POST', path: '/api/goals' })).toBe('/api/goals');
    for (const options of [
      { method: 'DELETE', path: '/api/goals/goal' },
      { method: 'POST', path: '/api/goal-metadata/worker' },
      { method: 'GET', path: '/api/goals/goal', query: { grantId: 'grant' } },
      { method: 'GET', path: '/api/goal-metadata/worker', query: { grantId: 'grant', owner: true } },
      { method: 'GET', path: '/api/goal-metadata/worker', query: { grantId: 'grant%3Aencoded' } },
      { method: 'GET', path: '/api/v1/sessions/ordinary' },
    ])
      expect(goalClientTarget(options)).toBeUndefined();
  });
  it('retains the generic URL serializer for non-Goal requests', async () => {
    const { calls, deps } = networkEdge();
    await httpRequest(deps.ctx, { method: 'GET', path: '/api/v1/sessions/session:1', query: { filter: 'value:1' } });
    expect(calls[0].path).toBe('/api/v1/sessions/session:1?filter=value%3A1');
  });
});
