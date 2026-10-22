import { describe, expect, it } from 'vitest';
import { cliConfigContent } from '../src/cli-config-content.js';

describe('transient CLI configuration', () => {
  it('keeps subscription model and explicit tool policy together', () => {
    expect(JSON.parse(cliConfigContent({ autoAllowTools: true }, '{"model":"openai/gpt-5.4"}')!))
      .toEqual({ model: 'openai/gpt-5.4', permission: { '*': 'allow' } });
  });
  it('keeps selected custom provider and credentials transient and honors explicit model', () => {
    const selected = { model: 'private/default', provider: { private: { options: { apiKey: 'synthetic-secret' } } } };
    const config = { autoAllowTools: true, model: 'private/chosen', configContent: '{"theme":"quiet"}' };
    const before = JSON.stringify(config);
    expect(JSON.parse(cliConfigContent(config, JSON.stringify(selected))!)).toEqual({
      theme: 'quiet', ...selected, model: 'private/chosen', permission: { '*': 'allow' },
    });
    expect(JSON.stringify(config)).toBe(before);
  });
  it('never silently replaces malformed provider configuration with defaults', () => {
    expect(() => cliConfigContent({ autoAllowTools: true }, 'bad-json')).toThrow();
    expect(() => cliConfigContent(undefined, '[]')).toThrow();
    expect(cliConfigContent()).toBeUndefined();
  });
});
