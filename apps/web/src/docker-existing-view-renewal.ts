/** Renew an existing website reader from actual canonical/native facts only. */
import { Session } from './session.js';
import { DockerEmployeeEngine } from './docker-employee-engine.js';
import { DockerEmployeeContinuationRecord } from './docker-employee-continuation-data.js';
import { dockerContinuationDigest } from './docker-employee-continuation.js';
import { dockerEmployeeProviderSourceDigest, type CompanyDockerContinuationStore } from './docker-employee-store.js';
import type { CompanyService } from './company-service.js';
import type { SessionState } from './types.js';

export interface ExistingDockerViewRenewal {
  readonly company: CompanyService;
  readonly store: CompanyDockerContinuationStore;
  readonly engine: DockerEmployeeEngine;
  readonly sessions: ReadonlyMap<string, Session>;
  readonly saved: (sessionId: string) => SessionState | null | undefined;
  readonly runtimeCurrent: () => void;
}
/** The operation grant is required until publication; the installed reader then
 * retains independent runtime, canonical binding, recipe and native-view currency.
 * No new provider, viewer transport, helper, resource mutation or input is issued. */
export async function renewExistingDockerProviderView(
  deps: ExistingDockerViewRenewal,
  input: DockerEmployeeContinuationRecord,
  session: Session,
  admitted: () => boolean,
  published?: () => void
): Promise<void> {
  const row = DockerEmployeeContinuationRecord.parse(input),
    rowDigest = dockerContinuationDigest(row),
    saved = deps.saved(row.request.sessionId);
  if (!saved || !['ready', 'provider-issued'].includes(row.phase) || !row.destination || !(session instanceof Session))
    throw Error('Original existing Docker reader required');
  const initial = deps.company.registeredEmployees().find((employee) => employee.id === row.employeeId),
    binding = initial?.dockerBinding;
  if (
    !initial ||
    !binding ||
    session.id !== row.request.sessionId ||
    session.pid === null ||
    session.docker?.containerName !== binding.containerId
  )
    throw Error('Original existing Docker reader changed');
  const bindingDigest = dockerContinuationDigest(binding),
    providerSource = row.version === 1 ? dockerEmployeeProviderSourceDigest(initial, saved) : row.providerSourceDigest;
  let publication: 'preparing' | 'published' | 'failed' = 'preparing';
  const current = () => {
    deps.runtimeCurrent();
    const live = deps.company.registeredEmployees().find((employee) => employee.id === row.employeeId),
      subject = deps.store.existingSubject(row.employeeId, row);
    if (
      publication === 'failed' ||
      (publication === 'preparing' && !admitted()) ||
      deps.company.store.publicationUnconfirmed ||
      !live ||
      !subject ||
      live.owner !== row.owner ||
      subject.owner !== row.owner ||
      live.onVacation ||
      live.desiredRunning !== true ||
      live.bindingMigration ||
      live.sessionId !== row.request.sessionId ||
      live.sessionGeneration !== row.request.sessionGeneration ||
      subject.sessionId !== row.request.sessionId ||
      subject.sessionGeneration !== row.request.sessionGeneration ||
      dockerContinuationDigest(live.dockerBinding) !== bindingDigest ||
      dockerContinuationDigest(deps.store.record(row.employeeId)) !== rowDigest ||
      deps.sessions.get(session.id) !== session ||
      session.owner !== row.owner ||
      dockerEmployeeProviderSourceDigest(live, { ...saved, ...session.providerRecipeState() }) !== providerSource
    )
      throw Error('Original existing Docker reader changed');
  };
  try {
    current();
    const seen = await DockerEmployeeEngine.prototype.observeDestination.call(deps.engine, row);
    current();
    if (
      !seen ||
      seen.state !== 'running' ||
      seen.provider.kind !== 'running' ||
      seen.provider.operationId !== binding.operationId ||
      seen.provider.sessionId !== binding.sessionId ||
      !DockerEmployeeEngine.prototype.existingResourcePolicyCurrent.call(deps.engine, row, seen.resources)
    )
      throw Error('Original existing Docker provider is unconfirmed');
    const view = await DockerEmployeeEngine.prototype.captureProviderView.call(deps.engine, row, current);
    current();
    Session.prototype.renewDockerContinuationView.call(session, view, () => {
      current();
      return true;
    });
    current();
    published?.();
    publication = 'published';
    current();
  } catch (cause) {
    publication = 'failed';
    throw cause;
  }
}
