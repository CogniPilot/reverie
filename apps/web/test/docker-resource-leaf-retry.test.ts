/** A leaf resource writer that failed because a process ended while it was
 * read is rerun from a fresh scope under its own journal intent. Every other
 * failure, and every unproven rerun condition, holds instead. Real decision
 * owners run against the controlled physical Docker port; no Engine is used. */
import { describe, expect, it } from 'vitest';
import { DOCKER_LEAF_ATTEMPTS_PER_REQUEST } from '../src/docker-contained-resource-controller.js';
import {
  DOCKER_TASK_ATTEMPT_LIMIT,
  DockerSingleAttemptTask,
  dockerTaskAttempt,
} from '../src/docker-continuation-task.js';
import { dockerContinuationDigest } from '../src/docker-employee-continuation.js';
import type { DockerResourceRevisionStore } from '../src/docker-resource-revisions.js';
import { fixture, helper, policy, workerId, writer } from './helpers/docker-resource-physical.js';

/** What the live system printed, twice, from a helper that names no path. */
const observed = 'BOXED_RESOURCE_IO: No such file or directory (os error 2); effectIssued=true\n';
const located =
  `BOXED_RESOURCE_IO: No such file or directory (os error 2) at /proc/868200/stat ` +
  `(member ${'9'.repeat(64)} task 868200); confirmed=memory.high; effectIssued=true\n`;
const refusal = 'BOXED_RESOURCE_HARD_POLICY_MISMATCH; effectIssued=false\n';
const leafImage = 'sha256:' + '7'.repeat(64);
const box = 'b'.repeat(64);

async function prepared(f = fixture()) {
  await f.controller.preparePool(f.row(), f.current);
  await f.setPool();
  f.makeWorker();
  f.resourcesIssued();
  return f;
}
const leaf = (f: ReturnType<typeof fixture>) => f.tasks.get('leaf-helper')!;
const leafStarts = (f: ReturnType<typeof fixture>) => f.starts.filter((role) => role === 'leaf-helper').length;
const leafWriters = (f: ReturnType<typeof fixture>) =>
  [...f.containers.values()].filter(
    (raw) => (raw.Config as { Labels?: Record<string, string> }).Labels?.['reverie.box.resource.role'] === 'leaf-helper'
  );
const attemptName = (f: ReturnType<typeof fixture>, attempt: number) =>
  'reverie-boxed-leaf-helper-' +
  dockerContinuationDigest([box, 'leaf-helper', f.row().request.operationId, ...(attempt > 1 ? [{ attempt }] : [])]);
const firstName = (f: ReturnType<typeof fixture>) => attemptName(f, 1);
/** Acknowledged by the writer of that attempt, and recorded without an index. */
const acknowledged = (f: ReturnType<typeof fixture>, attempt: number) => {
  expect(leaf(f)).toMatchObject({ phase: 'completed', name: attemptName(f, attempt) });
  expect(leaf(f)).not.toHaveProperty('attempt');
};

describe('a writer that lost a process while reading it', () => {
  it.each([
    ['as an earlier helper prints it', observed],
    ['as a later helper locates it, after the first limit was written', located],
    ['as an exited process', 'BOXED_RESOURCE_PID_EXITED; effectIssued=false\n'],
    ['as a spent deadline', 'BOXED_RESOURCE_DEADLINE; confirmed=memory.high; effectIssued=true\n'],
  ])('is rerun once without anyone asking, %s', async (_name, line) => {
    const f = await prepared();
    f.failLeafWriters(line);
    await f.controller.configure(f.row(), f.current);
    expect(await f.controller.read(f.row())).toEqual(policy);
    expect(f.phases.filter((phase) => phase.startsWith('leaf-helper'))).toEqual([
      'leaf-helper:create-issued',
      'leaf-helper:created',
      'leaf-helper:start-issued',
      'leaf-helper:failed',
      'leaf-helper:create-issued',
      'leaf-helper:created',
      'leaf-helper:start-issued',
      'leaf-helper:completed',
    ]);
    expect(leafStarts(f)).toBe(2);
    acknowledged(f, 2);
    const names = f.names.filter((name) => name.startsWith('reverie-boxed-leaf-helper-'));
    expect(names).toHaveLength(2);
    // The first attempt keeps the name every earlier office gave it.
    expect(names[0]).toBe(firstName(f));
    expect(names[1]).not.toBe(names[0]);
    expect(leaf(f).name).toBe(names[1]);
  });
  it('records the acknowledged rerun in the shape an earlier office reads, and settles it again without effects', async () => {
    const f = await prepared();
    f.failLeafWriters(observed);
    await f.controller.configure(f.row(), f.current);
    const done = structuredClone(leaf(f));
    expect(DockerSingleAttemptTask.parse(JSON.parse(JSON.stringify(done)))).toEqual(done);
    const effects = [f.creates.length, f.starts.length];
    // The same request once more finds its own acknowledged writer.
    await f.controller.configure(f.row(), f.current);
    expect(leaf(f)).toEqual(done);
    expect([f.creates.length, f.starts.length]).toEqual(effects);
  });
  it('refuses an issued writer whose name is not this box and operation', async () => {
    const f = await prepared();
    await f.controller.configure(f.row(), f.current);
    const foreign = {
      ...f.row(),
      request: { ...f.row().request, operationId: '99999999-9999-4999-8999-999999999999' },
    };
    const worker = f.containers.get(workerId)!;
    (worker.Config as { Labels: Record<string, string> }).Labels['reverie.boxed.operation'] =
      foreign.request.operationId;
    const starts = [...f.starts];
    await expect(f.controller.configure(foreign, f.current)).rejects.toThrow('ORIGINAL_TASK_CHANGED');
    expect(f.starts).toEqual(starts);
  });
  it('journals the class of the failure and nothing the helper printed', async () => {
    const f = await prepared();
    f.failLeafWriters(located, refusal);
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_REFUSED');
    const failed = f.phases.indexOf('leaf-helper:failed');
    expect(failed).toBeGreaterThan(-1);
    expect(leaf(f)).toEqual({
      role: 'leaf-helper',
      name: leaf(f).name,
      imageId: helper,
      configurationDigest: leaf(f).configurationDigest,
      attempt: 2,
      phase: 'failed',
      containerId: leaf(f).phase === 'failed' ? leaf(f).containerId : '',
      exitCode: 1,
      failure: 'refused',
    });
    const journaled = JSON.stringify([...f.tasks.values()]);
    for (const text of ['BOXED', 'os error', '/proc/', 'effectIssued', 'confirmed'])
      expect(journaled).not.toContain(text);
  });
  it('collects its scope again, so a laptop that joined the box is in the next writer and not the first', async () => {
    const f = await prepared(),
      joined = '5'.repeat(64);
    let added = false;
    f.beforeRun((args) => {
      if (!added && args[0] === 'container' && args[1] === 'wait') {
        added = true;
        f.addMember(joined, 555);
      }
    });
    f.failLeafWriters(observed);
    await f.controller.configure(f.row(), f.current);
    f.beforeRun(undefined);
    const [first, second] = leafWriters(f).map((raw) => (raw.Config as { Cmd: string[] }).Cmd);
    expect(first).not.toContain('--member');
    expect(second![second!.indexOf('--member') + 1]).toBe(`${joined}:555:20`);
    expect(second!.filter((value) => value !== '--member' && !value.startsWith(joined))).toEqual(first);
    expect(await f.controller.read(f.row())).toEqual(policy);
  });
  it('holds after three failures in one request and takes three more only when asked again', async () => {
    const f = await prepared();
    f.failLeafWriters(...Array<string>(DOCKER_LEAF_ATTEMPTS_PER_REQUEST).fill(observed));
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED');
    expect(leafStarts(f)).toBe(3);
    expect(leaf(f)).toMatchObject({ phase: 'failed', attempt: 3, failure: 'lost-process' });
    expect(await f.controller.read(f.row())).toBeNull();
    // The repeated request is the retry: the fourth writer succeeds.
    await f.controller.configure(f.row(), f.current);
    expect(leafStarts(f)).toBe(4);
    acknowledged(f, 4);
    expect(await f.controller.read(f.row())).toEqual(policy);
  });
  it('never issues a tenth writer for one operation', async () => {
    const f = await prepared();
    f.failLeafWriters(...Array<string>(DOCKER_TASK_ATTEMPT_LIMIT + 3).fill(observed));
    for (let round = 0; round < 2; round++)
      await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_RETRY_EXHAUSTED');
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_ATTEMPTS_SPENT');
    expect(leafStarts(f)).toBe(DOCKER_TASK_ATTEMPT_LIMIT);
    expect(dockerTaskAttempt(leaf(f))).toBe(DOCKER_TASK_ATTEMPT_LIMIT);
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_ATTEMPTS_SPENT');
    expect(leafStarts(f)).toBe(DOCKER_TASK_ATTEMPT_LIMIT);
    expect(new Set(f.names).size).toBe(f.names.length);
  });
});

describe('a writer that failed for any other reason', () => {
  it.each([
    ['a refused policy or identity', refusal, 'DOCKER_RESOURCE_HELPER_REFUSED', 'refused'],
    [
      'a lost close',
      observed.replace('; effectIssued', '; BOXED_RESOURCE_CLOSE_UNCONFIRMED: [Os { code: 4 }]; effectIssued'),
      'DOCKER_RESOURCE_HELPER_CLOSE_UNCONFIRMED',
      'close-unconfirmed',
    ],
    ['an unrecognized line', 'Killed\n', 'DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN', 'unknown'],
    [
      'a control file missing under the writable leaf',
      'BOXED_RESOURCE_IO: No such file or directory (os error 2) at /run/reverie-worker-cgroup/memory.high (leaf); effectIssued=false\n',
      'DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN',
      'unknown',
    ],
  ])('is never rerun: %s', async (_name, line, code, failure) => {
    const f = await prepared();
    f.failLeafWriters(line);
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow(code);
    expect(leaf(f)).toMatchObject({ phase: 'failed', failure, exitCode: 1 });
    expect(leaf(f)).not.toHaveProperty('attempt');
    expect(leafStarts(f)).toBe(1);
    const creates = [...f.creates];
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow(code);
    expect(leafStarts(f)).toBe(1);
    expect(f.creates).toEqual(creates);
    expect(await f.controller.read(f.row())).toBeNull();
  });
  it('is unknown when the helper was killed rather than exiting by itself', async () => {
    const f = await prepared();
    f.failLeafWriters(observed);
    f.beforeRun((args) => {
      if (args[0] === 'container' && args[1] === 'wait')
        (f.containers.get(args[2]!)!.State as Record<string, unknown>).ExitCode = 137;
    });
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_FAILURE_UNKNOWN');
    expect(leaf(f)).toMatchObject({ phase: 'failed', failure: 'unknown', exitCode: 137 });
  });
});

describe('what a rerun must prove first', () => {
  /** Three lost reads: the journal holds a terminal failure that may be rerun. */
  async function held() {
    const f = await prepared();
    f.failLeafWriters(observed, observed, observed);
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_RETRY_EXHAUSTED');
    const failed = leaf(f);
    if (failed.phase !== 'failed') throw Error('Expected a terminal failure');
    return { f, failed, raw: f.containers.get(failed.containerId)!, before: structuredClone(failed) };
  }
  const unchanged = (h: Awaited<ReturnType<typeof held>>, starts = 3) => {
    expect(leaf(h.f)).toEqual(h.before);
    expect(leafStarts(h.f)).toBe(starts);
  };
  it.each([
    [
      'running again',
      (state: Record<string, unknown>) => Object.assign(state, { Status: 'running', Running: true, Pid: 300 }),
    ],
    ['restarting', (state: Record<string, unknown>) => Object.assign(state, { Restarting: true })],
    ['paused', (state: Record<string, unknown>) => Object.assign(state, { Paused: true })],
    ['left with a process', (state: Record<string, unknown>) => Object.assign(state, { Pid: 300 })],
    ['showing another exit status', (state: Record<string, unknown>) => Object.assign(state, { ExitCode: 2 })],
  ])('refuses while the failed writer is %s', async (_name, change) => {
    const h = await held();
    change(h.raw.State as Record<string, unknown>);
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('HELPER_RETRY_UNCONFIRMED');
    unchanged(h);
  });
  it('refuses when the failed writer changes between its two inspections', async () => {
    const h = await held();
    let probes = 0;
    h.f.beforeRun((args) => {
      // The second leaf read of the request is the fresh one between the two
      // inspections of the closure proof.
      if (args[0] === 'exec' && args.includes('probe-worker') && ++probes === 2)
        (h.raw.State as Record<string, unknown>).FinishedAt = 'later';
    });
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('HELPER_RETRY_UNCONFIRMED');
    expect(probes).toBe(2);
    unchanged(h);
  });
  it('refuses a failed writer whose fixed configuration changed', async () => {
    const h = await held();
    (h.raw.HostConfig as Record<string, unknown>).RestartPolicy = { Name: 'always', MaximumRetryCount: 0 };
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('HELPER_CHANGED');
    unchanged(h);
  });
  it('refuses a changed policy, a later phase and a later soft-memory revision', async () => {
    const h = await held();
    const lower = { ...h.f.row(), policy: { ...policy, memoryHighBytes: 8 * 1024 ** 3 } };
    await expect(h.f.controller.configure(lower, h.f.current)).rejects.toThrow('HELPER_RETRY_SCOPE_CHANGED');
    unchanged(h);
    const revised = h.f.withRevisions({ history: () => [{}] } as unknown as DockerResourceRevisionStore);
    await expect(revised.configure(h.f.row(), h.f.current)).rejects.toThrow('HELPER_RETRY_SCOPE_CHANGED');
    unchanged(h);
    await expect(h.f.controller.configure({ ...h.f.row(), phase: 'resources-ready' }, h.f.current)).rejects.toThrow(
      'HELPER_RETRY_SCOPE_CHANGED'
    );
    unchanged(h);
  });
  it('refuses beside another unterminated leaf writer of the same worker, and ignores one of another worker', async () => {
    const h = await held();
    const other = (id: string, worker: string) => {
      const copy = structuredClone(h.raw),
        config = copy.Config as { Cmd: string[]; Labels: Record<string, string> },
        name = 'reverie-boxed-leaf-helper-' + id;
      copy.Id = id;
      config.Labels['reverie.box.resource.name'] = name;
      config.Cmd[config.Cmd.indexOf('--worker-id') + 1] = worker;
      (copy.HostConfig as { Binds: string[] }).Binds = (copy.HostConfig as { Binds: string[] }).Binds.map((bind) =>
        bind.replaceAll(workerId, worker)
      );
      copy.Mounts = (copy.Mounts as { Source: string }[]).map((mount) => ({
        ...mount,
        Source: mount.Source.replaceAll(workerId, worker),
      }));
      copy.State = { Status: 'running', Running: true, Paused: false, Restarting: false, Dead: false, Pid: 700 };
      h.f.containers.set(id, copy);
      return copy;
    };
    const foreign = other('8'.repeat(64), '6'.repeat(64));
    void foreign;
    // A live writer of another laptop does not concern this one.
    h.f.failLeafWriters(observed, observed, observed);
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('HELPER_RETRY_EXHAUSTED');
    expect(leafStarts(h.f)).toBe(6);
    const before = structuredClone(leaf(h.f));
    const live = other('4'.repeat(64), workerId);
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('HELPER_RETRY_UNCONFIRMED');
    expect(leaf(h.f)).toEqual(before);
    expect(leafStarts(h.f)).toBe(6);
    // Once it is terminal, the repeated request goes ahead.
    live.State = {
      Status: 'exited',
      Running: false,
      Paused: false,
      Restarting: false,
      Dead: false,
      Pid: 0,
      ExitCode: 1,
    };
    await h.f.controller.configure(h.f.row(), h.f.current);
    expect(await h.f.controller.read(h.f.row())).toEqual(policy);
  });
  it('refuses a leaf writer container it cannot read as one', async () => {
    const h = await held();
    const copy = structuredClone(h.raw);
    copy.Id = '4'.repeat(64);
    (copy.Config as { Cmd: string[] }).Cmd = ['configure-high', '--unapproved'];
    h.f.containers.set(copy.Id as string, copy);
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('LEAF_WRITER_UNCONFIRMED');
    unchanged(h);
  });
  it('refuses revoked authority before the next writer is created', async () => {
    const h = await held();
    h.f.revoke();
    await expect(h.f.controller.configure(h.f.row(), h.f.current)).rejects.toThrow('revoked');
    unchanged(h);
  });
});

describe('a writer an earlier office left started and never acknowledged', () => {
  /** The latch seen on the live system: the journal says start-issued and the
   * container exited 1. The office that issued it stopped right after. */
  async function latched(line = observed) {
    const f = await prepared();
    let live = true;
    const guard = () => {
      if (!live) throw Error('office stopped');
    };
    f.failLeafWriters(line);
    f.beforeRun((args) => {
      if (args[0] === 'container' && args[1] === 'wait') live = false;
    });
    await expect(f.controller.configure(f.row(), guard)).rejects.toThrow('office stopped');
    f.beforeRun(undefined);
    expect(leaf(f).phase).toBe('start-issued');
    expect(leaf(f).name).toBe(firstName(f));
    return f;
  }
  it('is settled as failed by the read-only inspection and then rerun by the next request', async () => {
    const f = await latched();
    const effects = () => [f.creates.length, f.starts.length];
    const before = effects();
    await f.controller.settleObservedHelpers(f.row(), f.current);
    expect(leaf(f)).toMatchObject({ phase: 'failed', failure: 'lost-process', exitCode: 1 });
    expect(effects()).toEqual(before);
    // Settled already: a second inspection changes nothing.
    await f.controller.settleObservedHelpers(f.row(), f.current);
    expect(effects()).toEqual(before);
    await f.controller.configure(f.row(), f.current);
    acknowledged(f, 2);
    expect(leafStarts(f)).toBe(2);
    expect(await f.controller.read(f.row())).toEqual(policy);
  });
  it('is settled by the recovery hook without any effect', async () => {
    const f = await latched();
    const starts = [...f.starts],
      creates = [...f.creates];
    await f.controller.settleFailedWriter(f.row(), f.current);
    expect(leaf(f)).toMatchObject({ phase: 'failed', failure: 'lost-process' });
    expect(f.starts).toEqual(starts);
    expect(f.creates).toEqual(creates);
  });
  it('is settled and rerun by the request itself', async () => {
    const f = await latched();
    await f.controller.configure(f.row(), f.current);
    acknowledged(f, 2);
    expect(await f.controller.read(f.row())).toEqual(policy);
  });
  it('is held, not rerun, when what it printed is not a lost read', async () => {
    const f = await latched(refusal);
    await f.controller.settleObservedHelpers(f.row(), f.current);
    expect(leaf(f)).toMatchObject({ phase: 'failed', failure: 'refused' });
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('DOCKER_RESOURCE_HELPER_REFUSED');
    expect(leafStarts(f)).toBe(1);
  });
  it('stays unconfirmed while it is still running', async () => {
    const f = await prepared();
    f.delayNextLeaf();
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('lost live start reply');
    const before = structuredClone(leaf(f));
    expect(before.phase).toBe('start-issued');
    await expect(f.controller.settleObservedHelpers(f.row(), f.current)).rejects.toThrow();
    await f.controller.settleFailedWriter(f.row(), f.current);
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow();
    expect(leaf(f)).toEqual(before);
    expect(leafStarts(f)).toBe(1);
  });
});

describe('the separately pinned leaf writer image', () => {
  it('runs new leaf writers only; the anchor and pool writer keep the baseline image', async () => {
    const f = await prepared(fixture(box, undefined, undefined, leafImage));
    await f.controller.configure(f.row(), f.current);
    expect(f.configurations.map((item) => [item.config.Labels && item.name.split('-')[2], item.config.Image])).toEqual([
      ['anchor', helper],
      ['pool', helper],
      ['leaf', leafImage],
    ]);
    expect(leaf(f)).toMatchObject({ phase: 'completed', imageId: leafImage });
    expect(await f.controller.read(f.row())).toEqual(policy);
    expect(leaf(f).name).toBe(firstName(f));
  });
  it('leaves a writer issued under the baseline image acknowledged after the pin is selected', async () => {
    const f = await prepared();
    await f.controller.configure(f.row(), f.current);
    const before = structuredClone(leaf(f));
    f.changeLeafWriterPin(leafImage);
    expect(await f.controller.read(f.row())).toEqual(policy);
    await f.controller.settleObservedHelpers(f.row(), f.current);
    expect(leaf(f)).toEqual(before);
    expect(before.imageId).toBe(helper);
  });
  it('reruns a baseline writer that failed before the pin was selected on the pinned image', async () => {
    const f = await prepared();
    f.failLeafWriters(observed, observed, observed);
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('HELPER_RETRY_EXHAUSTED');
    expect(leaf(f).imageId).toBe(helper);
    f.changeLeafWriterPin(leafImage);
    await f.controller.configure(f.row(), f.current);
    acknowledged(f, 4);
    expect(leaf(f).imageId).toBe(leafImage);
    expect(await f.controller.read(f.row())).toEqual(policy);
    expect(leafWriters(f).map((raw) => raw.Image)).toEqual([helper, helper, helper, leafImage]);
  });
  it('refuses an image built for another writer, or one the Engine cannot supply, before any intent', async () => {
    // The high-only image carries a label a leaf writer container must not inherit.
    const f = await prepared(fixture(box, undefined, undefined, writer));
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('LEAF_WRITER_IMAGE_UNAVAILABLE');
    expect(f.tasks.get('leaf-helper')).toBeUndefined();
    expect(leafStarts(f)).toBe(0);
    await expect(f.controller.validate({} as never, policy)).rejects.toThrow('LEAF_WRITER_IMAGE_UNAVAILABLE');
    f.changeLeafWriterPin(leafImage);
    f.beforeRun((args) => {
      if (args[0] === 'image' && args[2] === leafImage) throw Error('No such image');
    });
    await expect(f.controller.configure(f.row(), f.current)).rejects.toThrow('LEAF_WRITER_IMAGE_UNAVAILABLE');
    expect(f.tasks.get('leaf-helper')).toBeUndefined();
  });
  it('refuses a malformed pin at construction', () => {
    expect(() => fixture(box, undefined, undefined, 'latest')).toThrow('Fixed contained resource configuration');
  });
});
