/** What a boxed employee on an owner-configured local model needs before its
 * one launch attempt, derived from the employee's own recipe and the office's
 * endpoint store rather than from anything a laptop rebuild can lose.
 *
 * Pure DATA in, DATA out: no file, network or Engine access, and no launch
 * authority. Messages name the employee and the endpoint, never a key. */
import type { CliEntry } from './config/cli-registry/types.js';
import type { CompanyEmployee } from './company-types.js';
import type { CustomModelHost } from './custom-model-hosts.js';
import { buildCustomModelInjection } from './custom-model-injection.js';
import type { DockerProviderPreflightRefusal } from './docker-employee-continuation.js';
import type { SessionState } from './types.js';

/** Where a boxed laptop sees the office's shared local model socket. */
export const BOXED_MODEL_SOCKET = '/run/reverie-model/default.sock';
/** The one loopback port the laptop's fixed model relay serves that socket on. */
export const BOXED_MODEL_RELAY_PORT = 8092;

/** A CLI whose registry entry takes its model endpoint from the launch
 * environment of a boxed laptop. The same data starts the laptop's relay. */
export function takesBoxedModelEndpoint(entry: Pick<CliEntry, 'env' | 'capabilities'> | undefined): boolean {
  const injection = entry?.capabilities.customModelInjection;
  return injection?.kind === 'env' && (entry?.env.dockerExecEnvNames ?? []).includes(injection.baseUrlVar);
}

export interface BoxedLocalModelSelection {
  readonly endpointId: string;
  readonly modelId: string;
}

/** The employee's recipe is the owner's choice; the saved session copies of it
 * are what an older record still carries. */
export function boxedLocalModelSelection(
  employee: Pick<CompanyEmployee, 'runtimeRecipe'>,
  saved: SessionState
): BoxedLocalModelSelection | undefined {
  const kept = (saved as { __customModel?: { endpointId?: unknown; modelId?: unknown } }).__customModel;
  for (const chosen of [employee.runtimeRecipe?.customModel, kept, saved.customModel]) {
    if (chosen && typeof chosen.endpointId === 'string' && typeof chosen.modelId === 'string')
      return { endpointId: chosen.endpointId, modelId: chosen.modelId };
  }
  return undefined;
}

export type BoxedLocalModelResolution =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'ready'; readonly environment: Readonly<Record<string, string>> }
  | { readonly kind: 'refused'; readonly refusal: DockerProviderPreflightRefusal };

export interface BoxedLocalModelInput {
  readonly entry: CliEntry | undefined;
  readonly employee: Pick<CompanyEmployee, 'name' | 'pronouns' | 'runtimeRecipe'>;
  readonly saved: SessionState;
  readonly hosts: readonly CustomModelHost[];
  /** Engine inspect fact; `undefined` when nobody looked. */
  readonly modelSocketMounted: boolean | undefined;
}

function shown(value: string, limit = 80): string {
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function possessive(pronouns: string | undefined): string {
  const first = pronouns
    ?.trim()
    .toLowerCase()
    .split(/[\s/]+/)[0];
  return first === 'she' ? 'her' : first === 'he' ? 'his' : 'their';
}

function loopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}

function refused(code: string, message: string): BoxedLocalModelResolution {
  return { kind: 'refused', refusal: { code: 'DOCKER_CONTINUATION_LOCAL_MODEL_' + code, message } };
}

/** Why the endpoint cannot be reached from inside the laptop, when it cannot. */
function unreachable(host: CustomModelHost, socketMounted: boolean | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(host.baseUrl);
  } catch {
    return 'its saved address is not a URL';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'its saved address is not an http or https URL';
  if (!loopback(url.hostname)) return undefined;
  // A laptop has its own loopback. The only thing listening there is the fixed
  // relay of the office model socket, on one port.
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (url.protocol !== 'http:' || port !== BOXED_MODEL_RELAY_PORT)
    return (
      'it points at the address ' +
      shown(url.host) +
      ', which is this office itself; a laptop reaches the office model server only through its relay at http://127.0.0.1:' +
      BOXED_MODEL_RELAY_PORT
    );
  if (socketMounted === false)
    return (
      'the laptop was built without the shared model socket directory (' +
      BOXED_MODEL_SOCKET.slice(0, BOXED_MODEL_SOCKET.lastIndexOf('/')) +
      '); rebuild the laptop with that read-only mount in its template'
    );
  return undefined;
}

export function resolveBoxedLocalModel(input: BoxedLocalModelInput): BoxedLocalModelResolution {
  const { entry, employee, hosts } = input;
  if (!entry || !takesBoxedModelEndpoint(entry)) return { kind: 'not-applicable' };
  const name = shown(employee.name, 60) || 'This employee',
    their = possessive(employee.pronouns);
  const selection = boxedLocalModelSelection(employee, input.saved);
  if (!selection || !selection.endpointId.trim())
    return refused(
      'UNSELECTED',
      `${name} has no local model endpoint selected, and ${their} agent cannot start without one. ` +
        `Choose a local model for ${name}, then continue.`
    );
  const endpoint = `'${shown(selection.endpointId)}'`;
  const host = hosts.find((candidate) => candidate.id === selection.endpointId);
  if (!host)
    return refused(
      'ENDPOINT_MISSING',
      `${name}'s local model endpoint ${endpoint} is no longer saved in this office. ` +
        `Save that endpoint again or choose another local model for ${name}, then continue.`
    );
  const models = (host.models ?? []).filter((model) => typeof model === 'string' && model.trim() !== '');
  if (!selection.modelId.trim() || (models.length > 0 && !models.includes(selection.modelId)))
    return refused(
      'MODEL_MISSING',
      `${name}'s local model '${shown(selection.modelId)}' is not one of the models saved on endpoint ` +
        `${endpoint}. Discover that endpoint's models again or choose a saved one, then continue.`
    );
  const reason = unreachable(host, input.modelSocketMounted);
  if (reason)
    return refused(
      'ENDPOINT_UNREACHABLE',
      `${name}'s local model endpoint ${endpoint} is not reachable from ${their} laptop: ${reason}.`
    );
  let hostname = '';
  try {
    hostname = new URL(host.baseUrl).hostname;
  } catch {
    /* Already refused above. */
  }
  if (loopback(hostname) && !host.apiKey?.trim())
    return refused(
      'KEY_MISSING',
      `${name}'s local model endpoint ${endpoint} has no API key saved, and the office model server ` +
        `requires its key. Save the key on that endpoint, then continue.`
    );
  const injection = buildCustomModelInjection(
    entry,
    host,
    selection.modelId,
    host.modelContextLengths?.[selection.modelId]
  );
  if (injection.kind !== 'env') return { kind: 'not-applicable' };
  return { kind: 'ready', environment: Object.freeze({ ...injection.envOverrides }) };
}
