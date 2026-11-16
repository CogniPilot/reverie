/** Actual proof factory over controlled raw readonly kernel observations. No
 * proof/boolean port, process execution, signal, tmux or Docker effect. Manager
 * issuance ordering and Session attachment are separately composed tests. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as nativePort from '../src/docker-viewer-process.js';
import { DockerViewerPane, type DockerViewerCommand } from '../src/docker-viewer-pane.js';
import {
  installRecordedDockerViewer,
  recordedDockerViewerStat as stat,
  recordedDockerViewerSocketPath,
} from './helpers/recorded-docker-viewer.js';
import { DOCKER_PROVIDER_VIEW_PROGRAM } from '../src/docker-employee-provider-view-native.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';

afterEach(() => vi.restoreAllMocks());
const panePid = 701,
  serverPid = 601;
const uid = process.getuid?.() ?? 0;
const readNativeProcess = nativePort.readDockerViewerProcess;
function fixture(viewer = false, shell = false) {
  const row: MuxSession = {
    sessionId: '20000000-0000-4000-8000-000000000002',
    muxName: 'reverie-20000000',
    pid: panePid,
    createdAt: 1,
    workingDir: '/workspace',
    mode: 'claude',
    attached: false,
    docker: {
      hostId: 'boxed',
      label: 'Synthetic',
      engine: 'docker',
      image: 'sha256:' + 'b'.repeat(64),
      containerName: 'a'.repeat(64),
      hostWorkspacePath: '/',
      containerWorkdir: '/workspace',
      network: 'bridge',
      mountCredentials: false,
      hooksEnabled: false,
      resumeOnStart: true,
      owned: false,
      daemonHost: 'unix:///run/reverie-engine/docker.sock',
      continuation: {
        employeeId: '10000000-0000-4000-8000-000000000001',
        operationId: '30000000-0000-4000-8000-000000000003',
        sessionGeneration: 2,
        clientManifestDigest: 'b'.repeat(64),
        apiUrl: 'http://synthetic:3000',
      },
    },
  };
  const inner = viewer
    ? [
        '/opt/reverie-worker-client/bin/node',
        '--input-type=commonjs',
        '--no-warnings',
        '-e',
        DOCKER_PROVIDER_VIEW_PROGRAM,
        '--',
        'attach',
        row.sessionId,
        row.docker!.continuation!.operationId,
        'generation',
        '%1',
        '333',
        '456',
        'fixture:1',
      ]
    : ['sh', '-lc', 'retained original paid script'];
  const command: DockerViewerCommand = {
    argv: [
      '/bin/docker',
      '--host',
      row.docker!.daemonHost!,
      'exec',
      '-it',
      '--workdir',
      '/workspace',
      '--env',
      'REVERIE_SESSION_ID=' + row.sessionId,
      '--env',
      'REVERIE_MUX=1',
      '--env',
      'REVERIE_DOCKER_OPERATION_ID=' + row.docker!.continuation!.operationId,
      '--env',
      'REVERIE_WORKER_IDENTITY_FILE=/home/agent/.reverie/docker-worker-identity',
      '--env',
      'REVERIE_CLI=/opt/reverie-worker-client/bin/reverie',
      '--env',
      'REVERIE_API_URL=' + row.docker!.continuation!.apiUrl,
      row.docker!.containerName,
      ...inner,
    ],
    shellCommand: 'exact issued shell wrapper',
  };
  const recorder = installRecordedDockerViewer(),
    socketPath = recordedDockerViewerSocketPath('synthetic-office'),
    { pane, server: manager, socket } = recorder.seed(row, command, serverPid, shell, socketPath),
    rows = new Map([[row.sessionId, row]]),
    mux = { muxSocket: 'synthetic-office', getSession: (id: string) => rows.get(id) } as unknown as TerminalMultiplexer;
  pane.stat = stat(panePid, serverPid, '333');
  manager.stat = stat(serverPid, 1, '222');
  pane.statAfter = pane.stat;
  manager.statAfter = manager.stat;
  const read = recorder.read;
  const capture = () => DockerViewerPane.capture(mux, row, command, serverPid, socketPath),
    proof = () => {
      const value = capture();
      expect(value).toBeInstanceOf(DockerViewerPane);
      return value!;
    };
  return {
    row,
    command,
    pane,
    manager,
    rows,
    mux,
    read,
    socket,
    socketPath,
    readSocket: recorder.readSocket,
    capture,
    proof,
  };
}

describe.runIf(typeof process.getuid === 'function')('original Docker viewer process proof', () => {
  it.each([false, true])(
    'earns exact live %s process currency without treating raw DATA as an opaque proof',
    (viewer) => {
      const f = fixture(viewer),
        proof = f.proof();
      expect(() => proof.requireIssued(f.mux, f.row, () => true)).not.toThrow();
      expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
      expect(JSON.stringify(proof)).toBe('{}');
      expect(() => DockerViewerPane.prototype.require.call({} as DockerViewerPane, f.mux, f.row, () => true)).toThrow(
        'unconfirmed'
      );
      expect(() =>
        DockerViewerPane.prototype.require.call(Object.create(DockerViewerPane.prototype), f.mux, f.row, () => true)
      ).toThrow('unconfirmed');
    }
  );

  it('may retain an exact preexec birth but never treats the shell as viewer readiness', () => {
    const f = fixture(false, true),
      proof = f.proof();
    expect(() => proof.requireIssued(f.mux, f.row, () => true)).not.toThrow();
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
    f.pane.exe = f.pane.executables['/bin/docker'].path;
    f.pane.exeStat = structuredClone(f.pane.executables['/bin/docker'].stat);
    f.pane.cmdline = Buffer.from(
      [f.pane.executables['/bin/docker'].argv0, ...f.command.argv.slice(1)].join('\0') + '\0'
    );
    expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
  });

  it('retains the exact packaged Docker wrapper birth without accepting wrapper readiness or a logical argv0 at the leaf', () => {
    const f = fixture(),
      wrapper = f.pane.executables['/bin/docker'].entry;
    f.pane.exe = wrapper.path;
    f.pane.exeStat = structuredClone(wrapper.stat);
    f.pane.cmdline = Buffer.from(f.command.argv.join('\0') + '\0');
    const proof = f.proof();
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
    f.pane.exe = f.pane.executables['/bin/docker'].path;
    f.pane.exeStat = structuredClone(f.pane.executables['/bin/docker'].stat);
    f.pane.cmdline = Buffer.from(
      [f.pane.executables['/bin/docker'].argv0, ...f.command.argv.slice(1)].join('\0') + '\0'
    );
    expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
    f.pane.cmdline = Buffer.from(f.command.argv.join('\0') + '\0');
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
  });

  it.each(['json', 'version', 'purpose', 'extra', 'missing', 'path', 'argv0', 'bash-wrapper', 'pin-extra'] as const)(
    'refuses malformed or unowned manifest %s without a guessed wrapper fallback',
    (failure) => {
      const f = fixture();
      const value = JSON.parse(f.pane.manifest.text);
      if (failure === 'version') value.version = 2;
      if (failure === 'purpose') value.purpose = 'other';
      if (failure === 'extra') value.extra = true;
      if (failure === 'missing') delete value.executables['/bin/tmux'];
      if (failure === 'path') value.executables['/bin/docker'].executable = '/tmp/libexec/docker';
      if (failure === 'argv0') value.executables['/bin/docker'].argv0 = '/bin/docker';
      if (failure === 'bash-wrapper')
        value.executables['/bin/bash'].executable = value.executables['/bin/docker'].executable;
      if (failure === 'pin-extra') value.executables['/bin/docker'].fallback = '/bin/docker';
      f.pane.manifest.text = failure === 'json' ? 'HOSTILE_MANIFEST_RAW' : JSON.stringify(value);
      expect(f.capture()).toBeUndefined();
      expect(() => nativePort.parseDockerViewerExecutables(f.pane.manifest.text)).toThrow(
        'Original Docker viewer process observation unavailable'
      );
    }
  );

  it.each([
    'file-owner',
    'file-writable',
    'file-path',
    'file-inode',
    'bytes',
    'entry-inode',
    'entry-owner',
    'entry-path',
    'leaf-argv0',
  ] as const)('sticky refusal after issued manifest or entry %s drift', (failure) => {
    const f = fixture(),
      proof = f.proof(),
      saved = structuredClone(f.pane.manifest),
      files = structuredClone(f.pane.executables);
    if (failure === 'file-owner') f.pane.manifest.stat.uid = uid === 0 ? 1 : uid;
    if (failure === 'file-writable') f.pane.manifest.stat.mode = 0o100644;
    if (failure === 'file-path') f.pane.manifest.path = '/tmp/docker-viewer-executables.json';
    if (failure === 'file-inode') f.pane.manifest.stat.ino = '999';
    if (failure === 'bytes') f.pane.manifest.text += ' ';
    if (failure === 'entry-inode') f.pane.executables['/bin/docker'].entry.stat.ino = '999';
    if (failure === 'entry-owner') f.pane.executables['/bin/docker'].entry.stat.uid = 1;
    if (failure === 'entry-path') f.pane.executables['/bin/docker'].entry.path += '-foreign';
    if (failure === 'leaf-argv0') f.pane.executables['/bin/docker'].argv0 = '/bin/docker';
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
    f.pane.manifest = saved;
    f.pane.executables = files;
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
  });

  it.each(['argv', 'shell', 'birth', 'server'] as const)(
    'never resurrects an observed-invalid %s origin after raw data is restored',
    (selected) => {
      const f = fixture(),
        proof = f.proof(),
        old = {
          stat: f.pane.stat,
          exe: f.pane.exe,
          exeStat: structuredClone(f.pane.exeStat),
          cmdline: Buffer.from(f.pane.cmdline),
          server: f.manager.stat,
        };
      if (selected === 'argv') f.pane.cmdline = Buffer.from('/bin/docker\0unexpected\0');
      if (selected === 'shell') {
        f.pane.exe = f.pane.executables['/bin/bash'].path;
        f.pane.exeStat = structuredClone(f.pane.executables['/bin/bash'].stat);
        f.pane.cmdline = Buffer.from(['/bin/bash', '-c', f.command.shellCommand].join('\0') + '\0');
      }
      if (selected === 'birth') f.pane.stat = stat(panePid, serverPid, '999');
      if (selected === 'server') f.manager.stat = stat(serverPid, 1, '999');
      expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
      Object.assign(f.pane, { stat: old.stat, exe: old.exe, exeStat: old.exeStat, cmdline: old.cmdline });
      f.manager.stat = old.server;
      expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
      expect(() => proof.requireIssued(f.mux, f.row, () => true)).toThrow('unconfirmed');
    }
  );

  it('keeps one requester refusal separate from otherwise-current native issuance', () => {
    const f = fixture(),
      proof = f.proof();
    expect(() => proof.require(f.mux, f.row, () => false)).toThrow('unconfirmed');
    expect(() =>
      proof.requireIssued(f.mux, f.row, () => {
        throw Error('Revoked request');
      })
    ).toThrow('unconfirmed');
    expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
  });

  it.each(['T', 't'])('refuses stopped process state %s as a live transport', (state) => {
    const f = fixture();
    f.pane.stat = stat(panePid, serverPid, '333', state);
    expect(f.capture()).toBeUndefined();
  });

  const requiredEnvironment = [
    'REVERIE_SESSION_ID',
    'REVERIE_MUX',
    'REVERIE_DOCKER_OPERATION_ID',
    'REVERIE_WORKER_IDENTITY_FILE',
    'REVERIE_CLI',
    'REVERIE_API_URL',
  ];
  it.each(
    requiredEnvironment.flatMap((key) =>
      ['changed', 'duplicate', 'missing', 'name-only'].map((kind) => ({ key, kind }))
    )
  )('refuses $kind reserved $key even when the raw process vector agrees with the producer', ({ key, kind }) => {
    const f = fixture(),
      argv = [...f.command.argv],
      at = argv.findIndex((value) => value.startsWith(key + '='));
    expect(at).toBeGreaterThan(0);
    if (kind === 'changed') argv[at] = key + '=wrong';
    if (kind === 'duplicate') argv.splice(at + 1, 0, '--env', argv[at]!);
    if (kind === 'missing') argv.splice(at - 1, 2);
    if (kind === 'name-only') argv[at] = key;
    f.pane.cmdline = Buffer.from([f.pane.executables['/bin/docker'].argv0, ...argv.slice(1)].join('\0') + '\0');
    expect(DockerViewerPane.capture(f.mux, f.row, { ...f.command, argv }, serverPid, f.socketPath)).toBeUndefined();
  });

  it('retains only original server/row currency when the original pane has exited', () => {
    const f = fixture(),
      proof = f.proof(),
      read = f.read.getMockImplementation()!;
    f.read.mockImplementation((pid) => {
      if (pid === panePid) throw Error('Exited original process');
      return read(pid);
    });
    expect(() => proof.requireIssued(f.mux, f.row, () => true)).not.toThrow();
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
    f.row.pid++;
    expect(() => proof.requireIssued(f.mux, f.row, () => true)).toThrow('unconfirmed');
  });

  it.each([0o600, 0o660])('accepts only tmux complete attachment execute signal for socket mode %i', (mode) => {
    const f = fixture();
    f.socket.stat.mode = 0o140000 | mode;
    const proof = f.proof();
    f.socket.stat.mode |= (mode & 0o444) >> 2;
    f.socket.stat.changed = '999999';
    expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
    f.socket.stat.mode &= ~0o111;
    expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
  });

  it.each([
    'inode',
    'uid',
    'gid',
    'device',
    'type',
    'permissions',
    'partial-execute',
    'path',
    'parent-mode',
    'parent-owner',
  ] as const)('refuses changed physical socket %s and does not resurrect when restored', (selected) => {
    const f = fixture(),
      proof = f.proof(),
      original = structuredClone(f.socket);
    if (selected === 'inode') f.socket.stat.ino = '999';
    if (selected === 'uid') f.socket.stat.uid++;
    if (selected === 'gid') f.socket.stat.gid++;
    if (selected === 'device') f.socket.stat.dev = '999';
    if (selected === 'type') f.socket.stat.mode = 0o100600;
    if (selected === 'permissions') f.socket.stat.mode = 0o140660;
    if (selected === 'partial-execute') f.socket.stat.mode = 0o140610;
    if (selected === 'path') f.socket.path += '-rerouted';
    if (selected === 'parent-mode') f.socket.parents[0]!.mode = 0o040755;
    if (selected === 'parent-owner') f.socket.parents[0]!.uid++;
    expect(() => proof.requireIssued(f.mux, f.row, () => true)).toThrow('unconfirmed');
    Object.assign(f.socket, original);
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
  });

  it('brackets physical socket identity across the actual capture sequence', () => {
    const f = fixture(),
      read = f.readSocket.getMockImplementation()!;
    let serial = 0;
    f.readSocket.mockImplementation((name) => {
      const result = read(name);
      if (++serial === 1) f.socket.stat.ino = '999';
      return result;
    });
    expect(f.capture()).toBeUndefined();
  });

  it('pairs only the captured private server/socket tuple as denial data, never standalone client authority', () => {
    const f = fixture(),
      proof = f.proof(),
      metadata = f.socket.stat,
      scope = {
        serverPid,
        serverBirth: '222',
        socketPath: f.socketPath,
        socketStamp: [
          metadata.dev,
          metadata.ino,
          metadata.rdev,
          metadata.uid,
          metadata.gid,
          metadata.mode & ~0o111,
        ].join(':'),
      };
    expect(() => proof.requireClientServer(Object.freeze(scope), () => true)).not.toThrow();
    for (const changed of [
      { ...scope, serverPid: serverPid + 1 },
      { ...scope, serverBirth: '333' },
      { ...scope, socketPath: scope.socketPath + '-foreign' },
      { ...scope, socketStamp: scope.socketStamp + '-foreign' },
      { ...scope, extra: 'untrusted' },
    ])
      expect(() => proof.requireClientServer(changed, () => true)).toThrow('unconfirmed');
    let getters = 0;
    const accessor = Object.defineProperty({ ...scope }, 'serverPid', {
      get: () => {
        getters++;
        return serverPid;
      },
    });
    expect(() => proof.requireClientServer(accessor, () => true)).toThrow('unconfirmed');
    expect(getters).toBe(0);
    // Another caller's mismatched scope does not poison valid native issuance.
    expect(() => proof.require(f.mux, f.row, () => true)).not.toThrow();
  });

  const nativeChanges = [
    'pane-birth',
    'pane-parent',
    'pane-argv',
    'pane-exe',
    'pane-inode',
    'pane-uid',
    'pane-status-uid',
    'server-birth',
    'server-parent',
    'server-exe',
    'server-uid',
    'namespace',
    'procfs',
    'self-pid',
    'zombie',
    'binary-mode',
    'binary-owner',
    'binary-parent-mode',
    'binary-parent-owner',
    'binary-parent-path',
    'argv-truncated',
    'argv-invalid-utf8',
    'fixed-binary-inode',
  ] as const;
  function change(f: ReturnType<typeof fixture>, selected: (typeof nativeChanges)[number]) {
    if (selected === 'pane-birth') f.pane.stat = stat(panePid, serverPid, '334');
    if (selected === 'pane-parent') f.pane.stat = stat(panePid, serverPid + 1, '333');
    if (selected === 'pane-argv')
      f.pane.cmdline = Buffer.from([...f.command.argv, 'unexpected-argument'].join('\0') + '\0');
    if (selected === 'pane-exe') f.pane.exe = '/untrusted/docker';
    if (selected === 'pane-inode') f.pane.exeStat = { ...f.pane.exeStat, ino: '99' };
    if (selected === 'pane-uid') f.pane.directoryUid = uid + 1;
    if (selected === 'pane-status-uid') f.pane.status = `Uid:\t${uid}\t${uid + 1}\t${uid}\t${uid}\n`;
    if (selected === 'server-birth') f.manager.stat = stat(serverPid, 1, '223');
    if (selected === 'server-parent') f.manager.stat = stat(serverPid, 2, '222');
    if (selected === 'server-exe') f.manager.exe = f.manager.executables['/bin/bash'].path;
    if (selected === 'server-uid') f.manager.directoryUid = uid + 1;
    if (selected === 'namespace') f.pane.namespace = 'pid:[124]';
    if (selected === 'procfs') f.pane.procfs = 123;
    if (selected === 'self-pid') f.pane.selfStat = stat(process.pid + 1, 1, '111');
    if (selected === 'zombie') f.pane.stat = stat(panePid, serverPid, '333', 'Z');
    if (selected === 'binary-mode')
      f.pane.executables['/bin/docker'].stat = { ...f.pane.executables['/bin/docker'].stat, mode: 0o100777 };
    if (selected === 'binary-owner')
      f.pane.executables['/bin/docker'].stat = { ...f.pane.executables['/bin/docker'].stat, uid: 1 };
    if (selected === 'binary-parent-mode')
      f.pane.executables['/bin/docker'].parents[0] = {
        ...f.pane.executables['/bin/docker'].parents[0]!,
        mode: 0o040777,
      };
    if (selected === 'binary-parent-owner')
      f.pane.executables['/bin/docker'].parents[0] = { ...f.pane.executables['/bin/docker'].parents[0]!, uid: 1 };
    if (selected === 'binary-parent-path')
      f.pane.executables['/bin/docker'].parents[0] = {
        ...f.pane.executables['/bin/docker'].parents[0]!,
        path: '/missing-parent',
      };
    if (selected === 'argv-truncated') f.pane.cmdline = Buffer.from(f.pane.cmdline.subarray(0, -1));
    if (selected === 'argv-invalid-utf8') f.pane.cmdline = Buffer.from([0xff, 0]);
    if (selected === 'fixed-binary-inode')
      f.pane.executables['/bin/docker'].stat = { ...f.pane.executables['/bin/docker'].stat, ino: '99' };
  }
  it.each(nativeChanges)('refuses native %s drift after the original capture', (selected) => {
    const f = fixture(),
      proof = f.proof();
    change(f, selected);
    expect(() => proof.require(f.mux, f.row, () => true)).toThrow('unconfirmed');
  });
  it.each(nativeChanges.filter((value) => !['pane-birth', 'server-birth', 'server-parent'].includes(value)))(
    'does not mint an original capture from malformed %s observation',
    (selected) => {
      const f = fixture();
      change(f, selected);
      expect(f.capture()).toBeUndefined();
    }
  );

  it.each([
    'pid',
    'owner',
    'generation',
    'daemon',
    'name',
    'workingDir',
    'createdAt',
    'row',
    'socket',
    'mux',
    'grant',
  ] as const)('refuses changed original %s placement/admission', (selected) => {
    const f = fixture(),
      proof = f.proof();
    let mux = f.mux;
    if (selected === 'pid') f.row.pid++;
    if (selected === 'owner') f.row.owner = 'another-owner';
    if (selected === 'generation') f.row.docker!.continuation!.sessionGeneration++;
    if (selected === 'daemon') f.row.docker!.daemonHost = 'unix:///other.sock';
    if (selected === 'name') f.row.muxName += '-changed';
    if (selected === 'workingDir') f.row.workingDir = '/changed';
    if (selected === 'createdAt') f.row.createdAt++;
    if (selected === 'row') f.rows.set(f.row.sessionId, structuredClone(f.row));
    if (selected === 'socket') Object.defineProperty(f.mux, 'muxSocket', { value: 'changed-socket' });
    if (selected === 'mux') mux = { ...f.mux };
    expect(() => proof.require(mux, f.row, () => selected !== 'grant')).toThrow('unconfirmed');
    expect(() => proof.requireIssued(mux, f.row, () => selected !== 'grant')).toThrow('unconfirmed');
  });

  it.each(['pane', 'server'] as const)(
    'brackets %s birth across the actual observation await-free sequence',
    (selected) => {
      const f = fixture(),
        read = f.read.getMockImplementation()!;
      let seen = 0;
      f.read.mockImplementation((pid) => {
        const raw = read(pid);
        if (pid === (selected === 'pane' ? panePid : serverPid) && ++seen === 1)
          (selected === 'pane' ? f.pane : f.manager).stat = stat(pid, selected === 'pane' ? serverPid : 1, '999');
        return raw;
      });
      expect(f.capture()).toBeUndefined();
    }
  );

  it('does not expose raw process or filesystem error contents and rechecks the current callback', () => {
    const f = fixture(),
      proof = f.proof(),
      token = 'HOSTILE_RAW_PROCESS_TOKEN';
    f.read.mockImplementation(() => {
      throw Error('/private/path/' + token);
    });
    expect(f.capture()).toBeUndefined();
    expect(() => proof.requireIssued(f.mux, f.row, () => true)).toThrow('Original Docker viewer pane is unconfirmed');
    try {
      proof.require(f.mux, f.row, () => true);
    } catch (error) {
      expect(String(error)).not.toContain(token);
    }
    const g = fixture(),
      issued = g.proof();
    let allowed = true;
    const read = g.read.getMockImplementation()!;
    g.read.mockImplementation((pid) => {
      const value = read(pid);
      allowed = false;
      return value;
    });
    expect(() => issued.requireIssued(g.mux, g.row, () => allowed)).toThrow('unconfirmed');
  });
});

describe.runIf(process.platform === 'linux')('bounded readonly process syscall port', () => {
  function syscallFixture(failure?: 'oversized' | 'foreign' | 'not-file' | 'close' | 'pid-reuse' | 'namespace-change') {
    const frame = fixture(),
      recorded = frame.pane;
    // Test the real syscall reader, not its recording-module replacement.
    vi.restoreAllMocks();
    const files = new Map<string, Buffer>([
        ['/proc/self/stat', Buffer.from(recorded.selfStat)],
        ['/proc/' + panePid + '/stat', Buffer.from(recorded.stat)],
        ['/proc/' + panePid + '/status', Buffer.from(recorded.status)],
        ['/proc/' + panePid + '/cmdline', failure === 'oversized' ? Buffer.alloc(262145, 65) : recorded.cmdline],
      ]),
      opened = new Map<number, { bytes: Buffer; offset: number; owner: number }>(),
      names: string[] = [];
    let serial = 1000,
      statReads = 0,
      namespaces = 0;
    const big = (value: typeof recorded.exeStat) =>
      ({
        dev: BigInt(value.dev),
        ino: BigInt(value.ino),
        rdev: BigInt(value.rdev),
        uid: BigInt(value.uid),
        gid: BigInt(value.gid),
        mode: BigInt(value.mode),
        size: BigInt(value.size),
        ctimeNs: BigInt(value.changed),
        mtimeNs: BigInt(value.modified),
      }) as fs.BigIntStats;
    vi.spyOn(fs, 'lstatSync').mockImplementation((file) => {
      const name = String(file);
      if (name === '/proc/' + panePid) return { uid, mode: 0o040555, isDirectory: () => true } as fs.Stats;
      for (const executable of [
        recorded.manifest,
        ...Object.values(recorded.executables).flatMap((v) => [v, v.entry]),
      ]) {
        const parent = executable.parents.find((value) => value.path === name);
        if (parent) return { uid: parent.uid, mode: parent.mode } as fs.Stats;
      }
      throw Error('Unexpected readonly directory');
    });
    vi.spyOn(fs, 'realpathSync').mockImplementation((file) => {
      const name = String(file);
      if (name.endsWith('/docker-viewer-executables.json')) return recorded.manifest.path;
      const selected = recorded.executables[name as keyof typeof recorded.executables];
      if (selected) return selected.entry.path;
      if (Object.values(recorded.executables).some((value) => value.path === name)) return name;
      throw Error('Unexpected fixed executable');
    });
    vi.spyOn(fs, 'statSync').mockImplementation((file) => {
      if (String(file) === '/proc/' + panePid + '/exe') return big(recorded.exeStat);
      const executable = [recorded.manifest, ...Object.values(recorded.executables).flatMap((v) => [v, v.entry])].find(
        (value) => value.path === String(file)
      );
      if (!executable) throw Error('Unexpected readonly executable');
      return big(executable.stat);
    });
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ type: 0x9fa0 } as fs.StatsFs);
    vi.spyOn(fs, 'readlinkSync').mockImplementation((file) => {
      if (String(file) === '/proc/self/ns/pid') return recorded.selfNamespace;
      if (String(file) === '/proc/' + panePid + '/ns/pid')
        return failure === 'namespace-change' && ++namespaces > 1 ? 'pid:[999]' : recorded.namespace;
      if (String(file) === '/proc/' + panePid + '/exe') return recorded.exe;
      throw Error('Unexpected readonly link');
    });
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags) => {
      const name = String(file);
      let bytes = name.endsWith('/docker-viewer-executables.json')
        ? Buffer.from(recorded.manifest.text)
        : files.get(name);
      if (name === '/proc/' + panePid + '/stat' && failure === 'pid-reuse' && ++statReads > 1)
        bytes = Buffer.from(stat(panePid, serverPid, '999'));
      expect(Number(flags) & (fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)).toBe(
        fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      if (!bytes) throw Error('Unexpected readonly file');
      names.push(name);
      const fd = ++serial;
      opened.set(fd, { bytes, offset: 0, owner: name.endsWith('/docker-viewer-executables.json') ? 0 : uid });
      return fd;
    });
    vi.spyOn(fs, 'fstatSync').mockImplementation(
      (fd) =>
        ({
          uid: failure === 'foreign' ? uid + 1 : opened.get(fd)?.owner,
          isFile: () => failure !== 'not-file',
        }) as fs.Stats
    );
    const reader = fs as unknown as {
      readSync(fd: number, buffer: Buffer, offset: number, length: number, position: null): number;
    };
    vi.spyOn(reader, 'readSync').mockImplementation((fd, buffer, offset, length) => {
      const file = opened.get(fd);
      if (!file) throw Error('Unopened readonly file');
      const count = file.bytes.copy(buffer, offset, file.offset, file.offset + length);
      file.offset += count;
      return count;
    });
    const close = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (!opened.delete(fd)) throw Error('Unopened readonly close');
      if (failure === 'close') throw Error('HOSTILE_RAW_CLOSE_PATH');
    });
    return { recorded, opened, names, close, frame };
  }
  it('reads only fixed readonly proc bytes and executable metadata, closing every descriptor', () => {
    const f = syscallFixture(),
      result = readNativeProcess(panePid);
    expect(result).toEqual(f.recorded);
    expect(f.names).toEqual([
      '/proc/self/stat',
      '/proc/' + panePid + '/stat',
      new URL('../src/docker-viewer-executables.json', import.meta.url).pathname,
      '/proc/' + panePid + '/status',
      '/proc/' + panePid + '/cmdline',
      '/proc/' + panePid + '/status',
      '/proc/' + panePid + '/stat',
    ]);
    expect(f.opened.size).toBe(0);
    expect(f.close).toHaveBeenCalledTimes(7);
  });
  it.each(['oversized', 'foreign', 'not-file', 'close'] as const)(
    'closes and refuses %s native reads without leaking raw errors',
    (failure) => {
      const f = syscallFixture(failure);
      expect(() => readNativeProcess(panePid)).toThrow('Original Docker viewer process observation unavailable');
      expect(f.opened.size).toBe(0);
      expect(f.close).toHaveBeenCalled();
    }
  );
  it.each(['pid-reuse', 'namespace-change'] as const)(
    'the actual reader exposes late %s and the real proof factory refuses the mixed snapshot',
    (failure) => {
      const f = syscallFixture(failure),
        mixed = readNativeProcess(panePid);
      if (failure === 'pid-reuse') expect(mixed.statAfter).not.toBe(mixed.stat);
      else expect(mixed.namespaceAfter).not.toBe(mixed.namespace);
      vi.spyOn(nativePort, 'readDockerViewerProcess').mockImplementation((pid) =>
        pid === panePid
          ? mixed
          : {
              ...structuredClone(f.frame.manager),
              cmdline: Buffer.from(f.frame.manager.cmdline),
            }
      );
      vi.spyOn(nativePort, 'readDockerViewerSocket').mockReturnValue(f.frame.socket);
      expect(f.frame.capture()).toBeUndefined();
      expect(f.opened.size).toBe(0);
    }
  );
});
