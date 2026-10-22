/** Read a Reverie environment setting. An empty value counts as unset. */
export function envValue(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  return env[`REVERIE_${suffix}`] || undefined;
}

/** Environment entry inherited by a child process. */
export function environmentEntry(suffix: string, value: string): Record<string, string> {
  return { [`REVERIE_${suffix}`]: value };
}
