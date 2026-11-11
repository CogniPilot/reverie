/** Real WebServer test fixture. Owns only fresh temporary state; never a runtime. */
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { WebServer } from '../../src/web/server.js';

export interface IsolatedOffice {
  origin(): string;
  workspace: string;
  seedStoppedEmployees(): Promise<Array<{ id: string; sessionId: string; name: string }>>;
  assertNoRunningIntent(): Promise<void>;
  close(): Promise<void>;
}

function contained(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

export async function createIsolatedOffice(): Promise<IsolatedOffice> {
  if (process.env.VITEST !== 'true') throw new Error('The real-office fixture requires the isolated Vitest runner');
  const original = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), 'office-fixture-'));
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
    REVERIE_OWNER_SETUP: '1',
    REVERIE_INSTALL_CLIS: 'none',
  });
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
    server = await factory.createTestServer({ titleHostname: 'synthetic-office' });
    const assertNoRunningIntent = async () => {
      const { CompanyStore } = await import('../../src/company-store.js');
      const store = new CompanyStore(join(paths.data, 'company.json'));
      await store.init();
      if (store.snapshot().employees.some((employee) => employee.desiredRunning !== false || !employee.onVacation))
        throw new Error('A synthetic employee acquired running intent');
      try {
        const saved = JSON.parse(await readFile(join(paths.data, 'state.json'), 'utf8'));
        if (Array.isArray(saved.sessions) && saved.sessions.length)
          throw new Error('Unexpected session state in real-office fixture');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
    return {
      origin: () => {
        if (!server) throw new Error('The isolated office is stopped');
        return `http://127.0.0.1:${server.boundPort}`;
      },
      workspace: paths.workspace,
      seedStoppedEmployees: async () => {
        await assertNoRunningIntent();
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
        server = await factory.createTestServer({ titleHostname: 'synthetic-office' });
        await assertNoRunningIntent();
        return employees.map(({ id, sessionId, name }) => ({ id, sessionId, name }));
      },
      assertNoRunningIntent,
      close: async () => {
        try {
          await assertNoRunningIntent();
        } finally {
          try {
            if (server) await stop!(server);
            server = undefined;
          } finally {
            restoreEnvironment();
            await removeOwnedRoot();
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
