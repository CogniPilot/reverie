/** Controlled raw readonly syscall observations. The real DockerViewerPane
 * factory always mints proofs; this helper never constructs or returns one. */
import path from 'node:path';
import fs from 'node:fs';
import cp from 'node:child_process';
import { DockerPlanLocalClient } from '../../src/docker-plan-local-client.js';
import type { IPty } from 'node-pty';
import { vi } from 'vitest';
import { DockerViewerPane, type DockerViewerCommand } from '../../src/docker-viewer-pane.js';
import * as native from '../../src/docker-viewer-process.js';
import type { TerminalMultiplexer, MuxSession } from '../../src/mux-interface.js';

type Mutable<T> = T extends Buffer
  ? Buffer
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
export type RecordedDockerViewerProcess = Mutable<native.DockerViewerProcessObservation>;
export type RecordedDockerViewerSocket = Mutable<native.DockerViewerSocketObservation>;
export interface RecordedDockerViewerClient {
  pid: number;
  parent: number;
  birth: string;
  tty: string;
  fd0: string;
  device: Mutable<native.DockerViewerFileStat>;
  alive: boolean;
  listed: boolean;
  // Actual census peer is independent of the outer proof's retained server/socket.
  connectedServerPid: number;
  connectedSocketPath: string;
  session: string;
}
export function recordedDockerViewerSocketPath(socket: string): string {
  return '/fixture/tmux-' + (process.getuid?.() ?? 0) + '/' + socket;
}
export function recordedDockerViewerStat(pid: number, parent: number, birth: string, state = 'S'): string {
  return `${pid} (name with ) parentheses) ${state} ${parent} ${Array(17).fill('0').join(' ')} ${birth} 0\n`;
}
function executable(name: string, ino: number): Mutable<native.DockerViewerExecutableObservation> {
  const actual = '/nix/store/' + 'a'.repeat(32) + '-synthetic-' + name + '/bin/' + name,
    parents: Array<{ path: string; uid: number; mode: number }> = [];
  for (let parent = path.dirname(actual); ; parent = path.dirname(parent)) {
    parents.push({ path: parent, uid: 0, mode: 0o040555 });
    if (parent === '/') break;
  }
  return {
    path: actual,
    parents,
    stat: {
      dev: '1',
      ino: String(ino),
      rdev: '0',
      uid: 0,
      gid: 0,
      mode: 0o100555,
      size: '4096',
      changed: '123456',
      modified: '123456',
    },
  };
}
export function installRecordedDockerViewer() {
  const rows = new Map<number, RecordedDockerViewerProcess>(),
    commands = new Map<number, DockerViewerCommand>(),
    sockets = new Map<string, RecordedDockerViewerSocket>();
  const uid = process.getuid?.() ?? 0;
  let birth = 300;
  const observation = (
    pid: number,
    parent: number,
    command: DockerViewerCommand | undefined,
    server = false,
    shell = false
  ): RecordedDockerViewerProcess => {
    const entry = executable('docker', 11),
      leaf = executable('docker-leaf', 14),
      bash = executable('bash', 12),
      tmux = executable('tmux', 13);
    const executables = {
      '/bin/docker': { ...leaf, entry, argv0: leaf.path },
      '/bin/bash': { ...bash, entry: structuredClone(bash), argv0: '/bin/bash' },
      '/bin/tmux': { ...tmux, entry: structuredClone(tmux), argv0: '/bin/tmux' },
    };
    const manifestFile = executable('manifest', 15);
    manifestFile.stat.mode = 0o100444;
    const manifest = {
      ...manifestFile,
      text: JSON.stringify({
        version: 1,
        purpose: 'reverie-docker-viewer-executables-v1',
        executables: Object.fromEntries(
          Object.entries(executables).map(([name, value]) => [
            name,
            { entry: value.entry.path, executable: value.path, argv0: value.argv0 },
          ])
        ),
      }),
    };
    const selected = executables[server ? '/bin/tmux' : shell ? '/bin/bash' : '/bin/docker'];
    const stat = recordedDockerViewerStat(pid, parent, String(++birth)),
      status = `Name:\tfixture\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
    return {
      procfs: 0x9fa0,
      directoryUid: uid,
      namespace: 'pid:[123]',
      selfNamespace: 'pid:[123]',
      selfStat: recordedDockerViewerStat(process.pid, 1, '111'),
      stat,
      statAfter: stat,
      status,
      statusAfter: status,
      namespaceAfter: 'pid:[123]',
      exe: selected.path,
      exeStat: structuredClone(selected.stat),
      executables,
      manifest,
      cmdline: Buffer.from(
        (server
          ? ['tmux: server']
          : shell
            ? ['/bin/bash', '-c', command!.shellCommand]
            : [executables['/bin/docker'].argv0, ...command!.argv.slice(1)]
        ).join('\0') + '\0'
      ),
    };
  };
  const read = vi.spyOn(native, 'readDockerViewerProcess').mockImplementation((pid) => {
    const selected = rows.get(pid);
    if (!selected) throw Error('Recorded process is absent');
    return { ...structuredClone(selected), cmdline: Buffer.from(selected.cmdline) };
  });
  const readSocket = vi.spyOn(native, 'readDockerViewerSocket').mockImplementation((name) => {
    const selected = sockets.get(name);
    if (!selected) throw Error('Recorded socket is absent');
    return structuredClone(selected);
  });
  const socket = (name: string) => {
    const selected = sockets.get(name);
    if (!selected) throw Error('Recorded socket is absent');
    return selected;
  };
  const seed = (
    row: MuxSession,
    command: DockerViewerCommand,
    serverPid: number,
    shell = false,
    socketPath = recordedDockerViewerSocketPath('synthetic-office')
  ) => {
    commands.set(row.pid, command);
    const pane = observation(row.pid, serverPid, command, false, shell);
    const server = rows.get(serverPid) ?? observation(serverPid, 1, undefined, true);
    rows.set(row.pid, pane);
    rows.set(serverPid, server);
    if (!sockets.has(socketPath)) {
      const parents: RecordedDockerViewerSocket['parents'] = [];
      for (let parent = path.dirname(socketPath); ; parent = path.dirname(parent)) {
        parents.push({ path: parent, uid: parent === '/' ? 0 : uid, mode: 0o040700 });
        if (parent === '/') break;
      }
      sockets.set(socketPath, {
        path: socketPath,
        parents,
        stat: {
          dev: '2',
          ino: '51',
          rdev: '0',
          uid,
          gid: process.getgid?.() ?? uid,
          mode: 0o140600,
          size: '0',
          changed: '123456',
          modified: '123456',
        },
      });
    }
    return { pane, server, socket: socket(socketPath) };
  };
  const issued: Array<{
    mux: TerminalMultiplexer;
    row: MuxSession;
    command: DockerViewerCommand;
    serverPid: number;
    socketPath: string;
  }> = [];
  const recordCapture = () => {
    const actual = DockerViewerPane.capture;
    return vi.spyOn(DockerViewerPane, 'capture').mockImplementation((mux, row, command, serverPid, socketPath) => {
      seed(row, command, serverPid, false, socketPath);
      issued.push({ mux, row, command, serverPid, socketPath });
      return actual(mux, row, command, serverPid, socketPath);
    });
  };
  const data = (pid: number) => {
    const result = rows.get(pid);
    if (!result) throw Error('Recorded process is absent');
    return result;
  };
  const execDocker = (pid: number) => {
    const current = data(pid),
      command = commands.get(pid);
    if (!command) throw Error('Recorded command is absent');
    current.exe = current.executables['/bin/docker'].path;
    current.exeStat = structuredClone(current.executables['/bin/docker'].stat);
    current.cmdline = Buffer.from(
      [current.executables['/bin/docker'].argv0, ...command.argv.slice(1)].join('\0') + '\0'
    );
  };
  const clients: RecordedDockerViewerClient[] = [];
  const client = (pid: number) => {
    const selected = clients.find((value) => value.pid === pid);
    if (!selected) throw Error('Recorded website client is absent');
    return selected;
  };
  const recordLocalClients = (beforeCapture?: (client: RecordedDockerViewerClient) => void) => {
    const original = {
      readFile: fs.readFileSync,
      statfs: fs.statfsSync,
      open: fs.openSync,
      close: fs.closeSync,
      fstat: fs.fstatSync,
      stat: fs.statSync,
      lstat: fs.lstatSync,
      readlink: fs.readlinkSync,
      exec: cp.execFileSync,
    };
    const descriptors = new Map<number, RecordedDockerViewerClient>();
    let nextFd = 1073741824;
    const big = (value: native.DockerViewerFileStat): fs.BigIntStats =>
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
        isCharacterDevice: () => (value.mode & 0o170000) === 0o020000,
        isSocket: () => (value.mode & 0o170000) === 0o140000,
      }) as fs.BigIntStats;
    const missing = (): never => {
      throw Object.assign(Error('Recorded process absent'), { code: 'ENOENT' });
    };
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const name = String(args[0]);
      if (name === '/proc/self/stat') return recordedDockerViewerStat(process.pid, 1, '111');
      const match = /^\/proc\/([0-9]+)\/stat$/.exec(name);
      if (match) {
        const selected = clients.find((value) => value.pid === Number(match[1]));
        if (selected)
          return selected.alive ? recordedDockerViewerStat(selected.pid, selected.parent, selected.birth) : missing();
        const row = rows.get(Number(match[1]));
        if (row) return row.stat;
      }
      return Reflect.apply(original.readFile, fs, args);
    }) as typeof fs.readFileSync);
    vi.spyOn(fs, 'statfsSync').mockImplementation(((...args: Parameters<typeof fs.statfsSync>) =>
      String(args[0]) === '/proc'
        ? { type: 0x9fa0 }
        : Reflect.apply(original.statfs, fs, args)) as typeof fs.statfsSync);
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const selected = clients.find((value) => value.tty === String(args[0]));
      if (!selected) return Reflect.apply(original.open, fs, args);
      const required =
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY;
      if (args[1] !== required) throw Error('Unexpected website TTY flags');
      const fd = ++nextFd;
      descriptors.set(fd, selected);
      return fd;
    });
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      if (descriptors.has(fd)) {
        descriptors.delete(fd);
        return;
      }
      if (fd > 1073741824) throw Error('Recorded website TTY descriptor is already closed');
      return original.close(fd);
    });
    vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const selected = descriptors.get(args[0]);
      return selected ? big(selected.device) : Reflect.apply(original.fstat, fs, args);
    }) as typeof fs.fstatSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      const selected = sockets.get(String(args[0]));
      return selected ? big(selected.stat) : Reflect.apply(original.lstat, fs, args);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      const match = /^\/proc\/([0-9]+)\/fd\/0$/.exec(String(args[0]));
      const selected = match && clients.find((value) => value.pid === Number(match[1]));
      return selected ? (selected.alive ? big(selected.device) : missing()) : Reflect.apply(original.stat, fs, args);
    }) as typeof fs.statSync);
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) => {
      const match = /^\/proc\/([0-9]+)\/fd\/0$/.exec(String(args[0]));
      const selected = match && clients.find((value) => value.pid === Number(match[1]));
      return selected ? (selected.alive ? selected.fd0 : missing()) : Reflect.apply(original.readlink, fs, args);
    }) as typeof fs.readlinkSync);
    vi.spyOn(cp, 'execFileSync').mockImplementation(((...args: Parameters<typeof cp.execFileSync>) => {
      if (args[0] !== 'tmux') return Reflect.apply(original.exec, cp, args);
      const argv = args[1];
      if (!Array.isArray(argv) || argv[0] !== '-N' || argv[1] !== '-f' || argv[2] !== '/dev/null' || argv[3] !== '-L')
        throw Error('Unexpected recorded tmux observation');
      const logical = argv[4],
        issuedRow = [...issued].reverse().find((value) => value.mux.muxSocket === logical);
      if (!issuedRow) throw Error('Unissued recorded tmux observation');
      const rest = argv.slice(5);
      if (JSON.stringify(rest) === JSON.stringify(['display-message', '-p', '#{pid}|#{socket_path}']))
        return String(issuedRow.serverPid) + '|' + issuedRow.socketPath + '\n';
      if (
        JSON.stringify(rest) ===
        JSON.stringify([
          'list-clients',
          '-F',
          '#{client_pid}|#{client_tty}|#{client_name}|#{session_name}|#{pid}|#{socket_path}',
        ])
      )
        return clients
          .filter(
            (value) =>
              value.alive &&
              value.listed &&
              value.connectedServerPid === issuedRow.serverPid &&
              value.connectedSocketPath === issuedRow.socketPath
          )
          .map(
            (value) =>
              [
                value.pid,
                value.tty,
                value.tty,
                value.session,
                value.connectedServerPid,
                value.connectedSocketPath,
              ].join('|') + '\n'
          )
          .join('');
      throw Error('Non-observation tmux operation refused by recorded viewer port');
    }) as typeof cp.execFileSync);
    const capture = DockerPlanLocalClient.capture;
    return vi.spyOn(DockerPlanLocalClient, 'capture').mockImplementation((pty: IPty, mux, row) => {
      const own = [...issued].reverse().find((value) => value.mux === mux && value.row === row);
      const tty: unknown = Reflect.get(pty, 'ptsName');
      if (!own || typeof tty !== 'string') throw Error('Recorded client requires actual issued outer placement');
      const selected: RecordedDockerViewerClient = {
        pid: pty.pid,
        parent: process.pid,
        birth: String(1000000 + clients.length),
        tty,
        fd0: tty,
        alive: true,
        listed: true,
        connectedServerPid: own.serverPid,
        connectedSocketPath: own.socketPath,
        session: row.muxName,
        device: {
          dev: '3',
          ino: String(100 + clients.length),
          rdev: String(1000 + clients.length),
          uid,
          gid: process.getgid?.() ?? uid,
          mode: 0o020620,
          size: '0',
          changed: '123456',
          modified: '123456',
        },
      };
      if (clients.some((value) => value.pid === selected.pid || value.tty === selected.tty))
        throw Error('Recorded website clients require distinct PID and TTY identities');
      clients.push(selected);
      beforeCapture?.(selected);
      const result = capture(pty, mux, row);
      pty.onExit(() => {
        selected.alive = false;
        selected.listed = false;
      });
      return result;
    });
  };
  return {
    read,
    readSocket,
    recordLocalClients,
    clients,
    client,
    socket,
    seed,
    recordCapture,
    issued,
    data,
    execDocker,
    remove: (pid: number) => rows.delete(pid),
  };
}
