/** Source assembly lifecycle controls; actual canonical services, owned fixtures, app.inject only. */
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as nativeFs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyStore } from '../src/company-store.js';
import { CompanyService, type CompanyServiceDeps } from '../src/company-service.js';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import {
  createGoalServerAssembly,
  type GoalServerInput,
  type GoalServerProvisioning,
} from '../src/goal-server-assembly.js';
import { registerGoalServiceRoutes } from '../src/web/routes/goal-routes.js';
import { INACCESSIBLE_GOAL_AUTH } from '../src/goal-access.js';
import type { SessionManager } from '../src/session-manager.js';

describe('actual canonical Goal server assembly lifecycle', () => {
  let root: string,
    owner: OwnerAuthService,
    token: string,
    store: CompanyStore,
    config: GoalServerProvisioning,
    clock: number;
  const apps: ReturnType<typeof Fastify>[] = [];
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'goal-assembly-fixture-'));
    clock = Date.now();
    owner = new OwnerAuthService({
      store: new OwnerAuthStore(join(root, 'owner-auth.json')),
      auditFile: join(root, 'audit.jsonl'),
      setupEnabled: true,
      now: () => clock,
    });
    const credentials = { username: 'SYNTHETIC_ASSEMBLY_OWNER', password: 'synthetic-Owner!31-assembly' };
    await owner.setup(credentials.username, credentials.password, credentials.password, '127.0.0.1');
    token = (await owner.login(credentials.username, credentials.password, '127.0.0.1')).session!;
    store = new CompanyStore(join(root, 'company.json'));
    await store.init();
    await store.update(() => {});
    const file = join(root, 'nonces.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        storeId: '11111111-2222-4333-8444-555555555555',
        capacity: 2,
        revision: 0,
        clockFloor: 100000,
        entries: [],
      })
    );
    await fs.writeFile(file + '.lock', '');
    const flock = nativeFs.realpathSync(
      (process.env.PATH ?? '')
        .split(':')
        .map((path) => join(path, 'flock'))
        .find((path) => nativeFs.existsSync(path))!
    );
    config = {
      kind: 'canonical-goal-provisioning',
      mode: 'owner-and-employee',
      issuer: () => undefined,
      custody: {
        assertPrivateCustody: (path) => {
          if (path !== store.file) throw Error('wrong synthetic scope');
        },
      },
      nonce: {
        file,
        storeId: '11111111-2222-4333-8444-555555555555',
        capacity: 2,
        flockExecutable: flock,
        authorityNamespace: join(root, 'authority'),
        assertPrivateCustody: (scope) => {
          if (scope.file !== file) throw Error('wrong nonce scope');
        },
        now: () => 100000,
      },
    };
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    if (root?.startsWith(join(tmpdir(), 'goal-assembly-fixture-'))) await fs.rm(root, { recursive: true, force: true });
  });
  const company = (auth: ReturnType<typeof createGoalServerAssembly>['authentication'], canonical = store) =>
    new CompanyService(canonical, {
      goalAuthentication: auth,
      getSession: () => undefined,
      chatrooms: {
        rooms: () => [],
        room: () => undefined,
        addMember: () => {
          throw Error('not used');
        },
        setStatus: () => {
          throw Error('not used');
        },
      },
      research: {
        inspect: async () => undefined,
        start: async () => {
          throw Error('no effect');
        },
        stop: async () => {
          throw Error('no effect');
        },
      },
    } as CompanyServiceDeps);
  const sessions = { getSession: () => undefined } as Pick<SessionManager, 'getSession'>;
  const retirement = { isRetired: () => false };
  const request = (app: ReturnType<typeof Fastify>) =>
    app.inject({ method: 'GET', url: '/api/goals', headers: { host: 'localhost', cookie: 'reverie_owner=' + token } });
  it('refuses until the actual CompanyService is attached and refuses duplicate attachment', async () => {
    const assembly = createGoalServerAssembly(owner, store.file, config),
      service = company(assembly.authentication),
      app = Fastify();
    apps.push(app);
    await app.register(cookie);
    assembly.register(app);
    registerGoalServiceRoutes(app, service.goals);
    await app.ready();
    expect((await request(app)).statusCode).toBe(403);
    assembly.attach(service, sessions, retirement);
    expect((await request(app)).statusCode).toBe(200);
    expect(() => assembly.attach(service, sessions, retirement)).toThrow('attachment refused');
    expect(app.server.listening).toBe(false);
  });
  it('refuses a different canonical store filename before attachment', async () => {
    const assembly = createGoalServerAssembly(owner, store.file, config),
      different = new CompanyStore(join(root, 'wrong-company.json'));
    expect(() => assembly.attach(company(assembly.authentication, different), sessions, retirement)).toThrow(
      'attachment refused'
    );
    expect(await fs.readdir(root)).not.toContain('wrong-company.json');
  });
  it('has no production trust fallback even after a real owner and canonical services attach', async () => {
    const assembly = createGoalServerAssembly(owner, store.file),
      service = company(assembly.authentication),
      app = Fastify();
    apps.push(app);
    await app.register(cookie);
    assembly.register(app);
    assembly.attach(service, sessions, retirement);
    registerGoalServiceRoutes(app, service.goals);
    expect((await request(app)).statusCode).toBe(403);
  });
  it('rejects mixed canonical provisioning and low-level injection rather than choosing a bypass', () => {
    expect(() =>
      createGoalServerAssembly(owner, store.file, {
        ...config,
        employee: INACCESSIBLE_GOAL_AUTH,
      } as unknown as GoalServerInput)
    ).toThrow('Ambiguous');
  });
  it.each([undefined, '', 'employee', 'OWNER-ONLY', true])(
    'refuses an absent or unsupported trusted mode: %s',
    (mode) => {
      expect(() =>
        createGoalServerAssembly(owner, store.file, { ...config, mode } as unknown as GoalServerProvisioning)
      ).toThrow('Unsupported Goal integration mode');
    }
  );
  it('owner-only employee authenticate/current always refuse without even reading issuer or nonce ports', async () => {
    const issuer = vi.fn(() => {
      throw Error('employee issuer must remain untouched');
    });
    const nonce = vi.fn(() => {
      throw Error('employee nonce must remain untouched');
    });
    const provisioning = {
      ...config,
      mode: 'owner-only' as const,
      get issuer() {
        return issuer();
      },
      get nonce() {
        return nonce();
      },
    };
    const assembly = createGoalServerAssembly(owner, store.file, provisioning);
    const request = { method: 'GET', headers: {}, routeOptions: { url: '/api/goals' }, cookies: {} };
    await expect(assembly.authentication.authenticate(request)).rejects.toThrow();
    expect(() =>
      assembly.authentication.assertCurrent(
        { kind: 'employee', employeeId: 'worker', sessionId: 'synthetic', sessionGeneration: 1 },
        request
      )
    ).toThrow();
    expect(issuer).not.toHaveBeenCalled();
    expect(nonce).not.toHaveBeenCalled();
  });
  it('owner-only real owner-cookie expiry denies the existing session without an employee fallback', async () => {
    const assembly = createGoalServerAssembly(owner, store.file, { ...config, mode: 'owner-only' }),
      service = company(assembly.authentication),
      app = Fastify();
    apps.push(app);
    await app.register(cookie);
    assembly.register(app);
    assembly.attach(service, sessions, retirement);
    registerGoalServiceRoutes(app, service.goals);
    expect((await request(app)).statusCode).toBe(200);
    clock += 366 * 24 * 60 * 60 * 1000;
    expect(owner.session(token)).toBeUndefined();
    expect((await request(app)).statusCode).toBe(403);
  });
});
