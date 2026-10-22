import type { OpenCodeConfig } from './types.js';

/** Build transient launch JSON without dropping account/custom-provider selection or tool policy. */
export function cliConfigContent(config?: OpenCodeConfig, selectedContent?: string): string | undefined {
  const parse = (value?: string): Record<string, unknown> => {
    if (!value) return {};
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CLI config must be a JSON object');
    return parsed as Record<string, unknown>;
  };
  if (!config?.configContent && !config?.autoAllowTools && !selectedContent) return undefined;
  const merged = { ...parse(config?.configContent), ...parse(selectedContent) };
  if (config?.autoAllowTools) merged.permission = { '*': 'allow' };
  // Explicit launch model wins over a subscription's default or a saved config model.
  if (config?.model) merged.model = config.model;
  return JSON.stringify(merged);
}
