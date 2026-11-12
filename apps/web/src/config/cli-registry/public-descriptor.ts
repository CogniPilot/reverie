import type { CliEntry } from './types.js';

/** Public launch facts only: executable/configuration details and credentials stay server-side. */
export function cliPublicDescriptor(entry: CliEntry) {
  return {
    id: entry.id as string,
    label: entry.label,
    shortBadge: entry.shortBadge,
    order: entry.order,
    kind: entry.kind,
    enabled: entry.enabled,
    external: entry.capabilities.external,
    supportsCustomModel: entry.kind === 'agent' && entry.capabilities.customModelInjection.kind !== 'unsupported',
  };
}

export type CliPublicDescriptor = ReturnType<typeof cliPublicDescriptor>;
