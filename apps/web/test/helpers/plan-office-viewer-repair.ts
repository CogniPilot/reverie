/** Test-office only. Receipts are closed observations, never product authority.
 * The hosted driver must join them to independent physical provider/client reads. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveAgentContext } from '../../src/cli-agent.js';
import { viewerRecoveryStatus } from '../../src/cli-agent-viewer.js';
import { PlanOfficeForceChild, planOfficeForceChildArgs } from './plan-office-force-child.js';
import {
  readDockerViewerProcess,
  readDockerViewerSocket,
  type DockerViewerProcessObservation,
  type DockerViewerExecutableObservation,
} from '../../src/docker-viewer-process.js';
const uuid = z
    .string()
    .uuid()
    .regex(/^[a-f0-9-]+$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
export const planOfficeViewerDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const PlanOfficeViewerCommandInput = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-sdk-viewer-command-v1'),
    id: uuid,
    command: z.enum(['viewer-status', 'reconnect-viewer']),
    expected: z.enum(['allowed', 'denied']),
    callerEmployeeId: uuid,
    callerSessionId: uuid,
    employeeId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
  })
  .strict()
  .refine((value) => value.callerEmployeeId !== value.employeeId && value.callerSessionId !== value.sessionId)
  .refine((value) => value.command === 'viewer-status' || value.expected === 'allowed');
export type PlanOfficeViewerCommandInput = z.infer<typeof PlanOfficeViewerCommandInput>;
const reconnect = z
  .object({
    state: z.enum(['idle', 'connecting', 'connected', 'blocked']),
    reason: z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),
    attempts: z.number().int().min(0).max(1000),
    retryAfterMs: z.number().int().min(0).max(60000),
  })
  .strict();
export const PlanOfficeViewerCommandReceipt = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-sdk-viewer-command-returned-v1'),
    id: uuid,
    command: z.enum(['viewer-status', 'reconnect-viewer']),
    expected: z.enum(['allowed', 'denied']),
    callerEmployeeId: uuid,
    callerSessionId: uuid,
    employeeId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    namespacePid: z.number().int().min(2),
    child: PlanOfficeForceChild,
    exitCode: z.union([z.literal(0), z.literal(4)]),
    reconnect: reconnect.nullable(),
    stdoutSha256: hash,
    stderrSha256: hash,
  })
  .strict();
export type PlanOfficeViewerCommandReceipt = z.infer<typeof PlanOfficeViewerCommandReceipt>;
export function planOfficeViewerArgs(input: PlanOfficeViewerCommandInput) {
  PlanOfficeViewerCommandInput.parse(input);
  return Object.freeze(['agent', input.command, input.employeeId, '--json']);
}
export function planOfficeViewerPrompt(id: string) {
  uuid.parse(id);
  return { input: 'BOXED_VIEWER_COMMAND_' + id + '\r', useMux: true as const };
}
interface ViewerCommandFiles {
  viewerCommandRecord(kind: 'issued', value: PlanOfficeViewerCommandInput): void;
  viewerCommandRecord(kind: 'returned', value: PlanOfficeViewerCommandReceipt): void;
}
interface ViewerCli {
  (
    args: readonly string[],
    input: undefined,
    context: 'sdk-without-mux',
    observed: (value: PlanOfficeForceChild) => void
  ): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>;
}
/** Invoked only by the current external fake SDK's fixed UUID trigger. The
 * actual adapter clones its inherited environment and deletes ONLY MUX; the
 * existing /proc observer independently attests the post-entry Node child. */
export async function runPlanOfficeViewerCommand(
  unchecked: unknown,
  callerEmployeeId: string,
  files: ViewerCommandFiles,
  cli: ViewerCli,
  env: NodeJS.ProcessEnv = process.env
) {
  const input = PlanOfficeViewerCommandInput.parse(unchecked);
  assert.equal(env.HOME, '/home/agent');
  assert.equal(input.callerEmployeeId, callerEmployeeId);
  assert.ok(env.REVERIE_WORKER_IDENTITY_FILE, 'Actual SDK protected credential required');
  const context = resolveAgentContext(env);
  assert.ok(context.workerIdentity, 'The actual protected SDK reader must select worker identity');
  assert.equal(context.auth, undefined);
  assert.equal(context.selfId, input.callerSessionId);
  const args = planOfficeViewerArgs(input);
  files.viewerCommandRecord('issued', input); // exclusive close before binding GET or repair; never replay
  let child: PlanOfficeForceChild | undefined;
  const reply = await cli(args, undefined, 'sdk-without-mux', (value) => {
    assert.equal(child, undefined, 'One actual SDK CLI child observation only');
    child = PlanOfficeForceChild.parse(value);
  });
  assert.ok(child, 'Unobservable SDK child cannot qualify a returned CLI result');
  assert.equal(child.parentPid, process.pid);
  assert.equal(child.sessionId, input.callerSessionId);
  assert.equal(child.argsDigest, planOfficeViewerDigest(JSON.stringify(planOfficeForceChildArgs(args))));
  assert.equal(child.identityFileDigest, planOfficeViewerDigest(env.REVERIE_WORKER_IDENTITY_FILE));
  assert.equal(reply.signal, null);
  assert.equal(reply.exitCode, input.expected === 'allowed' ? 0 : 4);
  assert.ok(Buffer.byteLength(reply.stdout) <= 65536 && Buffer.byteLength(reply.stderr) <= 65536);
  let status: z.infer<typeof reconnect> | null = null;
  if (input.expected === 'allowed') {
    const result = z
      .object({ state: z.literal('viewer-connected').optional(), reconnect })
      .strict()
      .parse(JSON.parse(reply.stdout));
    status = reconnect.parse(viewerRecoveryStatus(result.reconnect));
    if (input.command === 'reconnect-viewer') {
      assert.equal(result.state, 'viewer-connected');
      assert.equal(status.state, 'connected');
    } else assert.equal(result.state, undefined);
  }
  const receipt = PlanOfficeViewerCommandReceipt.parse({
    ...input,
    purpose: 'reverie-ci-sdk-viewer-command-returned-v1',
    namespacePid: process.pid,
    child,
    exitCode: reply.exitCode,
    reconnect: status,
    stdoutSha256: planOfficeViewerDigest(reply.stdout),
    stderrSha256: planOfficeViewerDigest(reply.stderr),
  });
  files.viewerCommandRecord('returned', receipt); // consuming closes precede SDK stdout barrier
  return receipt;
}

/** Ordering port for the mandatory hosted team tail. Tests of this coordinator
 * are source contract checks; only the Driver supplies actual Engine/API ports. */
export interface PlanOfficeViewerRepairPorts {
  current(): void;
  grant(enabled: boolean): Promise<void>;
  snapshot(): Promise<unknown>;
  draft(): Promise<void>;
  detach(): Promise<void>;
  command(
    command: 'viewer-status' | 'reconnect-viewer',
    expected: 'allowed' | 'denied',
    id: string
  ): Promise<PlanOfficeViewerCommandReceipt>;
  verify(before: unknown, after: unknown, website: 'replaced' | 'same'): void;
  record(name: string, value: unknown): void;
}
export async function runPlanOfficeViewerRepair(ports: PlanOfficeViewerRepairPorts) {
  ports.current();
  await ports.grant(true);
  ports.current();
  await ports.draft();
  const before = await ports.snapshot();
  ports.current();
  const id = randomUUID();
  ports.record('viewer-repair-' + id + '-intent', { id, noReplay: true });
  await ports.detach(); // exactly one owned website client; never a pane/provider stop
  ports.current();
  const status = await ports.command('viewer-status', 'allowed', randomUUID());
  assert.ok(status.reconnect);
  assert.equal(status.reconnect?.state, 'blocked');
  assert.equal(status.reconnect.reason, 'not-attempted');
  const repaired = await ports.command('reconnect-viewer', 'allowed', randomUUID());
  assert.equal(repaired.reconnect?.state, 'connected');
  const connected = await ports.command('viewer-status', 'allowed', randomUUID());
  assert.equal(connected.reconnect?.state, 'connected');
  ports.current();
  const after = await ports.snapshot();
  ports.verify(before, after, 'replaced');
  await ports.grant(false);
  ports.current();
  const denied = await ports.command('viewer-status', 'denied', randomUUID());
  assert.equal(denied.exitCode, 4);
  const revoked = await ports.snapshot();
  ports.verify(after, revoked, 'same'); // caller grant lifetime never owns target view lifetime
  ports.current();
  const result = { id, status, repaired, connected, denied, before, after, revoked };
  ports.record('viewer-repair-' + id + '-completed', result);
  return result;
}

const positivePid = z.number().int().min(2).max(2147483647);
const birth = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const PlanOfficeWebsiteClient = z
  .object({
    sessionId: uuid,
    muxName: z.string().regex(/^reverie-[a-f0-9]{8}$/),
    pid: positivePid,
    birth,
    tty: z.string().regex(/^\/dev\/pts\/(?:0|[1-9][0-9]*)$/),
    ttyStamp: z.string().min(1).max(512),
    parentBirth: birth,
    parentCommandDigest: hash,
    serverPid: positivePid,
    serverBirth: birth,
    socketPath: z.string().min(1).max(4096),
    socketStamp: z.string().min(1).max(512),
    outerPid: positivePid,
    outerBirth: birth,
    outerCommandDigest: hash,
    outerForm: z.literal('paid-launch'),
    manifestDigest: hash,
  })
  .strict();
export type PlanOfficeWebsiteClient = z.infer<typeof PlanOfficeWebsiteClient>;
const websiteReceipt = PlanOfficeWebsiteClient.omit({ socketPath: true }).extend({ socketPathSha256: hash });
const flagPresence = z
  .object({ present: z.boolean(), value: z.boolean().nullable() })
  .strict()
  .refine((value) => (value.present ? value.value !== null : value.value === null));
const nativeReceipt = z
  .object({
    paneId: z.string().regex(/^%[0-9]+$/),
    panePid: positivePid,
    paneStartTicks: birth,
    threadId: uuid,
    hookGenerationSha256: hash,
  })
  .strict();
/** Approved artifact projection only; all full replies/configuration stay private. */
export const PlanOfficeViewerRepairCompletion = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-team-viewer-repair-completed-v1'),
    id: uuid,
    controlId: z.string().regex(/^[a-f0-9]{64}$/),
    callerEmployeeId: uuid,
    employeeId: uuid,
    callerSessionId: uuid,
    sessionId: uuid,
    sessionGeneration: z.number().int().positive().safe(),
    operationId: uuid,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    callerNative: nativeReceipt,
    targetNative: nativeReceipt,
    oldWebsite: websiteReceipt,
    newWebsite: websiteReceipt,
    afterRevokeWebsite: websiteReceipt,
    commands: z.tuple([
      PlanOfficeViewerCommandReceipt,
      PlanOfficeViewerCommandReceipt,
      PlanOfficeViewerCommandReceipt,
      PlanOfficeViewerCommandReceipt,
    ]),
    draft: z
      .object({
        sha256: hash,
        occurrences: z.literal(1),
        targetTurnFilesSha256: hash,
        consumingHistoryBarriersSha256: hash,
      })
      .strict(),
    paidJournalSha256: hash,
    kernelPolicySha256: hash,
    canonicalScopeSha256: hash,
    inputFences: z
      .object({
        publicTerminal: flagPresence,
        savedTerminal: flagPresence,
        publicProvider: flagPresence,
        savedProvider: flagPresence,
      })
      .strict(),
    activeUnknownInputExercised: z.boolean(),
    unknownPipelineHistoryNativeQualified: z.literal(false),
    sdkInheritedMinusOnlyMux: z.literal(true),
    realPackagedCliAndHttp: z.literal(true),
    oneWebsiteClientOnly: z.literal(true),
    originalPaidProviderAndDraftRetained: z.literal(true),
    grantRevokedAndReadBack: z.literal(true),
    currentAfterCallerGrantRevoked: z.literal(true),
    productViewCurrentAfterRepair: z.literal(true),
    productViewCurrentAfterCallerRevoke: z.literal(true),
    limitation: z.literal('External fake provider; no paid vendor/chat/self/website-restart recovery proof.'),
  })
  .strict();
const websiteControlCommand = z.tuple([
  z.string().regex(/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/node$/),
  z.string().regex(/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/lib\/reverie\/dist\/index\.js$/),
  z.literal('web'),
  z.literal('--host'),
  z.literal('0.0.0.0'),
  z.literal('--port'),
  z.literal('3000'),
]);
export const PlanOfficeWebsiteClientInput = z
  .object({
    operation: z.enum(['observe', 'detach']),
    sessionId: uuid,
    pid: positivePid,
    outerPid: positivePid,
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    operationId: uuid,
    controlCommand: websiteControlCommand,
    expected: PlanOfficeWebsiteClient.optional(),
  })
  .strict()
  .refine((value) => value.pid !== value.outerPid)
  .refine((value) => (value.operation === 'observe' ? value.expected === undefined : value.expected !== undefined));
export type PlanOfficeWebsiteClientInput = z.infer<typeof PlanOfficeWebsiteClientInput>;
function nativeStat(text: string, pid: number) {
  assert.ok(Buffer.byteLength(text) <= 8192 && text.startsWith(pid + ' ('));
  const fields = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  assert.ok(/^[A-Za-z]$/.test(fields[0]!) && !/[ZXTtx]/.test(fields[0]!));
  return { parent: z.coerce.number().int().min(0).parse(fields[1]), birth: birth.parse(fields[19]) };
}
function nativeArgs(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 262144 && bytes.at(-1) === 0);
  const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
  const args = text.slice(0, -1).split('\0');
  assert.ok(args.length <= 2048 && args[0]);
  return args;
}
function fixedFile(value: DockerViewerExecutableObservation) {
  assert.ok(value.path.startsWith('/nix/store/') && path.normalize(value.path) === value.path);
  assert.equal(value.stat.uid, 0);
  assert.equal(value.stat.mode & 0o170000, 0o100000);
  assert.equal(value.stat.mode & 0o222, 0);
  assert.ok(value.parents.length > 0 && value.parents.at(-1)!.path === '/');
  for (const parent of value.parents) {
    assert.equal(parent.uid, 0);
    assert.equal(parent.mode & 0o170000, 0o040000);
    assert.ok((parent.mode & 0o022) === 0 || (parent.mode & 0o1000) !== 0);
  }
}
/** Pure checked parser of the same actual readonly /proc port used below.
 * Its output is fixture observation DATA, never a product/native capability. */
export function parsePlanOfficeViewerProcess(
  raw: DockerViewerProcessObservation,
  pid: number,
  executable: '/bin/docker' | '/bin/tmux'
) {
  positivePid.parse(pid);
  assert.equal(raw.procfs, 0x9fa0);
  assert.equal(raw.directoryUid, process.getuid!());
  nativeStat(raw.selfStat, process.pid);
  assert.match(raw.selfNamespace, /^pid:\[[1-9][0-9]*\]$/);
  assert.equal(raw.namespace, raw.selfNamespace);
  assert.equal(raw.namespaceAfter, raw.namespace);
  const before = nativeStat(raw.stat, pid),
    after = nativeStat(raw.statAfter, pid);
  assert.deepEqual(after, before);
  assert.ok(before.parent > 0);
  for (const status of [raw.status, raw.statusAfter]) {
    const rows = [...status.matchAll(/^Uid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/gm)];
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.slice(1).every((uid) => Number(uid) === process.getuid!()));
  }
  fixedFile(raw.manifest);
  const pin = raw.executables[executable];
  fixedFile(pin);
  fixedFile(pin.entry);
  assert.equal(raw.exe, pin.path);
  assert.deepEqual(raw.exeStat, pin.stat);
  const args = nativeArgs(raw.cmdline);
  if (executable === '/bin/docker') assert.equal(args[0], pin.argv0);
  return { ...before, args, manifestDigest: planOfficeViewerDigest(JSON.stringify(raw.manifest)) };
}
function privateProc(pid: number, leaf: 'stat' | 'cmdline') {
  const fd = fs.openSync(
    '/proc/' + pid + '/' + leaf,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const st = fs.fstatSync(fd);
    assert.ok(st.isFile() && st.uid === process.getuid!());
    const bytes = Buffer.alloc(65537),
      length = fs.readSync(fd, bytes, 0, bytes.length, null);
    assert.ok(length > 0 && length <= 65536);
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
function controlParent(command: PlanOfficeWebsiteClientInput['controlCommand']) {
  const before = nativeStat(privateProc(1, 'stat').toString('utf8'), 1);
  assert.equal(before.parent, 0);
  const exe = fs.readlinkSync('/proc/1/exe'),
    args = privateProc(1, 'cmdline');
  assert.deepEqual(nativeArgs(args), command);
  assert.equal(exe, fs.realpathSync(command[0]));
  const st = fs.statSync(exe);
  assert.ok(st.isFile() && st.uid === 0 && (st.mode & 0o222) === 0);
  assert.equal(fs.readlinkSync('/proc/1/exe'), exe);
  assert.ok(privateProc(1, 'cmdline').equals(args));
  assert.deepEqual(nativeStat(privateProc(1, 'stat').toString('utf8'), 1), before);
  return { parentBirth: before.birth, parentCommandDigest: planOfficeViewerDigest(args) };
}
function websiteTmux(args: string[]) {
  return execFileSync('/bin/tmux', ['-N', '-f', '/dev/null', '-L', 'reverie', ...args], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 65536,
    env: { PATH: '/bin', HOME: '/fixture/home', TERM: 'xterm-256color', LC_ALL: 'C.UTF-8' },
  });
}
function socketIdentity(socketPath: string) {
  const value = readDockerViewerSocket(socketPath),
    s = value.stat;
  assert.equal(value.path, socketPath);
  assert.equal(path.basename(socketPath), 'reverie');
  assert.equal(s.uid, process.getuid!());
  assert.equal(s.mode & 0o170000, 0o140000);
  const execute = s.mode & 0o111,
    attached = (s.mode & 0o444) >> 2;
  assert.ok(execute === 0 || execute === attached);
  assert.ok(value.parents[0]?.uid === process.getuid!() && (value.parents[0]!.mode & 0o077) === 0);
  return [s.dev, s.ino, s.rdev, s.uid, s.gid, s.mode & ~0o111].join(':');
}
function ttyIdentity(st: fs.BigIntStats) {
  assert.ok(st.isCharacterDevice() && st.uid === BigInt(process.getuid!()));
  return [st.dev, st.ino, st.rdev, st.uid, st.gid, st.mode].join(':');
}
export interface PlanOfficeWebsiteClientPorts {
  open(input: PlanOfficeWebsiteClientInput): { value: PlanOfficeWebsiteClient; close(): void };
  detach(tty: string): void;
}
function openWebsiteClient(input: PlanOfficeWebsiteClientInput) {
  const muxName = 'reverie-' + input.sessionId.slice(0, 8);
  const [server, socketPath, ...extra] = websiteTmux(['display-message', '-p', '#{pid}|#{socket_path}'])
    .trim()
    .split('|');
  assert.equal(extra.length, 0);
  assert.ok(socketPath && path.isAbsolute(socketPath));
  const serverPid = positivePid.parse(Number(server));
  const tty = fs.readlinkSync('/proc/' + input.pid + '/fd/0');
  assert.match(tty, /^\/dev\/pts\/[0-9]+$/);
  const fd = fs.openSync(
    tty,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY
  );
  try {
    const capture = () => {
      const website = parsePlanOfficeViewerProcess(readDockerViewerProcess(input.pid), input.pid, '/bin/tmux');
      assert.equal(website.parent, 1);
      assert.deepEqual(website.args, ['tmux', '-L', 'reverie', 'attach-session', '-t', muxName]);
      assert.equal(fs.readlinkSync('/proc/' + input.pid + '/fd/0'), tty);
      const ttyStamp = ttyIdentity(fs.fstatSync(fd, { bigint: true }));
      assert.equal(ttyIdentity(fs.statSync('/proc/' + input.pid + '/fd/0', { bigint: true })), ttyStamp);
      const manager = parsePlanOfficeViewerProcess(readDockerViewerProcess(serverPid), serverPid, '/bin/tmux');
      const outer = parsePlanOfficeViewerProcess(
        readDockerViewerProcess(input.outerPid),
        input.outerPid,
        '/bin/docker'
      );
      assert.equal(outer.parent, serverPid);
      assert.deepEqual(outer.args.slice(1, 7), [
        '--host',
        'unix:///run/reverie-engine/docker.sock',
        'exec',
        '-it',
        '--workdir',
        '/workspace',
      ]);
      const container = outer.args.indexOf(input.containerId);
      assert.ok(container > 7 && outer.args.lastIndexOf(input.containerId) === container);
      assert.deepEqual(outer.args.slice(container + 1, container + 3), ['sh', '-lc']);
      for (const expected of [
        'REVERIE_SESSION_ID=' + input.sessionId,
        'REVERIE_DOCKER_OPERATION_ID=' + input.operationId,
      ])
        assert.equal(outer.args.filter((value) => value === expected).length, 1);
      const pane = websiteTmux([
        'list-panes',
        '-t',
        '=' + muxName + ':0',
        '-F',
        '#{session_name}|#{pane_pid}|#{pane_dead}',
      ]).trim();
      assert.equal(pane, muxName + '|' + input.outerPid + '|0');
      const clients = websiteTmux([
        'list-clients',
        '-F',
        '#{client_pid}|#{client_tty}|#{session_name}|#{pid}|#{socket_path}',
      ])
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|'));
      assert.ok(clients.length <= 128 && clients.every((fields) => fields.length === 5));
      const own = clients.filter((fields) => fields[2] === muxName);
      assert.deepEqual(own, [[String(input.pid), tty, muxName, String(serverPid), socketPath]]);
      assert.equal(website.manifestDigest, manager.manifestDigest);
      assert.equal(outer.manifestDigest, manager.manifestDigest);
      return PlanOfficeWebsiteClient.parse({
        sessionId: input.sessionId,
        muxName,
        pid: input.pid,
        birth: website.birth,
        tty,
        ttyStamp,
        ...controlParent(input.controlCommand),
        serverPid,
        serverBirth: manager.birth,
        socketPath,
        socketStamp: socketIdentity(socketPath),
        outerPid: input.outerPid,
        outerBirth: outer.birth,
        outerCommandDigest: planOfficeViewerDigest(JSON.stringify(outer.args)),
        outerForm: 'paid-launch',
        manifestDigest: outer.manifestDigest,
      });
    };
    const value = capture();
    assert.deepEqual(capture(), value, 'Website client native tuple changed during observation');
    return { value, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
/** Runs inside ONLY the actual owned fixture control. Retained readonly TTY
 * descriptors and two complete observations precede one exact detach. */
export function planOfficeWebsiteClientOperation(
  unchecked: unknown,
  ports: PlanOfficeWebsiteClientPorts = {
    open: openWebsiteClient,
    detach: (tty) => {
      websiteTmux(['detach-client', '-t', tty]);
    },
  }
) {
  const input = PlanOfficeWebsiteClientInput.parse(unchecked);
  const opened: Array<{ value: PlanOfficeWebsiteClient; close(): void }> = [];
  let value: PlanOfficeWebsiteClient | undefined,
    cause: unknown,
    failed = false;
  try {
    const first = ports.open(input);
    opened.push(first);
    const second = ports.open(input);
    opened.push(second);
    value = PlanOfficeWebsiteClient.parse(second.value);
    assert.deepEqual(value, PlanOfficeWebsiteClient.parse(first.value));
    assert.equal(value.pid, input.pid);
    assert.equal(value.outerPid, input.outerPid);
    assert.equal(value.sessionId, input.sessionId);
    if (input.operation === 'detach') {
      assert.deepEqual(value, input.expected, 'The original captured website client changed before detach');
      ports.detach(value.tty); // No await, signal, pane command or retry between final native read and this effect.
    }
  } catch (error) {
    cause = error;
    failed = true;
  }
  const errors: unknown[] = [];
  for (const record of opened.reverse())
    try {
      record.close();
    } catch (error) {
      errors.push(error);
    }
  if (failed || errors.length)
    throw new AggregateError(
      [...(failed ? [cause] : []), ...errors],
      'Website observation/detach outcome unconfirmed; never repeat the effect'
    );
  return value!;
}
export const PLAN_OFFICE_WEBSITE_CLIENT_PROGRAM =
  'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.planOfficeWebsiteClientOperation(JSON.parse(process.argv[2]))));';
/** Read-only completion of the one detach. A missing old process and census
 * membership are joined to the still-original server/socket/paid outer pane. */
export function planOfficeWebsiteClientGone(unchecked: unknown) {
  const input = z
    .object({ value: PlanOfficeWebsiteClient, controlCommand: websiteControlCommand })
    .strict()
    .parse(unchecked);
  const expected = input.value;
  assert.deepEqual(controlParent(input.controlCommand), {
    parentBirth: expected.parentBirth,
    parentCommandDigest: expected.parentCommandDigest,
  });
  const manager = parsePlanOfficeViewerProcess(
    readDockerViewerProcess(expected.serverPid),
    expected.serverPid,
    '/bin/tmux'
  );
  const outer = parsePlanOfficeViewerProcess(
    readDockerViewerProcess(expected.outerPid),
    expected.outerPid,
    '/bin/docker'
  );
  assert.equal(manager.birth, expected.serverBirth);
  assert.equal(outer.birth, expected.outerBirth);
  assert.equal(outer.parent, expected.serverPid);
  assert.equal(planOfficeViewerDigest(JSON.stringify(outer.args)), expected.outerCommandDigest);
  assert.equal(outer.manifestDigest, expected.manifestDigest);
  assert.equal(manager.manifestDigest, expected.manifestDigest);
  assert.equal(socketIdentity(expected.socketPath), expected.socketStamp);
  const clients = websiteTmux(['list-clients', '-F', '#{client_pid}|#{client_tty}'])
    .trimEnd()
    .split('\n')
    .filter(Boolean);
  assert.ok(clients.length <= 128 && clients.every((line) => line.split('|').length === 2));
  if (
    clients.some((line) => {
      const fields = line.split('|');
      return fields[0] === String(expected.pid) || fields[1] === expected.tty;
    })
  )
    return false;
  try {
    fs.lstatSync('/proc/' + expected.pid);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
export const PLAN_OFFICE_WEBSITE_GONE_PROGRAM =
  'const m=await import(process.argv[1]);process.stdout.write(JSON.stringify(m.planOfficeWebsiteClientGone(JSON.parse(process.argv[2]))));';
