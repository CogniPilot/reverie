/** What a refusal of the laptop reprovision and rebuild workflows means and
 * what can be done next, for a person or a managing agent. DATA only: a
 * sentence and action names never grant the action they name. */
export type DockerRecoveryAction =
  | 'rebuild'
  | 'rebuild-preview'
  | 'reprovision'
  | 'abandon'
  | 'observe'
  | 'retry'
  | 'reconcile-stop'
  | 'choose-network';
export interface DockerRecoveryGuidance {
  readonly message: string;
  readonly allowedActions: readonly DockerRecoveryAction[];
}
const again = 'Request a fresh preview and confirm it again.';
const GUIDANCE: Readonly<Record<string, DockerRecoveryGuidance>> = {
  DOCKER_REPROVISION_SESSION_ACTIVE: {
    message:
      'The office still holds a live terminal for this employee, so the absent-laptop workflow will not touch it. ' +
      'Use Rebuild laptop, which discards that terminal together with the laptop.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_EMPLOYEE_NOT_ELIGIBLE: {
    message:
      'This employee is out of the office or is being migrated, so the absent-laptop workflow will not build for them. ' +
      'Rebuild laptop also works for an employee who is out of the office; a migration in progress must finish first.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_CONTAINERS_PRESENT: {
    message:
      'Containers of this employee still exist, so nothing is treated as absent. ' +
      'Use Rebuild laptop to list and discard them.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_LAPTOP_NOT_REMOVABLE: {
    message:
      'A recorded laptop is still running something, so it was left alone. ' +
      'Use Rebuild laptop and confirm that its running conversation may be discarded.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_SESSION_VIEW_FOREIGN: {
    message:
      'The saved or live terminal of this employee points at a container that their records do not name, so it was ' +
      'left alone. Restart the office to drop the stale terminal, then preview the rebuild again.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_PLAN_MOVE_ACTIVE: {
    message:
      'A plan move for this employee is still open. Wait for it to finish, or abandon it once it is held for recovery, ' +
      'then use Rebuild laptop.',
    allowedActions: ['observe', 'abandon'],
  },
  DOCKER_REPROVISION_SCOPE_CHANGED: {
    message: 'The laptop or its records changed after the preview, so nothing was done. ' + again,
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_TARGET_CHANGED: {
    message:
      'The employee, their session or their record changed during the request, so nothing more was done. ' + again,
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_OPERATION_PENDING: {
    message:
      'An earlier rebuild of this laptop is recorded but not finished (pendingOperationId names it). ' +
      'Send that same request again, with the same operation and template, to finish it.',
    allowedActions: ['rebuild'],
  },
  DOCKER_REPROVISION_BUSY: {
    message: 'Another laptop operation for this employee is running right now. Wait a moment and try again.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_OWNER_STOP_PENDING: {
    message:
      'An owner stop of this employee has not been confirmed by the laptop yet. Settle that stop first, then try again.',
    allowedActions: ['reconcile-stop'],
  },
  DOCKER_REPROVISION_OFFICE_NETWORK_AMBIGUOUS: {
    message:
      'This employee has more than one office network. Send the preview again with template.network set to one of ' +
      'the names in networkCandidates.',
    allowedActions: ['choose-network'],
  },
  DOCKER_REPROVISION_ABSENCE_UNCONFIRMED: {
    message:
      'The container engine did not answer, so nothing is assumed about which containers exist and nothing was changed. ' +
      'Try again when the engine responds.',
    allowedActions: ['retry'],
  },
  DOCKER_REBUILD_PLAN_MOVE_HELD: {
    message:
      'A plan move for this employee is held for recovery. Abandon that move first (the preview names it in ' +
      'planMoves.open); then preview the rebuild again.',
    allowedActions: ['abandon'],
  },
  DOCKER_REBUILD_PLAN_MOVE_ACTIVE: {
    message:
      'A plan move for this employee is still working, or belongs to another recovery. Wait until it is held for ' +
      'recovery, abandon it, then preview the rebuild again.',
    allowedActions: ['observe'],
  },
  DOCKER_REBUILD_CONTAINER_FOREIGN: {
    message:
      'A container that the records name carries no label that ties it to this employee, so it will not be removed ' +
      '(the preview lists it under foreign). Inspect it; once it is gone, preview the rebuild again.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REBUILD_RUNNING_CONFIRMATION_REQUIRED: {
    message:
      'A laptop of this employee is still running (the preview lists it under runningLaptops). Rebuilding discards the ' +
      'conversation in its terminal; files in the home directory are kept. Send the same request with ' +
      'confirmDiscardRunning set to true to go ahead.',
    allowedActions: ['rebuild'],
  },
  DOCKER_REBUILD_CONTAINER_NOT_REMOVABLE: {
    message:
      'A container changed while it was being discarded (it is paused, restarting, or no longer the one that was ' +
      'previewed), so it was left alone. ' +
      again,
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REBUILD_REMOVAL_UNCONFIRMED: {
    message:
      'The container engine did not confirm that a container was removed. Nothing was recorded as rebuilt. ' + again,
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REBUILD_REMOVAL_UNAVAILABLE: {
    message:
      'This office cannot remove laptop containers, so the rebuild did nothing. Update the office and try again.',
    allowedActions: [],
  },
  DOCKER_REBUILD_VIEWER_DISCARD_UNAVAILABLE: {
    message:
      'This office cannot discard the live terminal that is attached to the laptop, so nothing was changed. ' +
      'Restart the office, then preview the rebuild again.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REBUILD_VIEWER_DISCARD_UNCONFIRMED: {
    message:
      'The laptop containers are gone, but the office could not confirm that the old terminal was closed. ' +
      'Nothing was recorded as rebuilt. Wait a moment, then preview the rebuild again.',
    allowedActions: ['rebuild-preview'],
  },
};
export function dockerRecoveryGuidance(code: string): DockerRecoveryGuidance | undefined {
  return Object.hasOwn(GUIDANCE, code) ? GUIDANCE[code] : undefined;
}
