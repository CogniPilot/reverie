/** Resolve an owner-configured endpoint independently of the selected agent harness. */
import type { CustomModelHost } from './custom-model-hosts.js';

export interface LocalModelProfile {
  customModel: { endpointId: string; modelId: string };
  label: string;
}

/**
 * Return only launch references, never endpoint credentials or copied configuration.
 * The regular quick-start endpoint remains responsible for owner and CLI capability checks.
 */
export function resolveLocalModelProfile(
  hosts: readonly CustomModelHost[],
  endpointId: string,
  modelId?: string
): LocalModelProfile {
  if (typeof endpointId !== 'string' || !endpointId.trim()) throw new Error('Select a local model endpoint.');
  const host = hosts.find((candidate) => candidate.id === endpointId);
  if (!host) throw new Error('Local model endpoint not found.');
  const models = Array.isArray(host.models)
    ? host.models.filter((model) => typeof model === 'string' && model.trim())
    : [];
  const selected = modelId === undefined ? host.defaultModelId || models[0] : modelId;
  if (typeof selected !== 'string' || !selected.trim() || !models.includes(selected)) {
    throw new Error('Select a model saved on this endpoint; configure or discover its models first.');
  }
  return { customModel: { endpointId: host.id, modelId: selected }, label: host.label || host.id };
}
