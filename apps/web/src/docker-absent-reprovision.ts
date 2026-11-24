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
import {
  dockerLaptopContainerProven,
  type DockerEngineCommand,
  type DockerLaptopContainerProof,
} from './docker-engine-command.js';
import {
  DockerAbsentContinuationRetirement,
  DockerAbsentReprovisionRequest,
  DockerLaptopRebuildRequest,
  DockerLaptopTemplate,
  REPROVISION_ACCOUNT_ROOT,
  allowedReprovisionTransition,
  type DockerReprovisionAccount,
  type DockerReprovisionSourceCursor,
} from './docker-absent-reprovision-data.js';
import {
  REPROVISION_OPERATION_LABEL,
  REPROVISION_PURPOSE_LABEL,
  reprovisionAccount,
  reprovisionSeatSource,
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
  /** `container` names the boxed laptop a live viewer is attached to, if any. */
  live(sessionId: string): { readonly inert: boolean; readonly container?: string } | undefined;
  /** Why the saved launch denial could not be removed, before anything is retired.
   * `discardingViewer` says the caller is the owner's rebuild and will discard
   * the live boxed viewer of this session: the launch that viewer itself owns
   * is then not a reason, while any other live launch still is. */
  blocked(sessionId: string, owner: string | undefined, discardingViewer?: boolean): string | undefined;
  /** Whether a launch this office process made is still owned by the live
   * boxed viewer of this session. Discarding that viewer releases it. */
  viewerLaunchOwned?(sessionId: string): boolean;
  /** The saved launch overrides, clamped exactly as the provider launch clamps them. */
  overrides(sessionId: string): Promise<Readonly<Record<string, string>> | undefined>;
  discard(sessionId: string): Promise<void>;
  /** Forget the office-side viewer of a boxed laptop whose own container the
   * Engine positively reports absent. Local terminal objects only; the saved
   * session record is kept. Used by the owner's rebuild alone. */
  discardView?(sessionId: string, containerAbsent: (containerId: string) => Promise<boolean>): Promise<void>;
  clear(proof: unknown): Promise<'cleared' | 'unchanged'>;
}
/** The office's own signed-in copy of one plan account, held until closed. */
export interface DockerSeatSignIn {
  authText(): string;
  close(): void;
}
export interface DockerAbsentReprovisionSeatAccounts {
  /** Undefined when the office holds no usable sign-in for that plan. The
   * profile ID is the employee's owner-selected one; no request names it. */
  capture(
    profileId: string,
    provider: 'anthropic' | 'openai',
    current: () => void
  ): Promise<DockerSeatSignIn | undefined>;
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
  /** Containers named by the moves the owner abandoned for this employee. */
  ownerAbandonedContainers?(
    employeeId: string,
    owner: string | undefined
  ): Promise<
    readonly {
      moveId: string;
      containers: {
        source: string;
        target?: string;
        sourceHolder?: string;
        helpers: readonly { role: 'storage-holder' | 'leaf-helper' | 'identity-helper'; containerId: string }[];
      };
    }[]
  >;
}
/** One container the owner's rebuild will stop (if running) and remove. */
export interface DockerRebuildDiscard {
  readonly containerId: string;
  readonly role: 'laptop' | 'source-holder' | 'storage-holder' | 'leaf-helper' | 'identity-helper';
  readonly running: boolean;
  readonly proof: DockerLaptopContainerProof;
}
export interface DockerAbsentReprovisionResult {
  operationId: string;
  state: 'ready' | 'pending' | 'held';
  code?: string;
  sourceContainerId?: string;
  sourceImageId?: string;
  /** Where in the laptop the mount whose host folder is missing would appear. */
  missingMountTarget?: string;
  /** The plan the office is not signed in to. */
  seatProfile?: { id: string; label?: string };
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
/** The two facts a hold may name beside its code: the laptop-side target of a
 * mount whose host folder is missing, and the plan that needs a sign-in. */
export function dockerReprovisionHoldDetail(
  cause: unknown
): Pick<DockerAbsentReprovisionResult, 'missingMountTarget' | 'seatProfile'> {
  if (!(cause instanceof DockerEmployeeContinuationError)) return {};
  const detail = cause.cause as
    | { missingMountTarget?: unknown; seatProfile?: { id?: unknown; label?: unknown } }
    | undefined;
  if (cause.code === 'DOCKER_CONTINUATION_CREATE_BIND_SOURCE_MISSING' && typeof detail?.missingMountTarget === 'string')
    return { missingMountTarget: detail.missingMountTarget };
  const profile = detail?.seatProfile;
  if (
    cause.code === 'DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT' &&
    typeof profile?.id === 'string' &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile.id)
  )
    return {
      seatProfile: {
        id: profile.id,
        ...(typeof profile.label === 'string' ? { label: profile.label.slice(0, 100) } : {}),
      },
    };
  return {};
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
    private readonly now: () => number = Date.now,
    private readonly seatAccounts: () => DockerAbsentReprovisionSeatAccounts | undefined = () => undefined
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
      // The names let the owner choose one with `template.network`.
      refuse(selected ? 'DOCKER_REPROVISION_OFFICE_NETWORK_REQUIRED' : 'DOCKER_REPROVISION_OFFICE_NETWORK_AMBIGUOUS', {
        networkCandidates: names,
      });
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
  #employee(
    employeeId: string,
    authority: DockerContinuationAuthority,
    state: CompanyState,
    rebuild = false
  ): CompanyEmployee {
    const rows = state.employees.filter((value) => value.id === employeeId),
      employee = rows[0];
    if (
      rows.length !== 1 ||
      !employee ||
      employee.owner !== authority.owner ||
      state.employees.filter((value) => value.sessionId === employee.sessionId).length !== 1
    )
      refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    // The owner's rebuild also serves an employee who is out of the office: it
    // creates only an inert source, and the continuation that follows still
    // needs its own explicit enter-office decision before anything runs.
    if (employee!.bindingMigration || (!rebuild && (employee!.onVacation || employee!.desiredRunning === false)))
      refuse('DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE');
    return employee!;
  }
  /** Synchronous canonical facts; re-read before and after every await. */
  #facts(employeeId: string, authority: DockerContinuationAuthority, rebuild = false) {
    this.runtimeCurrent();
    authority.require();
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_REPROVISION_PUBLICATION_UNCONFIRMED');
    const state = this.company.store.snapshot(),
      employee = this.#employee(employeeId, authority, state, rebuild);
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
    // A rebuild discards the live viewer itself, once its laptop is gone.
    if (!rebuild && this.sessions.live(employee.sessionId)?.inert === false)
      refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
    // A rebuild discards the live boxed viewer, and with it the launch that
    // viewer owns; without the means to discard it, that launch still blocks.
    const blocked = this.sessions.blocked(
      employee.sessionId,
      employee.owner,
      rebuild && !!this.sessions.discardView && this.sessions.live(employee.sessionId)?.container !== undefined
    );
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
  async #scope(employeeId: string, unchecked: unknown, authority: DockerContinuationAuthority, rebuild = false) {
    this.runtimeCurrent();
    authority.require();
    return this.#replaceable(employeeId)
      ? this.replaceScope(employeeId, unchecked, authority, rebuild)
      : this.absentScope(employeeId, unchecked, authority, rebuild);
  }
  #replaceFacts(employeeId: string, authority: DockerContinuationAuthority, rebuild = false) {
    this.runtimeCurrent();
    authority.require();
    if (this.company.store.publicationUnconfirmed) refuse('DOCKER_REPROVISION_PUBLICATION_UNCONFIRMED');
    const state = this.company.store.snapshot(),
      employee = this.#employee(employeeId, authority, state, rebuild);
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
    if (!rebuild && this.sessions.live(employee.sessionId)?.inert === false)
      refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
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
  private async replaceScope(
    employeeId: string,
    unchecked: unknown,
    authority: DockerContinuationAuthority,
    rebuild = false
  ) {
    const template = DockerLaptopTemplate.parse(unchecked),
      facts = this.#replaceFacts(employeeId, authority, rebuild);
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
      if (key(this.#replaceFacts(employeeId, authority, rebuild)) !== factsDigest)
        refuse('DOCKER_REPROVISION_TARGET_CHANGED');
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
      this.#input(facts.basis, template, '', facts.employee.name, image, network, account, facts.employee.sessionId)
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
  private async absentScope(
    employeeId: string,
    unchecked: unknown,
    authority: DockerContinuationAuthority,
    rebuild = false
  ) {
    const template = DockerLaptopTemplate.parse(unchecked),
      facts = this.#facts(employeeId, authority, rebuild);
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
      if (key(this.#facts(employeeId, authority, rebuild)) !== factsDigest) refuse('DOCKER_REPROVISION_TARGET_CHANGED');
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
      this.#input(facts.row, template, '', facts.employee.name, image, network, account, facts.employee.sessionId)
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
    account: DockerReprovisionAccount | undefined,
    sessionId: string
  ) {
    return {
      row,
      sessionId,
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
        // Before anything is discarded or retired: a seat that cannot be signed in stops here.
        await this.#seat(
          input.operationId,
          scope.account,
          scope.kind === 'absent' ? scope.facts.row : scope.facts.basis,
          scope.template,
          scope.current
        );
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
  /** One listed container, or undefined when the Engine positively lists none
   * under that ID. A failed read is unknown, never absence. */
  async #listedContainer(id: string) {
    if (!(await this.#containers(['id=' + id])).includes(id)) return undefined;
    try {
      const rows = z
        .array(
          z
            .object({
              Id: z.literal(id),
              Name: z.string().max(256),
              State: z.object({ Running: z.boolean() }).passthrough(),
              Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }).passthrough(),
            })
            .passthrough()
        )
        .length(1)
        .parse(JSON.parse(await this.command.run(['container', 'inspect', id])));
      return rows[0]!;
    } catch (cause) {
      return refuse('DOCKER_REPROVISION_ABSENCE_UNCONFIRMED', cause);
    }
  }
  /** Everything the owner's rebuild would discard, each bound to this employee:
   * laptops by the employee and deployment labels their creator set (or by the
   * employee's own canonical record), and the holder and helpers that a move
   * the owner abandoned named in its journal, by their own employee and box
   * labels. A container that carries no such proof is reported, never removed.
   * The shared pool is never part of this. Reads only. */
  private async rebuildScope(employeeId: string, unchecked: unknown, authority: DockerContinuationAuthority) {
    const template = DockerLaptopTemplate.parse(unchecked);
    this.runtimeCurrent();
    authority.require();
    // An earlier operation that retired the record but has not finished its
    // source is continued by repeating its own request, never started over.
    const head = this.#head(employeeId);
    if (
      head &&
      (head.source.phase !== 'created' ||
        head.session.phase !== 'cleared' ||
        (head.removal && head.removal.phase !== 'removed'))
    )
      refuse('DOCKER_REPROVISION_OPERATION_PENDING', { pendingOperationId: head.operationId });
    const replace = this.#replaceable(employeeId);
    const read = () => {
      const facts = replace
        ? this.#replaceFacts(employeeId, authority, true)
        : this.#facts(employeeId, authority, true);
      const basis = 'basis' in facts ? facts.basis : facts.row,
        // The unused source of a finished earlier operation is replaced by that
        // workflow's own never-started proof, not discarded here.
        source = 'head' in facts && facts.head.source.phase === 'created' ? facts.head.source.containerId : null,
        recorded = 'ids' in facts ? facts.ids : [];
      return { facts, basis, source, recorded };
    };
    const first = read(),
      { employee } = first.facts;
    const key = (value: ReturnType<typeof read>) =>
      dockerContinuationDigest({
        owner: value.facts.employee.owner ?? null,
        sessionId: value.facts.employee.sessionId,
        sessionGeneration: value.facts.employee.sessionGeneration,
        name: value.facts.employee.name,
        profile: value.facts.employee.runtimeRecipe?.subscriptionProfile?.id ?? null,
        row: value.facts.row,
        binding: value.facts.employee.dockerBinding ?? null,
        recorded: value.recorded,
        source: value.source,
      });
    const factsDigest = key(first);
    const current = () => {
      if (key(read()) !== factsDigest) refuse('DOCKER_REPROVISION_TARGET_CHANGED');
    };
    const storage = reprovisionStorage(first.basis, template);
    const moves = this.planMoves();
    if (!moves) refuse('DOCKER_REPROVISION_PLAN_JOURNAL_UNAVAILABLE');
    const open = await moves!.openMoves(employeeId, employee.owner);
    current();
    const abandoned = (await moves!.ownerAbandonedContainers?.(employeeId, employee.owner)) ?? [];
    current();
    const listed = (await this.#present(first.recorded, employeeId)).filter((id) => id !== first.source);
    current();
    const box = this.configuration.boxId,
      deployment = this.configuration.deployment;
    const wanted = new Map<string, { role: DockerRebuildDiscard['role']; moveId?: string }>();
    for (const id of listed) wanted.set(id, { role: 'laptop' });
    for (const move of abandoned) {
      // The source and candidate of a move are laptops: only the label listing
      // or the employee's own record above can select one of those.
      if (move.containers.sourceHolder && !wanted.has(move.containers.sourceHolder))
        wanted.set(move.containers.sourceHolder, { role: 'source-holder', moveId: move.moveId });
      for (const helper of move.containers.helpers)
        if (!wanted.has(helper.containerId)) wanted.set(helper.containerId, { role: helper.role, moveId: move.moveId });
    }
    const discard: DockerRebuildDiscard[] = [],
      foreign: string[] = [];
    for (const [id, hint] of [...wanted].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const raw = await this.#listedContainer(id);
      current();
      if (!raw) continue;
      const proofs: Record<DockerRebuildDiscard['role'], DockerLaptopContainerProof[]> = {
        laptop: [
          {
            kind: 'labels',
            labels: { 'reverie.boxed.employee': employeeId, 'reverie.boxed.instance': deployment },
          },
          { kind: 'labels', labels: { 'reverie.employee': employeeId, 'reverie.worker': deployment } },
          ...(first.recorded.includes(id) ? [{ kind: 'recorded' as const }] : []),
        ],
        'source-holder': [
          {
            kind: 'labels',
            labels: {
              'reverie.box.plan-source.employee': employeeId,
              'reverie.box.plan-source.box': box,
              'reverie.box.plan-source.move': hint.moveId ?? '',
            },
          },
        ],
        'storage-holder': [
          { kind: 'labels', labels: { 'reverie.box.storage.employee': employeeId, 'reverie.box.storage.box': box } },
        ],
        'identity-helper': [
          { kind: 'labels', labels: { 'reverie.box.identity.employee': employeeId, 'reverie.box.identity.box': box } },
        ],
        'leaf-helper': [
          {
            kind: 'labels',
            labels: { 'reverie.box.resource.box': box, 'reverie.box.resource.role': 'leaf-helper' },
          },
        ],
      };
      const labels = raw.Config.Labels ?? {},
        // A boxed laptop of another box in the same deployment is not this office's to remove.
        otherBox = labels['reverie.boxed.box'] !== undefined && labels['reverie.boxed.box'] !== box,
        proof = otherBox
          ? undefined
          : proofs[hint.role].find((candidate) => dockerLaptopContainerProven(raw, candidate));
      if (!proof) foreign.push(id);
      else discard.push({ containerId: id, role: hint.role, running: raw.State.Running, proof });
    }
    const laptops = discard.filter((item) => item.role === 'laptop').map((item) => item.containerId);
    const image = await this.#image();
    current();
    const { network, names } = await this.#network(employeeId, template.network, laptops);
    current();
    const account = await this.#account(first.basis, employee, template);
    current();
    requireReprovisionEphemeralLayout(
      this.#input(first.basis, template, '', employee.name, image, network, account, employee.sessionId)
    );
    const live = this.sessions.live(employee.sessionId);
    // A launch this office process made and its live boxed viewer still owns: the rebuild ends it with the viewer.
    const launchOwned = live?.container !== undefined && this.sessions.viewerLaunchOwned?.(employee.sessionId) === true;
    const templateDigest = dockerContinuationDigest(template);
    // Decided before any effect: a viewer this rebuild could not forget
    // afterwards must stop it here, not after the laptop is already gone.
    const own = [...first.recorded, ...discard.map((item) => item.containerId)];
    const viewer = !live
      ? undefined
      : live.container !== undefined
        ? !own.includes(live.container)
          ? ('DOCKER_REPROVISION_SESSION_VIEW_FOREIGN' as const)
          : !this.sessions.discardView
            ? ('DOCKER_REBUILD_VIEWER_DISCARD_UNAVAILABLE' as const)
            : undefined
        : live.inert
          ? undefined
          : ('DOCKER_REPROVISION_SESSION_ACTIVE' as const);
    const blocked = open.some((move) => move.busy || !move.docker)
      ? ('DOCKER_REBUILD_PLAN_MOVE_ACTIVE' as const)
      : open.length
        ? ('DOCKER_REBUILD_PLAN_MOVE_HELD' as const)
        : foreign.length
          ? ('DOCKER_REBUILD_CONTAINER_FOREIGN' as const)
          : viewer;
    const scopeDigest = dockerContinuationDigest({
      purpose: 'docker-laptop-rebuild-scope-v1',
      mode: replace ? 'replace-source' : 'retire',
      deployment,
      boxId: box,
      employeeId,
      owner: employee.owner ?? null,
      sessionId: employee.sessionId,
      sessionGeneration: employee.sessionGeneration,
      record: dockerContinuationDigest(first.facts.row),
      binding: dockerContinuationDigest(employee.dockerBinding ?? null),
      recorded: first.recorded,
      source: first.source,
      discard: discard.map((item) => ({ id: item.containerId, role: item.role, running: item.running })),
      foreign,
      openMoves: open.map((move) => move.id).sort(),
      abandonedMoves: abandoned.map((move) => move.moveId).sort(),
      viewer: live?.container ?? null,
      viewerLaunch: launchOwned,
      sourceImageId: image.imageId,
      network,
      storage,
      account,
      templateDigest,
    });
    return {
      replace,
      template,
      templateDigest,
      ...first,
      own,
      employee,
      current,
      storage,
      open,
      abandoned,
      discard,
      foreign,
      image,
      network,
      names,
      account,
      live,
      launchOwned,
      blocked,
      scopeDigest,
    };
  }
  /** Read-only. Lists what a rebuild keeps and what it discards; the digest
   * binds all of it, and `apply` must echo it. */
  async previewRebuild(employeeId: string, template: unknown, authority: DockerContinuationAuthority) {
    const scope = await this.rebuildScope(employeeId, template, authority),
      row = scope.facts.row,
      running = scope.discard.filter((item) => item.role === 'laptop' && item.running);
    return {
      action: 'rebuild' as const,
      mode: scope.replace ? ('replace-source' as const) : ('retire' as const),
      employeeId,
      sessionId: scope.employee.sessionId,
      sessionGeneration: scope.employee.sessionGeneration,
      outOfOffice: scope.employee.onVacation === true || scope.employee.desiredRunning === false,
      record: row ? { version: row.version, phase: row.phase, operationId: row.request.operationId } : null,
      discard: scope.discard.map(({ containerId, role, running: isRunning }) => ({
        containerId,
        role,
        running: isRunning,
      })),
      runningLaptops: running.map((item) => item.containerId),
      requiresConfirmation: running.length > 0 || scope.launchOwned,
      foreign: scope.foreign,
      viewer: scope.live
        ? { live: true, container: scope.live.container ?? null, ...(scope.launchOwned ? { ownsLaunch: true } : {}) }
        : { live: false, container: null },
      planMoves: { open: scope.open.map((move) => move.id), abandoned: scope.abandoned.map((move) => move.moveId) },
      kept: { home: scope.basis.original.home, nixSource: scope.storage.nix, scratchSource: scope.storage.scratch },
      account: scope.account,
      sourceImageId: scope.image.imageId,
      network: scope.network,
      networkCandidates: scope.names,
      templateDigest: scope.templateDigest,
      scopeDigest: scope.scopeDigest,
      allowedActions: scope.blocked
        ? scope.blocked === 'DOCKER_REBUILD_PLAN_MOVE_HELD'
          ? (['abandon'] as const)
          : scope.blocked === 'DOCKER_REBUILD_PLAN_MOVE_ACTIVE'
            ? (['observe'] as const)
            : ([] as const)
        : (['rebuild'] as const),
      lost:
        'Everything running in the laptop right now, including the conversation in its terminal. Files in the home ' +
        'directory, the shared Nix store, scratch space and shared drives are kept, and the saved conversation is ' +
        'resumed only if its transcript is among those files.',
      ...(scope.blocked ? { code: scope.blocked } : {}),
    };
  }
  /** The owner's rebuild. It first makes the recorded state true: every listed
   * container of this employee is stopped and removed and the viewer of the
   * gone laptop is forgotten. From there it is exactly the absent-laptop
   * workflow above, which retires the record and creates one inert source.
   * Each step only removes or advances, so a failed attempt is repeated from
   * a fresh preview and converges. */
  async rebuild(
    employeeId: string,
    unchecked: unknown,
    authority: DockerContinuationAuthority
  ): Promise<DockerAbsentReprovisionResult> {
    const input = DockerLaptopRebuildRequest.parse(unchecked);
    this.runtimeCurrent();
    authority.require();
    if (this.#flights.has(employeeId)) refuse('DOCKER_REPROVISION_BUSY');
    this.#flights.add(employeeId);
    try {
      let entry = this.#entry(input.operationId);
      if (!entry) {
        const scope = await this.rebuildScope(employeeId, input.template, authority);
        if (
          input.sessionId !== scope.employee.sessionId ||
          input.sessionGeneration !== scope.employee.sessionGeneration
        )
          refuse('DOCKER_REPROVISION_TARGET_CHANGED');
        if (input.expectedScopeDigest !== scope.scopeDigest) refuse('DOCKER_REPROVISION_SCOPE_CHANGED');
        if (scope.blocked) refuse(scope.blocked);
        // Stopping a running laptop, or ending a launch this office still holds live, needs the owner's explicit word.
        if (
          (scope.discard.some((item) => item.role === 'laptop' && item.running) || scope.launchOwned) &&
          !input.confirmDiscardRunning
        )
          refuse('DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED');
        // Before the laptop is discarded: a seat that cannot be signed in stops here.
        await this.#seat(input.operationId, scope.account, scope.basis, scope.template, scope.current);
        await this.#discardForRebuild(scope);
        await this.#forgetViewer(scope);
        // The recorded state is now true; the ordinary workflow takes over.
        const inner = await this.#scope(employeeId, input.template, authority, true);
        if (inner.present.length) refuse('DOCKER_REPROVISION_CONTAINERS_PRESENT');
        entry =
          inner.kind === 'absent'
            ? await this.#retire(employeeId, input, authority, inner, true)
            : await this.#replace(employeeId, input, authority, inner, true);
      } else if (
        entry.employeeId !== employeeId ||
        entry.owner !== authority.owner ||
        entry.sessionId !== input.sessionId ||
        entry.sessionGeneration !== input.sessionGeneration ||
        entry.templateDigest !== dockerContinuationDigest(input.template)
      )
        refuse('DOCKER_REPROVISION_OPERATION_CHANGED');
      return await this.#resume(entry, authority, true);
    } finally {
      this.#flights.delete(employeeId);
    }
  }
  /** Laptops first, so their viewers end; then the abandoned move's holder and
   * helpers. Never by force and never with volumes. A positive listing settles
   * every removal before anything canonical is written. */
  async #discardForRebuild(scope: Awaited<ReturnType<DockerAbsentReprovision['rebuildScope']>>): Promise<void> {
    if (!scope.discard.length) return;
    if (!this.command.discardLaptopContainer) refuse('DOCKER_REBUILD_REMOVAL_UNAVAILABLE');
    const ordered = [...scope.discard].sort((a, b) => Number(b.role === 'laptop') - Number(a.role === 'laptop'));
    for (const item of ordered) {
      scope.current();
      try {
        await this.command.discardLaptopContainer!(item.containerId, item.proof, scope.current);
      } catch (cause) {
        if (cause instanceof DockerEmployeeContinuationError) throw cause;
        refuse('DOCKER_REBUILD_REMOVAL_UNCONFIRMED', cause);
      }
    }
    for (const item of ordered) {
      scope.current();
      if ((await this.#containers(['id=' + item.containerId])).length) refuse('DOCKER_REBUILD_REMOVAL_UNCONFIRMED');
    }
    scope.current();
  }
  /** A live viewer of a laptop that no longer exists is only office-side
   * terminal state. It is forgotten through the state service once the Engine
   * positively lists no container under the ID it was attached to. */
  async #forgetViewer(scope: Awaited<ReturnType<DockerAbsentReprovision['rebuildScope']>>): Promise<void> {
    const sessionId = scope.employee.sessionId,
      live = this.sessions.live(sessionId);
    if (!live) return;
    const absent = async (id: string) => /^[a-f0-9]{64}$/.test(id) && !(await this.#containers(['id=' + id])).length;
    try {
      if (live.container !== undefined) {
        if (!this.sessions.discardView) refuse('DOCKER_REBUILD_VIEWER_DISCARD_UNAVAILABLE');
        // Only a viewer of one of this employee's own, now absent, laptops.
        if (!scope.own.includes(live.container)) refuse('DOCKER_REPROVISION_SESSION_VIEW_FOREIGN');
        if (!(await absent(live.container))) refuse('DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED');
        scope.current();
        await this.sessions.discardView!(sessionId, absent);
      } else if (live.inert) await this.sessions.discard(sessionId);
      else refuse('DOCKER_REPROVISION_SESSION_ACTIVE');
    } catch (cause) {
      if (cause instanceof DockerEmployeeContinuationError) throw cause;
      refuse('DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED', cause);
    }
    scope.current();
    if (this.sessions.live(sessionId)) refuse('DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED');
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
    scope: Awaited<ReturnType<DockerAbsentReprovision['absentScope']>>,
    rebuild = false
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
      const employee = this.#employee(employeeId, authority, state, rebuild),
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
    scope: Awaited<ReturnType<DockerAbsentReprovision['replaceScope']>>,
    rebuild = false
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
      const employee = this.#employee(employeeId, authority, state, rebuild),
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
    current: () => void,
    reissue = false
  ): Promise<DockerAbsentContinuationRetirement> {
    const next = DockerAbsentContinuationRetirement.parse({ ...before, ...change });
    if (!allowedReprovisionTransition(before, next, reissue)) refuse('DOCKER_REPROVISION_RETIREMENT_CHANGED');
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
    authority: DockerContinuationAuthority,
    rebuild = false
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
        employee = this.#employee(entry.employeeId, authority, state, rebuild);
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
      const latest = this.#entry(initial.operationId) ?? entry,
        held = result(
          latest,
          cause instanceof DockerEmployeeContinuationError ? cause.code : 'DOCKER_REPROVISION_EFFECT_UNCONFIRMED'
        );
      return { ...held, ...dockerReprovisionHoldDetail(cause) };
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
  /** A laptop whose plan is routed to a seat has to come up signed in. The
   * Engine refuses a bind whose host folder is missing, and an employee who
   * never used this plan has no seat folder yet; an empty one would leave the
   * laptop at the provider's sign-in screen. So a fixed helper, running as the
   * laptop user, makes the default seat inside the private home and, when the
   * office is signed in to that plan, places the office's signed-in copy of the
   * plan account: the same held snapshot a plan move installs, refreshed at
   * every rebuild so a rotated token is not stale. With no sign-in on either
   * side, nothing is built and the owner is told to sign in. The helper is
   * idempotent, so it runs before anything is discarded and again at every
   * attempt of the same operation. A folder the owner named with
   * `accountSource` is the owner's to provide. */
  async #seat(
    operationId: string,
    account: DockerReprovisionAccount | undefined,
    basis: DockerEmployeeContinuationRecord,
    template: DockerLaptopTemplate,
    current: () => void
  ): Promise<void> {
    if (account?.kind !== 'seat-mount') return;
    const home = reprovisionStorage(basis, template).home,
      profileId = account.path.slice(REPROVISION_ACCOUNT_ROOT.length);
    if (account.source !== reprovisionSeatSource(home, profileId)) return;
    if (!this.command.prepareSeatDirectory) return refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNAVAILABLE');
    const provider = account.key === 'CLAUDE_CONFIG_DIR' ? ('anthropic' as const) : ('openai' as const),
      accounts = this.seatAccounts();
    let signIn: DockerSeatSignIn | undefined;
    try {
      signIn = await accounts?.capture(profileId, provider, current);
      current();
      const receipt = await this.command.prepareSeatDirectory(
        'reverie-boxed-seat-prepare-' + operationId.replaceAll('-', ''),
        { imageId: this.configuration.workerImageId, user: template.user, homeSource: home, profileId, provider },
        current,
        signIn?.authText()
      );
      current();
      // Without a plan account service nothing is known about the office's
      // sign-in, and the folder alone is all this office can provide.
      if (accounts && receipt.credential === 'absent') {
        const profile = this.company.store
          .snapshot()
          .employees.find((value) => value.runtimeRecipe?.subscriptionProfile?.id === profileId)
          ?.runtimeRecipe?.subscriptionProfile;
        refuse('DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT', {
          seatProfile: { id: profileId, ...(profile ? { label: profile.label.slice(0, 100) } : {}) },
        });
      }
    } catch (cause) {
      if (cause instanceof DockerEmployeeContinuationError) throw cause;
      refuse('DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED', cause);
    } finally {
      try {
        signIn?.close();
      } catch {
        /* Read-only handles of the office's own account; its copy is already zeroed. */
      }
    }
  }
  /**
   * An intent issued before sources carried the employee's current session: its source was labelled with the session
   * of the first record, which differs once a plan move has replaced the session, so its proof can never pass. Exactly
   * that intent is recognised by its own recorded digest. The source it made, if it made one, is this operation's
   * never-started container and nothing else, and is removed under that proof; the intent is then issued again for
   * the configuration that can be accepted. Any other difference stays the refusal it was.
   */
  async #reissueFirstSessionSource(
    entry: DockerAbsentContinuationRetirement,
    basis: DockerEmployeeContinuationRecord,
    input: Parameters<typeof reprovisionSourceConfiguration>[0],
    name: string,
    configurationDigest: string,
    current: () => void
  ): Promise<DockerAbsentContinuationRetirement> {
    if (
      entry.source.phase !== 'issued' ||
      entry.source.name !== name ||
      entry.source.configurationDigest === configurationDigest ||
      basis.request.sessionId === entry.sessionId
    )
      return entry;
    const first = reprovisionSourceConfiguration({ ...input, sessionId: basis.request.sessionId });
    if (entry.source.configurationDigest !== dockerContinuationDigest(first)) return entry;
    const seen = await this.#sources(entry.employeeId);
    current();
    if (seen.length > 1) return refuse('DOCKER_REPROVISION_SOURCE_AMBIGUOUS');
    if (seen.length) {
      const raw = await this.#inspect(seen[0]!);
      current();
      // Its own name, image, labels and mounts, and never started.
      requireReprovisionSource(raw, name, first);
      if (!this.command.removeCreatedSource) return refuse('DOCKER_REPROVISION_REMOVAL_UNAVAILABLE');
      await this.command.removeCreatedSource(name, seen[0]!, current);
      current();
      if ((await this.#sources(entry.employeeId)).length) return refuse('DOCKER_REPROVISION_REMOVAL_UNCONFIRMED');
      current();
    }
    return this.#publish(entry, { source: { ...entry.source, configurationDigest } }, current, true);
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
    const input = this.#input(
      basis,
      entry.template,
      entry.operationId,
      employee.name,
      image,
      network,
      entry.account,
      entry.sessionId
    );
    const configuration = reprovisionSourceConfiguration(input),
      configurationDigest = dockerContinuationDigest(configuration);
    entry = await this.#reissueFirstSessionSource(entry, basis, input, name, configurationDigest, current);
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
      await this.#seat(entry.operationId, entry.account, basis, entry.template, current);
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
