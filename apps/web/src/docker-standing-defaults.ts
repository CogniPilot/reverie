/**
 * @fileoverview The owner's standing defaults for a laptop (company setting `supervisorStandingDefaults`), pure.
 *
 * Two things about a laptop are approved by the owner for each employee: its resource limits (the docker-policy
 * route) and its layout (the template of a rebuild or reprovision request). An employee who has neither waited for
 * the owner. The standing default is what the owner already approved for the OTHER employees of the same company,
 * reduced so that nobody is given more than every one of them has:
 *
 * - limits: every one of them must be in the same shared pool, with the same pool limits; the employee's own
 *   limits are the smallest of each value and the processors all of them may use. A soft memory limit is never
 *   given above the hard limit it stands beside;
 * - layout: an employee's own last laptop is read first (`layoutFor`). Only what it cannot say is taken from the
 *   others: every one of them must run as the same user and keep scratch space under the same root, and the
 *   drives are the ones all of their laptops have, read-only.
 *
 * Nothing here is a number or a path the owner did not approve for a laptop of this office. Where the others
 * disagree on what cannot be reduced (the pool, the user, the scratch root), or no other employee has anything
 * approved, there is no default and the answer is `undefined`. What belongs to one employee alone (the choice
 * among several office networks, a sign-in folder outside the home) is never copied.
 */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { DockerLaptopTemplate, REPROVISION_ACCOUNT_ROOT } from './docker-absent-reprovision-data.js';
import { DockerEmployeeResourcePolicy } from './docker-employee-continuation-data.js';

/** The most restrictive resource limits among those approved for the other employees. */
export function standingLimits(
  approved: readonly DockerEmployeeResourcePolicy[]
): DockerEmployeeResourcePolicy | undefined {
  const first = approved[0];
  if (!first || approved.some((policy) => !isDeepStrictEqual(policy.pool, first.pool))) return undefined;
  const least = (read: (policy: DockerEmployeeResourcePolicy) => number) => Math.min(...approved.map(read));
  const soft = approved.flatMap((policy) => (policy.memoryHighBytes === null ? [] : [policy.memoryHighBytes]));
  const memoryMaxBytes = least((policy) => policy.memoryMaxBytes);
  const parsed = DockerEmployeeResourcePolicy.safeParse({
    memoryMaxBytes,
    // The smallest soft limit any of them has, and never above the hard limit it is given beside.
    memoryHighBytes: soft.length ? Math.min(...soft, memoryMaxBytes) : null,
    swapMaxBytes: least((policy) => policy.swapMaxBytes),
    pidsMax: least((policy) => policy.pidsMax),
    cpuWeight: least((policy) => policy.cpuWeight),
    allowedCpus: first.allowedCpus.filter((cpu) => approved.every((policy) => policy.allowedCpus.includes(cpu))),
    pool: structuredClone(first.pool),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the other laptops share: their user, their scratch root and the drives every one of them has. The drives are
 * given read-only. Nobody is given a drive to write on because other employees may write on it: that is the owner's
 * choice for each of them. It serves only where the employee's own last laptop cannot say (`layoutFor`).
 */
export function standingLayout(layouts: readonly DockerLaptopTemplate[]): DockerLaptopTemplate | undefined {
  const first = layouts[0];
  if (!first || layouts.some((layout) => layout.user !== first.user || layout.scratchRoot !== first.scratchRoot))
    return undefined;
  const same = (mount: DockerLaptopTemplate['mounts'][number], layout: DockerLaptopTemplate) =>
    layout.mounts.find((other) => other.source === mount.source && other.destination === mount.destination);
  const mounts = first.mounts
    .filter((mount) => layouts.every((layout) => same(mount, layout)))
    .map((mount) => ({ ...mount, readOnly: true }));
  const alias =
    layouts.every((layout) => layout.workspaceAlias === true) &&
    mounts.some((mount) => mount.destination === '/reverie_workspace');
  const parsed = DockerLaptopTemplate.safeParse({
    user: first.user,
    scratchRoot: first.scratchRoot,
    mounts,
    ...(alias ? { workspaceAlias: true } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

/** An employee's own laptop as the Engine describes its container: what a layout can be read from. */
export interface OwnLaptop {
  readonly user: string;
  readonly mounts: readonly { readonly source: string; readonly destination: string; readonly readOnly: boolean }[];
  readonly networks: readonly string[];
}

const Inspected = z.object({
  Config: z.object({ User: z.string().min(1).max(64) }),
  Mounts: z
    .array(
      z.object({
        Type: z.string(),
        Source: z.string().max(4096),
        Destination: z.string().max(4096),
        RW: z.boolean(),
      })
    )
    .max(128),
  NetworkSettings: z.object({ Networks: z.record(z.string().max(255), z.unknown()) }),
});

/** One row of `container inspect`, reduced to that. Undefined for anything that is not such a row. */
export function ownLaptop(inspected: unknown): OwnLaptop | undefined {
  const parsed = Inspected.safeParse(inspected);
  if (!parsed.success) return undefined;
  return {
    user: parsed.data.Config.User,
    mounts: parsed.data.Mounts.filter((mount) => mount.Type === 'bind').map((mount) => ({
      source: mount.Source,
      destination: mount.Destination,
      readOnly: !mount.RW,
    })),
    networks: Object.keys(parsed.data.NetworkSettings.Networks),
  };
}

const SCRATCH = '/scratch';
const OFFICE_NETWORK = /^reverie-boxed-api-[a-z0-9-]{1,64}$/;

/** A mount of a laptop that a layout may name: a shared drive, a project or one of the operator's read-only ones. */
function layoutMount(mount: OwnLaptop['mounts'][number]): boolean {
  return DockerLaptopTemplate.safeParse({ user: '1000:1000', scratchRoot: '/laptops', mounts: [mount] }).success;
}

/**
 * The layout for an employee who has none on record.
 *
 * It is read from the employee's OWN last laptop wherever that can be read: the user it ran as, the drives it had
 * and whether it could write on them, the office network it was on, and the folder of its plan sign-in when that is
 * kept outside its home. A laptop built from that has what the last one had and nothing more.
 *
 * What the other laptops share (`standingLayout`) fills in only what the own laptop cannot say: where scratch
 * space is kept, for a laptop from before that layout, and everything for an employee whose laptop is gone, with
 * the drives read-only. The network and the sign-in folder are never taken from another employee. An employee whose
 * plan needs a sign-in folder, and whose laptop cannot be read, gets no layout: a laptop built without the folder
 * would stop at the sign-in screen, twice a day. `missing` says what could not be told.
 */
export function layoutFor(input: {
  readonly employeeId: string;
  /** The host directory of the employee's home, from their laptop record. */
  readonly home?: string;
  /** The subscription plan the employee is on, when it is one. */
  readonly seatProfile?: string;
  readonly own?: OwnLaptop;
  readonly others: readonly DockerLaptopTemplate[];
}): { readonly layout: DockerLaptopTemplate } | { readonly missing: string } {
  const { own, seatProfile } = input,
    shared = standingLayout(input.others);
  if (!own) {
    if (!shared)
      return {
        missing:
          'no laptop layout is on record for any laptop of this office, and this employee has no laptop to read one from',
      };
    if (seatProfile)
      return {
        missing:
          "the folder of this employee's plan sign-in cannot be told: their last laptop could not be read, and a " +
          'laptop built without it would stop at the sign-in screen',
      };
    return { layout: shared };
  }
  const scratch = own.mounts.find((mount) => mount.destination === SCRATCH)?.source,
    suffix = '/employees/' + input.employeeId,
    scratchRoot = scratch?.endsWith(suffix) ? scratch.slice(0, -suffix.length) : shared?.scratchRoot;
  if (!scratchRoot)
    return { missing: 'no laptop of this office says where scratch space is kept, and this one does not either' };
  const drives = own.mounts.filter(layoutMount),
    workspace = drives.find((mount) => mount.destination === '/workspace'),
    alias =
      !!workspace &&
      drives.some((mount) => mount.destination === '/reverie_workspace' && mount.source === workspace.source),
    networks = own.networks.filter((name) => OFFICE_NETWORK.test(name)),
    seat = seatProfile
      ? own.mounts.find((mount) => mount.destination === REPROVISION_ACCOUNT_ROOT + seatProfile)?.source
      : undefined,
    inHome = input.home !== undefined && seat === `${input.home}/.reverie/seat-auth/${seatProfile}`;
  const parsed = DockerLaptopTemplate.safeParse({
    user: own.user,
    scratchRoot,
    mounts: alias ? drives.filter((mount) => mount !== workspace) : drives,
    ...(alias ? { workspaceAlias: true } : {}),
    ...(networks.length === 1 ? { network: networks[0] } : {}),
    ...(seat && !inHome ? { accountSource: seat } : {}),
  });
  return parsed.success
    ? { layout: parsed.data }
    : { missing: "this employee's last laptop has a layout the office cannot build again" };
}
