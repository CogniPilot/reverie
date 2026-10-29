/** Normal CLI/daemon/service foreground bootstrap. No listener or authority alternative here. */
import type { WebLaunchOptions } from './daemon-control.js';
import { dataPath } from './config/instance.js';
import { loadGoalPrivateBootstrap } from './goal-private-bootstrap.js';
import { startWebServer } from './web/server.js';

export async function startConfiguredWebServer(launch: WebLaunchOptions) {
  const goals = loadGoalPrivateBootstrap(launch.goalPrivateConfig, dataPath('company.json'));
  const resourceArgs: [] | [boolean] = launch.resourceReplacement === true ? [true] : [];
  try {
    return await startWebServer(
      launch.port,
      launch.https,
      false,
      launch.host,
      launch.titleHostname,
      launch.allowUnauthenticatedNetwork ?? false,
      launch.basePath ?? '',
      goals,
      launch.serviceAuthConfig,
      ...resourceArgs
    );
  } catch (error) {
    goals?.close?.();
    throw error;
  }
}
