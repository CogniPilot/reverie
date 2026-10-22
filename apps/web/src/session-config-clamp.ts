/** Shared privilege policy for interactive, scheduled and company sessions. */
import { canUsernameRunPrivilegedCommands } from './user-store.js';
import { enabledClis } from './config/cli-registry/registry.js';

export async function clampExternalCliBypassForOwner<T extends Record<string, unknown>>(
  owner: string | undefined,
  configs: T
): Promise<T> {
  if (await canUsernameRunPrivilegedCommands(owner)) return configs;

  const out: Record<string, unknown> = { ...configs };
  for (const entry of enabledClis()) {
    const field = entry.launch.legacyConfigField;
    if (!field) continue;
    // `privilegedParams[].param` names the REGISTRY param, so it has to be translated to the
    // legacy wire field on the way out — the same `legacyConfigAliases` hop `configSetenvValues`
    // already makes. Writing `param` straight through would put it in a DIFFERENT namespace
    // from every other `param` in the schema, and a name that is right in one and wrong in the
    // other is a SILENT no-op: no load error, no failing test, the clamp simply stops clamping.
    // Codex is where the two names differ (`bypassApprovals` vs `dangerouslyBypassApprovals`),
    // and `schema.ts` refuses an entry naming a param it never declared.
    const aliases = entry.launch.legacyConfigAliases ?? {};
    const existing = out[field] as Record<string, unknown> | undefined;
    let next = existing;
    for (const { param, clampTo, materializeWhenAbsent } of entry.capabilities.privilegedParams) {
      // MATERIALIZE vs ONLY-IF-SENT is the whole design of this clamp, and the two are not
      // interchangeable — see CliCapabilities.privilegedParams. Materialize where the CLI's
      // own absent-config default is ITSELF unsafe (gemini defaults to yolo; pi's default is
      // an interactive trust prompt the session user could just answer "yes" to), so a
      // caller who sends no config at all still gets clamped.
      if (next === undefined && !materializeWhenAbsent) continue;
      next = { ...(next ?? {}), [aliases[param] ?? param]: clampTo };
    }
    if (next !== existing) out[field] = next;
  }
  return out as T;
}
