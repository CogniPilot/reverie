/** Actual client processes and enforced API/auth/journal/source stores. Synthetic
 * accounts and messages only; no providers, live namespaces or employee homes. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerAuthStore } from '../src/owner-auth/store.js';
import { OwnerAuthService } from '../src/owner-auth/service.js';
import { bootstrap } from '../src/owner-auth/admin.js';
import { callerOf, registerOwnerPolicy } from '../src/owner-auth/policy.js';
import { ownerVerifier } from '../src/owner-auth/marks.js';
import { registerAuthMiddleware } from '../src/web/middleware/auth.js';
import { registerEmployeeJournalRoutes } from '../src/web/routes/employee-journal-routes.js';
import { createUser } from '../src/user-store.js';
import { CompanyStore } from '../src/company-store.js';
import { EmployeeSchema } from '../src/company-types.js';
import { EmployeeJournalStore } from '../src/employee-journal.js';
import { ChatroomService, type ChatSessionLike } from '../src/chatroom-service.js';
import { ChatroomStore, saveChatrooms } from '../src/chatroom-store.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { InstalledMemoryBridge } from '../src/installed-memory-bridge.js';
import { createMcpServer } from '../src/mcp-server.js';

const SID = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';
const ALICE = 'native-journal-alice';
const BOB = 'native-journal-bob';
const PASSWORD = 'Synthetic-only-native-journal-93';
const QUOTE = 'Synthetic records carry exact UTC times';
const app = Fastify();
const sessions = new Map<string, ChatSessionLike>();
const ctx = { sessions } as unknown as SessionPort;
let directory: string, url: string, room: string, turn: string, unreadable: string;
let callerInstance: string;
let company: CompanyStore, journal: EmployeeJournalStore, chat: ChatroomService;
let auth: ReturnType<typeof registerAuthMiddleware>;
const responses: Array<{ method: string; path: string; code: number }> = [];
const requests: Array<{ method: string; path: string }> = [];
let dropNextSaveReply = false;
let holdNextSaveReply: (() => Promise<void>) | undefined;

beforeAll(async () => {
  vi.stubEnv('REVERIE_MULTIUSER', '1');
  directory = await mkdtemp(join(realpathSync(tmpdir()), 'native-journal-api-'));
  callerInstance = join(directory, 'caller-instance.json');
  await writeFile(
    callerInstance,
    JSON.stringify({
      id: 'synthetic-api-caller',
      agent_name: 'Synthetic employee',
      owner_name: 'Synthetic owner',
      data_dir: 'caller-state',
      persona: 'Synthetic test persona.',
    }),
    { mode: 0o600 }
  );
  await createUser({ username: ALICE, role: 'user', password: PASSWORD });
  await createUser({ username: BOB, role: 'user', password: PASSWORD });
  const authStore = new OwnerAuthStore(join(directory, 'owner.json'));
  await bootstrap(authStore, 'synthetic-owner', { enforce: true });
  const service = new OwnerAuthService({ store: authStore, auditFile: join(directory, 'audit.jsonl') });
  for (const [id, owner] of [
    [SID, ALICE],
    [FOREIGN, BOB],
  ])
    sessions.set(id!, {
      id: id!,
      owner,
      name: 'Synthetic employee',
      pid: 123,
      mode: 'shell',
      status: 'idle',
    } as ChatSessionLike);
  company = new CompanyStore(join(directory, 'company.json'));
  await company.init();
  await company.update((state) => {
    state.employees = [
      [SID, ALICE],
      [FOREIGN, BOB],
    ].map(([id, owner]) =>
      EmployeeSchema.parse({
        id,
        sessionId: id,
        owner,
        name: 'Synthetic employee',
        icon: 'X',
        position: 'Engineer',
        expertise: ['Testing'],
        sessionGeneration: 1,
        createdAt: 1,
        desiredRunning: true,
      })
    );
  });
  const rooms = new ChatroomStore();
  const visible = rooms.create('Synthetic visible room', ALICE, 1);
  room = visible.id;
  rooms.addMember(room, SID, {}, 1);
  turn = rooms.post(room, { kind: 'user', name: 'Synthetic user' }, `Remember this: ${QUOTE}.`, 'all', 100).id;
  const hidden = rooms.create('Synthetic private room', ALICE, 1);
  unreadable = rooms.post(
    hidden.id,
    { kind: 'user', name: 'Synthetic user' },
    `Remember this: ${QUOTE}.`,
    'all',
    100
  ).id;
  const file = join(directory, 'chatrooms.json');
  await saveChatrooms(file, rooms.list());
  chat = new ChatroomService({
    file,
    getSession: (id) => sessions.get(id),
    broadcast: () => {},
    deferDeliveryRecovery: true,
  });
  await chat.init();
  journal = EmployeeJournalStore.open(join(directory, 'employee-journal.db'));
  await app.register(cookie);
  auth = registerAuthMiddleware(app, false, '', service);
  registerOwnerPolicy(app, {
    service,
    ctx,
    isCapabilityRequest: () => false,
    relations: {
      known: (id) => sessions.has(id),
      related: (a, b) => a === b,
      upward: () => false,
      keeper: () => false,
      admin: () => false,
    },
  });
  registerEmployeeJournalRoutes(app, ctx, {
    verifiedOwner: ownerVerifier({ service, ctx }),
    agentSession: (request) => {
      const caller = callerOf(request, { service, ctx });
      return caller.kind === 'agent' ? caller.session : undefined;
    },
    company: (owner) => ({ employees: company.snapshot().employees.filter((employee) => employee.owner === owner) }),
    journal: () => journal,
    visibleMessage: (session, roomId, messageId) => chat.agentVisibleMessage(session, roomId, messageId),
  });
  app.addHook('onRequest', async (request) => {
    requests.push({ method: request.method, path: request.url });
  });
  app.addHook('onResponse', async (request, reply) => {
    responses.push({ method: request.method, path: request.url, code: reply.statusCode });
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      dropNextSaveReply &&
      request.method === 'POST' &&
      request.url === '/api/agent/journal/save' &&
      reply.statusCode === 200
    ) {
      dropNextSaveReply = false;
      reply.raw.destroy();
    }
    if (
      holdNextSaveReply &&
      request.method === 'POST' &&
      request.url === '/api/agent/journal/save' &&
      reply.statusCode === 200
    ) {
      const hold = holdNextSaveReply;
      holdNextSaveReply = undefined;
      await hold();
    }
    return payload;
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No owned listening socket');
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  await chat?.stop();
  journal?.close();
  for (const disposable of Object.values(auth ?? {})) disposable?.dispose();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}
async function procText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
async function ownedChildren(parent: number): Promise<string[]> {
  const root = `/proc/${parent}/task`;
  const children = new Set<string>();
  for (const tid of await readdir(root)) {
    expect(tid).toMatch(/^\d+$/);
    const raw = await procText(`${root}/${tid}/children`);
    for (const pid of (raw ?? '').trim().split(/\s+/).filter(Boolean)) {
      expect(pid).toMatch(/^[1-9]\d*$/);
      children.add(pid);
    }
  }
  return [...children];
}
function startTime(raw: string): string {
  expect(raw).toMatch(/^\d+ \(/);
  const value = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/)[19];
  expect(value).toMatch(/^[1-9]\d*$/);
  return value!;
}
function run(command: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Result> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function environment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    HOME: directory,
    PATH: process.env.PATH,
    VITEST: 'true',
    REVERIE_NO_AUTOSTART: '1',
    REVERIE_MUX: '1',
    REVERIE_SESSION_ID: SID,
    REVERIE_API_URL: url,
    REVERIE_INSTANCE_CONFIG: callerInstance,
    REVERIE_EMBED_DIMS: '8',
    REVERIE_MULTIUSER: '1',
    REVERIE_USERNAME: ALICE,
    REVERIE_PASSWORD: PASSWORD,
    ...extra,
  };
}
function invoke(extra: NodeJS.ProcessEnv = {}, changes: Record<string, string> = {}): Promise<Result> {
  const body = {
    action: 'remember',
    private: true,
    text: 'Synthetic records carry exact UTC times.',
    room,
    turn,
    tag: 'lesson',
    quote: QUOTE,
    ...changes,
  };
  const env = environment(extra);
  const candidate = process.env.NIX_REVERIE_TEST_MEMORY_CLI;
  if (candidate) return run(candidate, [], env, JSON.stringify(body));
  const args = [
    '--import',
    'tsx',
    resolve('src/index.ts'),
    'agent',
    'journal',
    'save',
    '--room',
    body.room,
    '--turn',
    body.turn,
    '--text',
    body.text,
    '--tag',
    body.tag,
    '--source',
    body.turn,
    '--quote',
    body.quote,
    '--json',
  ];
  return run(process.execPath, args, env);
}
function saved(result: Result): Record<string, unknown> {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  return (value.data ?? value) as Record<string, unknown>;
}

describe('native memory supported TypeScript journal path', () => {
  it('authenticates the actual client, checks the readable turn and replays only the identical save', async () => {
    const first = saved(await invoke());
    expect(first).toMatchObject({ entryId: 1, turnId: turn, replayed: false });
    await expect(stat(join(directory, 'caller-state'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(saved(await invoke())).toMatchObject({ entryId: 1, turnId: turn, replayed: true });
    expect(journal.receipt(ALICE, SID, turn)).toMatchObject({ status: 'committed' });
    expect((await invoke({}, { text: 'A changed payload for the same turn.' })).code).not.toBe(0);
  });

  it('refuses missing/wrong credentials and a foreign or missing current session', async () => {
    for (const env of [
      { REVERIE_PASSWORD: '' },
      { REVERIE_PASSWORD: 'Synthetic-wrong-password' },
      { REVERIE_SESSION_ID: FOREIGN },
      { REVERIE_SESSION_ID: 'not-current' },
    ]) {
      const before = responses.length;
      expect((await invoke(env)).code).not.toBe(0);
      expect(responses.slice(before).some((response) => response.code === 401 || response.code === 403)).toBe(true);
    }
    const session = sessions.get(SID)!;
    sessions.delete(SID);
    try {
      expect((await invoke()).code).not.toBe(0);
    } finally {
      sessions.set(SID, session);
    }
  });

  it('checks source visibility and exact quotes rather than trusting authenticated request fields', async () => {
    for (const changes of [{ quote: 'Invented quote not in the turn' }, { turn: unreadable }])
      expect((await invoke({}, changes)).code).not.toBe(0);
    expect(journal.receipt(ALICE, SID, unreadable)).toMatchObject({ status: 'not_found' });
  });

  it('uses the supported per-field credential file fallback without putting a password in argv', async () => {
    const home = join(directory, 'fallback-home');
    await mkdir(join(home, '.reverie'), { recursive: true });
    await writeFile(join(home, '.reverie', '.env'), `REVERIE_USERNAME=${ALICE}\nREVERIE_PASSWORD=${PASSWORD}\n`, {
      mode: 0o600,
    });
    expect(saved(await invoke({ HOME: home, REVERIE_USERNAME: '', REVERIE_PASSWORD: '' }))).toMatchObject({
      entryId: 1,
      replayed: true,
    });
  });

  it('does not automatically replay a save whose actual durable reply was lost', async () => {
    const message = chat.post(room, { kind: 'user', name: 'Synthetic user' }, `Remember this: ${QUOTE}.`, 'all', {
      deliver: false,
    });
    const before = requests.length;
    dropNextSaveReply = true;
    const result = await invoke({}, { turn: message.id });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/unknown|not confirmed/);
    expect(dropNextSaveReply).toBe(false);
    expect(journal.receipt(ALICE, SID, message.id)).toMatchObject({ status: 'committed' });
    expect(requests.slice(before).filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('does not accept a tool/environment-selected or ordinary filesystem executable origin', () => {
    for (const value of ['reverie-memory', '/bin/node', join(directory, 'reverie-memory')])
      expect(() => InstalledMemoryBridge.capture(value)).toThrow();
  });

  it.runIf(Boolean(process.env.NIX_REVERIE_TEST_MEMORY_CLI))(
    'settles the actual Node child before a signal terminates the native CLI',
    async () => {
      const candidate = process.env.NIX_REVERIE_TEST_MEMORY_CLI!;
      const message = chat.post(room, { kind: 'user', name: 'Synthetic user' }, `Remember this: ${QUOTE}.`, 'all', {
        deliver: false,
      });
      let reached!: () => void, release!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      holdNextSaveReply = () => {
        reached();
        return released;
      };
      const child = spawn(candidate, [], { env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (data) => {
        stdout += String(data);
      });
      child.stderr.on('data', (data) => {
        stderr += String(data);
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stdin.end(
        JSON.stringify({
          action: 'remember',
          private: true,
          room,
          turn: message.id,
          tag: 'lesson',
          text: QUOTE,
          quote: QUOTE,
        })
      );
      try {
        await Promise.race([
          arrived,
          closed.then(() => {
            throw new Error('CLI ended before the controlled reply');
          }),
        ]);
        const children = await ownedChildren(child.pid!);
        expect(children).toHaveLength(1);
        const node = children[0]!;
        const before = await readFile(`/proc/${node}/stat`, 'utf8');
        const started = startTime(before);
        const stopAt = Date.now();
        expect(child.kill('SIGTERM')).toBe(true);
        expect(await closed, stderr).toBe(143);
        expect(Date.now() - stopAt).toBeLessThan(3000);
        expect(stdout).toBe('');
        expect(stderr).toContain('interrupted');
        const after = await procText(`/proc/${node}/stat`);
        if (after) expect(startTime(after)).not.toBe(started);
        expect(journal.receipt(ALICE, SID, message.id)).toMatchObject({ status: 'committed' });
      } finally {
        clearTimeout(timer);
        release();
        holdNextSaveReply = undefined;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await closed.catch(() => {});
      }
    }
  );

  it.runIf(Boolean(process.env.NIX_REVERIE_TEST_MEMORY_CLI))(
    'merges an actual authenticated recall while leaving the initialized legacy profile unchanged',
    async () => {
      const candidate = process.env.NIX_REVERIE_TEST_MEMORY_CLI!;
      const instance = join(directory, 'recall-instance.json');
      await writeFile(
        instance,
        JSON.stringify({
          id: 'synthetic',
          agent_name: 'Synthetic employee',
          owner_name: 'Synthetic owner',
          data_dir: 'recall-state',
          persona: 'Synthetic test persona.',
        })
      );
      const env = environment({ REVERIE_INSTANCE_CONFIG: instance, REVERIE_EMBED_DIMS: '8' });
      const initialized = await run(candidate, ['--initialize'], env);
      expect(initialized.code, initialized.stderr).toBe(0);
      const profile = join(directory, 'recall-state/profile.md');
      const before = await readFile(profile);
      const database = join(directory, 'recall-state/memory.sqlite');
      const databaseBefore = await readFile(database);
      const result = await run(
        candidate,
        [],
        env,
        JSON.stringify({ action: 'recall', private: true, query: 'Synthetic records' })
      );
      expect(result.code, result.stderr).toBe(0);
      const recalled = JSON.parse(result.stdout);
      expect(
        recalled.journal.some((entry: { text: string }) => entry.text === 'Synthetic records carry exact UTC times.')
      ).toBe(true);
      expect(Array.isArray(recalled.legacy)).toBe(true);
      expect(await readFile(profile)).toEqual(before);
      expect(await readFile(database)).toEqual(databaseBefore);
    }
  );

  it.runIf(Boolean(process.env.NIX_REVERIE_TEST_MEMORY_CLI))(
    'keeps actual MCP journal auth in process and strips it from the real native screening child',
    async () => {
      const candidate = process.env.NIX_REVERIE_TEST_MEMORY_CLI!;
      const installation = environment({
        REVERIE_EMBED_DIMS: '8',
        REVERIE_EMBED_DOC_PREFIX: 'chosen-document: ',
        REVERIE_EMBED_QUERY_PREFIX: 'chosen-query: ',
        REVERIE_OUTPUT_POLICY: '{}',
      });
      const binding = InstalledMemoryBridge.capture(candidate, installation);
      const instance = join(directory, 'synthetic-instance.json');
      await writeFile(
        instance,
        JSON.stringify({
          id: 'synthetic-mcp',
          agent_name: 'Synthetic employee',
          owner_name: 'Synthetic owner',
          data_dir: 'mcp-state',
          persona: 'Synthetic test persona.',
        })
      );
      const out: Array<Record<string, unknown>> = [];
      const childEnvironments: NodeJS.ProcessEnv[] = [];
      const server = createMcpServer({
        config: {
          allowAnySession: false,
          version: 'qualification',
          apiUrl: url,
          selfId: SID,
          auth: { username: ALICE, password: PASSWORD },
        },
        write: (value) => {
          out.push(value);
        },
        modes: ['shell'],
        memory: { instance, native: binding },
        memoryRunner: async (program, args, options) => {
          expect(program).toBe(candidate);
          expect(args).toEqual([]);
          childEnvironments.push(options.env);
          const reply = await run(program, args, options.env, options.input);
          return { ...reply, code: reply.code ?? 1 };
        },
      });
      const message = chat.post(room, { kind: 'user', name: 'Synthetic user' }, `Remember this: ${QUOTE}.`, 'all', {
        deliver: false,
      });
      await server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'memory_remember',
            arguments: { room, turn: message.id, tag: 'lesson', text: QUOTE, quote: QUOTE },
          },
        })
      );
      const result = out[0]!.result as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({ turnId: message.id, replayed: false });
      expect(journal.receipt(ALICE, SID, message.id)).toMatchObject({ status: 'committed' });
      expect(childEnvironments).toHaveLength(1);
      const child = childEnvironments[0]!;
      expect(child.REVERIE_INSTANCE_CONFIG).toBe(instance);
      expect(child.REVERIE_OUTPUT_POLICY).toBe('{}');
      expect(child.REVERIE_EMBED_DOC_PREFIX).toBe('chosen-document: ');
      for (const key of [
        'REVERIE_PASSWORD',
        'REVERIE_USERNAME',
        'REVERIE_API_URL',
        'REVERIE_SESSION_ID',
        'REVERIE_MUX',
        'NODE_OPTIONS',
        'PYTHONPATH',
      ])
        expect(child[key], key).toBeUndefined();
      const beforeRecall = requests.length;
      out.length = 0;
      await server.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'memory_recall',
            arguments: { query: 'Synthetic records' },
          },
        })
      );
      const missing = out[0]!.result as { content: Array<{ text: string }>; isError: boolean };
      expect(missing.isError).toBe(true);
      expect(missing.content[0]!.text).toMatch(/initialized/);
      await expect(stat(join(directory, 'mcp-state'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(requests.length).toBe(beforeRecall);
      const beforePolicy = requests.length;
      const blockedOut: Array<Record<string, unknown>> = [];
      const blocked = createMcpServer({
        config: {
          allowAnySession: false,
          version: 'qualification',
          apiUrl: url,
          selfId: SID,
          auth: { username: ALICE, password: PASSWORD },
        },
        write: (value) => {
          blockedOut.push(value);
        },
        modes: ['shell'],
        memory: {
          instance,
          native: InstalledMemoryBridge.capture(candidate, {
            ...installation,
            REVERIE_OUTPUT_POLICY: '{"denied_patterns":["owner-rule"]}',
          }),
        },
        memoryRunner: async (program, args, options) => {
          const reply = await run(program, args, options.env, options.input);
          return { ...reply, code: reply.code ?? 1 };
        },
      });
      await blocked.handleLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'memory_remember',
            arguments: { room, turn: message.id, tag: 'lesson', text: QUOTE, quote: QUOTE },
          },
        })
      );
      const refused = blockedOut[0]!.result as { content: Array<{ text: string }>; isError: boolean };
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toContain('hard-floor check did not run');
      expect(requests.length).toBe(beforePolicy);
    }
  );
});
