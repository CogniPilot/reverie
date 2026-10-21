/**
 * Reverie variables are named REVERIE_*. The older FLEET_* spelling of each name is still read for one release
 * (the new name wins), and legacy CODEMAN_* inputs remain compatible.
 */
const reported = new Set<string>();

/** REVERIE_<suffix>, else FLEET_<suffix> (reported once as deprecated). An empty value counts as unset. */
export function envValue(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  const value = env[`REVERIE_${suffix}`];
  if (value) return value;
  const old = env[`FLEET_${suffix}`];
  if (!old) return undefined;
  if (!reported.has(suffix)) {
    reported.add(suffix);
    console.warn(`FLEET_${suffix} is deprecated; use REVERIE_${suffix}`);
  }
  return old;
}

/** Child environment entries under both names for one release, so an older runtime still finds them. */
export function bothNames(suffix: string, value: string): Record<string, string> {
  return { [`REVERIE_${suffix}`]: value, [`FLEET_${suffix}`]: value };
}

/**
 * Normalize this process's environment once at startup: a FLEET_X with no REVERIE_X fills REVERIE_X, then each
 * REVERIE_X is mirrored to FLEET_X (so children inherit both spellings) and to CODEMAN_X.
 */
export function applyFleetEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('FLEET_')) {
      const suffix = key.slice('FLEET_'.length);
      const value = envValue(env, suffix);
      if (value !== undefined) env[`REVERIE_${suffix}`] = value;
    }
  }
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (key.startsWith('REVERIE_') && value !== undefined) {
      const suffix = key.slice('REVERIE_'.length);
      env[`FLEET_${suffix}`] = value;
      env[`CODEMAN_${suffix}`] = value;
    }
  }
}

applyFleetEnvironment(process.env);
