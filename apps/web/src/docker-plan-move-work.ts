import { dockerPlanWorkerContainerIds } from './docker-plan-worker-inventory.js';
/** One original target's existing Engine/helper tasks in the SAME PlanMoves
 * journal. No independent task writer or replacement effect retry exists. */
import { isDeepStrictEqual } from 'node:util';
import { DockerEmployeeEngine, type DockerEmployeeImageConfiguration } from './docker-employee-engine.js';
import { DockerContainedResources } from './docker-contained-resource-controller.js';
import type { DockerResourceRevisionStore } from './docker-resource-revisions.js';
import type { CompanyDockerContinuationStore } from './docker-employee-store.js';
import type { PlanMoveStore } from './plan-move-store.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import {
  DockerEmployeePlanReplacementWorkRecord,
  type DockerEmployeeContinuationRecord,
} from './docker-employee-continuation-data.js';
import { allowedDockerTaskTransition, type DockerContinuationTaskJournal } from './docker-continuation-task.js';
import { allowedEphemeralTransition, type EphemeralJournal } from './docker-ephemeral-data.js';
import type { PlanMoveDockerJournal } from './plan-move-docker.js';
import { PlanMoveError } from './plan-move.js';
const phases = [
  'staged',
  'office-issued',
  'office-ready',
  'pool-issued',
  'pool-ready',
  'destination-issued',
  'destination-ready',
  'start-issued',
  'container-running',
  'resources-issued',
  'resources-ready',
  'identity-issued',
  'identity-ready',
  'provider-issued',
  'ready',
] as const;
function same(a: unknown, b: unknown) {
  return isDeepStrictEqual(a, b);
}
function stable(row: DockerEmployeeContinuationRecord) {
  const {
    phase: _phase,
    tasks: _tasks,
    pool: _pool,
    destination: _destination,
    ephemeralRestoration: _ephemeral,
    ...fixed
  } = row;
  return fixed;
}
export interface DockerPlanWorkComposition {
  readonly command: DockerEngineCommand;
  readonly deployment: string;
  readonly boxId: string;
  readonly helperImageId: string;
  readonly memoryHighHelperImageId?: string;
  readonly target: DockerEmployeeImageConfiguration;
  readonly canonical: CompanyDockerContinuationStore;
  readonly moves: PlanMoveStore;
  readonly revisions: DockerResourceRevisionStore;
  readonly providerMode: string;
}
export class DockerPlanMoveWork {
  readonly engine: DockerEmployeeEngine;
  readonly resources: DockerContainedResources;
  readonly #journal: PlanMoveDockerJournal;
  constructor(d: DockerPlanWorkComposition, journal: PlanMoveDockerJournal) {
    this.#journal = journal;
    const checked = (input: DockerEmployeeContinuationRecord) => {
      journal.current();
      const row = journal.read().work;
      if (!row || !same(stable(input), stable(row))) throw new PlanMoveError('The original target work changed', 409);
      return row;
    };
    const port: DockerContinuationTaskJournal & EphemeralJournal = {
      read: (row, role) => structuredClone(checked(row).tasks?.find((t) => t.role === role)),
      publish: async (input, before, next, current) => {
        current();
        const row = checked(input),
          actual = row.tasks?.find((t) => t.role === next.role);
        if (!same(before, actual) || !allowedDockerTaskTransition(actual, next))
          throw new PlanMoveError('The original native task changed', 409);
        const state = journal.read(),
          work = { ...row, tasks: [...(row.tasks ?? []).filter((t) => t.role !== next.role), structuredClone(next)] };
        await journal.publish(state, { ...state, work });
        current();
        return checked(input);
      },
      readEphemeral: (row) => structuredClone(checked(row).ephemeralRestoration),
      publishEphemeral: async (input, before, next, current) => {
        current();
        const row = checked(input);
        if (!same(before, row.ephemeralRestoration) || !allowedEphemeralTransition(before, next))
          throw new PlanMoveError('The original ephemeral task changed', 409);
        const state = journal.read();
        await journal.publish(state, { ...state, work: { ...row, ephemeralRestoration: structuredClone(next) } });
        current();
        checked(input);
      },
    };
    this.resources = new DockerContainedResources(
      d.command,
      port,
      {
        boxId: d.boxId,
        deployment: d.deployment,
        helperImageId: d.helperImageId,
        memoryHighHelperImageId: d.memoryHighHelperImageId,
        selectedWorkerContainerIds: () =>
          dockerPlanWorkerContainerIds(
            () => d.canonical.resourceInventory(),
            d.moves,
            () => journal.current()
          ),
        retainedPoolConfigurationTasks: () =>
          d.canonical.retainedPoolConfigurationTasks(
            'reverie-boxed-anchor-' + d.boxId.slice(0, 32),
            d.helperImageId,
            d.boxId
          ),
      },
      d.revisions
    );
    this.engine = new DockerEmployeeEngine(
      d.command,
      d.deployment,
      this.resources,
      d.target,
      port,
      d.helperImageId,
      d.boxId,
      () => d.providerMode
    );
  }
  row() {
    this.#journal.current();
    const row = this.#journal.read().work;
    if (!row) throw new PlanMoveError('Original target work is unavailable', 409);
    return DockerEmployeePlanReplacementWorkRecord.parse(row);
  }
  async phase(
    phase: DockerEmployeePlanReplacementWorkRecord['phase'],
    extra: Partial<Pick<DockerEmployeePlanReplacementWorkRecord, 'pool' | 'destination'>> = {}
  ) {
    const state = this.#journal.read(),
      row = this.row();
    if (phases.indexOf(phase) < phases.indexOf(row.phase))
      throw new PlanMoveError('Native target phase regressed', 409);
    await this.#journal.publish(state, { ...state, work: { ...row, ...extra, phase } });
    this.#journal.current();
  }
  async prepareNative() {
    const current = () => this.#journal.current();
    let row = this.row();
    await this.engine.validatePlanReplacement(row, current);
    current();
    await this.engine.prepareStorage(row, current);
    current();
    if (phases.indexOf(row.phase) < phases.indexOf('pool-issued')) {
      await this.phase('pool-issued');
      row = this.row();
    }
    // Original helpers own their own one-attempt cursors and native readbacks.
    if (phases.indexOf(row.phase) <= phases.indexOf('pool-issued')) {
      await this.resources.prepareRetainedPool(this.row(), current);
      current();
      const pool = await this.engine.observePool(this.row());
      current();
      if (!pool) throw new PlanMoveError('The original shared pool is unconfirmed', 409);
      await this.phase('pool-ready', { pool });
    }
    row = this.row();
    if (phases.indexOf(row.phase) < phases.indexOf('destination-issued')) {
      await this.phase('destination-issued');
      await this.engine.createPlanReplacementDestination(this.row(), current);
      current();
    }
    row = this.row();
    let seen = await this.engine.observePlanReplacementWork(row, current);
    current();
    if (!seen) throw new PlanMoveError('The original destination CREATE is unconfirmed', 409);
    if (row.phase === 'destination-issued') {
      await this.phase('destination-ready', { destination: seen.original });
      row = this.row();
    }
    if (row.phase === 'destination-ready') {
      if (seen.state !== 'stopped') throw new PlanMoveError('The original target START was not issued', 409);
      await this.phase('start-issued');
      await this.engine.start(this.row(), current);
      current();
    }
    row = this.row();
    seen = await this.engine.observePlanReplacementWork(row, current);
    current();
    if (!seen || seen.state !== 'running') throw new PlanMoveError('The original target START is unconfirmed', 409);
    if (row.phase === 'start-issued') await this.phase('container-running');
    row = this.row();
    if (row.phase === 'container-running') await this.phase('resources-issued');
    if (this.row().phase === 'resources-issued') {
      await this.engine.configureResources(this.row(), current);
      current();
      const read = await this.engine.observePlanReplacementWork(this.row(), current);
      current();
      if (!read || !same(read.resources, this.row().policy))
        throw new PlanMoveError('The original resource helper is unconfirmed', 409);
      seen = read;
      await this.phase('resources-ready');
    }
    // A completed helper cursor is historical DATA. Resuming later work still
    // requires fresh enforcement; an unconfirmed read never repeats configure.
    if (!same(seen.resources, this.row().policy))
      throw new PlanMoveError('The original resource enforcement is unconfirmed', 409);
  }
  /** Inspect/settle only original native metadata before epoch replacement. */
  async inspect(): Promise<void> {
    const current = () => this.#journal.current();
    let row = this.row();
    await this.engine.settlePlanReplacementStorage(row, current);
    current();
    await this.resources.settleObservedHelpers(this.row(), current);
    current();
    row = this.row();
    if (row.tasks?.some((t) => t.role === 'storage-holder')) {
      if ((await this.engine.observeStorage(row)) !== 'ready')
        throw new PlanMoveError('The original storage holder is unconfirmed', 409);
      current();
    }
    if (row.tasks?.some((t) => t.role === 'anchor' || t.role === 'pool-helper')) {
      const pool = await this.engine.observePool(row);
      current();
      if (!pool || (row.pool && !same(pool, row.pool)))
        throw new PlanMoveError('The original anchor or pool is unconfirmed', 409);
    }
    if (row.destination) {
      const destination = await this.engine.observePlanReplacementWork(row, current);
      current();
      if (!destination) throw new PlanMoveError('The original destination is unconfirmed', 409);
    }
    if (
      this.row().tasks?.some(
        (t) =>
          ['create-issued', 'start-issued', 'running'].includes(t.phase) &&
          !(t.phase === 'running' && ['anchor', 'storage-holder'].includes(t.role))
      )
    )
      throw new PlanMoveError('An original writer outcome is unconfirmed', 409);
  }
  close() {
    this.engine.close();
  }
}
