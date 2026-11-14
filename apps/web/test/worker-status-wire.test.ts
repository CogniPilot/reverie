/** Actual route, response envelope, private credential FD and owned loopback HTTP. No provider/Engine. */
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Session } from '../src/session.js';
import { workerCallback } from '../src/worker-client-callback.js';
import {
  DockerWorkerIdentityAuthentication,
  registerDockerWorkerIdentity,
  DOCKER_WORKER_IDENTITY_HEADER,
  type DockerWorkerIdentityBinding,
} from '../src/docker-worker-identity.js';
import { installResponseEnvelope } from '../src/web/response-envelope.js';
import { registerStatusTelemetryRoutes } from '../src/web/routes/status-telemetry-routes.js';
import type { SessionPort, EventPort } from '../src/web/ports/index.js';

const SID = '33333333-3333-4333-8333-333333333333';
const OTHER = '55555555-5555-4555-8555-555555555555';
const binding: DockerWorkerIdentityBinding = {
  employeeId: '22222222-2222-4222-8222-222222222222',
  sessionId: SID,
  sessionGeneration: 1,
  owner: undefined,
  containerId: 'a'.repeat(64),
  credentialId: '44444444-4444-4444-8444-444444444444',
};
const apps: FastifyInstance[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const payload = {
  model: { display_name: 'Synthetic Claude' },
  context_window: { used_percentage: 7, total_input_tokens: 1200, total_output_tokens: 12 },
};
async function fixture(mandatory = true) {
  const directory = await mkdtemp(join(tmpdir(), 'worker-status-'));
  await chmod(directory, 0o700);
  directories.push(directory);
  const session = new Session({ id: SID, workingDir: directory, mode: 'claude' });
  let selected: DockerWorkerIdentityBinding | undefined = binding;
  const authentication = new DockerWorkerIdentityAuthentication(
    '11111111-1111-4111-8111-111111111111',
    Buffer.alloc(32, 0x62),
    { binding: () => selected, keyCurrent: () => true }
  );
  const token = authentication.issue(binding, () => true);
  const file = join(directory, 'identity');
  await writeFile(file, token, { mode: 0o600 });
  const app = Fastify();
  apps.push(app);
  installResponseEnvelope(app, '');
  registerDockerWorkerIdentity(app, authentication, '', { requireMachineProof: mandatory });
  const context = {
    sessions: new Map([[SID, session]]),
    broadcast() {},
    persistSessionState() {},
  } as unknown as SessionPort & EventPort;
  registerStatusTelemetryRoutes(app, context);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  const env: NodeJS.ProcessEnv = {
    REVERIE_MUX: '1',
    REVERIE_SESSION_ID: SID,
    REVERIE_API_URL: 'http://127.0.0.1:' + address.port,
    REVERIE_WORKER_IDENTITY_FILE: file,
  };
  return {
    app,
    env,
    session,
    token,
    revoke: () => {
      selected = undefined;
    },
  };
}
describe('actual status telemetry worker wire', () => {
  it('roundtrips the real route/envelope through workerCallback and records the actual session model', async () => {
    const f = await fixture();
    expect(await workerCallback('status-telemetry', undefined, Readable.from(JSON.stringify(payload)), f.env)).toBe(
      'Synthetic Claude  in:1,200 out:12  ctx:7%'
    );
    expect(f.session.toState().displayModel).toEqual({ model: 'Synthetic Claude', source: 'statusline' });
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/status-telemetry',
      headers: { [DOCKER_WORKER_IDENTITY_HEADER]: f.token },
      payload: { sessionId: SID, data: payload },
    });
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ success: true, data: 'Synthetic Claude  in:1,200 out:12  ctx:7%' });
  });
  it('refuses absent, malformed, wrong-body and revoked proof before changing the actual session', async () => {
    const f = await fixture();
    for (const [headers, sessionId] of [
      [{}, SID],
      [{ [DOCKER_WORKER_IDENTITY_HEADER]: 'malformed' }, SID],
      [{ [DOCKER_WORKER_IDENTITY_HEADER]: f.token }, OTHER],
    ] as const) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/status-telemetry',
            headers,
            payload: { sessionId, data: payload },
          })
        ).statusCode
      ).toBe(403);
      expect(f.session.toState().displayModel).toBeUndefined();
    }
    f.revoke();
    await expect(
      workerCallback('status-telemetry', undefined, Readable.from(JSON.stringify(payload)), f.env)
    ).rejects.toThrow('delivery unconfirmed');
    expect(f.session.toState().displayModel).toBeUndefined();
  });
  it('preserves legacy text/plain and empty unknown-session responses under the global envelope', async () => {
    const f = await fixture(false);
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/status-telemetry',
      payload: { sessionId: SID, data: payload },
    });
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toBe('Synthetic Claude  in:1,200 out:12  ctx:7%');
    const unknown = await f.app.inject({
      method: 'POST',
      url: '/api/status-telemetry',
      payload: { sessionId: OTHER, data: payload },
    });
    expect(unknown.headers['content-type']).toContain('text/plain');
    expect(unknown.body).toBe('');
  });
});
