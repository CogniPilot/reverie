/** Private fixed-channel bridge; no routes, socket connection, cookie export or PTY. */
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import { inspect } from 'node:util';
import { OwnerLaptopTerminalAuthority, type AuthorityRequest, type PrivateAuthorityContext } from './owner-laptop-terminal-authority.js';

const MAX_FRAME = 8192, MAX_OPERATIONS = 1024, MAX_CHECKS = 64;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
type Row = Record<string, unknown>;
export class LedgerBridgeError extends Error {
  constructor(readonly state: 'busy' | 'refused' | 'unconfirmed') { super(`Owner terminal operation ${state}`); }
}
function requireThat(value: unknown): asserts value { if (!value) throw new LedgerBridgeError('unconfirmed'); }
function exact(value: unknown, keys: string[]): asserts value is Row {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireThat(Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)));
}
interface Stored { context: PrivateAuthorityContext; handle: string; employeeId: string; request: Row; proof: string }
interface Pending {
  n: number; operationId: string; handle: string; context: PrivateAuthorityContext;
  resolve(value: unknown): void; reject(error: Error): void; checks: number;
}
export interface PublicShellReference { shellId: string; authorizationRef: string; expiresAtEpochMs: number }

export class OwnerLedgerBridge<R extends AuthorityRequest> {
  readonly #socket: Socket;
  readonly #capture: (request: R, employeeId: string) => Promise<PrivateAuthorityContext>;
  readonly #contexts = new Map<string, PrivateAuthorityContext>();
  readonly #records = new Map<string, Stored>();
  readonly #challenges = new Set<string>();
  #pending?: Pending;
  #buffer = Buffer.alloc(0);
  #expected?: number;
  #sequence = 0;
  #busy = false;
  #checking = false;
  #failed = false;

  constructor(socket: Socket, authority: OwnerLaptopTerminalAuthority<R>) {
    requireThat(socket instanceof Socket && !socket.destroyed && socket.isPaused());
    requireThat(authority instanceof OwnerLaptopTerminalAuthority);
    this.#socket = socket;
    // Capture the real class method, not a wire-selected or mutable instance callback.
    this.#capture = OwnerLaptopTerminalAuthority.prototype.capture.bind(authority);
    socket.on('data', chunk => this.#data(chunk));
    socket.on('error', () => this.#fail());
    socket.on('end', () => this.#fail());
    socket.on('close', () => this.#fail());
    socket.resume();
  }
  [inspect.custom](): string { return '[Private owner-terminal ledger bridge]'; }
  toJSON(): never { throw new LedgerBridgeError('refused'); }
  close(): void { this.#fail(); }
  #fail(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#socket.destroy(); this.#contexts.clear(); this.#records.clear();
    this.#pending?.reject(new LedgerBridgeError('unconfirmed'));
    this.#pending = undefined; this.#buffer = Buffer.alloc(0);
  }
  #guard(): void { requireThat(!this.#failed && !this.#socket.destroyed); }
  #send(value: Row): void {
    this.#guard();
    const body = Buffer.from(JSON.stringify(value));
    requireThat(body.length > 0 && body.length <= MAX_FRAME && this.#socket.writableLength <= MAX_FRAME);
    const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
    this.#socket.write(Buffer.concat([header, body]));
  }
  #data(chunk: Buffer): void {
    try {
      requireThat(chunk.length <= 65536 && this.#buffer.length + chunk.length <= 2 * MAX_FRAME + 8);
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (true) {
        if (this.#expected === undefined) {
          if (this.#buffer.length < 4) return;
          this.#expected = this.#buffer.readUInt32BE(0); this.#buffer = this.#buffer.subarray(4);
          requireThat(this.#expected > 0 && this.#expected <= MAX_FRAME);
        }
        if (this.#buffer.length < this.#expected) return;
        const raw = this.#buffer.subarray(0, this.#expected);
        this.#buffer = this.#buffer.subarray(this.#expected); this.#expected = undefined;
        const row: unknown = JSON.parse(raw.toString('utf8'));
        requireThat(Buffer.from(JSON.stringify(row)).equals(raw)); // Duplicate/noncanonical JSON refuses.
        void this.#receive(row).catch(() => this.#fail());
      }
    } catch { this.#fail(); }
  }
  async #receive(value: unknown): Promise<void> {
    this.#guard();
    requireThat(value !== null && typeof value === 'object');
    const row = value as Row;
    if (row.kind === 'authority-check') {
      exact(row, ['kind', 'n', 'operationId', 'handle', 'challenge']);
      requireThat(!this.#checking && typeof row.operationId === 'string' && UUID.test(row.operationId)
        && typeof row.challenge === 'string' && UUID.test(row.challenge) && !this.#challenges.has(row.challenge)
        && typeof row.handle === 'string' && UUID.test(row.handle) && Number.isSafeInteger(row.n));
      const context = this.#contexts.get(row.handle);
      requireThat(context && (this.#pending
        ? this.#pending.n === row.n && this.#pending.operationId === row.operationId && this.#pending.handle === row.handle
        : row.n === 0 && !this.#busy));
      if (this.#pending) requireThat(++this.#pending.checks <= MAX_CHECKS);
      requireThat(this.#challenges.size < MAX_OPERATIONS * MAX_CHECKS);
      this.#challenges.add(row.challenge); this.#checking = true;
      try {
        await context.recheck(); this.#guard();
        requireThat(Date.now() < context.expiresAtEpochMs);
        this.#send({kind: 'authority', n: row.n, operationId: row.operationId, handle: row.handle,
          challenge: row.challenge, scopeDigest: context.ownerScopeDigest,
          expiresAtEpochMs: context.expiresAtEpochMs, target: context.target});
      } catch {
        if (!this.#failed) this.#send({kind: 'authority-refused', n: row.n,
          operationId: row.operationId, handle: row.handle, challenge: row.challenge});
      } finally { this.#checking = false; }
      return;
    }
    exact(row, ['kind', 'n', 'operationId', 'state', 'value']);
    const pending = this.#pending;
    requireThat(row.kind === 'result' && pending && !this.#checking
      && row.n === pending.n && row.operationId === pending.operationId);
    requireThat(['ok', 'refused', 'unconfirmed'].includes(String(row.state)));
    if (row.state === 'ok') pending.resolve(row.value);
    else if (row.state === 'refused') { requireThat(row.value === null); pending.reject(new LedgerBridgeError('refused')); }
    else { requireThat(row.value === null); this.#fail(); }
    this.#pending = undefined;
  }
  async #command(action: string, data: Row, handle: string, context: PrivateAuthorityContext): Promise<unknown> {
    this.#guard();
    try { await context.recheck(); } catch { throw new LedgerBridgeError('refused'); }
    this.#guard();
    requireThat(++this.#sequence <= MAX_OPERATIONS);
    const n = this.#sequence, operationId = randomUUID();
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        this.#pending = {n, operationId, handle, context, resolve, reject, checks: 0};
        timeout = setTimeout(() => this.#fail(), 5000);
        try { this.#send({kind: 'command', n, operationId, action, handle,
          employeeId: context.target.employeeId, ...data}); } catch { this.#fail(); }
      });
    } finally { if (timeout) clearTimeout(timeout); }
  }
  async issue(request: R, employeeId: string, cols: number, rows: number, lifetimeSeconds = 300): Promise<PublicShellReference> {
    if (this.#busy || this.#checking) throw new LedgerBridgeError('busy');
    this.#busy = true;
    const handle = randomUUID(); let successful = false, acknowledged = false;
    try {
      this.#guard();
      if (!(Number.isInteger(cols) && cols >= 2 && cols <= 300 && Number.isInteger(rows) && rows >= 2 && rows <= 120
        && Number.isSafeInteger(lifetimeSeconds) && lifetimeSeconds >= 1 && lifetimeSeconds <= 3600)) throw new LedgerBridgeError('refused');
      let context: PrivateAuthorityContext;
      try { context = await this.#capture(request, employeeId); } catch { throw new LedgerBridgeError('refused'); }
      this.#guard();
      if (this.#contexts.size >= 128) throw new LedgerBridgeError('refused');
      this.#contexts.set(handle, context);
      const value = await this.#command('issue', {cols, rows, lifetimeSeconds}, handle, context);
      acknowledged = true;
      exact(value, ['request', 'proof']);
      requireThat(typeof value.proof === 'string' && HEX.test(value.proof));
      exact(value.request, ['schema', 'shellId', 'employeeId', 'sessionId', 'sessionGeneration', 'containerId',
        'imageId', 'policyDigest', 'cols', 'rows', 'requestId', 'expiresAtEpochMs', 'authorizationRef']);
      const capability = value.request;
      requireThat(capability.schema === 'reverie-human-shell-v2' && capability.cols === cols && capability.rows === rows
        && typeof capability.shellId === 'string' && UUID.test(capability.shellId)
        && typeof capability.requestId === 'string' && UUID.test(capability.requestId)
        && typeof capability.authorizationRef === 'string' && UUID.test(capability.authorizationRef)
        && Number.isSafeInteger(capability.expiresAtEpochMs) && Number(capability.expiresAtEpochMs) > Date.now()
        && Number(capability.expiresAtEpochMs) <= context.expiresAtEpochMs);
      for (const k of ['employeeId', 'sessionId', 'sessionGeneration', 'containerId', 'imageId', 'policyDigest'] as const)
        requireThat(capability[k] === context.target[k]);
      await context.recheck(); this.#guard();
      this.#records.set(capability.authorizationRef, {context, handle, employeeId, request: capability, proof: value.proof});
      successful = true;
      return Object.freeze({shellId: capability.shellId, authorizationRef: capability.authorizationRef,
        expiresAtEpochMs: capability.expiresAtEpochMs as number});
    } catch (error) {
      if (acknowledged || !(error instanceof LedgerBridgeError && error.state === 'refused')) {
        this.#fail(); throw new LedgerBridgeError('unconfirmed');
      }
      throw error;
    } finally { if (!successful) this.#contexts.delete(handle); this.#busy = false; }
  }
  async metadata(request: R, reference: string, revoke = false): Promise<unknown> {
    if (this.#busy || this.#checking) throw new LedgerBridgeError('busy');
    this.#busy = true; let acknowledged = false;
    try {
      this.#guard();
      if (typeof reference !== 'string' || !UUID.test(reference)) throw new LedgerBridgeError('refused');
      const record = this.#records.get(reference);
      if (!record) throw new LedgerBridgeError('refused');
      let current: PrivateAuthorityContext;
      try { current = await this.#capture(request, record.employeeId); } catch { throw new LedgerBridgeError('refused'); }
      if (!(current.ownerScopeDigest === record.context.ownerScopeDigest
        && JSON.stringify(current.target) === JSON.stringify(record.context.target))) throw new LedgerBridgeError('refused');
      const value = await this.#command(revoke ? 'revoke' : 'status', {reference}, record.handle, record.context);
      acknowledged = true;
      await record.context.recheck(); this.#guard();
      if (revoke) { requireThat(value === null); return null; }
      exact(value, ['state', 'revision', 'requestId', 'shellId', 'expiresAtEpochMs']);
      requireThat(['ISSUED', 'CONSUMED', 'REVOKED'].includes(String(value.state)));
      return Object.freeze(value);
    } catch (error) {
      if (acknowledged || !(error instanceof LedgerBridgeError && error.state === 'refused')) {
        this.#fail(); throw new LedgerBridgeError('unconfirmed');
      }
      throw error;
    } finally { this.#busy = false; }
  }
}
