/** Supervisor service names for this Reverie instance. */
import { REVERIE_INSTANCE } from './instance.js';

/**
 * Instance name reduced to characters that are safe in a filename and in a
 * launchd label. `REVERIE_INSTANCE` is arbitrary operator input.
 */
const SAFE_INSTANCE = REVERIE_INSTANCE.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

/** systemd user unit: `reverie-web.service`, or `reverie-web-beta.service` for a beta. */
export const SYSTEMD_UNIT = `reverie-web${SAFE_INSTANCE ? `-${SAFE_INSTANCE}` : ''}.service`;

/** launchd job label: `com.reverie.web`, or `com.reverie.beta.web` for a beta. */
export const LAUNCHD_LABEL = SAFE_INSTANCE ? `com.reverie.${SAFE_INSTANCE}.web` : 'com.reverie.web';
