/** Admission for forgetting the office-side viewer of a boxed laptop that no
 * longer exists. Pure DATA checks; the caller holds the Engine's answer.
 *
 * A boxed Session is a terminal wrapper around a provider that runs inside a
 * laptop container. The guarded candidate cleanup refuses to stop such a
 * wrapper, because a wrapper never proves who owns the native job behind it.
 * Once the Engine positively lists no container under the exact ID the viewer
 * was attached to, there is no native job: what remains is this office's own
 * terminal client and its local pane. Only then may the ordinary local stop
 * tear those down. Nothing here stops, starts or removes a container. */
export interface AbsentLaptopViewSubject {
  readonly id: string;
  readonly owner?: string;
  readonly remote?: unknown;
  readonly docker?: {
    readonly hostId?: string;
    readonly engine?: string;
    readonly owned?: boolean;
    readonly containerName: string;
    readonly continuation?: unknown;
  };
  readonly paneLifecycleInFlight?: boolean;
}
/** Why this viewer may not be forgotten, or undefined when it may. */
export function absentLaptopViewRefusal(
  session: AbsentLaptopViewSubject,
  sessionId: string,
  cleaningUp: boolean
): string | undefined {
  const docker = session.docker;
  if (session.id !== sessionId) return 'the session changed';
  if (session.remote) return 'a remote session is not a boxed laptop viewer';
  if (
    !docker?.continuation ||
    docker.hostId !== 'boxed-runtime' ||
    docker.engine !== 'docker' ||
    docker.owned !== false ||
    !/^[a-f0-9]{64}$/.test(docker.containerName)
  )
    return 'only the viewer of a boxed employee laptop can be forgotten this way';
  if (cleaningUp) return 'another cleanup of this session is in progress';
  if (session.paneLifecycleInFlight) return 'a start or attach of this viewer is in progress';
  return undefined;
}
