import { describe, it, expect } from 'vitest';
import { DockerPlanSourceContext, dockerPlanContextForProvider } from '../src/docker-plan-source-data.js';
const nativeId = '12345678-1234-4234-8234-123456789abc',
  sha256 = 'a'.repeat(64);
function context(provider: 'anthropic' | 'openai' = 'anthropic') {
  const claude = provider === 'anthropic',
    history = claude ? 'projects' : 'sessions';
  return {
    source: { kind: 'home', relative: [claude ? '.claude' : '.codex'], dev: '1', ino: '2' },
    roles: [claude ? 'claude-projects' : 'codex-sessions'],
    conversation: {
      nativeId,
      relative: [history, 'private', claude ? nativeId + '.jsonl' : 'rollout-' + nativeId + '.jsonl'],
      sha256,
    },
  };
}
describe('fixed installer context DATA', () => {
  it('requires explicit null for no context and grants no launch authority', () => {
    expect(DockerPlanSourceContext.parse({ source: { kind: 'none' }, roles: [], conversation: null })).toEqual({
      source: { kind: 'none' },
      roles: [],
      conversation: null,
    });
    expect(() => DockerPlanSourceContext.parse({ source: { kind: 'none' }, roles: [] })).toThrow();
    expect(() => DockerPlanSourceContext.parse({ ...context(), source: { kind: 'none' } })).toThrow();
  });
  it.each(['anthropic', 'openai'] as const)(
    'accepts only selected %s history and matched provider roles',
    (provider) => {
      const v = context(provider);
      expect(dockerPlanContextForProvider(v, provider)).toEqual(v);
      expect(() => dockerPlanContextForProvider(v, provider === 'anthropic' ? 'openai' : 'anthropic')).toThrow();
      expect(() => DockerPlanSourceContext.parse({ ...v, roles: [...v.roles, ...v.roles] })).toThrow();
      expect(() => DockerPlanSourceContext.parse({ ...v, roles: ['claude-projects', 'codex-sessions'] })).toThrow();
    }
  );
  it('restricts external intake to the selected thread and one history role', () => {
    const value = { ...context(), source: { kind: 'intake', dev: '1', ino: '2' } };
    expect(DockerPlanSourceContext.parse(value)).toEqual(value);
    expect(() =>
      DockerPlanSourceContext.parse({ ...value, roles: ['claude-projects', 'claude-instructions'] })
    ).toThrow();
    expect(() => DockerPlanSourceContext.parse({ ...value, conversation: null })).toThrow();
  });
  it.each(['..', '/absolute', 'slash/child', 'back\\slash', 'control\0part', 'é'.repeat(128)])(
    'refuses unsafe/oversize UTF8 component %j',
    (component) => {
      expect(() =>
        DockerPlanSourceContext.parse({
          ...context(),
          source: { kind: 'home', relative: [component], dev: '1', ino: '2' },
        })
      ).toThrow();
    }
  );
  it('bounds complete relative paths and unsigned inode identities', () => {
    const v = context();
    expect(() =>
      DockerPlanSourceContext.parse({
        ...v,
        source: { kind: 'home', relative: Array(17).fill('x'.repeat(255)), dev: '1', ino: '2' },
      })
    ).toThrow();
    for (const ino of ['0', '01', '18446744073709551616'])
      expect(() =>
        DockerPlanSourceContext.parse({ ...v, source: { kind: 'home', relative: ['.claude'], dev: '1', ino } })
      ).toThrow();
  });
  it('binds native ID, provider filename and history root without accepting arbitrary path roles', () => {
    const v = context('openai');
    for (const relative of [
      ['sessions', nativeId + '.jsonl'],
      ['projects', 'rollout-' + nativeId + '.jsonl'],
      ['sessions', 'rollout-' + nativeId.replace('a', 'b') + '.jsonl'],
    ])
      expect(() => DockerPlanSourceContext.parse({ ...v, conversation: { ...v.conversation, relative } })).toThrow();
    expect(() => DockerPlanSourceContext.parse({ ...context(), token: 'forged' })).toThrow();
  });
});
