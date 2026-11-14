/** Read-only legacy desired DATA proposal. It grants no native outcome,
 * permission, resource credit or automatic approval. The owner sees and approves
 * the resulting closed policy through the normal continuation API.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DockerEmployeeResourcePolicy } from './docker-employee-continuation-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
const mib = z.number().int().positive().max(1048576);
const legacy = z
  .object({
    employeeResources: z.record(
      z.string(),
      z
        .object({
          budgetMode: z.literal('pool'),
          memoryMiB: mib,
          pidsLimit: z.number().int().positive(),
          poolMemoryMiB: mib,
          poolTasksMax: z.number().int().positive(),
          cpus: z.literal(0),
        })
        .passthrough()
    ),
    employeeMemoryPolicies: z.record(z.string(), z.object({ memoryHighMiB: mib, swapMiB: z.literal(0) }).strict()),
    workerPoolProvider: z
      .object({
        policy: z
          .object({
            memoryMaxMiB: mib,
            poolTasksMax: z.number().int().positive(),
            cpuWeight: z.number().int().min(1).max(10000),
            allowedCpus: z.array(z.number().int().nonnegative()).min(1),
          })
          .passthrough(),
        memberOverrides: z
          .record(z.string(), z.object({ memoryHighMiB: mib, cpuWeight: z.number().int().min(1).max(10000) }).strict())
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export interface DockerPolicyProposal {
  policy: DockerEmployeeResourcePolicy;
  policyDigest: string;
  sourceDigest: string;
  approved: false;
}
export function parseBoxedConfigurationJson(body: string): unknown {
  const parsed: unknown = JSON.parse(body),
    stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '"') {
      const start = index++;
      for (; index < body.length; index++) {
        if (body[index] === '\\') {
          index++;
          continue;
        }
        if (body[index] === '"') break;
      }
      const current = stack.at(-1);
      if (current?.object && current.key) {
        const key = JSON.parse(body.slice(start, index + 1)) as string;
        if (current.keys.has(key)) throw Error('Ambiguous policy data');
        current.keys.add(key);
        current.key = false;
      }
    } else if (char === '{' || char === '[') {
      if (stack.length >= 64) throw Error('Boxed configuration nesting exceeds bound');
      stack.push({ object: char === '{', key: char === '{', keys: new Set() });
    } else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.object) stack.at(-1)!.key = true;
  }
  return parsed;
}
export function proposeLegacyDockerPolicy(body: string, employeeId: string): DockerPolicyProposal | undefined {
  if (Buffer.byteLength(body) > 4 * 1024 * 1024 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(employeeId))
    throw Error('Bounded legacy policy data required');
  const config = legacy.parse(parseBoxedConfigurationJson(body)),
    resource = config.employeeResources[employeeId],
    memory = config.employeeMemoryPolicies[employeeId];
  if (!resource || !memory) return;
  const pool = config.workerPoolProvider.policy,
    member = config.workerPoolProvider.memberOverrides?.[employeeId];
  if (
    resource.poolMemoryMiB !== pool.memoryMaxMiB ||
    resource.poolTasksMax !== pool.poolTasksMax ||
    resource.memoryMiB > pool.memoryMaxMiB
  )
    throw Error('Legacy desired pool policy is inconsistent');
  const policy = DockerEmployeeResourcePolicy.parse({
    memoryMaxBytes: resource.memoryMiB * 1048576,
    memoryHighBytes: memory.memoryHighMiB * 1048576,
    swapMaxBytes: 0,
    pidsMax: resource.pidsLimit,
    cpuWeight: member?.cpuWeight ?? pool.cpuWeight,
    allowedCpus: pool.allowedCpus,
    pool: {
      memoryMaxBytes: pool.memoryMaxMiB * 1048576,
      swapMaxBytes: 0,
      pidsMax: pool.poolTasksMax,
      cpuWeight: pool.cpuWeight,
      allowedCpus: pool.allowedCpus,
    },
  });
  return {
    policy,
    policyDigest: dockerContinuationDigest(policy),
    sourceDigest: createHash('sha256').update(body).digest('hex'),
    approved: false,
  };
}
function stamp(value: fs.Stats): string {
  return [
    value.dev,
    value.ino,
    value.uid,
    value.gid,
    value.mode,
    value.nlink,
    value.size,
    value.mtimeMs,
    value.ctimeMs,
  ].join(':');
}
export function readLegacyDockerPolicyProposal(employeeId: string): DockerPolicyProposal | undefined {
  const path = '/run/reverie-import/worker-policy.json';
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  let result: DockerPolicyProposal | undefined, failure: unknown;
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.size > 4 * 1024 * 1024 ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      ![0, process.getuid?.()].includes(before.uid) ||
      stamp(before) !== stamp(fs.lstatSync(path))
    )
      throw Error('Legacy policy custody refused');
    const body = fs.readFileSync(fd);
    if (
      body.length !== before.size ||
      stamp(before) !== stamp(fs.fstatSync(fd)) ||
      stamp(before) !== stamp(fs.lstatSync(path))
    )
      throw Error('Legacy policy changed');
    const text = body.toString('utf8');
    if (!Buffer.from(text).equals(body)) throw Error('Legacy policy encoding refused');
    result = proposeLegacyDockerPolicy(text, employeeId);
  } catch (cause) {
    failure = cause;
  }
  try {
    fs.closeSync(fd);
  } catch (cause) {
    failure = failure === undefined ? cause : new AggregateError([failure, cause], 'Policy read and close failed');
  }
  if (failure !== undefined) throw failure;
  return result;
}
