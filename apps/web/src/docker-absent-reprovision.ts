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
  type DockerReprovisionSourceCursor,
} from './docker-absent-reprovision-data.js';
import {
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
  async #network(employeeId: string, selected: string | undefined): Promise<{ network: Network; names: string[] }> {
    const rows = (
      await this.#listed('network', ['label=reverie.boxed.employee=' + employeeId], '{{.ID}} {{.Name}}')
    ).map((line) => {
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
    // Exactly the office endpoint remains; another member is another laptop.
    if (
      !parsed.success ||
      parsed.data[0]!.Labels['reverie.boxed.employee'] !== employeeId ||
      Object.keys(parsed.data[0]!.Containers).length !== 1
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
  async #scope(employeeId: string, unchecked: unknown, authority: DockerContinuationAuthority) {
    const template = DockerLaptopTemplate.parse(unchecked),
      facts = this.#facts(employeeId, authority);
    // Identity, record, binding and saved view; unrelated profile edits do not matter.
    const key = (value: typeof facts) =>
      dockerContinuationDigest({
        owner: value.employee.owner ?? null,
        sessionId: value.employee.sessionId,
        sessionGeneration: value.employee.sessionGeneration,
        name: value.employee.name,
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
    const image = await this.#image();
    current();
    const { network, names } = await this.#network(employeeId, template.network);
    current();
    requireReprovisionEphemeralLayout(this.#input(facts.row, template, '', facts.employee.name, image, network));
    const templateDigest = dockerContinuationDigest(template);
    const scopeDigest = dockerContinuationDigest({
      purpose: 'docker-absent-reprovision-scope-v1',
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
    return { template, templateDigest, facts, current, storage, open, present, image, network, names, scopeDigest };
  }
  #input(
    row: DockerEmployeeContinuationRecord,
    template: DockerLaptopTemplate,
    operationId: string,
    employeeName: string,
    image: { imageId: string; path: string },
    network: Network
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
    };
  }
  /** Read-only. The digest binds everything the confirmation will act on. */
  async preview(employeeId: string, template: unknown, authority: DockerContinuationAuthority) {
    const scope = await this.#scope(employeeId, template, authority),
      { facts } = scope;
    return {
      employeeId,
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      record: { version: facts.row.version, phase: facts.row.phase, operationId: facts.row.request.operationId },
      absent: facts.ids.filter((id) => !scope.present.includes(id)),
      present: scope.present,
      home: facts.row.original.home,
      nixSource: scope.storage.nix,
      scratchSource: scope.storage.scratch,
      sourceImageId: scope.image.imageId,
      network: scope.network,
      networkCandidates: scope.names,
      planMoves: scope.open.map((move) => move.id),
      templateDigest: scope.templateDigest,
      scopeDigest: scope.scopeDigest,
      allowedActions: scope.present.length ? [] : (['reprovision'] as const),
      ...(scope.present.length ? { code: 'DOCKER_REPROVISION_CONTAINERS_PRESENT' } : {}),
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
      if (!entry) entry = await this.#retire(employeeId, input, authority);
      else if (
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
  /** Effect A. Intent (the retirement entry) is canonical before any state
   * service or Engine effect; the row and binding move in one transaction. */
  async #retire(
    employeeId: string,
    input: DockerAbsentReprovisionRequest,
    authority: DockerContinuationAuthority
  ): Promise<DockerAbsentContinuationRetirement> {
    const scope = await this.#scope(employeeId, input.template, authority),
      { facts } = scope;
    if (input.sessionId !== facts.employee.sessionId || input.sessionGeneration !== facts.employee.sessionGeneration)
      refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    if (scope.present.length) refuse('DOCKER_REPROVISION_CONTAINERS_PRESENT');
    if (input.expectedScopeDigest !== scope.scopeDigest) refuse('DOCKER_REPROVISION_SCOPE_CHANGED');
    if (input.operationId === facts.row.request.operationId) refuse('DOCKER_REPROVISION_OPERATION_CHANGED');
    const at = this.now();
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
      employeeId,
      ...(facts.employee.owner === undefined ? {} : { owner: facts.employee.owner }),
      sessionId: facts.employee.sessionId,
      sessionGeneration: facts.employee.sessionGeneration,
      scopeDigest: scope.scopeDigest,
      templateDigest: scope.templateDigest,
      template: scope.template,
      absent: { containerIds: facts.ids, planMoveIds: [...planMoveIds].sort() },
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
  async #publish(
    before: DockerAbsentContinuationRetirement,
    change: Partial<Pick<DockerAbsentContinuationRetirement, 'session' | 'source'>>,
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
    if (initial.session.phase === 'cleared' && initial.source.phase === 'created') return result(initial);
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
    const input = this.#input(entry.record, entry.template, entry.operationId, employee.name, image, network);
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
    if (!isDeepStrictEqual(original.home, entry.record.original.home)) refuse('DOCKER_REPROVISION_SOURCE_CHANGED');
    if (entry.source.phase !== 'issued') refuse('DOCKER_REPROVISION_RETIREMENT_CHANGED');
    return this.#publish(entry, { source: { ...entry.source, phase: 'created', containerId: id } }, current);
  }
}
