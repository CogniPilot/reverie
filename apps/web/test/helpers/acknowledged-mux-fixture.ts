/** Canonical Session/Store acknowledgement for a synthetic physical mux port.
 * This supplies no writer, authority callback, receipt or provider readiness.
 * Command-construction acceptance uses the separate real-manager process fixture.
 */
import type { CreateSessionOptions, RespawnPaneOptions } from '../../src/mux-interface.js';

export async function acknowledgeMuxFixture(options: CreateSessionOptions | RespawnPaneOptions): Promise<void> {
  if (
    options.workerAttachOnly ||
    ('remoteAttachOnly' in options && options.remoteAttachOnly) ||
    options.remote?.owned === false
  ) {
    options.onViewerDispatch?.();
    return;
  }
  const publication = options.providerLaunch;
  const subject = options.providerSubject;
  if (!publication || !subject) throw new Error('Actual original Session publication required by mux fixture');
  await publication.prepare(
    subject,
    Object.freeze({
      kind: 'mux',
      sessionId: options.sessionId,
      owner: options.owner ?? null,
      mode: options.mode,
      cwd: options.workingDir,
      command: 'synthetic-physical-mux-port',
      environment: Object.freeze({ ...options.envOverrides }),
    })
  );
  options.onProviderDispatch?.();
}
