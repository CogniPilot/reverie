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
      'A laptop of this employee is still running (the preview lists it under runningLaptops), or the office still ' +
      'holds the live terminal that it started for them (viewer.ownsLaunch in the preview). Rebuilding discards the ' +
      'conversation in that terminal; files in the home directory are kept. Send the same request with ' +
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
  DOCKER_CONTINUATION_SOURCE_IMAGE_OUTDATED: {
    message:
      'This laptop has never been started, and it was made for an earlier laptop image than the one this office ' +
      'uses now, so the office cannot start it. Nothing is in it. Rebuild the laptop to replace it with one made ' +
      'for the current image: POST /api/company/employees/:id/docker-rebuild/preview with the laptop template, ' +
      'then POST /api/company/employees/:id/docker-rebuild/apply with the scope digest that the preview returned. ' +
      'Then read the resource policy again and continue the laptop.',
    allowedActions: ['rebuild-preview'],
  },
  // Creating the laptop source. `retry` is the same request again, with the
  // same operation and template: the recorded operation keeps its template.
  DOCKER_CONTINUATION_CREATE_BIND_SOURCE_MISSING: {
    message:
      'The container engine refused to create the laptop because a host folder that it mounts does not exist ' +
      '(missingMountTarget names where that folder would appear inside the laptop). The office creates the default ' +
      'sign-in folder itself; a shared drive or scratch folder of the template, or a sign-in folder given as ' +
      'accountSource, has to exist on the host. Create that folder, then send the same request again.',
    allowedActions: ['retry'],
  },
  DOCKER_CONTINUATION_CREATE_CONFIG_REJECTED: {
    message:
      'The container engine refused the configuration of the laptop and gave no reason that the office recognizes, ' +
      'so nothing was created. An office that did not yet create sign-in folders reported a missing one this way; ' +
      'sending the same request again now creates it. If it is refused again, the engine log on the host names the ' +
      'setting it rejected.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_SEAT_ACCOUNT_SIGNED_OUT: {
    message:
      'The office is not signed in to the plan of this employee (seatProfile names it), and the employee has no ' +
      'sign-in of their own for it, so the laptop would have stopped at the provider sign-in screen. No laptop was ' +
      'created and nothing was discarded by this step. Sign in to that plan on the Plans page, then send the same ' +
      'request again; the laptop then comes up signed in.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_HELPER_FOREIGN: {
    message:
      'A storage holder container that carries the labels of this employee (foreignHelpers names it) is listed by ' +
      'none of their laptop records and by none of the laptop records that their finished plan moves replaced, so ' +
      'the office does not know what it holds open. Nothing was discarded and no laptop was created. Inspect that ' +
      'container; once it is gone, preview the rebuild again.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_ACCOUNT_PLAN_MISMATCH: {
    message:
      'The last plan move of this employee put their sign-in and their conversations in a folder for one provider, ' +
      'and the plan that is selected for them now is on the other provider. Nothing on record says which sign-in ' +
      'folder they have used since, so no laptop was created and nothing was discarded. Move the employee to the ' +
      'plan they should be on from the Plans page, which records the folder again, then preview the rebuild again.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_REPROVISION_SEAT_HOME_FOREIGN: {
    message:
      'The home folder of this employee is not a private folder (mode 0700) owned by the laptop user that the ' +
      'template names, so the office did not create a sign-in folder in it and created no laptop. Check the user ' +
      'in the template against the owner of the home folder. An operation that is already recorded keeps its ' +
      'template: fix the folder on the host, then send the same request again.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_SEAT_DIRECTORY_FOREIGN: {
    message:
      'The sign-in folder for the plan of this employee (.reverie/seat-auth/<plan> in their home), or one of the two ' +
      'folders above it, or the sign-in file in it, already exists but is a link, is not a folder (or a plain file), ' +
      'belongs to another user, or has a mode that the office could not narrow to private (0700 for a folder, 0600 ' +
      'for the file). A mode that is merely too permissive is narrowed by the office itself. No laptop was created. ' +
      'Make it a real folder or file of the laptop user on the host, then send the same request again.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_SEAT_DIRECTORY_UNWRITABLE: {
    message:
      'The office could not create the sign-in folder in the home of this employee: the disk is full or read-only, ' +
      'or the home cannot be written by the laptop user. No laptop was created. Fix that on the host, then send the ' +
      'same request again.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_SEAT_PREPARATION_UNCONFIRMED: {
    message:
      'The helper that creates the sign-in folder of this employee did not finish, or did not report a result that ' +
      'the office recognizes, so no laptop was created. The helper only adds missing folders: sending the same ' +
      'request again is safe and runs it again.',
    allowedActions: ['retry'],
  },
  DOCKER_REPROVISION_SEAT_PREPARATION_UNAVAILABLE: {
    message: 'This office cannot create sign-in folders, so no laptop was created. Update the office and try again.',
    allowedActions: [],
  },
  // The step that sets a laptop's resource limits. `retry` is the same request
  // again (Continue for a laptop recovery or a plan move); nothing is forced.
  DOCKER_RESOURCE_HELPER_RETRY_PENDING: {
    message:
      'Setting the resource limits of this laptop did not finish: a process in the box ended while the limits were ' +
      'being checked. That is harmless and nothing is stuck. Continue, and the office sets the limits again.',
    allowedActions: ['retry', 'rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_RETRY_EXHAUSTED: {
    message:
      'Setting the resource limits of this laptop failed three times in a row, each time because a process in the ' +
      'box ended while the limits were being checked. A box that is compiling or running many short commands does ' +
      'this. Continue to try three more times, or use Rebuild laptop to start it over.',
    allowedActions: ['retry', 'rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_RETRY_UNCONFIRMED: {
    message:
      'The office could not confirm that the earlier attempt to set this laptop’s resource limits has completely ' +
      'stopped, so it did not start another one beside it. Wait a moment and continue, or use Rebuild laptop.',
    allowedActions: ['retry', 'rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_ATTEMPTS_SPENT: {
    message:
      'Setting the resource limits of this laptop failed nine times, which is as often as the office tries for one ' +
      'laptop. Use Rebuild laptop: it keeps the employee, their files and their memories and builds a fresh laptop.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_REFUSED: {
    message:
      'The helper that sets resource limits refused: the laptop, its box or its limits were not what was approved ' +
      'when it checked. The office does not repeat a refused change. Use Rebuild laptop to build a fresh laptop ' +
      'under the current limits.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_CLOSE_UNCONFIRMED: {
    message:
      'The helper that sets resource limits could not confirm that it had released the laptop’s control files, so ' +
      'the office does not run it again for this laptop. Use Rebuild laptop to build a fresh one.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_FAILURE_UNKNOWN: {
    message:
      'The helper that sets resource limits stopped without a reason the office recognizes, so it is not run again ' +
      'for this laptop. Use Rebuild laptop to build a fresh one.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_RESOURCE_HELPER_RETRY_SCOPE_CHANGED: {
    message:
      'The laptop, its approved limits or the step it is at changed after the earlier attempt to set its resource ' +
      'limits failed, so that attempt is not repeated. Use Rebuild laptop to build a fresh one under the current limits.',
    allowedActions: ['rebuild-preview'],
  },
  DOCKER_RESOURCE_LEAF_WRITER_IMAGE_UNAVAILABLE: {
    message:
      'This office is configured to set laptop resource limits with a helper image that the container engine does ' +
      'not have, or that was built for something else. Nothing was changed. The office installation needs that ' +
      'image loaded or its setting corrected; then continue.',
    allowedActions: ['retry'],
  },
};
/** Reading a laptop's storage holder: a small container that only holds the
 * employee's home and Nix directories open. The read changes nothing and was
 * already repeated before any of these is reported. */
const HOLDER_READ =
  'Reading the storage holder of this laptop failed three times in a row. The read changes nothing, so continuing ' +
  'is safe and reads it again. ';
const HOLDER_STATUS: Readonly<Record<string, string>> = {
  KILLED:
    'Each time the read was killed inside the holder (exit 137), which for a helper that only reads means the ' +
    'holder reached its 16 MiB memory limit, usually because several reads ran in it at once.',
  OUT_OF_MEMORY:
    'Each time the container runtime could not start the read for lack of memory inside the holder, whose limit ' +
    'is 16 MiB; this happens when several reads run in it at once.',
  TASK_LIMIT:
    'Each time the container runtime could not start the read because the holder reached its limit of eight ' +
    'tasks; this happens when several reads run in it at once.',
  EXEC_REFUSED: 'Each time the container runtime refused to start the read inside the holder.',
  TIMED_OUT: 'The read did not answer within 30 seconds, so the office stopped waiting for it.',
  ENGINE_UNREACHABLE: 'The container engine could not be reached.',
  HELPER_REFUSED: 'Each time the holder helper itself refused the read with one of its own codes.',
  NOT_RUNNING: 'The container engine said the holder was not running while also reporting it as running.',
  ABSENT: 'The container engine said the holder did not exist while also reporting it as running.',
  FAILED: 'Each time the read ended with an error status that the office does not recognize.',
};
export function dockerRecoveryGuidance(code: string): DockerRecoveryGuidance | undefined {
  const prefix = 'DOCKER_STORAGE_HOLDER_STATUS_';
  if (code.startsWith(prefix) && Object.hasOwn(HOLDER_STATUS, code.slice(prefix.length)))
    return {
      message:
        (code === prefix + 'TIMED_OUT' || code === prefix + 'ENGINE_UNREACHABLE'
          ? 'Reading the storage holder of this laptop failed. The read changes nothing, so continuing is safe. '
          : HOLDER_READ) + HOLDER_STATUS[code.slice(prefix.length)],
      allowedActions: ['retry'],
    };
  return Object.hasOwn(GUIDANCE, code) ? GUIDANCE[code] : undefined;
}
