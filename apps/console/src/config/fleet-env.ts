/** Reverie variables take precedence; legacy CODEMAN_* inputs remain compatible. */
export function applyFleetEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('FLEET_') && env[key] !== undefined) {
      env[`CODEMAN_${key.slice(6)}`] = env[key];
    }
  }
}

applyFleetEnvironment(process.env);
