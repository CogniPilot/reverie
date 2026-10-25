/**
 * @fileoverview Install-time seams for service authentication: one tracked deployment file declares the purpose registry,
 * the dedicated service principals (opaque epoch plus a 32-byte host-managed key file each) and the owner setup page rows.
 * Service nonces live in the Goal private bootstrap's projected nonce store under a "service:" namespace. Only an explicit launcher option names the file; absent means no service authenticates. Nothing here issues a
 * grant: grants stay owner-issued canonical records.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { SERVICE_PURPOSE_NAME, type ServicePurposes } from './company-types.js';
import type { GoalNonceKey } from './goal-broker-auth.js';
import type { ServiceIssuer, ServiceNonceKey, ServiceGrantPorts } from './service-grant-auth.js';

const ID = z.string().regex(/^[A-Za-z0-9_.:-]{1,56}$/); // 'service:' + principal must fit the nonce store's 64-char issuer
const EPOCH = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const ACTION = z.string().regex(/^[a-z][a-z0-9.-]{0,95}$/);
const path = z
  .string()
  .refine((value) => isAbsolute(value) && normalize(value) === value && value !== '/' && !/[\0\r\n]/.test(value));

export const ServiceAuthConfigSchema = z
  .object({
    version: z.literal(1),
    /** Installer-selected non-root uid of the website (and the service daemons sharing its keys). Must equal the running
     * website's effective uid; config and keys are then trusted for root and this uid only. */
    serviceUid: z.number().int().min(1).max(4294967294).optional(),
    purposes: z
      .record(
        z.string().regex(SERVICE_PURPOSE_NAME),
        z
          .object({ scope: z.enum(['employees', 'resources', 'employees+resources']), action: ACTION.optional() })
          .strict()
      )
      .refine((value) => Object.keys(value).length <= 64, 'at most 64 purposes'),
    principals: z
      .array(z.object({ principal: ID, epoch: EPOCH, key: path }).strict())
      .max(32)
      .refine((items) => new Set(items.map((p) => p.principal)).size === items.length, 'principals are unique'),
    /** Owner setup page rows: proposed grants the owner issues with one click each. Never issued automatically.
     * employees are exact employee ids or exact unique display names, resolved to current ids when the page renders. */
    setupGrants: z
      .array(
        z
          .object({
            purpose: z.string().regex(SERVICE_PURPOSE_NAME),
            principal: ID,
            employees: z.array(z.string().min(1).max(100)).max(256).default([]),
            resources: z
              .array(z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/))
              .max(256)
              .default([]),
            expiresInHours: z.number().int().min(1).max(2160),
          })
          .strict()
      )
      .max(32)
      .default([]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const actions = Object.values(config.purposes).flatMap((p) => (p.action ? [p.action] : []));
    if (new Set(actions).size !== actions.length)
      ctx.addIssue({ code: 'custom', message: 'actions map to one purpose' });
  });
export type ServiceAuthConfig = z.infer<typeof ServiceAuthConfigSchema>;

export interface LoadedServiceAuth {
  readonly config: Readonly<ServiceAuthConfig>;
  /** sha256 of the exact loaded bytes, for receipts and status. */
  readonly digest: string;
  readonly purposes: ServicePurposes;
  /** Owners trusted for keys: root, plus serviceUid when declared and equal to this process's uid. */
  readonly trustedUids: readonly number[];
  /** Exact configured action name (e.g. reverie.ops.website.restart) to its purpose, or undefined. */
  purposeFor(action: string): string | undefined;
}
export interface TrustOptions {
  /** Owners trusted for the config and key files; root only by default. */
  readonly trustedUids?: readonly number[];
}

/** Regular, not a symlink, trusted owner, no group/other write (keys: no group/other access at all). */
function readTrusted(
  file: string,
  limit: number,
  secret: boolean,
  options: TrustOptions,
  owner?: { uid: number }
): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    const uids = options.trustedUids ?? [0];
    if (!info.isFile() || !uids.includes(info.uid) || info.mode & (secret ? 0o077 : 0o022) || info.size > limit)
      throw new Error('untrusted service authentication file');
    if (owner) owner.uid = info.uid;
    const data = Buffer.alloc(info.size);
    if (fs.readSync(fd, data, 0, info.size, 0) !== info.size) throw new Error('short read');
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

export function loadServiceAuthConfig(file: string, options: TrustOptions = {}): LoadedServiceAuth {
  if (!path.safeParse(file).success) throw new Error('service authentication config path must be absolute');
  const self = process.geteuid?.() ?? -1;
  const initial = options.trustedUids ?? [0, self];
  const owner = { uid: -1 };
  const bytes = readTrusted(file, 64 * 1024, false, { trustedUids: initial }, owner);
  if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('service authentication config is not UTF-8');
  const config = ServiceAuthConfigSchema.parse(JSON.parse(bytes.toString('utf8')));
  // The declared service uid must be the uid actually running; the file itself must belong to root or that uid.
  if (config.serviceUid !== undefined && config.serviceUid !== self && !options.trustedUids)
    throw new Error('serviceUid does not match the running website uid');
  const trustedUids = options.trustedUids ?? (config.serviceUid === undefined ? [0] : [0, config.serviceUid]);
  if (!trustedUids.includes(owner.uid)) throw new Error('service authentication config owner is not trusted');
  const purposes: Record<string, ServicePurposes[string]> = Object.create(null);
  const actions = new Map<string, string>();
  for (const [name, entry] of Object.entries(config.purposes)) {
    purposes[name] = entry.scope;
    if (entry.action) actions.set(entry.action, name);
  }
  return Object.freeze({
    config: Object.freeze(config),
    digest: createHash('sha256').update(bytes).digest('hex'),
    purposes: Object.freeze(purposes),
    trustedUids: Object.freeze([...trustedUids]),
    purposeFor: (action: string) => actions.get(action),
  });
}

/** ServiceGrantPorts.issuer from the configured principals. The key file is re-read and re-checked on every call, so a
 * removed, replaced or loosened key revokes at once; rotation is a new epoch and key file in the config. */
export function serviceIssuers(loaded: LoadedServiceAuth, options: TrustOptions = {}): ServiceGrantPorts['issuer'] {
  return (principal: string): ServiceIssuer | undefined => {
    try {
      const entry = loaded.config.principals.find((p) => p.principal === principal);
      if (!entry) return undefined;
      const key = readTrusted(entry.key, 32, true, { trustedUids: options.trustedUids ?? loaded.trustedUids });
      return key.length === 32 ? Object.freeze({ epoch: entry.epoch, key }) : undefined;
    } catch {
      return undefined;
    }
  };
}

/** Durable nonce port over the Goal private bootstrap's projected nonce store; service principals occupy their own
 * 'service:' issuer namespace, so they can never collide with Goal broker nonces. */
export function serviceNonces(store: {
  claim(key: GoalNonceKey): Promise<object | undefined>;
  assertCurrent(claim: object, key: GoalNonceKey): void;
}): ServiceGrantPorts['nonces'] {
  const map = (key: ServiceNonceKey): GoalNonceKey => ({
    issuer: 'service:' + key.principal,
    epoch: key.epoch,
    nonce: key.nonce,
    expiresAt: key.expiresAt,
  });
  return {
    claim: (key) => store.claim(map(key)),
    assertCurrent: (claim, key) => store.assertCurrent(claim, map(key)),
  };
}
