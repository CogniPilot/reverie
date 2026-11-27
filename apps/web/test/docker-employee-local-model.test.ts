import { afterEach, describe, expect, it } from 'vitest';
import { getCli } from '../src/config/cli-registry/registry.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
import { EmployeeSchema } from '../src/company-types.js';
import type { CustomModelHost } from '../src/custom-model-hosts.js';
import {
  BOXED_MODEL_RELAY_PORT,
  boxedLocalModelSelection,
  resolveBoxedLocalModel,
  takesBoxedModelEndpoint,
  type BoxedLocalModelInput,
} from '../src/docker-employee-local-model.js';
import { dockerEmployeeProviderSourceDigest, dockerEmployeeSourceDigest } from '../src/docker-employee-store.js';
import { Session } from '../src/session.js';
import type { SessionMode, SessionState } from '../src/types.js';

const sid = '20000000-0000-4000-8000-000000000002';
const key = 'synthetic-' + 'k3y'.repeat(12);
const hands = () => getCli('hands') as CliEntry;
const endpoint = (patch: Partial<CustomModelHost> = {}): CustomModelHost => ({
  id: 'local-gpu',
  label: 'Local GPU',
  baseUrl: 'http://127.0.0.1:' + BOXED_MODEL_RELAY_PORT,
  apiKey: key,
  authStyle: 'bearer',
  models: ['synthetic-27b'],
  ...patch,
});
const recipe = { mode: 'hands', workingDir: '/reverie_workspace/cases/expert-jinx', configs: {} };
function employee(customModel?: { endpointId: string; modelId: string }, pronouns: string | null = 'she/her') {
  return EmployeeSchema.parse({
    id: '10000000-0000-4000-8000-000000000001',
    sessionId: sid,
    sessionGeneration: 3,
    name: 'Jinx',
    icon: 'J',
    position: 'Chief Operating Officer',
    expertise: ['operations'],
    createdAt: 1,
    onVacation: false,
    desiredRunning: true,
    ...(pronouns ? { pronouns } : {}),
    runtimeRecipe: { ...recipe, ...(customModel ? { customModel } : {}) },
  });
}
const chosen = { endpointId: 'local-gpu', modelId: 'synthetic-27b' };
const saved = (patch: Record<string, unknown> = {}) =>
  ({ id: sid, mode: 'hands', workingDir: recipe.workingDir, ...patch }) as unknown as SessionState;
const input = (patch: Partial<BoxedLocalModelInput> = {}): BoxedLocalModelInput => ({
  entry: hands(),
  employee: employee(chosen),
  saved: saved(),
  hosts: [endpoint()],
  modelSocketMounted: true,
  ...patch,
});
function refusal(patch: Partial<BoxedLocalModelInput>) {
  const result = resolveBoxedLocalModel(input(patch));
  if (result.kind !== 'refused') throw Error('Expected a refusal, got ' + result.kind);
  expect(result.refusal.message).not.toContain(key);
  return result.refusal;
}

const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
});

describe('what a boxed employee on a local model needs before its one launch', () => {
  it('applies only to a CLI whose registry entry takes its endpoint from the laptop launch environment', () => {
    expect(takesBoxedModelEndpoint(hands())).toBe(true);
    for (const mode of ['claude', 'codex', 'shell', 'opencode'])
      expect(takesBoxedModelEndpoint(getCli(mode)), mode).toBe(false);
    expect(takesBoxedModelEndpoint(undefined)).toBe(false);
    expect(resolveBoxedLocalModel(input({ entry: getCli('claude') }))).toEqual({ kind: 'not-applicable' });
    expect(resolveBoxedLocalModel(input({ entry: undefined }))).toEqual({ kind: 'not-applicable' });
  });
  it('takes the selection from the recipe first, then from what an older saved session still carries', () => {
    const kept = { endpointId: 'kept', modelId: 'kept-model', label: 'Kept', envKeys: [] };
    const plain = { endpointId: 'plain', modelId: 'plain-model', label: 'Plain' };
    expect(boxedLocalModelSelection(employee(chosen), saved({ __customModel: kept, customModel: plain }))).toEqual(
      chosen
    );
    expect(boxedLocalModelSelection(employee(), saved({ __customModel: kept, customModel: plain }))).toEqual({
      endpointId: 'kept',
      modelId: 'kept-model',
    });
    expect(boxedLocalModelSelection(employee(), saved({ customModel: plain }))).toEqual({
      endpointId: 'plain',
      modelId: 'plain-model',
    });
    expect(boxedLocalModelSelection(employee(), saved())).toBeUndefined();
  });
  it('derives the launch environment from the recipe and the endpoint store alone', () => {
    // The saved session of a rebuilt laptop carries neither values nor bookkeeping.
    const result = resolveBoxedLocalModel(input({ saved: saved(), modelSocketMounted: undefined }));
    expect(result).toEqual({
      kind: 'ready',
      environment: {
        REVERIE_HANDS_BASE_URL: 'http://127.0.0.1:8092/v1',
        REVERIE_HANDS_API_KEY: key,
        REVERIE_HANDS_MODEL: 'synthetic-27b',
      },
    });
    // A network endpoint is taken as configured: the office cannot see it from the laptop.
    const remote = resolveBoxedLocalModel(
      input({ hosts: [endpoint({ baseUrl: 'https://models.example.test/', apiKey: undefined })] })
    );
    expect(remote).toMatchObject({
      kind: 'ready',
      environment: { REVERIE_HANDS_BASE_URL: 'https://models.example.test/v1' },
    });
  });
  it('refuses with a named code and a plain sentence when the launch could not work', () => {
    expect(refusal({ employee: employee(), saved: saved() })).toEqual({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_UNSELECTED',
      message:
        'Jinx has no local model endpoint selected, and her agent cannot start without one. ' +
        'Choose a local model for Jinx, then continue.',
    });
    expect(refusal({ hosts: [endpoint({ id: 'another' })] })).toEqual({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_ENDPOINT_MISSING',
      message:
        "Jinx's local model endpoint 'local-gpu' is no longer saved in this office. " +
        'Save that endpoint again or choose another local model for Jinx, then continue.',
    });
    expect(refusal({ hosts: [endpoint({ models: ['other-model'] })] })).toMatchObject({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_MODEL_MISSING',
      message: expect.stringContaining(
        "Jinx's local model 'synthetic-27b' is not one of the models saved on endpoint 'local-gpu'"
      ),
    });
    expect(refusal({ modelSocketMounted: false })).toEqual({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_ENDPOINT_UNREACHABLE',
      message:
        "Jinx's local model endpoint 'local-gpu' is not reachable from her laptop: the laptop was built without " +
        'the shared model socket directory (/run/reverie-model); rebuild the laptop with that read-only mount in ' +
        'its template.',
    });
    expect(refusal({ hosts: [endpoint({ baseUrl: 'http://localhost:11434' })] })).toMatchObject({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_ENDPOINT_UNREACHABLE',
      message: expect.stringContaining(
        'it points at the address localhost:11434, which is this office itself; a laptop reaches the office model ' +
          'server only through its relay at http://127.0.0.1:8092'
      ),
    });
    expect(refusal({ hosts: [endpoint({ baseUrl: 'unix:///run/reverie-model/default.sock' })] })).toMatchObject({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_ENDPOINT_UNREACHABLE',
      message: expect.stringContaining('its saved address is not an http or https URL'),
    });
    expect(refusal({ hosts: [endpoint({ baseUrl: 'not a url' })] }).code).toBe(
      'DOCKER_CONTINUATION_LOCAL_MODEL_ENDPOINT_UNREACHABLE'
    );
    expect(refusal({ hosts: [endpoint({ apiKey: '  ' })] })).toEqual({
      code: 'DOCKER_CONTINUATION_LOCAL_MODEL_KEY_MISSING',
      message:
        "Jinx's local model endpoint 'local-gpu' has no API key saved, and the office model server requires its " +
        'key. Save the key on that endpoint, then continue.',
    });
  });
  it('words the sentence for the employee and never trusts stored text as markup', () => {
    expect(refusal({ employee: employee(chosen, 'he/him'), modelSocketMounted: false }).message).toContain(
      'from his laptop'
    );
    expect(refusal({ employee: employee(chosen, null), modelSocketMounted: false }).message).toContain(
      'from their laptop'
    );
    const hostile = { endpointId: 'x'.repeat(300) + '\u0007\n<b>', modelId: 'synthetic-27b' };
    const message = refusal({ employee: employee(hostile), hosts: [] }).message;
    expect(message.length).toBeLessThan(320);
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('merging the derived values into one launch', () => {
  function candidate(state: SessionState) {
    const session = new Session({ ...state, mode: 'hands' as SessionMode });
    sessions.push(session);
    return session;
  }
  it('changes neither the saved recipe nor either launch fingerprint', () => {
    const person = employee(chosen),
      state = saved({ resumeSessionId: sid });
    const session = candidate(state);
    const before = session.toPersistedState();
    const digests = [dockerEmployeeSourceDigest(person, before), dockerEmployeeProviderSourceDigest(person, before)];
    const ready = resolveBoxedLocalModel(input({ employee: person, saved: state }));
    if (ready.kind !== 'ready') throw Error('Expected launch values');
    expect(session.mergeLaunchEnvironment(ready.environment).sort()).toEqual([
      'REVERIE_HANDS_API_KEY',
      'REVERIE_HANDS_BASE_URL',
      'REVERIE_HANDS_MODEL',
    ]);
    const after = session.toPersistedState();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(key);
    expect([dockerEmployeeSourceDigest(person, after), dockerEmployeeProviderSourceDigest(person, after)]).toEqual(
      digests
    );
    expect(session.customModel).toBeUndefined();
  });
  it('leaves alone any key that the saved state records, and empty values', () => {
    const session = candidate(saved());
    const before = session.toPersistedState();
    expect(
      session.mergeLaunchEnvironment({
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768',
        CLAUDE_CONFIG_DIR: '/elsewhere',
        CODEX_HOME: '/elsewhere',
        REVERIE_HANDS_MODEL: '',
      })
    ).toEqual([]);
    expect(session.toPersistedState()).toEqual(before);
  });
});
