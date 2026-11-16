/** Controlled raw readonly syscall observations. The real DockerViewerPane
 * factory always mints proofs; this helper never constructs or returns one. */
import path from 'node:path';
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
  return {
    read,
    readSocket,
    socket,
    seed,
    recordCapture,
    issued,
    data,
    execDocker,
    remove: (pid: number) => rows.delete(pid),
  };
}
