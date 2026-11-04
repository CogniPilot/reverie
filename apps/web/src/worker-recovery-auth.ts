/** @fileoverview Purpose-specific native recovery proofs. Parent headers and role titles are never authority. */
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GoalNonceStore } from './goal-nonce-store.js';
import type { CompanyEmployee } from './company-types.js';

export const RECOVERY_HEADER = 'x-reverie-recovery-assertion';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_BODY = 64 * 1024;
const MAX_NONCES = 1024 + 4096 * 256;
const MAX_OPERATION_MS = 5 * 60_000;
const exact = (re: RegExp, value: unknown): value is string =>
  typeof value === 'string' && !/[\r\n]/.test(value) && re.test(value);
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function recoveryRequestTarget(method: string, target: string): boolean {
  return (
    method === 'POST' &&
    (target === '/api/plans/moves/force' ||
      /^\/api\/plans\/moves\/[A-Za-z0-9_-]{1,100}\/(?:status|resolve|cancel)$/.test(target) ||
      new RegExp('^/api/company/employees/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/reconnect(?:/status)?$').test(
        target
      )) &&
    !/[\r\n]/.test(target)
  );
}

/** Long operations may consume their authenticated request once. Their existing
 * typed runtime transaction remains responsible for permitted SID transitions. */
export interface RecoveryAuthority {
  readonly employeeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly owner: string | undefined;
  assertIssued(): void;
  assertCurrent(): void;
}

function privateFile(file: string, maximum = MAX_BODY): { bytes: Buffer; identity: string } {
  if (resolve(file) !== file || fs.realpathSync(file) !== file) throw Error('Recovery authentication unavailable');
  for (let parent = dirname(file); ; parent = dirname(parent)) {
    const entry = fs.lstatSync(parent);
    if (
      !entry.isDirectory() ||
      ![0, process.getuid!()].includes(entry.uid) ||
      (entry.mode & 0o022 && !(entry.uid === 0 && entry.mode & 0o1000))
    )
      throw Error('Recovery custody unavailable');
    if (parent === '/') break;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const entry = fs.fstatSync(fd);
    if (
      !entry.isFile() ||
      entry.uid !== process.getuid!() ||
      (entry.mode & 0o777) !== 0o600 ||
      entry.nlink !== 1 ||
      entry.size > maximum
    )
      throw Error('Recovery custody unavailable');
    const bytes = fs.readFileSync(fd),
      after = fs.fstatSync(fd);
    const identity = [entry.dev, entry.ino, entry.ctimeMs, entry.mtimeMs, entry.size, sha(bytes)].join(':');
    const named = fs.lstatSync(file);
    if (
      named.dev !== entry.dev ||
      named.ino !== entry.ino ||
      named.isSymbolicLink() ||
      entry.ctimeMs !== after.ctimeMs ||
      entry.mtimeMs !== after.mtimeMs ||
      entry.size !== after.size
    )
      throw Error('Recovery custody changed');
    return { bytes, identity };
  } finally {
    fs.closeSync(fd);
  }
}

/** Fixed instance path, never request/env key material. Provisioning is an explicit
 * owner host action; absence or damaged/partial state denies delegated recovery. */
export class WorkerRecoveryAuthentication {
  private readonly bodies = new WeakMap<FastifyRequest, Buffer>();
  private readonly principals = new WeakMap<FastifyRequest, Promise<RecoveryAuthority>>();
  constructor(
    private readonly directory: string,
    private readonly employees: () => readonly CompanyEmployee[],
    private readonly flockExecutable = '/bin/flock',
    private readonly now: () => number = Date.now
  ) {}

  register(app: FastifyInstance): void {
    app.addHook('preParsing', async (request, _reply, payload) => {
      if (request.headers[RECOVERY_HEADER] === undefined) return payload;
      if (!recoveryRequestTarget(request.method, request.url))
        throw Object.assign(Error('Recovery proof target refused'), { statusCode: 403 });
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of payload) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_BODY) throw Object.assign(Error('Recovery proof body refused'), { statusCode: 403 });
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      this.bodies.set(request, body);
      return Readable.from(body);
    });
  }

  authenticate(request: FastifyRequest): Promise<RecoveryAuthority> {
    const prior = this.principals.get(request);
    if (prior) return prior;
    const flight = this.verify(request);
    this.principals.set(request, flight);
    return flight;
  }

  private async verify(request: FastifyRequest): Promise<RecoveryAuthority> {
    const header = request.headers[RECOVERY_HEADER],
      body = this.bodies.get(request);
    if (
      request.headers['x-reverie-service-token'] !== undefined ||
      request.cookies?.reverie_owner !== undefined ||
      !recoveryRequestTarget(request.method, request.url) ||
      typeof header !== 'string' ||
      header.length > 2048 ||
      !body
    )
      throw Error('Recovery proof refused');
    const configFile = join(this.directory, 'worker-recovery-auth.json');
    const first = privateFile(configFile),
      config = JSON.parse(first.bytes.toString());
    if (
      Object.keys(config).sort().join(',') !== 'epoch,issuer,key,storeId,version' ||
      config.version !== 1 ||
      ![config.issuer, config.epoch].every((value) => exact(ID, value)) ||
      !exact(UUID, config.storeId) ||
      !exact(HEX, config.key)
    )
      throw Error('Recovery configuration refused');
    const [encoded, signature, extra] = header.split('.');
    if (extra !== undefined || !exact(/^[A-Za-z0-9_-]+$/, encoded) || !exact(HEX, signature))
      throw Error('Recovery proof refused');
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw Error('Recovery proof refused');
    const fields: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !Array.isArray(fields) ||
      fields.length !== 12 ||
      fields[0] !== 1 ||
      fields[1] !== 'worker-recovery-request' ||
      fields[2] !== config.issuer ||
      fields[3] !== config.epoch ||
      !exact(UUID, fields[4]) ||
      !integer(fields[5]) ||
      fields[5] < 1 ||
      fields[6] !== request.method ||
      fields[7] !== request.url ||
      fields[8] !== sha(body) ||
      !integer(fields[9]) ||
      !integer(fields[10]) ||
      fields[10] <= fields[9] ||
      fields[10] - fields[9] > 10_000 ||
      !exact(/^[0-9a-f]{32}$/, fields[11])
    )
      throw Error('Recovery proof refused');
    const expected = createHmac('sha256', Buffer.from(config.key, 'hex'))
      .update('reverie-worker-recovery-request-v1\n' + encoded)
      .digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw Error('Recovery proof refused');
    const accepted = this.now();
    if (!integer(accepted) || fields[9] > accepted || fields[10] <= accepted) throw Error('Recovery proof expired');
    const caller = this.employees().find((e) => e.sessionId === fields[4] && e.sessionGeneration === fields[5]);
    if (!caller || caller.bindingMigration || caller.onVacation || caller.desiredRunning !== true)
      throw Error('Recovery caller unavailable');
    const identity = Object.freeze({
      employeeId: caller.id,
      sessionId: caller.sessionId,
      sessionGeneration: caller.sessionGeneration,
      owner: caller.owner,
    });
    const custody = () => {
      if (privateFile(configFile).identity !== first.identity) throw Error('Recovery issuer changed');
    };
    const nonces = new GoalNonceStore({
      file: join(this.directory, 'recovery-nonces.json'),
      storeId: config.storeId,
      capacity: 4096,
      maxLifetimeMs: MAX_OPERATION_MS,
      flockExecutable: this.flockExecutable,
      authorityNamespace: configFile,
      now: this.now,
      assertPrivateCustody: (scope) => {
        custody();
        if (
          scope.root !== this.directory ||
          scope.parent !== dirname(this.directory) ||
          scope.file !== join(this.directory, 'recovery-nonces.json') ||
          scope.authorityNamespace !== configFile ||
          scope.lock !== scope.file + '.lock' ||
          scope.temporary !== scope.file + '.pending'
        )
          throw Error('Recovery nonce namespace refused');
        privateFile(scope.file, MAX_NONCES);
        privateFile(scope.lock, 0);
        try {
          privateFile(scope.temporary, MAX_NONCES);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      },
    });
    const nonce = {
      issuer: config.issuer,
      epoch: config.epoch,
      nonce: fields[11],
      expiresAt: accepted + MAX_OPERATION_MS,
    };
    const claim = await nonces.claim(nonce);
    if (!claim) throw Error('Recovery proof was already consumed');
    const principal: RecoveryAuthority = {
      ...identity,
      assertIssued: () => {
        custody();
        nonces.assertCurrent(claim, nonce);
      },
      assertCurrent: () => {
        principal.assertIssued();
        const current = this.employees().find((e) => e.id === identity.employeeId);
        if (
          !current ||
          current.owner !== identity.owner ||
          current.sessionId !== identity.sessionId ||
          current.sessionGeneration !== identity.sessionGeneration ||
          current.bindingMigration ||
          current.onVacation ||
          current.desiredRunning !== true
        )
          throw Error('Recovery caller changed');
      },
    };
    principal.assertCurrent();
    return Object.freeze(principal);
  }
}
