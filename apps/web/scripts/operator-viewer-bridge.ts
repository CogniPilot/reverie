/** Explicit operator attachment to one existing Docker/tmux target.
 * Never creates/stops providers, containers or sessions; not native recovery/Office authority.
 */
import {execFileSync, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {chmodSync, lstatSync, realpathSync, unlinkSync} from 'node:fs';
import {createServer, type Socket} from 'node:net';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
const MAX = 262_144;
export interface Target {sessionId: string; containerId: string; startedAt: string; pid: number; socket: string;}
export function validateTarget(t: Target): void {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(t.sessionId) || !/^[a-f0-9]{64}$/.test(t.containerId)
    || !Number.isSafeInteger(t.pid) || t.pid < 1 || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(t.startedAt)
    || !isAbsolute(t.socket) || resolve(t.socket) !== t.socket || Buffer.byteLength(t.socket) > 100)
    throw new Error('Exact session, full container ID, start timestamp, PID and private socket required');
}
export function inspectTarget(t: Target, value: unknown): void {
  const row = value as {Id?: unknown; Name?: unknown; State?: {Running?: unknown; StartedAt?: unknown; Pid?: unknown}};
  if (row?.Id !== t.containerId || row.Name !== `/reverie-agent-${t.sessionId}` || row.State?.Running !== true
    || row.State.StartedAt !== t.startedAt || row.State.Pid !== t.pid) throw new Error('Original running container changed');
}
export function attachRequest(t: Target, kind: number, payload: Buffer): {cols: number; rows: number} {
  if (kind !== 74 || payload.length > MAX) throw new Error('Only attach-only J supported');
  const row: unknown = JSON.parse(payload.toString('utf8'));
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid attachment');
  const r = row as Record<string, unknown>;
  if (r.sessionId !== t.sessionId || r.attachOnly !== true || !Number.isSafeInteger(r.cols) || Number(r.cols) < 1
    || Number(r.cols) > 1000 || !Number.isSafeInteger(r.rows) || Number(r.rows) < 1 || Number(r.rows) > 500)
    throw new Error('Original session and bounded attach-only geometry required');
  // Request command/cwd/env are ignored, never executed or trusted as authority.
  return {cols: Number(r.cols), rows: Number(r.rows)};
}
export function attachmentCommand(t: Target, cols: number, rows: number): string {
  validateTarget(t);
  if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1000 || !Number.isSafeInteger(rows) || rows < 1 || rows > 500) throw new Error('Invalid geometry');
  return `stty cols ${cols} rows ${rows}; exec docker exec -it ${t.containerId} /bin/tmux -u -L reverie-laptop attach-session -t =office`;
}
function frame(s: Socket, kind: string, payload: Buffer | string): void {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  for (let offset = 0; offset < bytes.length || offset === 0; offset += MAX) {
    const part = bytes.subarray(offset, offset + MAX), header = Buffer.alloc(5);
    header[0] = kind.charCodeAt(0); header.writeUInt32BE(part.length, 1); s.write(Buffer.concat([header, part]));
    if (bytes.length === 0) break;
  }
}
function current(t: Target): string {
  const rows = JSON.parse(execFileSync('docker', ['inspect', t.containerId], {encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024}));
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Original container unavailable');
  inspectTarget(t, rows[0]);
  const pane = execFileSync('docker', ['exec', t.containerId, '/bin/tmux', '-L', 'reverie-laptop', 'display-message', '-p', '-t', '=office:',
    '#{session_id}|#{session_created}|#{pane_id}|#{pane_pid}|#{pane_dead}'], {encoding: 'utf8', timeout: 5000, maxBuffer: 4096}).trim();
  if (!/^\$\d+\|\d+\|%\d+\|[1-9]\d*\|0$/.test(pane)) throw new Error('Original live office pane unavailable');
  return pane;
}
function detach(child: ChildProcessWithoutNullStreams): void {
  // Only script/docker-client/attach belong to this new process group. The
  // persistent existing provider/container/tmux server never belongs to it.
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {process.kill(-child.pid, 'SIGTERM');} catch { /* attachment already ended */ }
}
export function serve(t: Target): void {
  validateTarget(t);
  const parent = dirname(t.socket), uid = process.getuid?.(), info = lstatSync(parent);
  if (uid === undefined || !info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0 || realpathSync(parent) !== parent)
    throw new Error('Socket directory must be an original owner-only directory');
  try {lstatSync(t.socket); throw new Error('Socket already exists; never replacing it');}
  catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;}
  const originalPane = current(t);
  let occupied = false;
  const clients = new Set<Socket>();
  const server = createServer(s => {
    clients.add(s);
    let buffer = Buffer.alloc(0), attached = false, child: ChildProcessWithoutNullStreams | undefined;
    const fail = () => {if (!s.destroyed) {frame(s, 'E', 'OPERATOR_VIEWER_REFUSED'); s.end();}};
    s.on('error', () => {});
    s.on('close', () => {clients.delete(s); if (child) detach(child);});
    s.setTimeout(10_000, () => {if (!attached) fail();});
    s.on('data', bytes => {
      try {
        if (buffer.length + bytes.length > MAX + 5) throw new Error('Frame bound exceeded');
        buffer = Buffer.concat([buffer, bytes]);
        while (buffer.length >= 5) {
          const kind = buffer[0], length = buffer.readUInt32BE(1);
          if (length > MAX) throw new Error('Frame bound exceeded');
          if (buffer.length < length + 5) return;
          const payload = buffer.subarray(5, 5 + length); buffer = buffer.subarray(5 + length);
          if (!attached) {
            const size = attachRequest(t, kind, payload);
            if (occupied || current(t) !== originalPane) throw new Error('Original attachment unavailable');
            occupied = true; attached = true; s.setTimeout(0);
            child = spawn('script', ['-q', '-f', '-e', '-c', attachmentCommand(t, size.cols, size.rows), '/dev/null'],
              {detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, TERM: 'xterm-256color'}});
            child.stdout.on('data', data => {if (!s.destroyed) {frame(s, 'O', data); if (s.writableLength > 1024 * 1024) {fail(); if (child) detach(child);}}});
            child.stderr.on('data', () => { /* Host diagnostics/credentials never copied to the terminal. */ });
            child.on('error', () => {fail();});
            child.on('close', code => {occupied = false; if (!s.destroyed) {frame(s, 'X', JSON.stringify(code ?? 1)); s.end();}});
          } else if (kind === 73) {
            if (!child || current(t) !== originalPane) throw new Error('Original target changed');
            child.stdin.write(payload);
          } else if (kind === 82) {
            // Emergency attachment applies initial geometry only. Later resize
            // is unsupported and never becomes a provider lifecycle action.
            const size: unknown = JSON.parse(payload.toString('utf8'));
            if (!Array.isArray(size) || size.length !== 2 || size.some(n => !Number.isSafeInteger(n) || n < 1 || n > 1000)) throw new Error('Invalid resize');
          } else throw new Error('Unsupported attachment frame');
        }
      } catch {fail(); if (child) detach(child);}
    });
  });
  let identity: {dev: number; ino: number} | undefined;
  const close = () => {for (const s of clients) s.destroy(); server.close(() => {
    try {const found = lstatSync(t.socket); if (identity && found.dev === identity.dev && found.ino === identity.ino) unlinkSync(t.socket);} catch { /* preserve foreign replacement */ }
  });};
  server.on('error', error => {console.error(`Operator viewer unavailable: ${error.message}`); close(); process.exitCode = 1;});
  process.once('SIGTERM', close); process.once('SIGINT', close);
  const oldMask = process.umask(0o077);
  try {server.listen(t.socket, () => {chmodSync(t.socket, 0o600); const found = lstatSync(t.socket); identity = {dev: found.dev, ino: found.ino}; console.log('Operator attachment ready; provider readiness is not asserted');});}
  finally {process.umask(oldMask);}
}
function main(): void {
  const v = parseArgs({options: {'session-id': {type: 'string'}, 'container-id': {type: 'string'}, 'started-at': {type: 'string'}, pid: {type: 'string'}, socket: {type: 'string'}}, strict: true}).values;
  serve({sessionId: v['session-id'] ?? '', containerId: v['container-id'] ?? '', startedAt: v['started-at'] ?? '', pid: Number(v.pid), socket: v.socket ?? ''});
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {main();} catch (e) {console.error(e instanceof Error ? e.message : 'Operator attachment refused'); process.exitCode = 1;}
}
