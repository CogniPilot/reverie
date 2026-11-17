/** Private original-issuance process proof for a website Docker pane. This
 * observer grants no CREATE, launch, signal, input, native-provider or idle
 * authority. Only Manager's acknowledged dispatch may retain its result. */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TerminalMultiplexer, MuxSession } from './mux-interface.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from './docker-employee-provider-view-native.js';
import { dockerPlanGeneration } from './docker-plan-install-data.js';
import {
  DOCKER_VIEWER_EXECUTABLES,
  parseDockerViewerExecutables,
  type DockerViewerExecutableObservation,
  readDockerViewerProcess,
  readDockerViewerSocket,
  type DockerViewerFileStat,
  type DockerViewerProcessObservation,
  type DockerViewerSocketObservation,
} from './docker-viewer-process.js';

export type DockerViewerCommand = Readonly<{ argv: readonly string[]; shellCommand: string }>;
const origin = Symbol('original acknowledged Docker viewer process');
const hash = /^[a-f0-9]{64}$/;
function refuse(): never {
  throw Error('Original Docker viewer pane is unconfirmed');
}
function decimal(value: string, positive = false): boolean {
  return (
    typeof value === 'string' &&
    /^(?:0|[1-9][0-9]{0,19})$/.test(value) &&
    BigInt(value) <= 18446744073709551615n &&
    (!positive || value !== '0')
  );
}
function pid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 1 && value <= 2147483647;
}
function processStat(text: string, expected: number) {
  const end = text.lastIndexOf(') ');
  if (Buffer.byteLength(text) > 8192 || !text.startsWith(expected + ' (') || end < 3) return refuse();
  const fields = text
      .slice(end + 2)
      .trim()
      .split(/\s+/),
    birth = fields[19],
    parent = fields[1];
  if (
    !/^[A-Za-z]$/.test(fields[0] ?? '') ||
    /[ZXTtx]/.test(fields[0]!) ||
    !birth ||
    !decimal(birth, true) ||
    !parent ||
    !/^(?:0|[1-9][0-9]{0,9})$/.test(parent) ||
    Number(parent) > 2147483647
  )
    return refuse();
  return { parent: Number(parent), birth };
}
function file(value: DockerViewerFileStat, execute = true): void {
  if (
    value.uid !== 0 ||
    !Number.isSafeInteger(value.gid) ||
    value.gid < 0 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode & 0o170000) !== 0o100000 ||
    (value.mode & 0o222) !== 0 ||
    (execute && (value.mode & 0o111) === 0) ||
    (value.mode & 0o7000) !== 0 ||
    !decimal(value.dev) ||
    !decimal(value.ino, true) ||
    !decimal(value.rdev) ||
    !decimal(value.size, true) ||
    !decimal(value.changed) ||
    !decimal(value.modified)
  )
    return refuse();
}
function executable(value: DockerViewerExecutableObservation, execute = true): void {
  if (
    !path.isAbsolute(value.path) ||
    path.normalize(value.path) !== value.path ||
    value.path.length > 4096 ||
    /[\0\r\n]/.test(value.path)
  )
    return refuse();
  file(value.stat, execute);
  let expected = path.dirname(value.path);
  if (value.parents.length === 0 || value.parents.length > 128) return refuse();
  for (const parent of value.parents) {
    if (
      parent.path !== expected ||
      parent.uid !== 0 ||
      !Number.isSafeInteger(parent.mode) ||
      (parent.mode & 0o170000) !== 0o040000 ||
      ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)
    )
      return refuse();
    if (expected === '/' && parent !== value.parents.at(-1)) return refuse();
    expected = path.dirname(expected);
  }
  if (value.parents.at(-1)?.path !== '/') return refuse();
}
function argumentsOf(value: Buffer): readonly string[] {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 262144 || value.at(-1) !== 0) return refuse();
  const text = value.toString('utf8');
  if (!Buffer.from(text).equals(value)) return refuse();
  const args = text.slice(0, -1).split('\0');
  if (args.length > 2048 || !args[0]) return refuse();
  return args;
}
function socketStamp(
  value: DockerViewerSocketObservation,
  socketPath: string,
  socketName: string,
  uid: number
): string {
  const metadata = value.stat,
    execute = metadata.mode & 0o111,
    attached = (metadata.mode & 0o444) >> 2;
  if (
    !path.isAbsolute(socketPath) ||
    path.normalize(socketPath) !== socketPath ||
    socketPath.length > 4096 ||
    /[\0\r\n]/.test(socketPath) ||
    path.basename(socketPath) !== socketName ||
    value.path !== socketPath ||
    (metadata.mode & 0o170000) !== 0o140000 ||
    metadata.uid !== uid ||
    !Number.isSafeInteger(metadata.mode) ||
    !Number.isSafeInteger(metadata.gid) ||
    metadata.gid < 0 ||
    !decimal(metadata.dev) ||
    !decimal(metadata.ino, true) ||
    !decimal(metadata.rdev) ||
    (execute !== 0 && execute !== attached)
  )
    return refuse();
  let expected = path.dirname(socketPath);
  if (
    value.parents.length === 0 ||
    value.parents.length > 128 ||
    value.parents[0]?.uid !== uid ||
    (value.parents[0]!.mode & 0o077) !== 0
  )
    return refuse();
  for (const parent of value.parents) {
    if (
      parent.path !== expected ||
      ![0, uid].includes(parent.uid) ||
      !Number.isSafeInteger(parent.mode) ||
      (parent.mode & 0o170000) !== 0o040000 ||
      ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)
    )
      return refuse();
    if (expected === '/' && parent !== value.parents.at(-1)) return refuse();
    expected = path.dirname(expected);
  }
  if (value.parents.at(-1)?.path !== '/') return refuse();
  return [metadata.dev, metadata.ino, metadata.rdev, metadata.uid, metadata.gid, metadata.mode & ~0o111].join(':');
}
function observed(raw: DockerViewerProcessObservation, selected: number, uid: number) {
  if (
    raw.procfs !== 0x9fa0 ||
    raw.directoryUid !== uid ||
    typeof raw.namespace !== 'string' ||
    typeof raw.selfNamespace !== 'string' ||
    typeof raw.stat !== 'string' ||
    typeof raw.statAfter !== 'string' ||
    typeof raw.statusAfter !== 'string' ||
    typeof raw.namespaceAfter !== 'string' ||
    typeof raw.selfStat !== 'string' ||
    typeof raw.status !== 'string' ||
    !/^pid:\[[1-9][0-9]{0,19}\]$/.test(raw.namespace) ||
    raw.namespace !== raw.selfNamespace ||
    raw.namespaceAfter !== raw.namespace
  )
    return refuse();
  const self = processStat(raw.selfStat, process.pid),
    native = processStat(raw.stat, selected),
    after = processStat(raw.statAfter, selected);
  if (!isDeepStrictEqual(native, after)) return refuse();
  const uids = [...raw.status.matchAll(/^Uid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/gm)];
  if (
    Buffer.byteLength(raw.status) > 65536 ||
    uids.length !== 1 ||
    !uids[0]!.slice(1).every((value) => value === String(uid))
  )
    return refuse();
  const afterUids = [
    ...raw.statusAfter.matchAll(/^Uid:[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]+([0-9]+)[ \t]*$/gm),
  ];
  if (
    Buffer.byteLength(raw.statusAfter) > 65536 ||
    afterUids.length !== 1 ||
    !afterUids[0]!.slice(1).every((value) => value === String(uid))
  )
    return refuse();
  executable(raw.manifest, false);
  const pins = parseDockerViewerExecutables(raw.manifest.text);
  if (!/^\/nix\/store\/[0-9a-z]{32}-[^/]+\/.+/.test(raw.manifest.path)) return refuse();
  for (const name of DOCKER_VIEWER_EXECUTABLES) {
    const value = raw.executables[name],
      pin = pins.executables[name];
    executable(value);
    executable(value.entry);
    if (value.path !== pin.executable || value.entry.path !== pin.entry || value.argv0 !== pin.argv0) return refuse();
  }
  return { ...native, selfBirth: self.birth, namespace: raw.namespace, argv: argumentsOf(raw.cmdline), raw };
}
function placement(row: MuxSession): unknown {
  return {
    sessionId: row.sessionId,
    muxName: row.muxName,
    owner: row.owner,
    pid: row.pid,
    docker: row.docker,
    remote: row.remote,
    mode: row.mode,
    workingDir: row.workingDir,
    createdAt: row.createdAt,
  };
}
function commandScope(command: DockerViewerCommand, row: MuxSession): DockerViewerCommand {
  if (
    !command ||
    !Array.isArray(command.argv) ||
    command.argv.length > 2048 ||
    command.argv.some((value) => typeof value !== 'string' || value.includes('\0')) ||
    typeof command.shellCommand !== 'string' ||
    !command.shellCommand ||
    command.shellCommand.includes('\0') ||
    Buffer.byteLength(command.shellCommand) > 262144 ||
    Buffer.byteLength(command.argv.join('\0')) > 262144
  )
    return refuse();
  const a = command.argv,
    docker = row.docker;
  if (
    !docker?.continuation ||
    docker.owned !== false ||
    docker.engine !== 'docker' ||
    docker.daemonHost !== 'unix:///run/reverie-engine/docker.sock' ||
    docker.context !== undefined ||
    docker.extraExecArgs !== undefined ||
    docker.extraCreateArgs !== undefined ||
    docker.commands !== undefined ||
    !hash.test(docker.containerName) ||
    row.remote ||
    row.discovered ||
    !isDeepStrictEqual(a.slice(0, 7), [
      '/bin/docker',
      '--host',
      docker.daemonHost,
      'exec',
      '-it',
      '--workdir',
      docker.containerWorkdir,
    ])
  )
    return refuse();
  const principal = docker.continuation;
  const required: Record<string, string> = {
    REVERIE_SESSION_ID: row.sessionId,
    REVERIE_MUX: '1',
    REVERIE_DOCKER_OPERATION_ID: principal.operationId,
    REVERIE_WORKER_IDENTITY_FILE: principal.planReplacement
      ? dockerPlanGeneration({
          ...principal.planReplacement,
          operationId: principal.operationId,
          containerId: docker.containerName,
        }).identityFile
      : '/home/agent/.reverie/docker-worker-identity',
    REVERIE_CLI: '/opt/reverie-worker-client/bin/reverie',
    REVERIE_API_URL: principal.apiUrl,
  };
  const seen = new Set<string>();
  let at = 7;
  while (a[at] === '--env') {
    const flag = a[at + 1] ?? '',
      equals = flag.indexOf('='),
      key = equals < 0 ? flag : flag.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:=[\s\S]*)?$/.test(flag)) return refuse();
    if (Object.hasOwn(required, key)) {
      if (seen.has(key) || equals < 0 || flag.slice(equals + 1) !== required[key]) return refuse();
      seen.add(key);
    }
    at += 2;
  }
  if (seen.size !== Object.keys(required).length) return refuse();
  if (a[at++] !== docker.containerName) return refuse();
  const inner = a.slice(at);
  const paid = inner.length === 3 && inner[0] === 'sh' && inner[1] === '-lc' && !!inner[2];
  const viewer =
    isDeepStrictEqual(inner.slice(0, 9), [
      '/opt/reverie-worker-client/bin/node',
      '--input-type=commonjs',
      '--no-warnings',
      '-e',
      DOCKER_PROVIDER_VIEW_PROGRAM,
      '--',
      'attach',
      row.sessionId,
      docker.continuation.operationId,
    ]) &&
    inner.length === 14 &&
    ['none', 'generation'].includes(inner[9]!) &&
    /^%[0-9]{1,10}$/.test(inner[10] ?? '') &&
    pid(Number(inner[11])) &&
    decimal(inner[12] ?? '', true) &&
    (inner[9] === 'none' ? inner[13] === '' : /^[A-Za-z0-9_.:-]{1,256}$/.test(inner[13] ?? ''));
  if (!paid && !viewer) return refuse();
  return Object.freeze({ argv: Object.freeze([...a]), shellCommand: command.shellCommand });
}
type Observed = ReturnType<typeof observed>;
function identity(value: Observed) {
  return { parent: value.parent, birth: value.birth, selfBirth: value.selfBirth, namespace: value.namespace };
}
function kind(value: Observed, command: DockerViewerCommand): 'docker' | 'shell' {
  const raw = value.raw;
  if (
    raw.exe === raw.executables['/bin/docker'].path &&
    isDeepStrictEqual(raw.exeStat, raw.executables['/bin/docker'].stat) &&
    isDeepStrictEqual(value.argv, [raw.executables['/bin/docker'].argv0, ...command.argv.slice(1)])
  )
    return 'docker';
  // The packaging-owned Docker wrapper can seed original birth only. It cannot qualify a ready viewer.
  const wrapper = raw.executables['/bin/docker'].entry;
  if (
    wrapper.path !== raw.executables['/bin/docker'].path &&
    raw.exe === wrapper.path &&
    isDeepStrictEqual(raw.exeStat, wrapper.stat) &&
    isDeepStrictEqual(value.argv, command.argv)
  )
    return 'shell';
  if (
    raw.exe === raw.executables['/bin/bash'].path &&
    isDeepStrictEqual(raw.exeStat, raw.executables['/bin/bash'].stat) &&
    isDeepStrictEqual(value.argv, ['/bin/bash', '-c', command.shellCommand])
  )
    return 'shell';
  return refuse();
}
function server(value: Observed): void {
  if (
    value.raw.exe !== value.raw.executables['/bin/tmux'].path ||
    !isDeepStrictEqual(value.raw.exeStat, value.raw.executables['/bin/tmux'].stat) ||
    value.parent < 1
  )
    return refuse();
}

export class DockerViewerPane {
  readonly #mux: TerminalMultiplexer;
  readonly #row: MuxSession;
  readonly #placement: unknown;
  readonly #socket: string;
  readonly #socketPath: string;
  readonly #socketStamp: string;
  readonly #uid: number;
  readonly #command: DockerViewerCommand;
  readonly #serverPid: number;
  readonly #server: ReturnType<typeof identity>;
  readonly #process: ReturnType<typeof identity>;
  readonly #manifest: DockerViewerProcessObservation['manifest'];
  readonly #files: DockerViewerProcessObservation['executables'];
  #invalid = false;
  #dockerObserved: boolean;
  private constructor(
    issuer: symbol,
    mux: TerminalMultiplexer,
    row: MuxSession,
    command: DockerViewerCommand,
    serverPid: number,
    native: Observed,
    manager: Observed,
    uid: number,
    socketPath: string,
    socket: string
  ) {
    if (issuer !== origin) throw Error('Original Docker viewer pane is unconfirmed');
    this.#mux = mux;
    this.#row = row;
    this.#placement = structuredClone(placement(row));
    this.#socket = mux.muxSocket;
    this.#socketPath = socketPath;
    this.#socketStamp = socket;
    this.#uid = uid;
    this.#command = command;
    this.#serverPid = serverPid;
    this.#server = identity(manager);
    this.#process = identity(native);
    this.#files = structuredClone(native.raw.executables);
    this.#manifest = structuredClone(native.raw.manifest);
    this.#dockerObserved = kind(native, command) === 'docker';
    Object.freeze(this);
  }
  static capture(
    mux: TerminalMultiplexer,
    row: MuxSession,
    command: DockerViewerCommand,
    serverPid: number,
    socketPath: string
  ): DockerViewerPane | undefined {
    try {
      const uid = process.getuid?.();
      if (
        uid === undefined ||
        !pid(row.pid) ||
        !pid(serverPid) ||
        row.pid === serverPid ||
        mux.getSession(row.sessionId) !== row ||
        !/^[A-Za-z0-9_.-]{1,100}$/.test(mux.muxSocket) ||
        !/^reverie-[A-Za-z0-9_-]{1,100}$/.test(row.muxName)
      )
        return refuse();
      const fixed = commandScope(command, row),
        before = structuredClone(placement(row)),
        socket = mux.muxSocket;
      const stamp = socketStamp(readDockerViewerSocket(socketPath), socketPath, socket, uid);
      const a = observed(readDockerViewerProcess(row.pid), row.pid, uid),
        s = observed(readDockerViewerProcess(serverPid), serverPid, uid),
        b = observed(readDockerViewerProcess(row.pid), row.pid, uid),
        t = observed(readDockerViewerProcess(serverPid), serverPid, uid);
      server(s);
      server(t);
      const first = kind(a, fixed),
        last = kind(b, fixed);
      if (
        a.parent !== serverPid ||
        b.parent !== serverPid ||
        !isDeepStrictEqual(identity(a), identity(b)) ||
        !isDeepStrictEqual(identity(s), identity(t)) ||
        a.namespace !== s.namespace ||
        a.selfBirth !== s.selfBirth ||
        !isDeepStrictEqual(a.raw.manifest, s.raw.manifest) ||
        !isDeepStrictEqual(a.raw.manifest, b.raw.manifest) ||
        !isDeepStrictEqual(a.raw.manifest, t.raw.manifest) ||
        !isDeepStrictEqual(a.raw.executables, s.raw.executables) ||
        !isDeepStrictEqual(a.raw.executables, b.raw.executables) ||
        !isDeepStrictEqual(a.raw.executables, t.raw.executables) ||
        (first === 'docker' && last !== 'docker') ||
        mux.getSession(row.sessionId) !== row ||
        mux.muxSocket !== socket ||
        !isDeepStrictEqual(placement(row), before) ||
        socketStamp(readDockerViewerSocket(socketPath), socketPath, socket, uid) !== stamp
      )
        return refuse();
      return new DockerViewerPane(origin, mux, row, fixed, serverPid, b, t, uid, socketPath, stamp);
    } catch {
      return undefined;
    }
  }
  #scope(mux: TerminalMultiplexer, row: MuxSession): void {
    if (
      process.getuid?.() !== this.#uid ||
      mux !== this.#mux ||
      row !== this.#row ||
      mux.getSession(row.sessionId) !== row ||
      mux.muxSocket !== this.#socket ||
      !isDeepStrictEqual(placement(row), this.#placement)
    )
      return refuse();
  }
  #native<T>(read: () => T): T {
    if (this.#invalid) return refuse();
    try {
      return read();
    } catch {
      this.#invalid = true;
      return refuse();
    }
  }
  #admitted(current: () => boolean): void {
    try {
      if (current() !== true) return refuse();
    } catch {
      return refuse();
    }
  }
  /** Deny-only original issuance/server currency. Never proves a live pane. */
  requireIssued(mux: TerminalMultiplexer, row: MuxSession, current: () => boolean): void {
    if (typeof this !== 'object' || this === null || !(#invalid in this)) return refuse();
    this.#admitted(current);
    this.#native(() => {
      this.#scope(mux, row);
      if (
        socketStamp(readDockerViewerSocket(this.#socketPath), this.#socketPath, this.#socket, this.#uid) !==
        this.#socketStamp
      )
        return refuse();
      const a = observed(readDockerViewerProcess(this.#serverPid), this.#serverPid, this.#uid),
        b = observed(readDockerViewerProcess(this.#serverPid), this.#serverPid, this.#uid);
      server(a);
      server(b);
      if (
        !isDeepStrictEqual(identity(a), this.#server) ||
        !isDeepStrictEqual(identity(b), this.#server) ||
        !isDeepStrictEqual(a.raw.manifest, this.#manifest) ||
        !isDeepStrictEqual(b.raw.manifest, this.#manifest) ||
        !isDeepStrictEqual(a.raw.executables, this.#files) ||
        !isDeepStrictEqual(b.raw.executables, this.#files)
      )
        return refuse();
      this.#scope(mux, row);
      if (
        socketStamp(readDockerViewerSocket(this.#socketPath), this.#socketPath, this.#socket, this.#uid) !==
        this.#socketStamp
      )
        return refuse();
    });
    this.#admitted(current);
  }
  /** Denial-only join with a separately branded local-client census checker.
   * Matching scalar DATA never proves a client or permits attachment. */
  requireClientServer(
    scope: Readonly<{ serverPid: number; serverBirth: string; socketPath: string; socketStamp: string }>,
    current: () => boolean
  ): void {
    if (typeof this !== 'object' || this === null || !(#invalid in this)) return refuse();
    DockerViewerPane.prototype.requireIssued.call(this, this.#mux, this.#row, current);
    try {
      if (!scope || ![Object.prototype, null].includes(Object.getPrototypeOf(scope))) return refuse();
      const keys = Reflect.ownKeys(scope),
        expected = ['serverPid', 'serverBirth', 'socketPath', 'socketStamp'];
      if (keys.length !== 4 || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) return refuse();
      const descriptors = Object.getOwnPropertyDescriptors(scope);
      if (!expected.every((key) => Object.hasOwn(descriptors[key]!, 'value'))) return refuse();
      if (
        descriptors.serverPid!.value !== this.#serverPid ||
        descriptors.serverBirth!.value !== this.#server.birth ||
        descriptors.socketPath!.value !== this.#socketPath ||
        descriptors.socketStamp!.value !== this.#socketStamp
      )
        return refuse();
    } catch {
      return refuse();
    }
    DockerViewerPane.prototype.requireIssued.call(this, this.#mux, this.#row, current);
  }
  /** Only the actual exact Docker executable/vector may qualify attachment. */
  require(mux: TerminalMultiplexer, row: MuxSession, current: () => boolean): void {
    if (typeof this !== 'object' || this === null || !(#invalid in this)) return refuse();
    DockerViewerPane.prototype.requireIssued.call(this, mux, row, current);
    const ready = this.#native(() => {
      this.#scope(mux, row);
      const a = observed(readDockerViewerProcess(row.pid), row.pid, this.#uid),
        b = observed(readDockerViewerProcess(row.pid), row.pid, this.#uid);
      const first = kind(a, this.#command),
        last = kind(b, this.#command);
      if (
        (this.#dockerObserved && (first !== 'docker' || last !== 'docker')) ||
        (first === 'docker' && last !== 'docker') ||
        !isDeepStrictEqual(identity(a), this.#process) ||
        !isDeepStrictEqual(identity(b), this.#process) ||
        !isDeepStrictEqual(a.raw.manifest, this.#manifest) ||
        !isDeepStrictEqual(b.raw.manifest, this.#manifest) ||
        !isDeepStrictEqual(a.raw.executables, this.#files) ||
        !isDeepStrictEqual(b.raw.executables, this.#files)
      )
        return refuse();
      this.#dockerObserved ||= first === 'docker' || last === 'docker';
      this.#scope(mux, row);
      return first === 'docker' && last === 'docker';
    });
    DockerViewerPane.prototype.requireIssued.call(this, mux, row, current);
    if (!ready) return refuse();
  }
}
Object.freeze(DockerViewerPane.prototype);
