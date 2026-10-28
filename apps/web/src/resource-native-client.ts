/** Fixed resource-purpose transport over the existing website-only broker UDS.
 * No wire value creates an OwnerAuth context or a native claim/launch permit.
 * Importing this module does not connect, provision or register an endpoint.
 */
import {Socket} from 'node:net';
import {lstat} from 'node:fs/promises';
import {isAbsolute, normalize} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {Session} from './session.js';
import type {PlanMoveRecord} from './plan-move.js';
import {ResourceWorkerLaunch} from './resource-worker-launch.js';
import {ResourceSessionReadiness} from './resource-readiness.js';
import {ResourceOwnerAuthority, assertResourceOperation, type ResourceApproval,
  type ResourceOwnerBinding, type ResourceOwnerContext, type ResourcePreviewContext} from './resource-owner-authority.js';

const MAX_FRAME = 64 * 1024;
const UUID = z.string().uuid().refine(value => value.toLowerCase() === value);
const Approval = z.object({employeeId: UUID, draftId: UUID, operationId: UUID, reservationId: UUID,
  targetSid: UUID, profileVersion: z.string().regex(/^[1-9][0-9]{0,15}$/),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/), previewDigest: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const Check = z.object({kind: z.literal('resource-owner-check'), requestId: UUID, nonce: UUID,
  stage: z.enum(['preview', 'apply']), employeeId: UUID, approval: Approval.nullable()}).strict();
const Reply = z.object({kind: z.literal('resource-result'), requestId: UUID,
  value: z.unknown()}).strict();
const Refusal = z.object({kind: z.literal('resource-refused'), requestId: UUID,
  reason: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)}).strict();
const Launch = z.object({kind: z.literal('resource-launch-ready'), requestId: UUID, reference: UUID}).strict();
const Command = z.object({kind: z.literal('resource-command-check'), requestId: UUID, nonce: UUID,
  sessionId: UUID, cwd: z.string().min(1).max(16384), commandDigest: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const Readiness = z.object({kind: z.literal('resource-readiness-check'), requestId: UUID, nonce: UUID,
  stage: z.enum(['verify', 'finalize']), sessionId: UUID, operationId: UUID,
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const registered = new WeakSet<object>();
const settlements = new WeakSet<object>();
const Completion = z.object({state: z.literal('HISTORICAL_NATIVE_SETTLEMENT_CONFIRMED'), operationId: UUID,
  reservationId: UUID, employeeId: UUID, targetSid: UUID, profileVersion: z.string().regex(/^[1-9][0-9]{0,15}$/),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/), previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  settlementDigest: z.string().regex(/^[a-f0-9]{64}$/), currentBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  readOnly: z.literal(true)}).strict();

/** A fresh read-only host result, never a permit or serialized authority.
 * Reinspection after the metadata save catches observed drift during storage.
 * It cannot make external writes after the final observations atomic.
 */
export class ResourceHistoricalSettlement {
  readonly #client: ResourceNativeClient;
  readonly #record: Readonly<PlanMoveRecord>;
  readonly #facts: z.infer<typeof Completion>;
  readonly #current: () => void;
  constructor(token: symbol, client: ResourceNativeClient, record: Readonly<PlanMoveRecord>,
    facts: z.infer<typeof Completion>, current: () => void) {
    need(token === MINT && registered.has(client));
    this.#client = client; this.#record = structuredClone(record); this.#facts = facts; this.#current = current;
    settlements.add(this); this.assertRecord(record); Object.freeze(this);
  }
  assertRecord(record: Readonly<PlanMoveRecord>): void {
    need(settlements.has(this)); this.#current();
    for (const field of ['id','owner','employeeId','oldSession','newSession','fromAccount','toAccount','purpose',
      'runtimeDigest','requestDigest','resourceIntent','resourceOwnerScope','sourceStopRequested','sourceCleanupVerified'] as const)
      need(isDeepStrictEqual(record[field], this.#record[field]));
    const intent = record.resourceIntent, facts = this.#facts;
    need(intent && ['completed','recovery-required'].includes(record.phase) && record.resourcePhase === 'verified' &&
      record.sourceStopRequested === true && record.sourceCleanupVerified === true && record.purpose === 'runtime-refresh' &&
      record.id === facts.operationId && intent.operationId === facts.operationId &&
      record.employeeId === facts.employeeId && record.newSession === facts.targetSid &&
      intent.reservationId === facts.reservationId && intent.profileVersion === facts.profileVersion &&
      intent.profileDigest === facts.profileDigest && intent.previewDigest === facts.previewDigest);
  }
  async recheck(record: Readonly<PlanMoveRecord>): Promise<void> {
    this.assertRecord(record);
    const facts = Completion.parse(await this.#client.request('completion', {
      employeeId: record.employeeId, operationId: record.id}));
    need(isDeepStrictEqual(facts, this.#facts)); this.assertRecord(record);
  }
}
function need(value: unknown): asserts value {
  if (!value) throw new Error('Protected resource broker channel is unavailable or changed');
}
function canonical(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}
function encode(value: unknown): Buffer {
  const raw = Buffer.from(canonical(value)); need(raw.length > 0 && raw.length <= MAX_FRAME);
  const header = Buffer.alloc(4); header.writeUInt32BE(raw.length); return Buffer.concat([header, raw]);
}

/** Only normal Session objects and their registered private launch joins can
 * react to this event. A callback, caller JSON, or another target cannot start.
 */
export class ResourceSessionLaunchTask {
  readonly #session: Session;
  readonly #launch: ResourceWorkerLaunch;
  readonly #binding: ResourceOwnerBinding;
  readonly #record: Readonly<PlanMoveRecord>;
  readonly #reference: string;
  readonly #readiness?: ResourceSessionReadiness;
  #started?: Promise<void>;
  #attempted = false;
  constructor(session: Session, launch: ResourceWorkerLaunch, binding: ResourceOwnerBinding,
    record: Readonly<PlanMoveRecord>, reference: string, readiness?: ResourceSessionReadiness) {
    need(session instanceof Session && launch instanceof ResourceWorkerLaunch && session.id === record.newSession &&
      session.owner === record.owner && !session.pid && !session.muxName);
    assertResourceOperation(binding, record.owner, record); UUID.parse(reference);
    this.#session = session; this.#launch = launch; this.#binding = binding;
    this.#record = Object.freeze({...record, resourceIntent: Object.freeze({...record.resourceIntent!})});
    this.#reference = reference; this.#readiness = readiness; Object.freeze(this);
  }
  begin(reference: string): void {
    need(!this.#attempted && reference === this.#reference); this.#attempted = true;
    assertResourceOperation(this.#binding, this.#record.owner, this.#record);
    this.#launch.arm(reference);
    this.#started = this.#session.startInteractive().then(async () => {
      assertResourceOperation(this.#binding, this.#record.owner, this.#record);
      if (this.#readiness) await this.#readiness.waitUntilReady();
    });
    // Observe errors immediately while the native result is still outstanding.
    // wait() returns the original rejection, never a successful substitute.
    void this.#started.catch(() => undefined);
  }
  async wait(): Promise<void> {need(this.#started); await this.#started;}
  assertCommand(digest: string, sessionId: string, cwd: string): void {
    need(this.#attempted); assertResourceOperation(this.#binding, this.#record.owner, this.#record);
    this.#launch.assertCommand(digest, sessionId, cwd);
  }
}

interface Pending {
  readonly id: string;
  readonly deadline: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly launch?: ResourceSessionLaunchTask;
  readonly readiness?: ResourceSessionReadiness;
  readonly challenges: Set<string>;
  resultSeen: boolean;
}

/** Current-cookie proof is evaluated by the real authority for every native
 * challenge. This class has no owner-shaped JSON fallback or automatic retry.
 * Host-side exact website program/custody admission remains independently
 * mandatory; a socket path or this class is not a native execution grant.
 */
export class ResourceNativeClient {
  readonly #socket: Socket;
  readonly #authority: ResourceOwnerAuthority;
  readonly #context: ResourceOwnerContext | ResourcePreviewContext;
  readonly #untrack: () => void;
  #buffer = Buffer.alloc(0);
  #ready = false;
  #closed = false;
  #pending?: Pending;
  constructor(token: symbol, socket: Socket, authority: ResourceOwnerAuthority,
    context: ResourceOwnerContext | ResourcePreviewContext) {
    need(token === MINT && socket instanceof Socket && authority instanceof ResourceOwnerAuthority);
    authority.assertContext(context);
    this.#socket = socket; this.#authority = authority; this.#context = context;
    this.#untrack = authority.track(context, socket); registered.add(this);
    socket.on('data', chunk => {try {this.#data(chunk);} catch (error) {this.close(error as Error);}});
    socket.on('error', () => this.close()); socket.on('close', () => this.close());
  }
  static async open(path: string, authority: ResourceOwnerAuthority,
    context: ResourceOwnerContext | ResourcePreviewContext): Promise<ResourceNativeClient> {
    authority.assertContext(context);
    need(isAbsolute(path) && normalize(path) === path && !/[\0\r\n]/.test(path) && process.getuid);
    const before = await lstat(path, {bigint: true});
    need(before.isSocket() && before.uid === BigInt(process.getuid()) && (before.mode & 0o077n) === 0n);
    authority.assertContext(context);
    const socket = new Socket(), client = new ResourceNativeClient(MINT, socket, authority, context);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {socket.destroy(); reject(new Error('Protected resource connection expired'));}, 3000);
        socket.once('connect', () => {clearTimeout(timer); resolve();});
        socket.once('error', error => {clearTimeout(timer); reject(error);}); socket.connect(path);
      });
      const after = await lstat(path, {bigint: true});
      need(before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.uid === after.uid);
      authority.assertContext(context);
      // First-frame purpose has no owner/session values or generic operation.
      const raw = Buffer.from('{"purpose":"resource-replacement-v1","version":1}');
      const header = Buffer.alloc(5); header[0] = 'Q'.charCodeAt(0); header.writeUInt32BE(raw.length, 1);
      socket.write(Buffer.concat([header, raw])); return client;
    } catch (error) {client.close(); throw error;}
  }
  close(error = new Error('Protected resource outcome is unavailable; inspect the retained operation')): void {
    if (this.#closed) return; this.#closed = true;
    const pending = this.#pending; this.#pending = undefined;
    if (pending) {clearTimeout(pending.timer); pending.reject(error);}
    this.#untrack(); this.#socket.destroy();
  }
  #write(value: unknown): void {
    need(!this.#closed && !this.#socket.destroyed); this.#authority.assertContext(this.#context);
    this.#socket.write(encode(value));
  }
  #data(chunk: Buffer): void {
    need(!this.#closed && chunk.length + this.#buffer.length <= MAX_FRAME + 10);
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (!this.#ready) {
      const greeting = Buffer.from('RESOURCE_READY\n');
      need(this.#buffer.subarray(0, Math.min(greeting.length, this.#buffer.length))
        .equals(greeting.subarray(0, Math.min(greeting.length, this.#buffer.length))));
      if (this.#buffer.length < greeting.length) return;
      this.#buffer = this.#buffer.subarray(greeting.length); this.#ready = true;
      if (this.#pending) this.#flushRequest();
    }
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32BE(0); need(size > 0 && size <= MAX_FRAME);
      if (this.#buffer.length < size + 4) return;
      const raw = this.#buffer.subarray(4, size + 4); this.#buffer = this.#buffer.subarray(size + 4);
      const text = new TextDecoder('utf-8', {fatal: true}).decode(raw), value: unknown = JSON.parse(text);
      // Reject duplicate-key/noncanonical frames before interpreting any proof.
      need(canonical(value) === text); this.#message(value);
    }
  }
  #request?: Readonly<Record<string, unknown>>;
  #flushRequest(): void {need(this.#pending && this.#request); this.#write(this.#request); this.#request = undefined;}
  #message(value: unknown): void {
    const pending = this.#pending; need(pending && performance.now() < pending.deadline && !pending.resultSeen);
    this.#authority.assertContext(this.#context);
    if (Check.safeParse(value).success) {
      const check = Check.parse(value); need(check.requestId === pending.id && !pending.challenges.has(check.nonce) &&
        pending.challenges.size < 256 && check.stage === this.#context.stage);
      pending.challenges.add(check.nonce);
      const approval: Readonly<ResourceApproval> | null = this.#context.stage === 'apply' ? this.#context.approval : null;
      need(check.employeeId === (approval?.employeeId ?? (this.#context as ResourcePreviewContext).employeeId) &&
        isDeepStrictEqual(check.approval, approval));
      this.#write({kind: 'resource-owner-current', requestId: pending.id, nonce: check.nonce,
        purpose: this.#context.purpose, stage: this.#context.stage, owner: this.#context.owner ?? null,
        ownerScopeDigest: this.#context.ownerScopeDigest, expiresAtEpochMs: this.#context.expiresAtEpochMs, approval});
    } else if (Readiness.safeParse(value).success) {
      const check = Readiness.parse(value);
      need(check.requestId === pending.id && pending.readiness && this.#context.stage === 'apply' &&
        check.operationId === this.#context.approval.operationId &&
        check.profileDigest === this.#context.approval.profileDigest && check.sessionId === this.#context.approval.targetSid &&
        !pending.challenges.has(check.nonce) && pending.challenges.size < 256);
      pending.challenges.add(check.nonce);
      void pending.readiness.proof(check.stage).then(proof => {
        need(this.#pending === pending && !this.#closed && performance.now() < pending.deadline);
        this.#write({kind: 'resource-readiness-current', requestId: pending.id, nonce: check.nonce,
          stage: check.stage, proof});
      }).catch(error => this.close(error as Error));
    } else if (Command.safeParse(value).success) {
      const command = Command.parse(value);
      need(command.requestId === pending.id && pending.launch && !pending.challenges.has(command.nonce) &&
        pending.challenges.size < 256);
      pending.challenges.add(command.nonce);
      pending.launch.assertCommand(command.commandDigest, command.sessionId, command.cwd);
      this.#write({kind: 'resource-command-current', requestId: pending.id,
        nonce: command.nonce, commandDigest: command.commandDigest});
    } else if (Launch.safeParse(value).success) {
      const launch = Launch.parse(value); need(launch.requestId === pending.id && pending.launch);
      pending.launch.begin(launch.reference);
    } else if (Refusal.safeParse(value).success) {
      const refused = Refusal.parse(value); need(refused.requestId === pending.id);
      this.close(new Error('Protected resource operation refused: ' + refused.reason));
    } else {
      const reply = Reply.parse(value); need(reply.requestId === pending.id); pending.resultSeen = true;
      void (async () => {
        try {
          if (pending.launch) await pending.launch.wait();
          need(this.#pending === pending && !this.#closed && performance.now() < pending.deadline);
          this.#authority.assertContext(this.#context); clearTimeout(pending.timer); this.#pending = undefined;
          pending.resolve(reply.value);
        } catch (error) {this.close(error as Error);}
      })();
    }
  }
  /** Closed native verbs only; caller references remain non-authorizing. */
  async historicalCompletion(record: Readonly<PlanMoveRecord>): Promise<ResourceHistoricalSettlement> {
    need(registered.has(this) && this.#context.stage === 'preview' &&
      this.#context.employeeId === record.employeeId && this.#context.owner === record.owner);
    const facts = Completion.parse(await this.request('completion', {employeeId: record.employeeId, operationId: record.id}));
    this.#authority.assertContext(this.#context);
    return new ResourceHistoricalSettlement(MINT, this, record, facts, () => {
      need(!this.#closed); this.#authority.assertContext(this.#context);
    });
  }
  async request(verb: 'draft' | 'claim' | 'publication' | 'prepare' | 'source-stop' | 'start' | 'verify' | 'finalize' | 'completion',
    fields: Readonly<Record<string, unknown>>, launch?: ResourceSessionLaunchTask,
    readiness?: ResourceSessionReadiness): Promise<unknown> {
    need(registered.has(this) && !this.#closed && !this.#pending && !this.#request);
    this.#authority.assertContext(this.#context);
    need(['draft','claim','publication','prepare','source-stop','start','verify','finalize','completion'].includes(verb) &&
      this.#context.stage === (verb === 'draft' || verb === 'completion' ? 'preview' : 'apply') &&
      Object.keys(fields).every(key => !['kind', 'requestId', 'verb'].includes(key)) &&
      (verb === 'start' ? launch instanceof ResourceSessionLaunchTask : launch === undefined) &&
      (['verify','finalize'].includes(verb) ? readiness instanceof ResourceSessionReadiness : readiness === undefined));
    const id = randomUUID(), remaining = Math.min(180_000, this.#context.expiresAtEpochMs - Date.now());
    need(remaining > 0);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(new Error('Protected resource outcome expired; do not retry')), remaining);
      this.#pending = {id, resolve, reject, timer, deadline: performance.now() + remaining,
        challenges: new Set(), resultSeen: false, ...(launch ? {launch} : {})};
      if (readiness) this.#pending = {...this.#pending, readiness};
      this.#request = Object.freeze({kind: 'resource-operation', requestId: id, verb, ...fields});
      try {if (this.#ready) this.#flushRequest();}
      catch (error) {this.close(error as Error);}
    });
  }
}
const MINT = Symbol('resource-native-client');
