/** Reverie supervisor names are separate from historical Codeman services. */
import { CODEMAN_INSTANCE } from './instance.js';

/**
 * Instance name reduced to characters that are safe in a filename and in a
 * launchd label. `CODEMAN_INSTANCE` is arbitrary operator input.
 */
const SAFE_INSTANCE = CODEMAN_INSTANCE.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

/** systemd user unit: `fleet-web.service`, or `fleet-web-beta.service` for a beta. */
export const SYSTEMD_UNIT = `fleet-web${SAFE_INSTANCE ? `-${SAFE_INSTANCE}` : ''}.service`;

/** launchd job label: `com.agentfleet.web`, or `com.agentfleet.beta.web` for a beta. */
export const LAUNCHD_LABEL = SAFE_INSTANCE ? `com.agentfleet.${SAFE_INSTANCE}.web` : 'com.agentfleet.web';
