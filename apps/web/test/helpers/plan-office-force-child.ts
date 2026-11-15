/** Read-only Linux observation of the actual packaged CLI child; never a launch grant. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { WORKER_CLIENT_PREFIX } from '../../src/worker-client-manifest.js';
const node = WORKER_CLIENT_PREFIX + '/bin/node',
  script = WORKER_CLIENT_PREFIX + '/bin/reverie.mjs';
export const PlanOfficeForceChild = z
  .object({
    childPid: z.number().int().min(2),
    parentPid: z.number().int().min(2),
    childBirthTicks: z.string().regex(/^[1-9][0-9]{0,19}$/),
    nodeStage: z.literal('/opt/reverie-worker-client/bin/node'),
    argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sessionId: z.string().uuid(),
    identityFileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    childMuxAbsent: z.literal(true),
    requiredEnvironmentMatched: z.literal(true),
  })
  .strict();
export type PlanOfficeForceChild = z.infer<typeof PlanOfficeForceChild>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function stat(text: string, pid: number, parent: number) {
  assert.ok(text.startsWith(String(pid) + ' (') && text.lastIndexOf(')') > text.indexOf(' ('));
  assert.equal(Number(text.slice(0, text.indexOf(' '))), pid);
  const fields = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  assert.ok(!['Z', 'X', 'x'].includes(fields[0]!));
  assert.equal(Number(fields[1]), parent);
  return z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .parse(fields[19]);
}
function strings(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 65536);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(text.endsWith('\0'));
  return text.slice(0, -1).split('\0');
}
export function planOfficeForceChildArgs(args: readonly string[]) {
  return [node, '--no-global-search-paths', '--no-addons', script, ...args];
}
/** Pure parser used by the same actual /proc observer. Tests supply bytes only,
 * never fabricate a runtime acceptance or weaken process observability. */
export function parsePlanOfficeForceChild(
  value: {
    pid: number;
    parent: number;
    before: string;
    after: string;
    exeBefore: string;
    exeAfter: string;
    command: Buffer;
    environment: Buffer;
    commandAfter: Buffer;
    environmentAfter: Buffer;
  },
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  expectedBirth?: string
): PlanOfficeForceChild | undefined {
  const birth = stat(value.before, value.pid, value.parent);
  assert.equal(stat(value.after, value.pid, value.parent), birth);
  if (expectedBirth !== undefined) assert.equal(birth, expectedBirth);
  // Spawn can expose the SDK or static entry before exec. Such a sample proves nothing.
  if (value.exeBefore !== node || value.exeAfter !== node) return;
  const command = strings(value.command);
  if (JSON.stringify(command) !== JSON.stringify(planOfficeForceChildArgs(args))) return;
  assert.ok(value.command.equals(value.commandAfter), 'Actual CLI command changed during observation');
  assert.ok(value.environment.equals(value.environmentAfter), 'Actual CLI environment changed during observation');
  const entries = strings(value.environment);
  assert.ok(entries.length <= 64);
  const selected = new Map<string, string>();
  const allowed = new Set([
    'HOME',
    'TERM',
    'REVERIE_SESSION_ID',
    'REVERIE_API_URL',
    'REVERIE_WORKER_IDENTITY_FILE',
    'REVERIE_HOOK_GENERATION',
    'PATH',
    'LANG',
    'LC_ALL',
  ]);
  for (const entry of entries) {
    const at = entry.indexOf('='),
      key = entry.slice(0, at);
    assert.ok(at > 0 && allowed.has(key) && !selected.has(key), 'Actual CLI environment is unconfirmed');
    selected.set(key, entry.slice(at + 1));
  }
  assert.equal(selected.has('REVERIE_MUX'), false, 'Legacy MUX must be absent in the actual Node CLI environment');
  for (const key of ['HOME', 'REVERIE_API_URL', 'REVERIE_SESSION_ID', 'REVERIE_WORKER_IDENTITY_FILE']) {
    assert.ok(typeof env[key] === 'string' && env[key] !== '');
    assert.equal(selected.get(key), env[key]);
  }
  if (env.REVERIE_HOOK_GENERATION !== undefined)
    assert.equal(selected.get('REVERIE_HOOK_GENERATION'), env.REVERIE_HOOK_GENERATION);
  if (env.TERM !== undefined) assert.equal(selected.get('TERM'), env.TERM);
  assert.equal(selected.get('PATH'), '/bin:/usr/bin');
  assert.equal(selected.get('LANG'), 'C.UTF-8');
  assert.equal(selected.get('LC_ALL'), 'C.UTF-8');
  return PlanOfficeForceChild.parse({
    childPid: value.pid,
    parentPid: value.parent,
    childBirthTicks: birth,
    nodeStage: node,
    argsDigest: hash(JSON.stringify(command)),
    sessionId: selected.get('REVERIE_SESSION_ID'),
    identityFileDigest: hash(selected.get('REVERIE_WORKER_IDENTITY_FILE')!),
    childMuxAbsent: true,
    requiredEnvironmentMatched: true,
  });
}
function bytes(pid: number, leaf: 'stat' | 'cmdline' | 'environ') {
  const fd = fs.openSync(
    '/proc/' + pid + '/' + leaf,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    assert.ok(length > 0 && length <= 65536);
    return buffer.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
export async function observePlanOfficeForceChild(
  pid: number,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  closed: () => boolean
): Promise<PlanOfficeForceChild> {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const started = performance.now();
  let previous = started,
    birth: string | undefined;
  for (let attempt = 0; attempt < 500; attempt++) {
    const now = performance.now();
    assert.ok(Number.isFinite(now) && now >= previous && now - started <= 5000);
    previous = now;
    assert.equal(closed(), false, 'Actual force CLI exited before observation');
    assert.equal(fs.statfsSync('/proc').type, 0x9fa0);
    assert.equal(fs.lstatSync('/proc/' + pid).uid, process.getuid!());
    const before = bytes(pid, 'stat').toString('utf8');
    const currentBirth = stat(before, pid, process.pid);
    if (birth === undefined) birth = currentBirth;
    else assert.equal(currentBirth, birth);
    const exeBefore = fs.readlinkSync('/proc/' + pid + '/exe'),
      command = bytes(pid, 'cmdline');
    if (exeBefore !== node || JSON.stringify(strings(command)) !== JSON.stringify(planOfficeForceChildArgs(args))) {
      assert.equal(stat(bytes(pid, 'stat').toString('utf8'), pid, process.pid), birth);
      await pause(10);
      continue;
    }
    const environment = bytes(pid, 'environ'),
      exeAfter = fs.readlinkSync('/proc/' + pid + '/exe'),
      commandAfter = bytes(pid, 'cmdline'),
      environmentAfter = bytes(pid, 'environ'),
      after = bytes(pid, 'stat').toString('utf8');
    const result = parsePlanOfficeForceChild(
      {
        pid,
        parent: process.pid,
        before,
        after,
        exeBefore,
        exeAfter,
        command,
        environment,
        commandAfter,
        environmentAfter,
      },
      args,
      env,
      birth
    );
    if (result) return result;
    await pause(10);
  }
  throw Error('Actual force CLI context remained unobservable; no replay is permitted');
}
