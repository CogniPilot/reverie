import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { expertRuntimeRecipe, RuntimeRecipeSchema } from '../src/expert-runtime-recipe.js';

describe('durable expert launch recipe', () => {
  it('keeps account references, thread and launch switches without credential/config content', () => {
    const session = new Session({ id: 'expert', workingDir: '/workspace/expert', mode: 'opencode',
      subscriptionProfile: { id: 'account', label: 'Account', provider: 'openai' },
      openCodeConfig: { continueSession: 'ses_exact', autoAllowTools: true, configContent: '{"apiKey":"private-value"}' },
      envOverrides: { CODEX_HOME: '/private/account', OPENCODE_CONFIG_CONTENT: '{"apiKey":"private-value"}' } });
    const recipe = expertRuntimeRecipe(session);
    expect(recipe.configs.openCodeConfig).toEqual({ continueSession: 'ses_exact', autoAllowTools: true });
    expect(recipe.subscriptionProfile?.id).toBe('account');
    expect(recipe.workingDir).toBe('/workspace/expert');
    expect(JSON.stringify(recipe)).not.toMatch(/private-value|private\/account|configContent|envOverrides/);
    expect(() => RuntimeRecipeSchema.parse({ ...recipe, envOverrides: { KEY: 'secret' } })).toThrow();
    for (const configs of [{ openCodeConfig: { configContent: 'secret' } }, { codexConfig: { apiKey: 'secret' } }, { credentials: { model: 'secret' } }]) {
      expect(() => RuntimeRecipeSchema.parse({ ...recipe, configs })).toThrow();
    }
  });
});
