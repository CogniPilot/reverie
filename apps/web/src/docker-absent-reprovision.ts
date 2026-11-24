/** Owner workflow: reprovision an employee laptop whose recorded Docker
 * containers are absent. It retires the stuck continuation row into canonical
 * history and creates one inert replacement source. Identity, session,
 * generation, HOME/Nix storage and conversation are preserved; the ordinary
 * continuation then builds the destination. A failed inspect is never absence:
 * only an Engine listing that returns no container qualifies. */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CompanyService, CompanyError } from './company-service.js';
import type { CompanyEmployee, CompanyState } from './company-types.js';
import type { SessionState } from './types.js';
import { ownerStopPending } from './owner-stop-journal.js';
import { CompanyDockerContinuationStore } from './docker-employee-store.js';
import {
  DockerEmployeeContinuationError,
  dockerContinuationDigest,
  type DockerContinuationAuthority,
  type DockerContinuationSubject,
} from './docker-employee-continuation.js';
import { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { DockerEmployeeInspect, boxedOriginal } from './docker-employee-engine-data.js';
import type { DockerEngineCommand } from './docker-engine-command.js';
import {
  DockerAbsentContinuationRetirement,
  DockerAbsentReprovisionRequest,
  DockerLaptopTemplate,
  allowedReprovisionTransition,
  type DockerReprovisionAccount,
  type DockerReprovisionSourceCursor,
} from './docker-absent-reprovision-data.js';
import {
  REPROVISION_OPERATION_LABEL,
  REPROVISION_PURPOSE_LABEL,
  reprovisionAccount,
  reprovisionSourceConfiguration,
  reprovisionSourceName,
  reprovisionStorage,
  requireReprovisionEphemeralLayout,
  requireReprovisionSource,
} from './docker-absent-reprovision-source.js';
import {
  captureDockerAbsentSessionRetirement,
  dockerAbsentSessionReference,
} from './docker-absent-reprovision-proof.js';
function refuse(code: string, cause?: unknown): never {
  throw new DockerEmployeeContinuationError(code, 409, cause === undefined ? undefined : { cause });
}
const cid = /^[a-f0-9]{64}$/;
export interface DockerAbsentReprovisionConfiguration {
  readonly deployment: string;
  readonly boxId: string;
  readonly apiUrl: string;
  readonly workerImageId: string;
  readonly sourceImageIds: readonly string[];
}
/** The state service that owns state.json and the live application Sessions. */
export interface DockerAbsentReprovisionSessions {
  saved(sessionId: string): SessionState | undefined;
  live(sessionId: string): { readonly inert: boolean } | undefined;
  /** Why the saved launch denial could not be removed, before anything is retired. */
  blocked(sessionId: string, owner: string | undefined): string | undefined;
  /** The saved launch overrides, clamped exactly as the provider launch clamps them. */
  overrides(sessionId: string): Promise<Readonly<Record<string, string>> | undefined>;
  discard(sessionId: string): Promise<void>;
  clear(proof: unknown): Promise<'cleared' | 'unchanged'>;
}
export interface DockerAbsentReprovisionPlanMoves {
  openMoves(
    employeeId: string,
    owner: string | undefined
  ): Promise<readonly { id: string; docker: boolean; busy: boolean }[]>;
  abandonAbsentDockerMoves(
    employeeId: string,
    owner: string | undefined,
    abandonment: { version: 1; reason: 'recorded-containers-absent'; operationId: string; at: number },
    current: () => void
  ): Promise<readonly string[]>;
}
export interface DockerAbsentReprovisionResult {
  operationId: string;
  state: 'ready' | 'pending' | 'held';
  code?: string;
  sourceContainerId?: string;
  sourceImageId?: string;
}
type Network = { name: string; id: string };
/** Same closed name rule the deployment verifier applies to a worker bridge. */
/** Three bridge generations exist. Each binds the employee by label, or by the
 * full-identity name together with the per-worker purpose label. */
function officeBridgeLabels(labels: Record<string, string>, name: string, employeeId: string): boolean {
  if (labels['reverie.boxed.employee'] !== undefined) return labels['reverie.boxed.employee'] === employeeId;
  if (labels['reverie.box.purpose'] !== 'per-worker-office-api') return false;
  if (labels['reverie.box.employee'] !== undefined) return labels['reverie.box.employee'] === employeeId;
  return name === 'reverie-boxed-api-' + employeeId.replaceAll('-', '');
}
function workerBridgeName(name: string, employeeId: string): boolean {
  if (!name.startsWith('reverie-boxed-api-')) return false;
  const suffix = name.slice('reverie-boxed-api-'.length),
    prefix = employeeId.slice(0, 8);
  return (
    suffix === employeeId.replaceAll('-', '') ||
    suffix === prefix + '-bootstrap' ||
    new RegExp('^' + prefix + '-move[0-9a-f]{8}$').test(suffix)
  );
}
function persisted<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export class DockerAbsentReprovision {
  readonly #flights = new Set<string>();
  constructor(
    private readonly company: CompanyService,
    private readonly store: CompanyDockerContinuationStore,
    private readonly command: DockerEngineCommand,
    private readonly configuration: DockerAbsentReprovisionConfiguration,
    private readonly sessions: DockerAbsentReprovisionSessions,
    private readonly planMoves: () => DockerAbsentReprovisionPlanMoves | undefined,
    private readonly continuationBusy: (employeeId: string) => boolean,
    private readonly runtimeCurrent: () => void,
    private readonly now: () => number = Date.now
  ) {
    if (
      !(company instanceof CompanyService) ||
      !(store instanceof CompanyDockerContinuationStore) ||
      store.company !== company
    )
      throw Error('Actual boxed company owners required');
    if (!cid.test(configuration.boxId)) throw Error('Fixed boxed namespace required');
  }
  /** Positive inventory only. A command failure or foreign output is unknown. */
  async #listed(kind: 'container' | 'network', filters: readonly string[], format: string): Promise<string[]> {
    let text: string;
    try {
      text = await this.command.run([
        kind,
        'ls',
        ...(kind === 'container' ? ['--all'] : []),
        '--no-trunc',
        ...filters.flatMap((filter) => ['--filter', filter]),
        '--format',
        format,
      ]);
    } catch (cause) {
      return refuse('DOCKER_REPROVISION_ABSENCE_UNCONFIRMED', cause);
    }
    if (typeof text !== 'string') refuse('DOCKER_REPROVISION_ABSENCE_UNCONFIRMED');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  async #containers(filters: readonly string[]): Promise<string[]> {
    const ids = await this.#listed('container', filters, '{{.ID}}');
    if (ids.some((id) => !cid.test(id))) refuse('DOCKER_REPROVISION_ABSENCE_UNCONFIRMED');
    return ids;
  }
  #sources(employeeId: string): Promise<string[]> {
    return this.#containers([
      'label=reverie.employee=' + employeeId,
      'label=reverie.worker=' + this.configuration.deployment,
    ]);
  }
  /** Every recorded ID and every container still labelled for this employee. */
  async #present(ids: readonly string[], employeeId: string): Promise<string[]> {
    const found = new Set<string>();
    for (const id of ids) for (const seen of await this.#containers(['id=' + id])) found.add(seen);
    for (const seen of await this.#containers([
      'label=reverie.boxed.employee=' + employeeId,
      'label=reverie.boxed.instance=' + this.configuration.deployment,
    ]))
      found.add(seen);
    for (const seen of await this.#sources(employeeId)) found.add(seen);
    return [...found].sort();
  }
  async #imagePath(imageId: string): Promise<string | undefined> {
    try {
      const rows = z
        .array(
          z.object({ Id: z.string(), Config: z.object({ Env: z.array(z.string().max(16384)).max(256).nullable() }) })
        )
        .length(1)
        .parse(JSON.parse(await this.command.run(['image', 'inspect', imageId])));
      const paths = (rows[0]!.Config.Env ?? []).filter((value) => value.startsWith('PATH='));
      return rows[0]!.Id === imageId && paths.length === 1 ? paths[0] : undefined;
    } catch {
      return undefined;
    }
  }
  /** The qualified worker image is itself an accepted source; prefer it. */
  async #image(): Promise<{ imageId: string; path: string }> {
    const candidates = [...new Set([this.configuration.workerImageId, ...this.configuration.sourceImageIds])];
    for (const imageId of candidates) {
      const path = await this.#imagePath(imageId);
      if (path) return { imageId, path };
    }
    return refuse('DOCKER_REPROVISION_SOURCE_IMAGE_UNAVAILABLE');
  }
  /** The surviving per-worker office API bridge gives the laptop its only
   * network, as on an ordinary boxed destination. This workflow creates none. */
  async #network(
    employeeId: string,
    selected: string | undefined,
    discarded: readonly string[] = []
  ): Promise<{ network: Network; names: string[] }> {
    const rows = // Earlier bridge generations carry different labels; the name rule and
      // the inspected labels below bind each candidate to this employee.
      (await this.#listed('network', ['name=reverie-boxed-api-'], '{{.ID}} {{.Name}}')).map((line) => {
        const [id, name, ...rest] = line.split(' ');
        if (!id || !name || rest.length || !cid.test(id)) refuse('DOCKER_REPROVISION_OFFICE_NETWORK_UNCONFIRMED');
        return { id: id!, name: name! };
      });
    const candidates = rows.filter((row) => workerBridgeName(row.name, employeeId)),
      names = candidates.map((row) => row.name).sort();
    if (!candidates.length) refuse('DOCKER_REPROVISION_OFFICE_NETWORK_REQUIRED');
    const chosen = selected ? candidates.filter((row) => row.name === selected) : candidates;
    if (chosen.length !== 1)
      refuse(selected ? 'DOCKER_REPROVISION_OFFICE_NETWORK_REQUIRED' : 'DOCKER_REPROVISION_OFFICE_NETWORK_AMBIGUOUS');
    const network = chosen[0]!;
    let inspected: unknown;
    try {
      inspected = JSON.parse(await this.command.run(['network', 'inspect', network.id]));
    } catch (cause) {
      return refuse('DOCKER_REPROVISION_OFFICE_NETWORK_UNCONFIRMED', cause);
    }
    const parsed = z
      .array(
        z
          .object({
            Id: z.literal(network.id),
            Name: z.literal(network.name),
            Driver: z.literal('bridge'),
            Labels: z.record(z.string(), z.string()),
            Containers: z.record(z.string().regex(cid), z.unknown()),
          })
          .passthrough()
      )
      .length(1)
      .safeParse(inspected);
    // Exactly the office endpoint remains; another member is another laptop,
    // except the recorded containers this same operation is about to discard.
    if (
      !parsed.success ||
      !officeBridgeLabels(parsed.data[0]!.Labels, network.name, employeeId) ||
      Object.keys(parsed.data[0]!.Containers).filter((id) => !discarded.includes(id)).length !== 1
    )
      refuse('DOCKER_REPROVISION_OFFICE_NETWORK_CHANGED');
    return { network, names };
  }
  #entry(operationId: string, state = this.company.store.snapshot()) {
    return state.retiredDockerEmployeeContinuations?.find((row) => row.operationId === operationId);
  }
  #employee(employeeId: string, authority: DockerContinuationAuthority, state: CompanyState): CompanyEmployee {
    const rows = state.employees.filter((value) => value.id === employeeId),
      employee = rows[0];
    if (
      rows.length !== 1 ||
      !employee ||
      employee.owner !== authority.owner ||
      state.employees.filter((value) => value.sessionId === employee.sessionId).length !== 1
    )
      refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    if (employee!.bindingMigration || employee!.onVacation || employee!.desiredRunning === false)
      refuse('DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE');
    return employee!;
  }
  /** Synchronous canonical facts; re-read before and after every await. */
  #facts(employeeId: string, authority: DockerContinuationAuthority) {
    this.runtimeCurrent();
    authority.require();
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_REPROVISION_PUBLICATION_UNCONFIRMED');
    const state = this.company.store.snapshot(),
      employee = this.#employee(employeeId, authority, state);
    if (ownerStopPending(employee.sessionId)) refuse('DOCKER_REPROVISION_OWNER_STOP_PENDING');
    if (!this.company.employeeRecoveryAvailable(employeeId, employee.owner, state))
      refuse('DOCKER_REPROVISION_RECOVERY_PENDING');
    const rows = state.dockerEmployeeContinuations?.filter((value) => value.employeeId === employeeId) ?? [],
      row = rows[0];
    if (rows.length !== 1 || !row) refuse('DOCKER_REPROVISION_RECORD_REQUIRED');
    if (
      row!.owner !== employee.owner ||
      row!.request.sessionId !== employee.sessionId ||
      row!.request.sessionGeneration !== employee.sessionGeneration
    )
      refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    if (this.continuationBusy(employeeId)) refuse('DOCKER_REPROVISION_BUSY');
    const binding = employee.dockerBinding ?? null;
    const ids = [
      ...new Set([
        row!.original.containerId,
        ...(row!.destination ? [row!.destination.containerId] : []),
        ...(binding ? [binding.containerId] : []),
        ...(row!.version === 3 ? [row!.planReplacement.source.binding.containerId] : []),
      ]),
    ].sort();
    const saved = this.sessions.saved(employee.sessionId);
    if (!saved || saved.id !== employee.sessionId || saved.owner !== employee.owner || saved.remote)
      refuse('DOCKER_REPROVISION_SAVED_SESSION_REQUIRED');
    if (saved!.nativePlanRetiredBy !== undefined) refuse('DOCKER_REPROVISION_SESSION_RETIRED');
    const stale = dockerAbsentSessionReference(saved!.docker, {
      operationId: '',
      employeeId,
      owner: employee.owner,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      absent: ids,
    });
    if (saved!.docker && !stale) refuse('DOCKER_REPROVISION_SESSION_VIEW_FOREIGN');
    if (!stale && (saved!.providerDispatchHeld || saved!.terminalInputHeld)) refuse('DOCKER_REPROVISION_SESSION_HELD');
    if (this.sessions.live(employee.sessionId)?.inert === false) refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
    const blocked = this.sessions.blocked(employee.sessionId, employee.owner);
    if (blocked) refuse(blocked);
    return {
      employee,
      row: DockerEmployeeContinuationRecord.parse(persisted(row!)),
      binding,
      ids,
      savedContainer: stale ? saved!.docker!.containerName : null,
    };
  }
  #head(employeeId: string, state = this.company.store.snapshot()) {
    const entries = (state.retiredDockerEmployeeContinuations ?? []).filter((row) => row.employeeId === employeeId);
    const heads = entries.filter((row) => !entries.some((other) => other.previous === row.operationId));
    if (heads.length > 1) refuse('DOCKER_REPROVISION_HISTORY_AMBIGUOUS');
    return heads[0];
  }
  /** The record every later source of one employee derives from. */
  #basis(entry: DockerAbsentContinuationRetirement, state = this.company.store.snapshot()) {
    let at = entry;
    for (let depth = 0; depth < 256 && at.previous; depth++) {
      const before = this.#entry(at.previous, state);
      if (!before || before.employeeId !== entry.employeeId) refuse('DOCKER_REPROVISION_HISTORY_AMBIGUOUS');
      at = before!;
    }
    if (at.previous || !at.record || at.reason !== 'recorded-containers-absent')
      refuse('DOCKER_REPROVISION_HISTORY_AMBIGUOUS');
    return DockerEmployeeContinuationRecord.parse(persisted(at.record!));
  }
  async #account(basis: DockerEmployeeContinuationRecord, employee: CompanyEmployee, template: DockerLaptopTemplate) {
    // The profile is the owner's choice; the saved session's mode is what launches.
    const selected = employee.runtimeRecipe?.subscriptionProfile,
      mode = this.sessions.saved(employee.sessionId)?.mode ?? 'claude';
    return reprovisionAccount(
      basis,
      selected ? { id: selected.id, provider: selected.provider, mode } : undefined,
      await this.sessions.overrides(employee.sessionId),
      template
    );
  }
  /** A completed entry whose source may be replaced, when no continuation
   * record exists or the only one was begun from that exact source. */
  #replaceable(employeeId: string): boolean {
    const state = this.company.store.snapshot(),
      head = this.#head(employeeId, state),
      rows = state.dockerEmployeeContinuations?.filter((value) => value.employeeId === employeeId) ?? [];
    if (!head || head.source.phase !== 'created') return false;
    // A record that requested its destination is retired as a whole instead.
    const advanced =
      rows.length === 1 &&
      (!!rows[0]!.destination || !!state.employees.find((value) => value.id === employeeId)?.dockerBinding);
    return (
      rows.length === 0 || (rows.length === 1 && !advanced && rows[0]!.original.containerId === head.source.containerId)
    );
  }
  async #scope(employeeId: string, unchecked: unknown, authority: DockerContinuationAuthority) {
    this.runtimeCurrent();
    authority.require();
    return this.#replaceable(employeeId)
      ? this.replaceScope(employeeId, unchecked, authority)
      : this.absentScope(employeeId, unchecked, authority);
  }
  #replaceFacts(employeeId: string, authority: DockerContinuationAuthority) {
    this.runtimeCurrent();
    authority.require();
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_REPROVISION_PUBLICATION_UNCONFIRMED');
    const state = this.company.store.snapshot(),
      employee = this.#employee(employeeId, authority, state);
    if (ownerStopPending(employee.sessionId)) refuse('DOCKER_REPROVISION_OWNER_STOP_PENDING');
    if (!this.company.employeeRecoveryAvailable(employeeId, employee.owner, state))
      refuse('DOCKER_REPROVISION_RECOVERY_PENDING');
    if (this.continuationBusy(employeeId)) refuse('DOCKER_REPROVISION_BUSY');
    const head = this.#head(employeeId, state);
    if (
      !head ||
      head.source.phase !== 'created' ||
      head.session.phase !== 'cleared' ||
      (head.removal && head.removal.phase !== 'removed')
    )
      return refuse('DOCKER_REPROVISION_OPERATION_PENDING');
    if (
      head.owner !== employee.owner ||
      head.sessionId !== employee.sessionId ||
      head.sessionGeneration !== employee.sessionGeneration
    )
      refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    if (employee.dockerBinding) refuse('DOCKER_REPROVISION_CONTINUATION_ADVANCED');
    const rows = state.dockerEmployeeContinuations?.filter((value) => value.employeeId === employeeId) ?? [],
      row = rows[0] ? DockerEmployeeContinuationRecord.parse(persisted(rows[0])) : null;
    // Only a version 2 record that never requested a destination from this
    // exact source may be superseded. Anything later keeps its own workflow.
    if (
      rows.length > 1 ||
      (row &&
        (row.version !== 2 ||
          // An issued destination CREATE that produced no container is still
          // unrequested in effect: any created destination carries this
          // employee's label and holds the scope as a present container.
          !['staged', 'office-issued', 'office-ready', 'pool-issued', 'pool-ready', 'destination-issued'].includes(
            row.phase
          ) ||
          row.destination ||
          row.owner !== employee.owner ||
          row.request.sessionId !== employee.sessionId ||
          row.request.sessionGeneration !== employee.sessionGeneration ||
          row.original.containerId !== head.source.containerId ||
          row.tasks?.some((task) => !['storage-holder', 'anchor', 'pool-helper'].includes(task.role))))
    )
      refuse('DOCKER_REPROVISION_CONTINUATION_ADVANCED');
    const saved = this.sessions.saved(employee.sessionId);
    if (!saved || saved.id !== employee.sessionId || saved.owner !== employee.owner || saved.remote)
      refuse('DOCKER_REPROVISION_SAVED_SESSION_REQUIRED');
    if (saved!.nativePlanRetiredBy !== undefined) refuse('DOCKER_REPROVISION_SESSION_RETIRED');
    if (saved!.docker) refuse('DOCKER_REPROVISION_SESSION_VIEW_FOREIGN');
    if (saved!.providerDispatchHeld || saved!.terminalInputHeld) refuse('DOCKER_REPROVISION_SESSION_HELD');
    if (this.sessions.live(employee.sessionId)?.inert === false) refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
    // Storage holders the journal already owns: this record's and retired ones'.
    const holders = [row, ...(state.retiredDockerEmployeeContinuations ?? []).map((entry) => entry.record)]
      .filter((value) => value?.employeeId === employeeId)
      .flatMap((value) => value!.tasks ?? [])
      .flatMap((task) => (task.role === 'storage-holder' && 'containerId' in task ? [task.containerId] : []));
    return { employee, head, row, basis: this.#basis(head, state), holders: [...new Set(holders)].sort() };
  }
  /** Exactly the recorded source, never started. Its recorded name, operation
   * label, image and network are the fingerprint of the entry that created it. */
  async #unusedSource(head: DockerAbsentContinuationRetirement): Promise<void> {
    if (head.source.phase !== 'created') return refuse('DOCKER_REPROVISION_OPERATION_PENDING');
    let raw: DockerEmployeeInspect;
    try {
      raw = await this.#inspect(head.source.containerId);
    } catch (cause) {
      if (cause instanceof DockerEmployeeContinuationError) throw cause;
      return refuse('DOCKER_REPROVISION_SOURCE_UNCONFIRMED', cause);
    }
    const state = raw.State as { Status?: unknown; Pid?: unknown; StartedAt?: unknown },
      labels = raw.Config.Labels ?? {};
    if (
      (raw as { Name?: unknown }).Name !== '/' + head.source.name ||
      raw.Image !== head.source.imageId ||
      raw.HostConfig.NetworkMode !== head.source.network.name ||
      labels[REPROVISION_OPERATION_LABEL] !== head.operationId ||
      labels[REPROVISION_PURPOSE_LABEL] !== 'absent-laptop-source-v1' ||
      labels['reverie.worker'] !== this.configuration.deployment ||
      labels['reverie.employee'] !== head.employeeId ||
      labels['reverie.session'] !== head.sessionId
    )
      refuse('DOCKER_REPROVISION_SOURCE_CHANGED');
    if (
      raw.State.Running ||
      state.Status !== 'created' ||
      state.Pid !== 0 ||
      state.StartedAt !== '0001-01-01T00:00:00Z'
    )
      refuse('DOCKER_REPROVISION_SOURCE_STARTED');
  }
  /** Storage holders are labelled by employee. Each one must already belong to
   * this journal; they hold read-only directory handles and are left in place. */
  async #helpers(employeeId: string, known: readonly string[]): Promise<string[]> {
    const listed = await this.#containers([
      'label=reverie.box.storage.employee=' + employeeId,
      'label=reverie.box.storage.box=' + this.configuration.boxId,
    ]);
    if (listed.some((id) => !known.includes(id))) refuse('DOCKER_REPROVISION_HELPER_FOREIGN');
    return listed.sort();
  }
  private async replaceScope(employeeId: string, unchecked: unknown, authority: DockerContinuationAuthority) {
    const template = DockerLaptopTemplate.parse(unchecked),
      facts = this.#replaceFacts(employeeId, authority);
    const key = (value: typeof facts) =>
      dockerContinuationDigest({
        owner: value.employee.owner ?? null,
        sessionId: value.employee.sessionId,
        sessionGeneration: value.employee.sessionGeneration,
        name: value.employee.name,
        profile: value.employee.runtimeRecipe?.subscriptionProfile?.id ?? null,
        head: value.head,
        row: value.row,
        holders: value.holders,
      });
    const factsDigest = key(facts);
    const current = () => {
      if (key(this.#replaceFacts(employeeId, authority)) !== factsDigest) refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    };
    const sourceId = (facts.head.source as { containerId: string }).containerId;
    const storage = reprovisionStorage(facts.basis, template);
    const moves = this.planMoves();
    if (!moves) refuse('DOCKER_REPROVISION_PLAN_JOURNAL_UNAVAILABLE');
    const open = await moves!.openMoves(employeeId, facts.employee.owner);
    current();
    if (open.length) refuse('DOCKER_REPROVISION_PLAN_MOVE_ACTIVE');
    const listed = await this.#present([sourceId], employeeId);
    current();
    if (!listed.includes(sourceId)) refuse('DOCKER_REPROVISION_SOURCE_ABSENT');
    const present = listed.filter((id) => id !== sourceId);
    await this.#unusedSource(facts.head);
    current();
    const helpers = await this.#helpers(employeeId, facts.holders);
    current();
    const image = await this.#image();
    current();
    const { network, names } = await this.#network(employeeId, template.network);
    current();
    const account = await this.#account(facts.basis, facts.employee, template);
    current();
    requireReprovisionEphemeralLayout(
      this.#input(facts.basis, template, '', facts.employee.name, image, network, account)
    );
    const templateDigest = dockerContinuationDigest(template);
    const mode = facts.row ? ('retire' as const) : ('replace-source' as const),
      reason = facts.row ? ('source-superseded' as const) : ('source-replaced' as const);
    const scopeDigest = dockerContinuationDigest({
      purpose: 'docker-absent-reprovision-scope-v1',
      mode,
      reason,
      deployment: this.configuration.deployment,
      boxId: this.configuration.boxId,
      employeeId,
      owner: facts.employee.owner ?? null,
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      previous: dockerContinuationDigest(facts.head),
      record: dockerContinuationDigest(facts.row),
      present,
      helpers,
      sourceImageId: image.imageId,
      network,
      storage,
      account,
      templateDigest,
    });
    return {
      kind: 'replace' as const,
      mode,
      reason,
      template,
      templateDigest,
      facts,
      current,
      storage,
      present,
      helpers,
      image,
      network,
      names,
      account,
      sourceId,
      scopeDigest,
    };
  }
  private async absentScope(employeeId: string, unchecked: unknown, authority: DockerContinuationAuthority) {
    const template = DockerLaptopTemplate.parse(unchecked),
      facts = this.#facts(employeeId, authority);
    // Identity, record, binding and saved view; unrelated profile edits do not matter.
    const key = (value: typeof facts) =>
      dockerContinuationDigest({
        owner: value.employee.owner ?? null,
        sessionId: value.employee.sessionId,
        sessionGeneration: value.employee.sessionGeneration,
        name: value.employee.name,
        profile: value.employee.runtimeRecipe?.subscriptionProfile?.id ?? null,
        row: value.row,
        binding: value.binding,
        ids: value.ids,
        savedContainer: value.savedContainer,
      });
    const factsDigest = key(facts);
    const current = () => {
      if (key(this.#facts(employeeId, authority)) !== factsDigest) refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    };
    const storage = reprovisionStorage(facts.row, template);
    const moves = this.planMoves();
    if (!moves) refuse('DOCKER_REPROVISION_PLAN_JOURNAL_UNAVAILABLE');
    const open = await moves!.openMoves(employeeId, facts.employee.owner);
    current();
    if (open.some((move) => !move.docker || move.busy)) refuse('DOCKER_REPROVISION_PLAN_MOVE_ACTIVE');
    const present = await this.#present(facts.ids, employeeId);
    current();
    // A continuation that never reached ready has no retry for a failed
    // one-shot step (a resource helper, its one provider launch), and the
    // owner may move a stopped ready laptop to new storage. The recorded
    // containers may be discarded once each is stopped or proven to host
    // nothing beyond its own init; a laptop with a live tenant is refused.
    const discardable =
      present.length > 0 && present.every((id) => facts.ids.includes(id)) && !!this.command.removeIdleLaptop;
    const image = await this.#image();
    current();
    const { network, names } = await this.#network(employeeId, template.network, discardable ? present : []);
    current();
    const account = await this.#account(facts.row, facts.employee, template);
    current();
    requireReprovisionEphemeralLayout(
      this.#input(facts.row, template, '', facts.employee.name, image, network, account)
    );
    const templateDigest = dockerContinuationDigest(template);
    const scopeDigest = dockerContinuationDigest({
      purpose: 'docker-absent-reprovision-scope-v1',
      mode: 'retire',
      reason: 'recorded-containers-absent',
      account,
      deployment: this.configuration.deployment,
      boxId: this.configuration.boxId,
      employeeId,
      owner: facts.employee.owner ?? null,
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      record: dockerContinuationDigest(facts.row),
      binding: dockerContinuationDigest(facts.binding),
      absent: facts.ids,
      present,
      savedContainer: facts.savedContainer,
      planMoves: open.map((move) => move.id).sort(),
      sourceImageId: image.imageId,
      network,
      storage,
      templateDigest,
    });
    return {
      kind: 'absent' as const,
      mode: 'retire' as const,
      reason: 'recorded-containers-absent' as const,
      template,
      templateDigest,
      facts,
      current,
      storage,
      open,
      present,
      discardable,
      image,
      network,
      names,
      account,
      scopeDigest,
    };
  }
  #input(
    row: DockerEmployeeContinuationRecord,
    template: DockerLaptopTemplate,
    operationId: string,
    employeeName: string,
    image: { imageId: string; path: string },
    network: Network,
    account: DockerReprovisionAccount | undefined
  ) {
    return {
      row,
      template,
      operationId,
      deployment: this.configuration.deployment,
      employeeName,
      imageId: image.imageId,
      imagePath: image.path,
      network: network.name,
      apiUrl: this.configuration.apiUrl,
      ...(account ? { account } : {}),
    };
  }
  /** Read-only. The digest binds everything the confirmation will act on. */
  async preview(employeeId: string, template: unknown, authority: DockerContinuationAuthority) {
    const scope = await this.#scope(employeeId, template, authority),
      { facts } = scope,
      basis = scope.kind === 'absent' ? scope.facts.row : scope.facts.basis;
    return {
      mode: scope.mode,
      reason: scope.reason,
      employeeId,
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      record: facts.row
        ? { version: facts.row.version, phase: facts.row.phase, operationId: facts.row.request.operationId }
        : null,
      ...(scope.kind === 'replace'
        ? {
            previous: { operationId: scope.facts.head.operationId, sourceContainerId: scope.sourceId },
            helpers: scope.helpers,
          }
        : {}),
      absent: scope.kind === 'absent' ? scope.facts.ids.filter((id) => !scope.present.includes(id)) : [],
      present: scope.present,
      account: scope.account,
      home: basis.original.home,
      nixSource: scope.storage.nix,
      scratchSource: scope.storage.scratch,
      sourceImageId: scope.image.imageId,
      network: scope.network,
      networkCandidates: scope.names,
      planMoves: scope.kind === 'absent' ? scope.open.map((move) => move.id) : [],
      templateDigest: scope.templateDigest,
      scopeDigest: scope.scopeDigest,
      discard: scope.kind === 'absent' && scope.discardable ? scope.present : [],
      allowedActions:
        scope.present.length && !(scope.kind === 'absent' && scope.discardable) ? [] : (['reprovision'] as const),
      ...(scope.present.length && !(scope.kind === 'absent' && scope.discardable)
        ? { code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT' }
        : {}),
    };
  }
  async reprovision(
    employeeId: string,
    unchecked: unknown,
    authority: DockerContinuationAuthority
  ): Promise<DockerAbsentReprovisionResult> {
    const input = DockerAbsentReprovisionRequest.parse(unchecked);
    this.runtimeCurrent();
    authority.require();
    if (this.#flights.has(employeeId)) refuse('DOCKER_REPROVISION_BUSY');
    this.#flights.add(employeeId);
    try {
      let entry = this.#entry(input.operationId);
      if (!entry) {
        const scope = await this.#scope(employeeId, input.template, authority);
        if (
          input.sessionId !== scope.facts.employee.sessionId ||
          input.sessionGeneration !== scope.facts.employee.sessionGeneration
        )
          refuse('DOCKER_REPROVISION_TARGET_CHANGED');
        if (scope.present.length && !(scope.kind === 'absent' && scope.discardable))
          refuse('DOCKER_REPROVISION_CONTAINERS_PRESENT');
        if (input.expectedScopeDigest !== scope.scopeDigest) refuse('DOCKER_REPROVISION_SCOPE_CHANGED');
        if (scope.kind === 'absent' && scope.present.length) await this.#discard(scope.present, scope.current);
        entry =
          scope.kind === 'absent'
            ? await this.#retire(employeeId, input, authority, scope)
            : await this.#replace(employeeId, input, authority, scope);
      } else if (
        entry.employeeId !== employeeId ||
        entry.owner !== authority.owner ||
        entry.sessionId !== input.sessionId ||
        entry.sessionGeneration !== input.sessionGeneration ||
        entry.templateDigest !== dockerContinuationDigest(input.template)
      )
        refuse('DOCKER_REPROVISION_OPERATION_CHANGED');
      return await this.#resume(entry, authority);
    } finally {
      this.#flights.delete(employeeId);
    }
  }
  /** Each container is removed only after the Engine shows it hosts no process
   * beyond its own init, and never by force. Home, Nix and scratch are binds. */
  async #discard(ids: readonly string[], current: () => void): Promise<void> {
    for (const id of ids) {
      current();
      try {
        await this.command.removeIdleLaptop!(id, current);
      } catch (cause) {
        if (cause instanceof DockerEmployeeContinuationError) throw cause;
        refuse('DOCKER_REPROVISION_REMOVAL_UNCONFIRMED', cause);
      }
    }
  }
  /** Effect A. Intent (the retirement entry) is canonical before any state
   * service or Engine effect; the row and binding move in one transaction. */
  async #retire(
    employeeId: string,
    input: DockerAbsentReprovisionRequest,
    authority: DockerContinuationAuthority,
    scope: Awaited<ReturnType<DockerAbsentReprovision['absentScope']>>
  ): Promise<DockerAbsentContinuationRetirement> {
    const { facts } = scope;
    if (input.operationId === facts.row.request.operationId) refuse('DOCKER_REPROVISION_OPERATION_CHANGED');
    const at = this.now();
    // One history per employee: a later retirement names the entry it follows.
    const head = this.#head(employeeId);
    let planMoveIds: readonly string[] = [];
    if (scope.open.length) {
      try {
        planMoveIds = await this.planMoves()!.abandonAbsentDockerMoves(
          employeeId,
          facts.employee.owner,
          { version: 1, reason: 'recorded-containers-absent', operationId: input.operationId, at },
          scope.current
        );
      } catch (cause) {
        if (cause instanceof DockerEmployeeContinuationError || cause instanceof CompanyError) throw cause;
        refuse('DOCKER_REPROVISION_PLAN_MOVE_UNCONFIRMED', cause);
      }
    }
    scope.current();
    // Bracket the canonical write with a second positive inventory.
    if ((await this.#present(facts.ids, employeeId)).length) refuse('DOCKER_REPROVISION_CONTAINERS_PRESENT');
    scope.current();
    const entry = DockerAbsentContinuationRetirement.parse({
      version: 1,
      purpose: 'docker-absent-continuation-retirement-v1',
      retiredAt: at,
      operationId: input.operationId,
      reason: 'recorded-containers-absent',
      ...(head ? { previous: head.operationId } : {}),
      employeeId,
      ...(facts.employee.owner === undefined ? {} : { owner: facts.employee.owner }),
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      scopeDigest: scope.scopeDigest,
      templateDigest: scope.templateDigest,
      template: scope.template,
      absent: { containerIds: facts.ids, planMoveIds: [...planMoveIds].sort() },
      account: scope.account,
      record: facts.row,
      binding: facts.binding,
      session: { phase: 'pending', containerName: facts.savedContainer },
      source: { phase: 'pending' },
    });
    const authorityCurrent = () => {
      this.runtimeCurrent();
      authority.require();
    };
    await this.company.store.update((state) => {
      authorityCurrent();
      const employee = this.#employee(employeeId, authority, state),
        rows = state.dockerEmployeeContinuations ?? [],
        index = rows.findIndex((value) => value.employeeId === employeeId);
      if (
        index < 0 ||
        !isDeepStrictEqual(persisted(rows[index]), persisted(facts.row)) ||
        !isDeepStrictEqual(persisted(employee.dockerBinding ?? null), persisted(facts.binding)) ||
        employee.sessionId !== entry.sessionId ||
        employee.sessionGeneration !== entry.sessionGeneration ||
        this.#entry(entry.operationId, state)
      )
        refuse('DOCKER_REPROVISION_TARGET_CHANGED');
      rows.splice(index, 1);
      delete employee.dockerBinding;
      (state.retiredDockerEmployeeContinuations ??= []).push(structuredClone(entry));
    }, authorityCurrent);
    return entry;
  }
  /** Replace an unused source. The new entry (intent) is canonical before the
   * old source is removed; a superseded record moves in the same transaction.
   * Its storage holder and the shared pool anchor are not touched. */
  async #replace(
    employeeId: string,
    input: DockerAbsentReprovisionRequest,
    authority: DockerContinuationAuthority,
    scope: Awaited<ReturnType<DockerAbsentReprovision['replaceScope']>>
  ): Promise<DockerAbsentContinuationRetirement> {
    const { facts } = scope,
      head = facts.head;
    if (head.source.phase !== 'created') return refuse('DOCKER_REPROVISION_OPERATION_PENDING');
    if (input.operationId === facts.row?.request.operationId) refuse('DOCKER_REPROVISION_OPERATION_CHANGED');
    // Bracket the canonical write with a second positive inventory.
    const listed = await this.#present([scope.sourceId], employeeId);
    scope.current();
    if (listed.length !== 1 || listed[0] !== scope.sourceId) refuse('DOCKER_REPROVISION_CONTAINERS_PRESENT');
    await this.#unusedSource(head);
    scope.current();
    const entry = DockerAbsentContinuationRetirement.parse({
      version: 1,
      purpose: 'docker-absent-continuation-retirement-v1',
      retiredAt: this.now(),
      operationId: input.operationId,
      reason: scope.reason,
      previous: head.operationId,
      employeeId,
      ...(facts.employee.owner === undefined ? {} : { owner: facts.employee.owner }),
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      scopeDigest: scope.scopeDigest,
      templateDigest: scope.templateDigest,
      template: scope.template,
      absent: { containerIds: [], planMoveIds: [] },
      account: scope.account,
      removal: { phase: 'pending', name: head.source.name, containerId: scope.sourceId },
      ...(facts.row ? { record: facts.row } : {}),
      binding: null,
      session: { phase: 'cleared', containerName: null },
      source: { phase: 'pending' },
    });
    const authorityCurrent = () => {
      this.runtimeCurrent();
      authority.require();
    };
    await this.company.store.update((state) => {
      authorityCurrent();
      const employee = this.#employee(employeeId, authority, state),
        rows = state.dockerEmployeeContinuations ?? [],
        mine = rows.filter((value) => value.employeeId === employeeId),
        actual = this.#head(employeeId, state);
      if (
        !actual ||
        !isDeepStrictEqual(persisted(actual), persisted(head)) ||
        employee.dockerBinding ||
        employee.sessionId !== entry.sessionId ||
        employee.sessionGeneration !== entry.sessionGeneration ||
        mine.length !== (facts.row ? 1 : 0) ||
        (facts.row && !isDeepStrictEqual(persisted(mine[0]), persisted(facts.row))) ||
        this.#entry(entry.operationId, state)
      )
        refuse('DOCKER_REPROVISION_TARGET_CHANGED');
      if (facts.row) rows.splice(rows.indexOf(mine[0]!), 1);
      (state.retiredDockerEmployeeContinuations ??= []).push(structuredClone(entry));
    }, authorityCurrent);
    return entry;
  }
  /** An issued removal is settled by a positive listing. The never-started
   * source is re-proven immediately before each removal request. */
  async #remove(
    initial: DockerAbsentContinuationRetirement,
    current: () => void
  ): Promise<DockerAbsentContinuationRetirement> {
    let entry = initial;
    const removal = entry.removal!,
      previous = this.#entry(entry.previous!);
    if (!previous || previous.source.phase !== 'created' || previous.source.containerId !== removal.containerId)
      return refuse('DOCKER_REPROVISION_HISTORY_AMBIGUOUS');
    if (removal.phase === 'pending') {
      await this.#unusedSource(previous);
      current();
      entry = await this.#publish(entry, { removal: { ...removal, phase: 'issued' } }, current);
    }
    if ((await this.#containers(['id=' + removal.containerId])).length) {
      current();
      await this.#unusedSource(previous);
      current();
      if (!this.command.removeCreatedSource) return refuse('DOCKER_REPROVISION_REMOVAL_UNAVAILABLE');
      await this.command.removeCreatedSource(removal.name, removal.containerId, current);
      current();
      if ((await this.#containers(['id=' + removal.containerId])).length)
        refuse('DOCKER_REPROVISION_REMOVAL_UNCONFIRMED');
    }
    current();
    return this.#publish(entry, { removal: { ...removal, phase: 'removed' } }, current);
  }
  async #publish(
    before: DockerAbsentContinuationRetirement,
    change: Partial<Pick<DockerAbsentContinuationRetirement, 'session' | 'source' | 'removal'>>,
    current: () => void
  ): Promise<DockerAbsentContinuationRetirement> {
    const next = DockerAbsentContinuationRetirement.parse({ ...before, ...change });
    if (!allowedReprovisionTransition(before, next)) refuse('DOCKER_REPROVISION_RETIREMENT_CHANGED');
    await this.company.store.update((state) => {
      current();
      const rows = state.retiredDockerEmployeeContinuations ?? [],
        index = rows.findIndex((row) => row.operationId === before.operationId);
      if (index < 0 || !isDeepStrictEqual(persisted(rows[index]), persisted(before)))
        refuse('DOCKER_REPROVISION_RETIREMENT_CHANGED');
      rows[index] = structuredClone(next);
    }, current);
    return next;
  }
  async #resume(
    initial: DockerAbsentContinuationRetirement,
    authority: DockerContinuationAuthority
  ): Promise<DockerAbsentReprovisionResult> {
    const result = (entry: DockerAbsentContinuationRetirement, code?: string): DockerAbsentReprovisionResult => ({
      operationId: entry.operationId,
      state: code ? 'held' : 'ready',
      ...(code ? { code } : {}),
      ...(entry.source.phase === 'created'
        ? { sourceContainerId: entry.source.containerId, sourceImageId: entry.source.imageId }
        : {}),
    });
    // A completed operation replays its recorded result without new effects.
    if (
      initial.session.phase === 'cleared' &&
      initial.source.phase === 'created' &&
      (!initial.removal || initial.removal.phase === 'removed')
    )
      return result(initial);
    let entry = initial;
    const current = () => {
      this.runtimeCurrent();
      authority.require();
      if (this.company.store.publicationUnconfirmed) refuse('DOCKER_REPROVISION_PUBLICATION_UNCONFIRMED');
      const state = this.company.store.snapshot(),
        employee = this.#employee(entry.employeeId, authority, state);
      if (
        employee.sessionId !== entry.sessionId ||
        employee.sessionGeneration !== entry.sessionGeneration ||
        employee.dockerBinding ||
        state.dockerEmployeeContinuations?.some((row) => row.employeeId === entry.employeeId)
      )
        refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    };
    try {
      current();
      if (entry.session.phase === 'pending') entry = await this.#clearSession(entry, current);
      if (entry.removal && entry.removal.phase !== 'removed') entry = await this.#remove(entry, current);
      entry = await this.#source(entry, current);
      return result(entry);
    } catch (cause) {
      if (cause instanceof CompanyError) throw cause;
      const latest = this.#entry(initial.operationId) ?? entry;
      return result(
        latest,
        cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_REPROVISION_EFFECT_UNCONFIRMED'
      );
    }
  }
  /** Through the state service only; this class never writes state.json. */
  async #clearSession(
    entry: DockerAbsentContinuationRetirement,
    current: () => void
  ): Promise<DockerAbsentContinuationRetirement> {
    const live = this.sessions.live(entry.sessionId);
    if (live) {
      // A stale viewer object would carry its loaded launch denial into the
      // next first launch. Only an inert one may be discarded.
      if (!live.inert) refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
      await this.sessions.discard(entry.sessionId);
      current();
      if (this.sessions.live(entry.sessionId)) refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
    }
    const proof = captureDockerAbsentSessionRetirement(this.company, entry.operationId, current);
    await this.sessions.clear(proof);
    current();
    const saved = this.sessions.saved(entry.sessionId);
    if (!saved || saved.docker || !this.store.subject(entry.employeeId))
      refuse('DOCKER_REPROVISION_SESSION_UNCONFIRMED');
    return this.#publish(entry, { session: { ...entry.session, phase: 'cleared' } }, current);
  }
  async #inspect(id: string): Promise<DockerEmployeeInspect> {
    const rows = z
      .array(DockerEmployeeInspect)
      .length(1)
      .parse(JSON.parse(await this.command.run(['container', 'inspect', id])));
    if (rows[0]!.Id !== id) refuse('DOCKER_REPROVISION_SOURCE_CHANGED');
    return rows[0]!;
  }
  /** Effect B. One inert source; an issued CREATE is settled by observation. */
  async #source(
    initial: DockerAbsentContinuationRetirement,
    current: () => void
  ): Promise<DockerAbsentContinuationRetirement> {
    let entry = initial;
    if (entry.source.phase === 'created') return entry;
    const name = reprovisionSourceName(this.configuration.boxId, entry.operationId);
    const employee = this.company.store.snapshot().employees.find((value) => value.id === entry.employeeId)!;
    let image: { imageId: string; path: string }, network: Network;
    if (entry.source.phase === 'pending') {
      image = await this.#image();
      current();
      network = (await this.#network(entry.employeeId, entry.template.network)).network;
      current();
    } else {
      const path = await this.#imagePath(entry.source.imageId);
      current();
      if (!path) refuse('DOCKER_REPROVISION_SOURCE_IMAGE_UNAVAILABLE');
      image = { imageId: entry.source.imageId, path: path! };
      network = entry.source.network;
    }
    const basis = this.#basis(entry);
    const input = this.#input(basis, entry.template, entry.operationId, employee.name, image, network, entry.account);
    const configuration = reprovisionSourceConfiguration(input),
      configurationDigest = dockerContinuationDigest(configuration);
    if (entry.source.phase === 'pending') {
      requireReprovisionEphemeralLayout(input);
      if ((await this.#sources(entry.employeeId)).length) refuse('DOCKER_REPROVISION_CONTAINERS_PRESENT');
      current();
      const issued: DockerReprovisionSourceCursor = {
        phase: 'issued',
        name,
        imageId: image.imageId,
        network,
        configurationDigest,
      };
      entry = await this.#publish(entry, { source: issued }, current);
    } else if (entry.source.name !== name || entry.source.configurationDigest !== configurationDigest)
      refuse('DOCKER_REPROVISION_SOURCE_INTENT_CHANGED');
    const seen = await this.#sources(entry.employeeId);
    current();
    if (seen.length > 1) refuse('DOCKER_REPROVISION_SOURCE_AMBIGUOUS');
    // The deterministic name is unique in the Engine, so a positively empty
    // listing after an issued intent cannot hide an earlier success.
    if (!seen.length) {
      // The broker's ordinary image preparation, before the laptop exists:
      // the destination image's tools resolve only inside this private store.
      if (!this.command.prepareWorkerStore) return refuse('DOCKER_REPROVISION_STORE_PREPARATION_UNAVAILABLE');
      try {
        await this.command.prepareWorkerStore(
          'reverie-boxed-nix-prepare-' + entry.operationId.replaceAll('-', ''),
          {
            imageId: this.configuration.workerImageId,
            user: entry.template.user,
            nixSource: reprovisionStorage(basis, entry.template).nix,
          },
          current
        );
      } catch (cause) {
        if (cause instanceof DockerEmployeeContinuationError) throw cause;
        refuse('DOCKER_REPROVISION_STORE_PREPARATION_UNCONFIRMED', cause);
      }
      current();
    }
    const id = seen[0] ?? (await this.command.create(name, configuration, current));
    current();
    const raw = await this.#inspect(id);
    current();
    requireReprovisionSource(raw, name, configuration);
    const original = boxedOriginal(
      raw,
      { employeeId: entry.employeeId, sessionId: entry.sessionId } as DockerContinuationSubject,
      this.configuration.deployment
    );
    if (!isDeepStrictEqual(original.home, basis.original.home)) refuse('DOCKER_REPROVISION_SOURCE_CHANGED');
    if (entry.source.phase !== 'issued') refuse('DOCKER_REPROVISION_RETIREMENT_CHANGED');
    return this.#publish(entry, { source: { ...entry.source, phase: 'created', containerId: id } }, current);
  }
}
