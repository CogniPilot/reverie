/**
 * Which routes a Rust handler serves, read once at startup. The list is empty unless the owner sets
 * REVERIE_RUST_ROUTES to exact route keys; an unknown key, or a list without an absolute
 * REVERIE_RUST_ROUTE_HANDLER file, refuses to start, so a typo never leaves a route silently on TS.
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { envValue } from '../config/reverie-env.js';
import { SUBSCRIPTION_PROFILES } from './frames.js';

/** Statuses each route's handler may answer with; mirrors `route_frames_v1::ROUTES`. */
export const ROUTE_STATUSES: Record<string, readonly number[]> = {
  [SUBSCRIPTION_PROFILES]: [200, 500],
};

export interface RustRoutes {
  moved: ReadonlySet<string>;
  handlerPath: string;
}

export function rustRoutes(env: NodeJS.ProcessEnv): RustRoutes | undefined {
  const list = envValue(env, 'RUST_ROUTES');
  if (!list) return undefined;
  const moved = new Set(list.split(','));
  for (const key of moved) {
    if (!Object.hasOwn(ROUTE_STATUSES, key))
      throw new Error(`REVERIE_RUST_ROUTES names an unknown route: ${JSON.stringify(key)}`);
  }
  const handlerPath = envValue(env, 'RUST_ROUTE_HANDLER');
  if (!handlerPath || !isAbsolute(handlerPath) || !statSync(handlerPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      'REVERIE_RUST_ROUTES is set, so REVERIE_RUST_ROUTE_HANDLER must be the absolute path of the handler binary'
    );
  }
  return { moved, handlerPath };
}
