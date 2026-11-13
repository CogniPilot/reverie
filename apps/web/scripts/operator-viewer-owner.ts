/** Process-local proof for one native attachment, never provider authority. */
import type { Writable } from 'node:stream';
export const VIEWER_CHILD_CAPABILITY = 'REVERIE_VIEWER_CHILD_V1';
export function validateCapability(text: string): void {
  if (text !== VIEWER_CHILD_CAPABILITY + '\n')
    throw new Error('Worker image lacks native viewer ownership; no attachment was started');
}
export interface OwnerBirth {
  readonly pid: number;
  readonly start: string;
  readonly boot: string;
  readonly namespace: string;
}
interface ClosedProof {
  readonly pid: number;
  readonly owner: OwnerBirth;
}
export interface ViewerCleanupPort {
  close(): Promise<string>;
  status(): Promise<string>;
  exited(owner: OwnerBirth): Promise<string>;
  assertOriginalContainer(): Promise<void>;
  clients(): Promise<string>;
  release(): Promise<string>;
  localExit(): Promise<void>;
}
type Phase =
  | { kind: 'prepared' }
  | { kind: 'starting' }
  | { kind: 'attached' }
  | { kind: 'closing' }
  | { kind: 'held' }
  | { kind: 'closed' };
export class ViewerAttachmentOwner {
  #phase: Phase = { kind: 'prepared' };
  #subject?: ClosedProof;
  #closedProof?: ClosedProof;
  #releaseIssued = false;
  #closing?: Promise<void>;
  #reconciling?: Promise<void>;
  #endpointCleanup: 'confirmed' | 'unconfirmed' = 'unconfirmed';
  readonly #nonce: string;
  readonly #port: ViewerCleanupPort;
  constructor(nonce: string, port: ViewerCleanupPort) {
    if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('Invalid attachment nonce');
    this.#nonce = nonce;
    this.#port = Object.freeze({ ...port });
  }
  get awaitingReady(): boolean {
    return this.#phase.kind === 'starting';
  }
  get acceptsInput(): boolean {
    return this.#phase.kind === 'attached';
  }
  get closed(): boolean {
    return this.#phase.kind === 'closed';
  }
  get endpointCleanup(): 'confirmed' | 'unconfirmed' {
    return this.#endpointCleanup;
  }
  start(dispatch: () => void): void {
    if (this.#phase.kind !== 'prepared') throw new Error('Original attachment was already dispatched');
    this.#phase = { kind: 'starting' };
    dispatch();
  }
  /** Capture constructor identity during stop without admitting input or requiring
   * the attach client to remain present after its original stdin was closed. */
  observeStartup(line: string): void {
    if (!['starting', 'closing', 'held'].includes(this.#phase.kind))
      throw new Error('Original startup is no longer observable');
    const subject = parseReceipt('READY', this.#nonce, line);
    if (this.#subject && !sameProof(this.#subject, subject)) throw new Error('Original attachment changed');
    this.#subject = subject;
  }
  ready(line: string, clients: string): void {
    if (!this.awaitingReady) throw new Error('Attachment was already admitted');
    const subject = parseReceipt('READY', this.#nonce, line);
    if (this.#subject && !sameProof(this.#subject, subject)) throw new Error('Original attachment changed');
    if (!clientPids(clients).includes(subject.pid)) throw new Error('Original native client has not attached');
    this.#subject = subject;
    this.#phase = { kind: 'attached' };
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.#closing) return this.#closing;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    this.#closing = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#phase = { kind: 'closing' };
    void this.#initialClose().then(resolve, reject);
    return this.#closing;
  }
  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.#phase.kind === 'closing') return this.#closing!;
    if (this.#phase.kind !== 'held') return Promise.reject(new Error('No original held cleanup to reconcile'));
    if (this.#reconciling) return this.#reconciling;
    let resolve!: () => void, reject!: (cause: unknown) => void;
    const pending = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.#reconciling = pending;
    const clear = () => {
      if (this.#reconciling === pending) this.#reconciling = undefined;
    };
    void this.#reconcile().then(
      () => {
        clear();
        resolve();
      },
      (cause) => {
        clear();
        reject(cause);
      }
    );
    return pending;
  }
  #acceptClosed(text: string): ClosedProof {
    const proof = parseReceipt('CLOSED', this.#nonce, text);
    if (this.#subject && !sameProof(this.#subject, proof)) throw new Error('Original attachment changed');
    this.#subject ??= proof;
    this.#closedProof = proof;
    return proof;
  }
  async #readback(proof: ClosedProof): Promise<void> {
    // Original native CLOSED proves this attachment, not provider liveness.
    // A changed/dead provider still cannot grant a new attachment or input.
    await this.#port.assertOriginalContainer();
    if (clientPids(await this.#port.clients()).includes(proof.pid))
      throw new Error('Original native client is still present');
  }
  async #finish(proof: ClosedProof): Promise<void> {
    await this.#readback(proof);
    this.#releaseIssued = true;
    const released = parseReceipt('RELEASED', this.#nonce, await this.#port.release());
    if (!sameProof(proof, released)) throw new Error('Original release is unconfirmed');
    await this.#port.localExit();
    this.#endpointCleanup = 'confirmed';
    this.#phase = { kind: 'closed' };
  }
  #hold(cause: unknown): never {
    this.#phase = { kind: 'held' };
    throw new Error(
      'Original viewer cleanup is unconfirmed; no replacement attachment is allowed. Reconcile this original operation.',
      { cause }
    );
  }
  async #initialClose(): Promise<void> {
    try {
      await this.#finish(this.#acceptClosed(await this.#port.close()));
    } catch (cause) {
      this.#hold(cause);
    }
  }
  async #reconcile(): Promise<void> {
    try {
      if (this.#releaseIssued) {
        const proof = this.#closedProof;
        if (!proof) throw new Error('Original actual CLOSED proof is unavailable');
        const exited = await this.#port.exited(proof.owner);
        if (exited !== exitedReceipt(this.#nonce, proof.owner)) throw new Error('Original owner exit is unconfirmed');
        await this.#readback(proof);
        await this.#port.localExit();
        // Original attachment/owner are gone; no filesystem cleanup is inferred
        // from their absence, and no stale nonce artifact is unlinked here.
        this.#phase = { kind: 'closed' };
        return;
      }
      await this.#finish(this.#acceptClosed(await this.#port.status()));
    } catch (cause) {
      this.#hold(cause);
    }
  }
}
/** Historical callbacks may release only their own proven original slot. */
export function settleOriginalOwner(
  owners: Set<ViewerAttachmentOwner>,
  original: ViewerAttachmentOwner,
  occupied: ViewerAttachmentOwner | undefined
): ViewerAttachmentOwner | undefined {
  if (!original.closed) throw new Error('Original attachment settlement is unconfirmed');
  owners.delete(original);
  return occupied === original ? undefined : occupied;
}
function sameProof(a: ClosedProof, b: ClosedProof): boolean {
  return (
    a.pid === b.pid &&
    a.owner.pid === b.owner.pid &&
    a.owner.start === b.owner.start &&
    a.owner.boot === b.owner.boot &&
    a.owner.namespace === b.owner.namespace
  );
}
const KERNEL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const U64_MAX = (1n << 64n) - 1n;
function kernelInteger(word: string): boolean {
  return /^(?:0|[1-9]\d{0,19})$/.test(word) && BigInt(word) <= U64_MAX;
}
export function exitedReceipt(nonce: string, owner: OwnerBirth): string {
  return `EXITED ${nonce} ${owner.pid} ${owner.start} ${owner.boot} ${owner.namespace}\n`;
}
export function parseReceipt(kind: 'READY' | 'CLOSED' | 'RELEASED', nonce: string, text: string): ClosedProof {
  const prefix = `${kind} ${nonce} `;
  if (!text.startsWith(prefix) || !text.endsWith('\n')) throw new Error('Original viewer receipt required');
  const words = text.slice(prefix.length, -1).split(' ');
  if (words.length !== 5 || !words.filter((_, i) => i !== 3).every(kernelInteger) || !KERNEL_UUID.test(words[3]))
    throw new Error('Original kernel birth required');
  const pid = Number(words[0]),
    ownerPid = Number(words[1]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid > 0xffff_ffff ||
    !Number.isSafeInteger(ownerPid) ||
    ownerPid <= 1 ||
    ownerPid > 0xffff_ffff
  )
    throw new Error('Original viewer identity required');
  return Object.freeze({
    pid,
    owner: Object.freeze({ pid: ownerPid, start: words[2], boot: words[3], namespace: words[4] }),
  });
}
export function receipt(kind: 'READY' | 'CLOSED' | 'RELEASED', nonce: string, text: string): number {
  return parseReceipt(kind, nonce, text).pid;
}
export function clientPids(text: string): number[] {
  if (text === '') return [];
  if (!/^(?:[1-9]\d*\n)+$/.test(text)) throw new Error('Client census unconfirmed');
  const pids = text
    .trim()
    .split('\n')
    .map((value) => {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Client identity unconfirmed');
      return pid;
    });
  if (new Set(pids).size !== pids.length) throw new Error('Ambiguous client census');
  return pids;
}
export function writeBounded(input: Writable, bytes: Buffer): boolean {
  if (input.destroyed || !input.writable || input.writableLength + bytes.length > 1024 * 1024)
    throw new Error('Native input backpressure limit');
  return input.write(bytes);
}
