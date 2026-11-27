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
 * - layout: every one of them must run as the same user and keep scratch space under the same root; the drives are
 *   the ones all of their laptops have, read-only where any of them has it read-only.
 *
 * Nothing here is a number or a path the owner did not approve for a laptop of this office. Where the others
 * disagree on what cannot be reduced (the pool, the user, the scratch root), or no other employee has anything
 * approved, there is no default and the answer is `undefined`. What belongs to one employee alone (the choice
 * among several office networks, a sign-in folder outside the home) is never copied.
 */
import { isDeepStrictEqual } from 'node:util';
import { DockerLaptopTemplate } from './docker-absent-reprovision-data.js';
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

/** The layout that every laptop with a layout on record shares. */
export function standingLayout(layouts: readonly DockerLaptopTemplate[]): DockerLaptopTemplate | undefined {
  const first = layouts[0];
  if (!first || layouts.some((layout) => layout.user !== first.user || layout.scratchRoot !== first.scratchRoot))
    return undefined;
  const same = (mount: DockerLaptopTemplate['mounts'][number], layout: DockerLaptopTemplate) =>
    layout.mounts.find((other) => other.source === mount.source && other.destination === mount.destination);
  const mounts = first.mounts
    .filter((mount) => layouts.every((layout) => same(mount, layout)))
    .map((mount) => ({ ...mount, readOnly: layouts.some((layout) => same(mount, layout)!.readOnly) }));
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
