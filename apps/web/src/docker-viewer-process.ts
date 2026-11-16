/** Bounded Linux read-only syscall port. No process, signal, environment or
 * command execution is exposed. Its returned bytes are DATA, never authority. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCKER_VIEWER_EXECUTABLES = ['/bin/docker', '/bin/bash', '/bin/tmux'] as const;
export type DockerViewerExecutable = (typeof DOCKER_VIEWER_EXECUTABLES)[number];
export interface DockerViewerFileStat {
  readonly dev: string;
  readonly ino: string;
  readonly rdev: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: string;
  readonly changed: string;
  readonly modified: string;
}
export interface DockerViewerExecutableObservation {
  readonly path: string;
  readonly stat: DockerViewerFileStat;
  readonly parents: readonly { readonly path: string; readonly uid: number; readonly mode: number }[];
}
export type DockerViewerSocketObservation = DockerViewerExecutableObservation;
export interface DockerViewerExecutablePin extends DockerViewerExecutableObservation {
  readonly entry: DockerViewerExecutableObservation;
  readonly argv0: string;
}
export interface DockerViewerExecutableManifest {
  readonly version: 1;
  readonly purpose: 'reverie-docker-viewer-executables-v1';
  readonly executables: Readonly<
    Record<DockerViewerExecutable, Readonly<{ entry: string; executable: string; argv0: string }>>
  >;
}
export function parseDockerViewerExecutables(text: string): DockerViewerExecutableManifest {
  const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  const immutable = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^\/nix\/store\/[0-9a-z]{32}-[A-Za-z0-9+._?=-]+\/[^\0\r\n]+$/.test(value) &&
    value.length <= 4096 &&
    path.normalize(value) === value;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16384) return refuse();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return refuse();
  }
  if (
    !exact(value, ['version', 'purpose', 'executables']) ||
    value.version !== 1 ||
    value.purpose !== 'reverie-docker-viewer-executables-v1' ||
    !exact(value.executables, DOCKER_VIEWER_EXECUTABLES)
  )
    return refuse();
  for (const name of DOCKER_VIEWER_EXECUTABLES) {
    const pin = value.executables[name];
    if (
      !exact(pin, ['entry', 'executable', 'argv0']) ||
      !immutable(pin.entry) ||
      !immutable(pin.executable) ||
      pin.argv0 !== (name === '/bin/docker' ? pin.executable : name) ||
      (name !== '/bin/docker' && pin.entry !== pin.executable)
    )
      return refuse();
  }
  return value as unknown as DockerViewerExecutableManifest;
}
export interface DockerViewerManifestObservation extends DockerViewerExecutableObservation {
  readonly text: string;
}
export interface DockerViewerProcessObservation {
  readonly procfs: number;
  readonly selfStat: string;
  readonly selfNamespace: string;
  readonly namespace: string;
  readonly directoryUid: number;
  readonly stat: string;
  readonly statAfter: string;
  readonly status: string;
  readonly statusAfter: string;
  readonly namespaceAfter: string;
  readonly cmdline: Buffer;
  readonly exe: string;
  readonly exeStat: DockerViewerFileStat;
  readonly executables: Readonly<Record<DockerViewerExecutable, DockerViewerExecutablePin>>;
  readonly manifest: DockerViewerManifestObservation;
}
function refuse(): never {
  throw Error('Original Docker viewer process observation unavailable');
}
function metadata(stat: fs.BigIntStats): DockerViewerFileStat {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    rdev: String(stat.rdev),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode),
    size: String(stat.size),
    changed: String(stat.ctimeNs),
    modified: String(stat.mtimeNs),
  });
}
function read(file: string, maximum: number, owner = process.getuid?.()): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== owner) return refuse();
    const out = Buffer.alloc(maximum + 1);
    let offset = 0;
    for (;;) {
      const count = fs.readSync(fd, out, offset, out.length - offset, null);
      offset += count;
      if (offset > maximum) return refuse();
      if (count === 0) return out.subarray(0, offset);
    }
  } finally {
    fs.closeSync(fd);
  }
}
function parentsOf(canonical: string) {
  const parents: Array<{ path: string; uid: number; mode: number }> = [];
  for (let parent = path.dirname(canonical); ; parent = path.dirname(parent)) {
    if (parents.length >= 128) return refuse();
    const stat = fs.lstatSync(parent);
    parents.push({ path: parent, uid: stat.uid, mode: stat.mode });
    if (parent === '/') break;
  }
  return parents;
}
function executable(file: string): DockerViewerExecutableObservation {
  const canonical = fs.realpathSync(file);
  if (!path.isAbsolute(canonical) || canonical.length > 4096 || canonical.includes('\0')) return refuse();
  return Object.freeze({
    path: canonical,
    stat: metadata(fs.statSync(canonical, { bigint: true })),
    parents: parentsOf(canonical),
  });
}
export function readDockerViewerSocket(socketPath: string): DockerViewerSocketObservation {
  try {
    if (
      process.platform !== 'linux' ||
      !path.isAbsolute(socketPath) ||
      path.normalize(socketPath) !== socketPath ||
      socketPath.length > 4096 ||
      /[\0\r\n]/.test(socketPath)
    )
      return refuse();
    return {
      path: fs.realpathSync(socketPath),
      stat: metadata(fs.lstatSync(socketPath, { bigint: true })),
      parents: parentsOf(socketPath),
    };
  } catch {
    return refuse();
  }
}
export function readDockerViewerProcess(pid: number): DockerViewerProcessObservation {
  try {
    if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 1 || pid > 2147483647 || !process.getuid)
      return refuse();
    const root = '/proc/' + pid,
      directory = fs.lstatSync(root);
    if (!directory.isDirectory() || directory.uid !== process.getuid()) return refuse();
    const selfStat = read('/proc/self/stat', 8192).toString('utf8'),
      before = read(root + '/stat', 8192).toString('utf8');
    // Packaging alone selects this file. No request, environment or instance configuration can redirect it.
    const manifestFile = fileURLToPath(new URL('./docker-viewer-executables.json', import.meta.url));
    const manifest = { ...executable(manifestFile), text: read(manifestFile, 16384, 0).toString('utf8') };
    const pins = parseDockerViewerExecutables(manifest.text);
    const fixed = (name: DockerViewerExecutable): DockerViewerExecutablePin => {
      const pin = pins.executables[name],
        entry = executable(name),
        leaf = executable(pin.executable);
      if (entry.path !== pin.entry || leaf.path !== pin.executable) return refuse();
      return { ...leaf, entry, argv0: pin.argv0 };
    };
    return {
      procfs: fs.statfsSync('/proc').type,
      selfStat,
      selfNamespace: fs.readlinkSync('/proc/self/ns/pid'),
      namespace: fs.readlinkSync(root + '/ns/pid'),
      directoryUid: directory.uid,
      stat: before,
      status: read(root + '/status', 65536).toString('utf8'),
      cmdline: read(root + '/cmdline', 262144),
      exe: fs.readlinkSync(root + '/exe'),
      exeStat: metadata(fs.statSync(root + '/exe', { bigint: true })),
      executables: {
        '/bin/docker': fixed('/bin/docker'),
        '/bin/bash': fixed('/bin/bash'),
        '/bin/tmux': fixed('/bin/tmux'),
      },
      manifest,
      statusAfter: read(root + '/status', 65536).toString('utf8'),
      namespaceAfter: fs.readlinkSync(root + '/ns/pid'),
      statAfter: read(root + '/stat', 8192).toString('utf8'),
    };
  } catch {
    return refuse();
  }
}
