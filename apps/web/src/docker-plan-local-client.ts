/** Linux website-owned tmux attach client only. Never a pane/worker stop. */
import fs from 'node:fs';
import cp from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { IPty } from 'node-pty';
import type { TerminalMultiplexer, MuxSession } from './mux-interface.js';
// tmux sanitizes literal TABs to underscores in the C locale used by Nix.
// A printable separator preserves field boundaries there; extra separators fail closed.
const clientFormat = '#{client_pid}|#{client_tty}|#{client_name}|#{session_name}|#{pid}|#{socket_path}';
const serverFormat = '#{pid}|#{socket_path}';
const observationArgs = (socket: string): readonly string[] => ['-N', '-f', '/dev/null', '-L', socket];
function refuse(): never {
  throw Error('The original local tmux client is unconfirmed');
}
function positive(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) return refuse();
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return refuse();
  return n;
}
function proc(pid: number): Readonly<{ parent: number; birth: string }> | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return refuse();
  let text: string;
  try {
    text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return refuse();
  }
  const at = text.lastIndexOf(')');
  if (at < 0 || text.slice(0, text.indexOf(' ')) !== String(pid)) return refuse();
  const fields = text
      .slice(at + 2)
      .trim()
      .split(/\s+/),
    birth = fields[19];
  if (!birth || !/^(?:0|[1-9][0-9]{0,19})$/.test(birth) || BigInt(birth) > 18446744073709551615n) return refuse();
  return Object.freeze({ parent: positive(fields[1] ?? ''), birth });
}
function stamp(value: fs.BigIntStats): string {
  return [value.dev, value.ino, value.rdev, value.uid, value.mode].join(':');
}
function stable(record: MuxSession): unknown {
  return {
    sessionId: record.sessionId,
    muxName: record.muxName,
    owner: record.owner,
    docker: record.docker,
    remote: record.remote,
    mode: record.mode,
    workingDir: record.workingDir,
    createdAt: record.createdAt,
  };
}
function environment(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { TERM: 'xterm-256color' };
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMUX_TMPDIR', 'LANG', 'LC_ALL']) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.freeze(out);
}
interface Client {
  pid: number;
  tty: string;
  name: string;
  session: string;
  server: number;
  socket: string;
}
/** Capture is minted by an actual own PTY child; it supplies no native grant.
 * Session must separately re-require its genuine stopped-source/target proof. */
export class DockerPlanLocalClient {
  readonly #pty: IPty;
  readonly #mux: TerminalMultiplexer;
  readonly #record: MuxSession;
  readonly #stable: unknown;
  readonly #pid: number;
  readonly #birth: string;
  readonly #tty: string;
  readonly #ttyStamp: string;
  readonly #server: number;
  readonly #serverBirth: string;
  readonly #socketPath: string;
  readonly #socketStamp: string;
  readonly #socket: string;
  readonly #env: NodeJS.ProcessEnv;
  #fd: number | undefined;
  #exited = false;
  #closeFailed = false;
  private constructor(
    pty: IPty,
    mux: TerminalMultiplexer,
    record: MuxSession,
    pid: number,
    birth: string,
    tty: string,
    fd: number,
    server: number,
    serverBirth: string,
    socketPath: string,
    env: NodeJS.ProcessEnv
  ) {
    this.#pty = pty;
    this.#mux = mux;
    this.#record = record;
    this.#stable = structuredClone(stable(record));
    this.#pid = pid;
    this.#birth = birth;
    this.#tty = tty;
    this.#fd = fd;
    this.#ttyStamp = stamp(fs.fstatSync(fd, { bigint: true }));
    this.#server = server;
    this.#serverBirth = serverBirth;
    this.#socketPath = socketPath;
    this.#socketStamp = stamp(fs.lstatSync(socketPath, { bigint: true }));
    this.#socket = mux.muxSocket;
    this.#env = env;
    pty.onExit(() => {
      this.#exited = true;
      const owned = this.#fd;
      this.#fd = undefined;
      if (owned !== undefined)
        try {
          fs.closeSync(owned);
        } catch {
          this.#closeFailed = true;
        }
    });
    Object.freeze(this);
  }
  static capture(pty: IPty, mux: TerminalMultiplexer, record: MuxSession): DockerPlanLocalClient {
    if (
      process.platform !== 'linux' ||
      fs.statfsSync('/proc').type !== 0x9fa0 ||
      mux.getAttachCommand() !== 'tmux' ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(mux.muxSocket) ||
      !/^reverie-[A-Za-z0-9_-]+$/.test(record.muxName) ||
      !record.docker?.continuation ||
      record.remote ||
      record.discovered
    )
      return refuse();
    const self = fs.readFileSync('/proc/self/stat', 'utf8');
    if (Number(self.match(/^(\d+) \(/)?.[1]) !== process.pid) return refuse();
    if (mux.getSession(record.sessionId) !== record) return refuse();
    if (
      !isDeepStrictEqual(mux.getAttachArgs(record.muxName), [
        '-L',
        mux.muxSocket,
        'attach-session',
        '-t',
        record.muxName,
      ])
    )
      return refuse();
    const pid = pty.pid,
      seen = proc(pid);
    if (!seen || seen.parent !== process.pid) return refuse();
    // node-pty's UnixTerminal exposes this readonly native slave name, although
    // its platform-neutral IPty declaration does not expose the Unix accessor.
    const tty: unknown = Reflect.get(pty, 'ptsName');
    if (typeof tty !== 'string' || !/^\/dev\/pts\/(?:0|[1-9][0-9]*)$/.test(tty)) return refuse();
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        tty,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY
      );
      const device = fs.fstatSync(fd, { bigint: true });
      if (!device.isCharacterDevice() || device.uid !== BigInt(process.getuid?.() ?? -1)) return refuse();
      const env = environment(),
        body = cp
          .execFileSync('tmux', [...observationArgs(mux.muxSocket), 'display-message', '-p', serverFormat], {
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 8192,
            env,
          })
          .trim(),
        fields = body.split('|');
      if (fields.length !== 2 || !fields[1]?.startsWith('/') || /[\0\r\n]/.test(fields[1]) || fields[1].length > 4096)
        return refuse();
      const server = positive(fields[0]!),
        serverProc = proc(server),
        socket = fs.lstatSync(fields[1]!, { bigint: true });
      if (
        !serverProc ||
        !socket.isSocket() ||
        socket.uid !== BigInt(process.getuid?.() ?? -1) ||
        !isDeepStrictEqual(proc(pid), seen)
      )
        return refuse();
      const result = new DockerPlanLocalClient(
        pty,
        mux,
        record,
        pid,
        seen.birth,
        tty,
        fd,
        server,
        serverProc.birth,
        fields[1]!,
        env
      );
      fd = undefined;
      return result;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  #command(args: readonly string[]): string {
    try {
      return cp.execFileSync('tmux', [...observationArgs(this.#socket), ...args], {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 65536,
        env: this.#env,
      });
    } catch {
      return refuse();
    }
  }
  #currency(
    pty: IPty | null,
    mux: TerminalMultiplexer | undefined,
    record: MuxSession | null,
    current: () => void
  ): void {
    current();
    if (
      (pty !== this.#pty && !(pty === null && this.#exited)) ||
      mux !== this.#mux ||
      record !== this.#record ||
      mux.getSession(this.#record.sessionId) !== this.#record ||
      mux.muxSocket !== this.#socket ||
      !isDeepStrictEqual(stable(record), this.#stable) ||
      this.#closeFailed
    )
      return refuse();
    const server = proc(this.#server);
    if (
      !server ||
      server.birth !== this.#serverBirth ||
      stamp(fs.lstatSync(this.#socketPath, { bigint: true })) !== this.#socketStamp
    )
      return refuse();
    current();
  }
  #census(): readonly Client[] {
    const raw = this.#command(['list-clients', '-F', clientFormat]);
    if (Buffer.byteLength(raw) > 65536) return refuse();
    const lines = raw.trimEnd() ? raw.trimEnd().split('\n') : [];
    if (lines.length > 128) return refuse();
    return lines.map((line) => {
      const f = line.split('|');
      if (f.length !== 6 || !f[2] || !f[3] || f[4] !== String(this.#server) || f[5] !== this.#socketPath)
        return refuse();
      return { pid: positive(f[0]!), tty: f[1]!, name: f[2], session: f[3], server: this.#server, socket: f[5] };
    });
  }
  #live(): void {
    const seen = proc(this.#pid);
    if (
      !seen ||
      seen.parent !== process.pid ||
      seen.birth !== this.#birth ||
      this.#fd === undefined ||
      stamp(fs.fstatSync(this.#fd, { bigint: true })) !== this.#ttyStamp
    )
      return refuse();
    if (
      fs.readlinkSync('/proc/' + this.#pid + '/fd/0') !== this.#tty ||
      stamp(fs.statSync('/proc/' + this.#pid + '/fd/0', { bigint: true })) !== this.#ttyStamp
    )
      return refuse();
  }
  async detach(
    pty: IPty | null,
    mux: TerminalMultiplexer | undefined,
    record: MuxSession | null,
    current: () => void
  ): Promise<void> {
    const check = () => this.#currency(pty, mux, record, current);
    check();
    const before = this.#census();
    check();
    if (!this.#exited) {
      this.#live();
      const matches = before.filter((c) => c.pid === this.#pid || c.tty === this.#tty || c.name === this.#tty);
      if (
        matches.length !== 1 ||
        matches[0]!.pid !== this.#pid ||
        matches[0]!.tty !== this.#tty ||
        matches[0]!.name !== this.#tty ||
        matches[0]!.session !== this.#record.muxName
      )
        return refuse();
      // No await between the last native identity check and this one-client
      // effect. Default detach never sends a signal (-P) or selects other clients.
      check();
      this.#live();
      this.#command(['detach-client', '-t', this.#tty]);
      check();
    }
    const deadline = performance.now() + 2000;
    while (!this.#exited) {
      check();
      if (performance.now() >= deadline) return refuse();
      await delay(10);
    }
    check();
    if (proc(this.#pid) !== undefined) return refuse();
    const after = this.#census();
    check();
    if (after.some((c) => c.pid === this.#pid || c.tty === this.#tty || c.name === this.#tty)) return refuse();
  }
}
Object.freeze(DockerPlanLocalClient.prototype);
