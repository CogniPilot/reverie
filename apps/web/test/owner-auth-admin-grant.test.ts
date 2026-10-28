/**
 * @fileoverview Owner auth, enforce readiness: the board is an agent route, an owner-set admin agent
 * (`reverie owner admins`) may call ADMIN_ROUTES and nothing else owner-only, and `enforce` is refused
 * while it would lock the owner or the host services out (unless forced, audited). Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, promises as fsp } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { ADMIN_ROUTES, adminGrant, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { relations, type RelationSources } from '../src/owner-auth/relations.js';
import * as admin from '../src/owner-auth/admin.js';
import type { SessionPort } from '../src/web/ports/session-port.js';

const USER = 'owner-test';
const REVIEWER = '0000002d-0035-4000-8000-000000000047'; // bound to EMPLOYEE
const CHILD = '00000038-0043-4000-8000-000000000060'; // spawned by REVIEWER
const STRANGER = '00000046-0058-4000-8000-000000000084';
const EMPLOYEE = 'employee-reviewer';
const HOUR = 60 * 60 * 1000;
const CONSOLE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Owner-only routes an admin must still be refused (sample of the "never on the grant" list), as route
 * patterns: the policy keys on the pattern, so a stub at a literal URL would never match a grant entry.
 */
const OWNER_ONLY: Array<[string, string]> = [
  ['PUT', '/api/company/employees/:id'], // position: what the CTO/COO recovery reads
  ['POST', '/api/company/employees'], // hire
  ['PUT', '/api/company/settings'], // the CTO
  ['POST', '/api/company/employees/:id/retire'],
  ['POST', '/api/company/employees/:id/memories'],
  ['PUT', '/api/company/employees/:id/thread'],
  ['PUT', '/api/settings'],
  ['POST', '/api/sessions/:id/mode'],
  ['POST', '/api/clis'],
  ['PUT', '/api/clis/:id'],
  ['POST', '/api/subscription-profiles'],
  ['POST', '/api/plans/login-all'],
  ['PUT', '/api/routines-grants'],
  ['POST', '/api/tunnel/qr/regenerate'],
  ['POST', '/api/owner/password'],
];

describe('owner auth: board, admins and the enforce lockout guard', () => {
  let dir: string;
  let store: OwnerAuthStore;
  let service: OwnerAuthService;
  let app: FastifyInstance;
  const sessions = new Map<string, { id: string; parentSessionId?: string }>([
    [REVIEWER, { id: REVIEWER }],
    [CHILD, { id: CHILD, parentSessionId: REVIEWER }],
    [STRANGER, { id: STRANGER }],
  ]);
  const sources = (): RelationSources => ({
    recordedParent: (id) => sessions.get(id)?.parentSessionId,
    known: (id) => sessions.has(id),
    rooms: () => [],
    predecessor: () => undefined,
    employeeOf: (id) => (id === REVIEWER ? EMPLOYEE : undefined),
    keepers: () => service.keepers(),
    admins: () => service.admins(),
  });
  const auditFile = () => join(dir, 'owner-auth-audit.jsonl');
  const audit = async () => readFile(auditFile(), 'utf8').catch(() => '');
  const asAgent = (id: string) => ({ 'x-reverie-parent-session': id });
  const call = (method: string, url: string, who?: string) =>
    app.inject({ method: method as 'GET', url, headers: who ? asAgent(who) : {}, ...(method === 'GET' ? {} : { payload: {} }) });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'owner-auth-admin-'));
    store = new OwnerAuthStore(join(dir, 'owner-auth.json'));
    await admin.bootstrap(store, USER);
    await admin.setPolicy(store, 'enforce', { forceLockoutRisk: true }); // setup; the guard is tested below
    service = new OwnerAuthService({ store, auditFile: auditFile() });
    app = Fastify();
    await app.register(fastifyCookie);
    registerOwnerPolicy(app, {
      service,
      ctx: { sessions } as unknown as SessionPort,
      isCapabilityRequest: () => false,
      relations: relations(sources()),
    });
    // Every route answers with the admin grant the policy recorded for it.
    const answer = async (req: FastifyRequest) => ({ success: true, admin: adminGrant(req) ?? null });
    // Each route once, so a grant list that wrongly holds an owner-only route fails on the status, not on setup.
    const keys = new Set([
      ...ADMIN_ROUTES,
      ...OWNER_ONLY.map(([method, url]) => `${method} ${url}`),
      'GET /api/board',
      'GET /api/board/issues',
      'GET /api/publication/credentials/status',
      'GET /api/sessions/:id',
      'POST /api/board/issues',
      'PATCH /api/board/issues/:id',
      'DELETE /api/sessions/:id',
    ]);
    for (const key of keys) {
      const [method, url] = key.split(' ');
      app.route({ method: method as 'GET', url, handler: answer });
    }
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('the board and own credential status are agent routes: any agent reads and moves cards, an unsigned caller does not', async () => {
    for (const [method, url] of [['GET', '/api/board'], ['GET', '/api/board/issues'], ['GET', '/api/publication/credentials/status'], ['POST', '/api/board/issues'], ['PATCH', '/api/board/issues/7']]) {
      expect((await call(method, url, STRANGER)).statusCode, url).toBe(200);
      expect((await call(method, url)).statusCode, url).toBe(401);
    }
  });

  it('no admins by default: an agent is refused every admin route and gets no grant', async () => {
    expect(admin.listAdmins(store)).toEqual([]);
    for (const key of ADMIN_ROUTES) {
      const [method, url] = key.split(' ');
      const res = await call(method, url.replace(':id', REVIEWER).replace(':sessionId', 'gone'), REVIEWER);
      expect(res.statusCode, key).toBe(403);
    }
  });

  it('an admin employee may call every admin route, the handler sees who, and it is audited', async () => {
    await admin.addAdmin(store, EMPLOYEE);
    for (const key of ADMIN_ROUTES) {
      const [method, url] = key.split(' ');
      const res = await call(method, url.replace(':id', REVIEWER).replace(':sessionId', 'gone'), REVIEWER);
      expect(res.statusCode, key).toBe(200);
      expect(res.json().admin, key).toBe(REVIEWER);
    }
    expect(await audit()).toMatch(/"event":"admin_added".*"actor":"host-cli"/);
    expect(await audit()).toMatch(/"event":"admin_action".*"route":"POST \/api\/sessions"/);
    // Another agent is not an admin; the owner path is unchanged (no grant).
    expect((await call('POST', '/api/sessions', STRANGER)).statusCode).toBe(403);
    await admin.removeAdmin(store, EMPLOYEE);
    expect((await call('POST', '/api/sessions', REVIEWER)).statusCode).toBe(403);
    expect(await audit()).toMatch(/"event":"admin_removed"/);
  });

  it('admin grants match exact employee ids and never a role selector', async () => {
    await admin.addAdmin(store, 'cto');
    expect((await call('POST', '/api/sessions', REVIEWER)).statusCode).toBe(403);
    await admin.addAdmin(store, EMPLOYEE);
    expect((await call('POST', '/api/sessions', REVIEWER)).statusCode).toBe(200);
    await admin.removeAdmin(store, EMPLOYEE);
    expect((await call('POST', '/api/sessions', REVIEWER)).statusCode).toBe(403);
  });

  it('an admin is still refused every owner-only route, and ending a session stays scoped', async () => {
    await admin.addAdmin(store, EMPLOYEE);
    for (const [method, url] of OWNER_ONLY) {
      const res = await call(method, url.replace(':id', 'e1'), REVIEWER);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await call('DELETE', `/api/sessions/${STRANGER}`, REVIEWER)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/sessions/${CHILD}`, REVIEWER)).statusCode).toBe(200); // its own child, as before
  });

  it('interactive is scoped like the session routes: itself and its descendants only', async () => {
    await admin.addAdmin(store, EMPLOYEE);
    expect((await call('POST', `/api/sessions/${REVIEWER}/interactive`, REVIEWER)).statusCode).toBe(200);
    expect((await call('POST', `/api/sessions/${CHILD}/interactive`, REVIEWER)).statusCode).toBe(200);
    expect((await call('POST', `/api/sessions/${STRANGER}/interactive`, REVIEWER)).statusCode).toBe(403);
  });

  it('an unresolvable header or a service token gets no admin grant', async () => {
    await admin.addAdmin(store, EMPLOYEE);
    expect((await call('POST', '/api/sessions', 'not-a-session')).statusCode).toBe(403);
    expect((await call('POST', '/api/company/temporary/prune')).statusCode).toBe(401);
  });

  it('admins: exact employee ids are listed and removing an unknown one says so', async () => {
    await expect(admin.addAdmin(store, 'not an id!')).rejects.toThrow(/admin/);
    await admin.addAdmin(store, 'cto');
    await admin.addAdmin(store, 'cto');
    expect(admin.listAdmins(store)).toEqual(['cto']);
    expect(admin.describe(store).admins).toEqual(['cto']);
    expect(await admin.removeAdmin(store, 'nobody')).toBe(false);
  });

  describe('the enforce lockout guard', () => {
    const NOW = 1_800_000_000_000;
    let tokens: string[] = [];
    async function ready() {
      await admin.setPolicy(store, 'log');
      await store.update((a) => {
        a.mustChange = false;
        a.totp = { secret: 'synthetic', enabledAt: 1, lastStep: 0 };
        a.recovery = Array.from({ length: 10 }, (_, i) => ({ hash: `h${i}` }));
      });
      tokens = [];
      for (const name of admin.REQUIRED_SERVICES) tokens.push(await admin.issueServiceToken(store, name));
    }
    const wouldDeny = (caller: string, ago: number, count = 1) =>
      appendFile(auditFile(), JSON.stringify({ at: new Date(NOW - ago).toISOString(), event: 'policy_would_deny', caller, reason: 'x', route: 'GET /api/x', count }) + '\n');

    it('passes when everything is in place, and the flip is audited', async () => {
      await ready();
      await wouldDeny('agent', 0, 9); // agents are not the owner: they do not block the flip
      await wouldDeny('anonymous', 2 * HOUR + 1000, 50); // older than the window
      expect(await admin.enforceProblems(store, NOW)).toEqual([]);
      await admin.setPolicy(store, 'enforce', { now: NOW });
      expect(store.read()!.policy).toBe('enforce');
      expect(await audit()).toMatch(/"event":"policy_changed","actor":"host-cli","from":"log","to":"enforce"}/);
      // Setting it again is fine.
      await admin.setPolicy(store, 'enforce', { now: NOW });
    });

    const cases: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['policy off', () => store.update((a) => { a.policy = 'off'; }), /policy is off/],
      ['one-time password', () => store.update((a) => { a.mustChange = true; }), /one-time password/],
      ['no two-step', () => store.update((a) => { delete a.totp; }), /two-step/],
      ['few recovery codes', () => store.update((a) => { a.recovery.slice(0, 6).forEach((r) => (r.usedAt = 1)); }), /only 4 unused recovery codes/],
      ['no watcher token', () => admin.revokeServiceToken(store, 'watcher'), /service token for: watcher/],
      ['no plan-usage token', () => admin.revokeServiceToken(store, 'plan-usage'), /service token for: plan-usage/],
      ['anonymous callers in the window', () => wouldDeny('anonymous', 90 * 60 * 1000, 3), /3 requests in the last two hours/],
    ];
    for (const [name, breakIt, message] of cases) {
      it(`refuses, names the problem and changes nothing: ${name}`, async () => {
        await ready();
        await breakIt();
        const before = store.read()!.policy;
        await expect(admin.setPolicy(store, 'enforce', { now: NOW })).rejects.toThrow(message);
        expect(store.read()!.policy).toBe(before);
        expect(await audit()).toMatch(/"event":"policy_enforce_refused"/);
      });
    }

    it('anonymous counts are summed and damaged lines skipped', async () => {
      await ready();
      await wouldDeny('anonymous', 0, 4);
      await wouldDeny('anonymous', HOUR, 6);
      await appendFile(auditFile(), '{"event":"policy_would_deny", broken\n');
      expect(await admin.recentAnonymous(store, NOW)).toEqual({ known: true, count: 10 });
    });

    it('--force-lockout-risk flips anyway and audits that it was forced, with the problems', async () => {
      await ready();
      await store.update((a) => { delete a.totp; });
      await admin.setPolicy(store, 'enforce', { now: NOW, forceLockoutRisk: true });
      expect(store.read()!.policy).toBe('enforce');
      expect(await audit()).toMatch(/"event":"policy_changed".*"forced":true.*two-step/);
    });

    it('the refusal names no secret', async () => {
      await ready();
      await store.update((a) => { a.recovery = []; });
      const err = await admin.setPolicy(store, 'enforce', { now: NOW }).catch((e: Error) => e);
      expect(String(err)).toMatch(/recovery codes/);
      const said = String(err) + (await audit());
      for (const secret of ['synthetic', ...tokens, ...store.read()!.services.map((s) => s.hash)]) {
        expect(said).not.toContain(secret);
      }
    });

    it('off and log never need the checks', async () => {
      await admin.setPolicy(store, 'off');
      await admin.setPolicy(store, 'log');
      expect(store.read()!.policy).toBe('log');
    });

    // Inspector OA-K2: the checks hold for the account that is committed, not a snapshot before it.
    it('a change queued while the flip reads the audit is checked: TOTP removed in between refuses', async () => {
      await ready();
      const flip = admin.setPolicy(store, 'enforce', { now: NOW });
      const removeSecondFactor = store.update((a) => { delete a.totp; });
      const [flipped] = await Promise.allSettled([flip, removeSecondFactor]);
      expect(flipped.status).toBe('rejected');
      expect(String((flipped as PromiseRejectedResult).reason)).toMatch(/two-step/);
      expect(store.read()!.policy).toBe('log');
      expect(store.read()!.totp).toBeUndefined();
    });

    /** Run `between` once, after the flip's checks passed and its account is written to the temp file, before the rename. */
    function beforeCommit(between: () => Promise<unknown>) {
      const real = fsp.rename.bind(fsp);
      let left = 1;
      return vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to) === store.file && left > 0) {
          left--;
          await between();
        }
        return real(from, to);
      });
    }

    /**
     * A separate node process that removes TOTP through OwnerAuthStore (as the host CLI does). It writes
     * `<gate>.trying` just before it asks for the lock; with `hold`, it then stops inside the lock just
     * before its rename (writes `<gate>.held`) until `<gate>.go` exists.
     */
    async function writerProcess(gate: string, hold: boolean) {
      const script = join(dir, 'writer.mts');
      await writeFile(script, `
        import { existsSync, promises as fsp, writeFileSync } from 'node:fs';
        import { OwnerAuthStore } from ${JSON.stringify(join(CONSOLE_ROOT, 'src/owner-auth/store.ts'))};
        const [file, gate, hold] = process.argv.slice(2);
        const store = new OwnerAuthStore(file);
        if (hold === 'hold') {
          const real = fsp.rename.bind(fsp);
          fsp.rename = async (from, to) => {
            if (to === file) {
              writeFileSync(gate + '.held', '');
              while (!existsSync(gate + '.go')) await new Promise((r) => setTimeout(r, 20));
            }
            return real(from, to);
          };
        }
        writeFileSync(gate + '.trying', '');
        await store.update((a) => { delete a.totp; });
      `);
      const child = spawn(process.execPath, ['--import', 'tsx', script, store.file, gate, hold ? 'hold' : ''], { cwd: CONSOLE_ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
      return { child, exited, stderr: () => stderr };
    }
    const until = async (file: string) => {
      for (let i = 0; i < 1000 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(file), file).toBe(true);
    };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Tester/Inspector OA-K2: the exact gap after the flip's last check and before its rename, with a real writer process.
    it('a real second process (like the host CLI) writing after the flip checked and before it commits: it waits, nothing is undone', async () => {
      await ready();
      const gate = join(dir, 'gate-a');
      let writer: Awaited<ReturnType<typeof writerProcess>> | undefined;
      let onDiskInGap: { policy: string; totp?: unknown } | undefined;
      const spy = beforeCommit(async () => {
        writer = await writerProcess(gate, false);
        await until(gate + '.trying');
        await pause(1000); // the writer asked for the lock; it must still be waiting
        expect(writer.child.exitCode).toBeNull();
        onDiskInGap = JSON.parse(await readFile(store.file, 'utf8'));
      });
      try {
        await admin.setPolicy(store, 'enforce', { now: NOW });
      } finally {
        spy.mockRestore();
      }
      expect(onDiskInGap!.policy).toBe('log');
      expect(onDiskInGap!.totp).toBeDefined(); // the writer did not commit inside the flip's transaction
      expect(await writer!.exited, writer!.stderr()).toBe(0);
      const onDisk = JSON.parse(await readFile(store.file, 'utf8'));
      expect(onDisk.policy).toBe('enforce'); // the flip committed on the account it checked
      expect(onDisk.totp).toBeUndefined(); // and the later removal is kept, not undone
    }, 30_000);

    it('a real second process inside its own write: the flip waits for it, then checks the new account and refuses', async () => {
      await ready();
      const gate = join(dir, 'gate-b');
      const writer = await writerProcess(gate, true);
      await until(gate + '.held');
      let settled = false;
      const flip = admin.setPolicy(store, 'enforce', { now: NOW }).finally(() => { settled = true; });
      flip.catch(() => undefined); // observed below, after the writer finishes
      await pause(1000);
      expect(settled).toBe(false);
      expect(JSON.parse(await readFile(store.file, 'utf8')).policy).toBe('log');
      await writeFile(gate + '.go', '');
      expect(await writer.exited, writer.stderr()).toBe(0);
      await expect(flip).rejects.toThrow(/two-step/);
      const onDisk = JSON.parse(await readFile(store.file, 'utf8'));
      expect(onDisk.policy).toBe('log');
      expect(onDisk.totp).toBeUndefined();
    }, 30_000);

    it('a second store in this process (its own queue) waits for the lock too', async () => {
      await ready();
      const other = new OwnerAuthStore(store.file);
      let removal: Promise<unknown> | undefined;
      let settledInGap = true;
      const spy = beforeCommit(async () => {
        let settled = false;
        removal = other.update((a) => { delete a.totp; }).finally(() => { settled = true; });
        await pause(300);
        settledInGap = settled;
      });
      try {
        await admin.setPolicy(store, 'enforce', { now: NOW });
      } finally {
        spy.mockRestore();
      }
      expect(settledInGap).toBe(false);
      await removal;
      expect(store.read()!.policy).toBe('enforce');
      expect(store.read()!.totp).toBeUndefined();
    });

    it('the transaction reads the file, not this store\'s cache: a same-size change with the same timestamps is seen', async () => {
      await ready();
      expect(store.read()!.totp!.secret).toBe('synthetic'); // cached now
      const stamp = join(dir, 'stamp');
      expect(spawnSync('cp', ['--preserve=timestamps', store.file, stamp]).status).toBe(0);
      const text = await readFile(store.file, 'utf8');
      await writeFile(store.file, text.replace('"synthetic"', '"revoked!!"')); // another writer, same size
      expect(spawnSync('touch', ['-r', stamp, store.file]).status).toBe(0); // same mtime to the nanosecond
      expect(await store.update((a) => a.totp!.secret)).toBe('revoked!!');
    });

    it('a holder that dies leaves no stale lock: the kernel frees it', async () => {
      await ready();
      const gate = join(dir, 'gate-c');
      const writer = await writerProcess(gate, true);
      await until(gate + '.held');
      writer.child.kill('SIGKILL'); // our own test process, killed inside its transaction
      await writer.exited;
      await admin.setPolicy(store, 'enforce', { now: NOW });
      expect(store.read()!.policy).toBe('enforce');
      expect(store.read()!.totp).toBeDefined(); // the dead writer committed nothing
    }, 30_000);

    it('a lock held past the wait fails closed: nothing is written', async () => {
      await ready();
      const impatient = new OwnerAuthStore(store.file, 1);
      const flock = process.env.REVERIE_FLOCK_BIN || 'flock';
      const holder = spawn(flock, ['--close', impatient.lockFile, 'sleep', '30'], { stdio: 'ignore' });
      try {
        for (let i = 0; i < 250 && spawnSync(flock, ['--nonblock', impatient.lockFile, 'true']).status === 0; i++) await pause(20);
        await expect(impatient.update((a) => { a.policy = 'enforce'; })).rejects.toThrow(/busy.*nothing was written/);
        await expect(admin.setPolicy(impatient, 'enforce', { now: NOW })).rejects.toThrow(/busy/);
        await expect(impatient.replace({ ...store.read()!, policy: 'off' })).rejects.toThrow(/busy/); // the bootstrap writer too
      } finally {
        holder.kill('SIGKILL'); // our own test process
      }
      expect(JSON.parse(await readFile(store.file, 'utf8')).policy).toBe('log');
    }, 30_000);

    // Inspector OA-K3: traffic evidence that cannot be read is unknown, never quiet.
    const unknownAudit: Array<[string, () => Promise<unknown>, RegExp]> = [
      ['missing', () => rename(auditFile(), auditFile() + '.saved'), /no audit log yet/],
      ['a directory (EISDIR)', async () => { await rename(auditFile(), auditFile() + '.saved'); await mkdir(auditFile()); }, /not a regular file/],
      ['a FIFO (would block)', async () => {
        await rename(auditFile(), auditFile() + '.saved');
        expect(spawnSync('mkfifo', [auditFile()]).status).toBe(0);
      }, /not a regular file/],
      ['too new to cover an hour of log mode', () => writeFile(auditFile(),
        JSON.stringify({ at: new Date(NOW - 10 * 60 * 1000).toISOString(), event: 'policy_changed', to: 'log' }) + '\n'), /does not cover the last hour/],
      ['log mode turned on 10 minutes ago', () => appendFile(auditFile(),
        JSON.stringify({ at: new Date(NOW - 10 * 60 * 1000).toISOString(), event: 'policy_changed', from: 'off', to: 'log' }) + '\n'), /does not cover the last hour/],
    ];
    for (const [name, breakIt, message] of unknownAudit) {
      it(`an audit log that is ${name} is unknown traffic: preflight names it and enforce is refused`, async () => {
        await ready();
        await breakIt();
        expect((await admin.recentAnonymous(store, NOW)).known).toBe(false);
        expect((await admin.enforceProblems(store, NOW)).join('\n')).toMatch(message);
        await expect(admin.setPolicy(store, 'enforce', { now: NOW })).rejects.toThrow(/quiet cannot be established/);
        expect(store.read()!.policy).toBe('log');
      });
    }

    it('a forced flip with an unreadable audit still flips, and says the audit line is missing', async () => {
      await ready();
      await rename(auditFile(), auditFile() + '.saved');
      await mkdir(auditFile());
      expect(await admin.setPolicy(store, 'enforce', { now: NOW, forceLockoutRisk: true })).toEqual({ audited: false });
      expect(store.read()!.policy).toBe('enforce');
      await rm(auditFile(), { recursive: true });
      expect(await admin.setPolicy(store, 'log')).toEqual({ audited: true });
    });
  });
});
