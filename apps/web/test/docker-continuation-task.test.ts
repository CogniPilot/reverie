/** The canonical helper task journal: records written before the leaf writer
 * could be rerun must read unchanged, and a terminal failure may lead only to
 * the next attempt of a leaf writer whose failure was a lost read. */
import { describe, expect, it } from 'vitest';
import {
  DOCKER_TASK_ATTEMPT_LIMIT,
  DockerContinuationTask,
  DockerSingleAttemptTask,
  allowedDockerTaskTransition,
  dockerTaskAttempt,
  dockerTaskFailureRetryable,
} from '../src/docker-continuation-task.js';
import { DockerEmployeePlanReplacementWorkRecord } from '../src/docker-employee-continuation-data.js';
import { assertDockerPlanMoveTransition } from '../src/docker-plan-move-data.js';
import { dockerPlanJournalFixture } from './helpers/docker-plan-move-fixture.js';

const hex = (digit: string) => digit.repeat(64);
const leaf = {
  role: 'leaf-helper',
  name: 'reverie-boxed-leaf-helper-' + hex('1'),
  imageId: 'sha256:' + hex('a'),
  configurationDigest: hex('2'),
} as const;
const second = { ...leaf, name: 'reverie-boxed-leaf-helper-' + hex('3'), configurationDigest: hex('4'), attempt: 2 };
const task = (value: unknown) => DockerContinuationTask.parse(value);
const failed = (failure: string, extra: Record<string, unknown> = {}) =>
  task({ ...leaf, phase: 'failed', containerId: hex('c'), exitCode: 1, failure, ...extra });

describe('records written before the leaf writer could be rerun', () => {
  // Exactly the JSON an earlier office persisted for each phase.
  const persisted = [
    { ...leaf, phase: 'create-issued' },
    { ...leaf, phase: 'created', containerId: hex('c') },
    { ...leaf, phase: 'start-issued', containerId: hex('c') },
    { ...leaf, phase: 'running', containerId: hex('c'), initPid: 4242, initStartTicks: '77' },
    { ...leaf, phase: 'completed', containerId: hex('c'), resultDigest: hex('d') },
    { ...leaf, role: 'anchor', phase: 'running', containerId: hex('c'), initPid: 100, initStartTicks: '10' },
    { ...leaf, role: 'pool-helper', phase: 'completed', containerId: hex('c'), resultDigest: hex('d') },
    { ...leaf, role: 'storage-holder', phase: 'start-issued', containerId: hex('c') },
    { ...leaf, role: 'identity-helper', phase: 'created', containerId: hex('c') },
  ];
  it.each(persisted)('reads $role $phase unchanged and as a first attempt', (stored) => {
    const read = JSON.parse(JSON.stringify(stored)) as unknown;
    const parsed = task(read);
    expect(parsed).toEqual(stored);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(stored));
    expect(dockerTaskAttempt(parsed)).toBe(1);
    expect(DockerSingleAttemptTask.parse(read)).toEqual(stored);
  });
  it('reads an operation record whose leaf writer was started and never acknowledged', () => {
    const work = {
      ...dockerPlanJournalFixture().work,
      phase: 'resources-issued',
      tasks: [{ ...leaf, phase: 'start-issued', containerId: hex('c') }],
    };
    const stored = JSON.parse(JSON.stringify(work)) as unknown;
    const parsed = DockerEmployeePlanReplacementWorkRecord.parse(stored);
    expect(parsed).toEqual(stored);
    expect(parsed.tasks?.find((item) => item.role === 'leaf-helper')).toEqual({
      ...leaf,
      phase: 'start-issued',
      containerId: hex('c'),
    });
  });
  it('keeps the earlier transitions exactly', () => {
    const [issued, made, started, live, done] = persisted.slice(0, 5).map(task);
    expect(allowedDockerTaskTransition(undefined, issued!)).toBe(true);
    expect(allowedDockerTaskTransition(issued, made!)).toBe(true);
    expect(allowedDockerTaskTransition(made, started!)).toBe(true);
    expect(allowedDockerTaskTransition(made, live!)).toBe(true);
    expect(allowedDockerTaskTransition(started, live!)).toBe(true);
    expect(allowedDockerTaskTransition(started, done!)).toBe(true);
    expect(allowedDockerTaskTransition(live, done!)).toBe(true);
    for (const [before, next] of [
      [undefined, made],
      [issued, started],
      [issued, done],
      [made, done],
      [started, made],
      [done, started],
      [done, issued],
      [live, started],
    ] as const)
      expect(allowedDockerTaskTransition(before, next!)).toBe(false);
    expect(allowedDockerTaskTransition(started, task({ ...done, containerId: hex('e') }))).toBe(false);
    expect(allowedDockerTaskTransition(started, task({ ...done, name: second.name }))).toBe(false);
    expect(allowedDockerTaskTransition(started, task({ ...done, imageId: 'sha256:' + hex('b') }))).toBe(false);
  });
});

describe('the terminal failed phase', () => {
  it('follows only a started or running leaf writer on the same container', () => {
    const started = task({ ...leaf, phase: 'start-issued', containerId: hex('c') });
    const live = task({ ...leaf, phase: 'running', containerId: hex('c'), initPid: 9, initStartTicks: '5' });
    expect(allowedDockerTaskTransition(started, failed('lost-process'))).toBe(true);
    expect(allowedDockerTaskTransition(live, failed('unknown', { exitCode: 137 }))).toBe(true);
    expect(allowedDockerTaskTransition(started, failed('lost-process', { containerId: hex('e') }))).toBe(false);
    expect(allowedDockerTaskTransition(started, failed('lost-process', { name: second.name }))).toBe(false);
    expect(allowedDockerTaskTransition(started, failed('lost-process', { attempt: 2 }))).toBe(false);
    for (const phase of ['create-issued', 'created', 'completed'] as const)
      expect(
        allowedDockerTaskTransition(
          task({
            ...leaf,
            phase,
            ...(phase === 'create-issued' ? {} : { containerId: hex('c') }),
            ...(phase === 'completed' ? { resultDigest: hex('d') } : {}),
          }),
          failed('lost-process')
        )
      ).toBe(false);
    expect(allowedDockerTaskTransition(undefined, failed('lost-process'))).toBe(false);
  });
  it('is never acknowledged, restarted or completed afterwards', () => {
    const before = failed('lost-process');
    for (const next of [
      { ...leaf, phase: 'completed', containerId: hex('c'), resultDigest: hex('d') },
      { ...leaf, phase: 'start-issued', containerId: hex('c') },
      { ...leaf, phase: 'running', containerId: hex('c'), initPid: 9, initStartTicks: '5' },
      { ...leaf, phase: 'created', containerId: hex('c') },
      { ...leaf, phase: 'create-issued' },
      { ...leaf, phase: 'failed', containerId: hex('c'), exitCode: 1, failure: 'deadline' },
    ])
      expect(allowedDockerTaskTransition(before, task(next))).toBe(false);
  });
  it('exists for the leaf writer only, with a closed class and a real exit status', () => {
    for (const role of ['anchor', 'pool-helper', 'storage-holder', 'identity-helper']) {
      expect(DockerContinuationTask.safeParse({ ...failed('lost-process'), role }).success).toBe(false);
      expect(DockerContinuationTask.safeParse({ ...leaf, role, phase: 'create-issued', attempt: 2 }).success).toBe(
        false
      );
    }
    expect(DockerContinuationTask.safeParse({ ...failed('lost-process'), failure: 'ENOENT at /proc/7' }).success).toBe(
      false
    );
    expect(DockerContinuationTask.safeParse({ ...failed('lost-process'), stderr: 'text' }).success).toBe(false);
    for (const exitCode of [0, 256, -1, 1.5])
      expect(DockerContinuationTask.safeParse({ ...failed('lost-process'), exitCode }).success).toBe(false);
    expect(DockerSingleAttemptTask.safeParse(failed('lost-process')).success).toBe(false);
    expect(DockerSingleAttemptTask.safeParse({ ...second, phase: 'create-issued' }).success).toBe(false);
  });
});

describe('the next attempt', () => {
  const next = task({ ...second, phase: 'create-issued' });
  it('follows a failure that was a lost read or a deadline, under its own name and the next index', () => {
    expect(allowedDockerTaskTransition(failed('lost-process'), next)).toBe(true);
    expect(allowedDockerTaskTransition(failed('deadline'), next)).toBe(true);
    expect(
      allowedDockerTaskTransition(failed('lost-process'), task({ ...second, phase: 'create-issued', attempt: 3 }))
    ).toBe(false);
    expect(allowedDockerTaskTransition(failed('lost-process'), task({ ...leaf, phase: 'create-issued' }))).toBe(false);
    expect(
      allowedDockerTaskTransition(failed('lost-process'), task({ ...second, name: leaf.name, phase: 'create-issued' }))
    ).toBe(false);
    expect(
      allowedDockerTaskTransition(failed('lost-process'), task({ ...second, phase: 'created', containerId: hex('e') }))
    ).toBe(false);
  });
  it.each(['refused', 'close-unconfirmed', 'unknown'] as const)('never follows a %s failure', (failure) => {
    expect(dockerTaskFailureRetryable(failure)).toBe(false);
    expect(allowedDockerTaskTransition(failed(failure), next)).toBe(false);
  });
  it('carries its index through every later phase and cannot change it', () => {
    const made = task({ ...second, phase: 'created', containerId: hex('e') });
    const started = task({ ...second, phase: 'start-issued', containerId: hex('e') });
    const done = task({ ...second, phase: 'completed', containerId: hex('e'), resultDigest: hex('d') });
    expect(allowedDockerTaskTransition(next, made)).toBe(true);
    expect(allowedDockerTaskTransition(made, started)).toBe(true);
    expect(allowedDockerTaskTransition(started, done)).toBe(true);
    expect(dockerTaskAttempt(done)).toBe(2);
    const { attempt: _attempt, ...unnumbered } = done;
    expect(allowedDockerTaskTransition(started, task(unnumbered))).toBe(false);
    expect(allowedDockerTaskTransition(started, task({ ...done, attempt: 3 }))).toBe(false);
    const again = task({ ...second, phase: 'failed', containerId: hex('e'), exitCode: 1, failure: 'lost-process' });
    expect(allowedDockerTaskTransition(started, again)).toBe(true);
    expect(
      allowedDockerTaskTransition(
        again,
        task({ ...leaf, name: 'reverie-boxed-leaf-helper-' + hex('5'), phase: 'create-issued', attempt: 3 })
      )
    ).toBe(true);
  });
  it('stops at the attempt limit', () => {
    const last = failed('lost-process', { attempt: DOCKER_TASK_ATTEMPT_LIMIT });
    expect(
      DockerContinuationTask.safeParse({ ...second, phase: 'create-issued', attempt: DOCKER_TASK_ATTEMPT_LIMIT + 1 })
        .success
    ).toBe(false);
    expect(
      allowedDockerTaskTransition(last, {
        ...second,
        phase: 'create-issued',
        attempt: DOCKER_TASK_ATTEMPT_LIMIT + 1,
      })
    ).toBe(false);
    for (const attempt of [0, 1, 1.5])
      expect(DockerContinuationTask.safeParse({ ...second, phase: 'create-issued', attempt }).success).toBe(false);
  });
});

describe('the plan move journal', () => {
  const { closed, work } = dockerPlanJournalFixture();
  const withLeaf = (value: unknown) => ({
    ...closed,
    work: { ...work, phase: 'resources-issued' as const, tasks: [task(value)] },
  });
  it('admits the failure and the next attempt of its leaf writer, and nothing else in their place', () => {
    const started = withLeaf({ ...leaf, phase: 'start-issued', containerId: hex('c') });
    const lost = withLeaf(failed('lost-process'));
    const retried = withLeaf({ ...second, phase: 'create-issued' });
    expect(() => assertDockerPlanMoveTransition(started, lost)).not.toThrow();
    expect(() => assertDockerPlanMoveTransition(lost, retried)).not.toThrow();
    expect(() => assertDockerPlanMoveTransition(started, retried)).toThrow('native task changed');
    expect(() => assertDockerPlanMoveTransition(withLeaf(failed('refused')), retried)).toThrow('native task changed');
    expect(() => assertDockerPlanMoveTransition(lost, started)).toThrow('native task changed');
  });
});
