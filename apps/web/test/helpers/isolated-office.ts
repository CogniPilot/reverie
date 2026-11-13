/** Real WebServer test fixture. Owns only fresh temporary state; never a runtime. */
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WebServer } from '../../src/web/server.js';
import type { Session } from '../../src/session.js';
export interface IsolatedOffice {
  origin(): string;
  workspace: string;
  currentServer(): WebServer;
  seedUnstartedSessions(options?: {
    employees: readonly { id: string; sessionId: string; name: string }[];
    nativeSocket: string;
  }): Promise<Array<{ id: string; name: string }>>;
  seedStoppedEmployees(): Promise<Array<{ id: string; sessionId: string; name: string }>>;
  assertNoRunningIntent(): Promise<void>;
  close(): Promise<void>;
}
function contained(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
export async function createIsolatedOffice(
  options: { ownerSetup?: boolean; beforeStart?: (server: WebServer) => void | Promise<void> } = {}
): Promise<IsolatedOffice> {
  if (process.env.VITEST !== 'true') throw new Error('The real-office fixture requires the isolated Vitest runner');
  const original = { ...process.env };
  // Chromium's singleton uses a Unix socket below TMPDIR. Nix/GitHub's
  // inherited temporary path can already consume its entire pathname limit.
  // Allocate an owned, short system-temp root; retain the marker/cleanup checks.
  const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rvo-')));
  const paths = Object.fromEntries(
    ['home', 'data', 'workspace', 'cases', 'research', 'runtime', 'tmp', 'attachments'].map((name) => [
      name,
      join(root, name),
    ])
  );
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { mode: 0o700 })));
  const restoreEnvironment = () => {
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(original, key)) delete process.env[key];
    Object.assign(process.env, original);
  };
  // App modules read instance configuration during import. Remove inherited
  // instance/provider authority before dynamically importing any of them.
  const allowed = new Set([
    'PATH',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'TERM',
    'CI',
    'NODE_ENV',
    'NODE_CHANNEL_FD',
    'NODE_UNIQUE_ID',
    'NODE_V8_COVERAGE',
    'LD_LIBRARY_PATH',
    'FONTCONFIG_FILE',
    'FONTCONFIG_PATH',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
    'PLAYWRIGHT_BROWSERS_PATH',
  ]);
  const namespace = `office-fixture-${randomUUID().slice(0, 8)}`;
  const ownership = JSON.stringify({ purpose: 'real-office-browser-fixture', namespace, root });
  const marker = join(root, 'fixture-ownership.json');
  await writeFile(marker, ownership, { flag: 'wx', mode: 0o600 });
  const removeOwnedRoot = async () => {
    if ((await readFile(marker, 'utf8')) !== ownership) throw new Error('Fixture cleanup ownership changed');
    await rm(root, { recursive: true, force: true });
  };
  for (const key of Object.keys(process.env))
    if (!allowed.has(key) && !key.startsWith('VITEST') && !key.startsWith('NIX_')) delete process.env[key];
  Object.assign(process.env, {
    HOME: paths.home,
    USERPROFILE: paths.home,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    TMUX_TMPDIR: paths.tmp,
    XDG_CONFIG_HOME: join(paths.home, 'config'),
    XDG_CACHE_HOME: join(paths.home, 'cache'),
    XDG_DATA_HOME: join(paths.home, 'share'),
    REVERIE_DATA_DIR: paths.data,
    REVERIE_INSTANCE: namespace,
    REVERIE_TMUX_SOCKET: namespace,
    REVERIE_CASES_PATH: paths.cases,
    REVERIE_RESEARCH_ROOT: paths.research,
    REVERIE_RUNTIME_STATE: join(paths.runtime, 'controller-state.json'),
    REVERIE_SHARED_WORKSPACE_PATH: paths.workspace,
    REVERIE_SHARED_ATTACHMENTS_PATH: paths.attachments,
    REVERIE_OWNER_SETUP: options.ownerSetup === false ? '0' : '1',
    REVERIE_INSTALL_CLIS: 'none',
  });
  const declaredSessions = new Map<string, Session>();
  let server: WebServer | undefined;
  let stop: ((server: WebServer) => Promise<void>) | undefined;
  try {
    const instance = await import('../../src/config/instance.js');
    if (
      !contained(root, await realpath(instance.getDataDir())) ||
      instance.resolveTmuxSocketName() !== namespace ||
      process.env.REVERIE_WORKER_SOCKET ||
      process.env.REVERIE_WORKER_VIEWER_SOCKET
    )
      throw new Error('The real-office fixture did not retain its isolated configuration');
    // A genuine first-run claim requires both account and policy marker absent.
    // OWNER_SETUP already enforces authentication before that first claim.
    const factory = await import('../mobile/helpers/server.js');
    stop = factory.stopTestServer;
    server = await factory.createTestServer({ titleHostname: 'synthetic-office', beforeStart: options.beforeStart });
    const assertNoRunningIntent = async () => {
      const { CompanyStore } = await import('../../src/company-store.js');
      const store = new CompanyStore(join(paths.data, 'company.json'));
      await store.init();
      if (store.snapshot().employees.some((employee) => employee.desiredRunning !== false || !employee.onVacation))
        throw new Error('A synthetic employee acquired running intent');
      try {
        const saved = JSON.parse(await readFile(join(paths.data, 'state.json'), 'utf8'));
        const rows: unknown = saved.sessions;
        if (
          !rows ||
          typeof rows !== 'object' ||
          Array.isArray(rows) ||
          Object.keys(rows).length !== declaredSessions.size
        )
          throw new Error('Unexpected session Record in real-office fixture');
        for (const [id, row] of Object.entries(rows)) {
          if (
            !declaredSessions.has(id) ||
            !row ||
            typeof row !== 'object' ||
            Array.isArray(row) ||
            row.id !== id ||
            row.pid !== null ||
            row.status !== 'idle' ||
            row.currentTaskId !== null ||
            row.isWorking === true ||
            row.remote !== undefined ||
            row.docker !== undefined
          )
            throw new Error('A stored fixture Session acquired running or provider-effect state');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || declaredSessions.size) throw error;
      }
      const actual = server?.['sessions'];
      if (!actual || actual.size !== declaredSessions.size)
        throw new Error('Unexpected live Session registry in real-office fixture');
      for (const [id, original] of declaredSessions) {
        if (
          actual.get(id) !== original ||
          original.pid !== null ||
          original.status !== 'idle' ||
          original.isWorking ||
          original.currentTaskId !== null ||
          original.remote ||
          original.docker
        )
          throw new Error('An original fixture Session acquired running or provider-effect state');
      }
    };
    return {
      origin: () => {
        if (!server) throw new Error('The isolated office is stopped');
        return `http://127.0.0.1:${server.boundPort}`;
      },
      workspace: paths.workspace,
      currentServer: () => {
        if (!server) throw new Error('The owned office is stopped');
        return server;
      },
      seedUnstartedSessions: async (options) => {
        await assertNoRunningIntent();
        if (declaredSessions.size || !server) throw new Error('Unstarted Sessions may be seeded only once');
        const { Session } = await import('../../src/session.js');
        const { getStore } = await import('../../src/state-store.js');
        const rows = [];
        let selected: Array<{ id: string; name: string }> = ['Synthetic stream A', 'Synthetic stream B'].map(
          (name) => ({ id: randomUUID(), name })
        );
        if (options) {
          const { CompanyStore } = await import('../../src/company-store.js');
          const company = new CompanyStore(join(paths.data, 'company.json'));
          await company.init();
          const employees = company.snapshot().employees;
          const socket = await import('node:fs/promises').then((fs) => fs.lstat(options.nativeSocket));
          if (
            !socket.isSocket() ||
            socket.uid !== process.getuid?.() ||
            (socket.mode & 0o077) !== 0 ||
            !options.employees.length ||
            new Set(options.employees.map((row) => row.sessionId)).size !== options.employees.length ||
            options.employees.some(
              (row) =>
                employees.filter(
                  (e) =>
                    e.id === row.id &&
                    e.sessionId === row.sessionId &&
                    e.name === row.name &&
                    e.desiredRunning === false &&
                    e.onVacation
                ).length !== 1
            )
          )
            throw Error('Original OFF employee bindings/private physical fixture socket required');
          selected = options.employees.map((row) => ({ id: row.sessionId, name: row.name }));
        }
        for (const { id, name } of selected) {
          const previousSocket = process.env.REVERIE_WORKER_SOCKET;
          let session: Session;
          try {
            if (options) process.env.REVERIE_WORKER_SOCKET = options.nativeSocket;
            session = new Session({
              id,
              name,
              mode: options ? 'claude' : 'shell',
              workingDir: paths.workspace,
              useMux: false,
            });
          } finally {
            if (previousSocket === undefined) delete process.env.REVERIE_WORKER_SOCKET;
            else process.env.REVERIE_WORKER_SOCKET = previousSocket;
          }
          declaredSessions.set(session.id, session);
          await server['registerSessionWithLayout'](session);
          getStore().setSession(session.id, session.toState());
          rows.push({ id: session.id, name });
        }
        await getStore().saveNowAsync();
        server['cachedLightState'] = null;
        server['cachedSessionsList'] = null;
        await assertNoRunningIntent();
        return rows;
      },
      seedStoppedEmployees: async () => {
        await assertNoRunningIntent();
        if (declaredSessions.size) throw new Error('Seed stopped employees before declaring Session streams');
        await stop!(server!);
        server = undefined;
        const { CompanyStore } = await import('../../src/company-store.js');
        const { EmployeeSchema } = await import('../../src/company-types.js');
        const store = new CompanyStore(join(paths.data, 'company.json'));
        await store.init();
        if (store.snapshot().employees.length) throw new Error('Stopped employees may be seeded only once');
        const employees = ['Fixture reviewer', 'Fixture engineer'].map((name) =>
          EmployeeSchema.parse({
            id: randomUUID(),
            sessionId: randomUUID(),
            name,
            icon: 'F',
            position: 'Synthetic reviewer',
            expertise: ['Browser acceptance'],
            reportsTo: 'owner',
            researchEnabled: false,
            sleepEnabled: false,
            dreamEnabled: false,
            desiredRunning: false,
            onVacation: true,
            createdAt: Date.now(),
          })
        );
        await store.update((state) => {
          state.employees.push(...employees);
        });
        await writeFile(
          join(paths.workspace, 'fixture-readme.md'),
          '# Synthetic shared workspace\n\nNo personal data.\n',
          { mode: 0o600 }
        );
        server = await factory.createTestServer({
          titleHostname: 'synthetic-office',
          beforeStart: options.beforeStart,
        });
        await assertNoRunningIntent();
        return employees.map(({ id, sessionId, name }) => ({ id, sessionId, name }));
      },
      assertNoRunningIntent,
      close: async () => {
        let safeToRemove = false;
        try {
          await assertNoRunningIntent();
          safeToRemove = true;
        } finally {
          try {
            if (server) await stop!(server);
            server = undefined;
          } finally {
            restoreEnvironment();
            if (safeToRemove) await removeOwnedRoot();
          }
        }
      },
    };
  } catch (error) {
    try {
      if (server && stop) await stop(server);
    } finally {
      restoreEnvironment();
      await removeOwnedRoot();
    }
    throw error;
  }
}
