/** Pure local account config codecs. These grant no launch, filesystem or owner authority. */
import { isAbsolute } from 'node:path';
import type { ClaudeMode } from './types.js';
import type { StartupAccountProfileName } from './config/cli-registry/profiles.js';
import type { FullAccessDefaults } from './config/cli-registry/types.js';

type Config = Record<string, unknown>;
const object = (value: unknown): value is Config => !!value && typeof value === 'object' && !Array.isArray(value);
export const SELECTED_ACCOUNT_BYPASS_FLAG = '--dangerously-skip-permissions';
export interface StartupAccountProfile {
  readonly name: StartupAccountProfileName;
  readonly selectedAccount?: Readonly<{
    provider: 'anthropic';
    configFile: '.claude.json';
    settingsFile: 'settings.json';
    prepare(
      config: Config,
      settings: Config,
      workingDir: string,
      mode: ClaudeMode
    ): { config: Config; settings: Config };
  }>;
  readonly workspaceTrustArgument?: (workingDir: string) => string;
  readonly bypassFlags?: (mode: ClaudeMode | undefined) => string[];
}
function prepareSelectedAccount(original: Config, preferences: Config, workingDir: string, mode: ClaudeMode) {
  const config = structuredClone(original),
    settings = structuredClone(preferences);
  if (config.hasCompletedOnboarding === undefined) config.hasCompletedOnboarding = true;
  if (config.theme === undefined) config.theme = 'dark';
  if (config.projects !== undefined && !object(config.projects))
    throw new Error(
      'Selected Claude account projects configuration is malformed. Repair it before starting the expert.'
    );
  const projects = { ...(config.projects as Config | undefined) },
    current = projects[workingDir];
  if (current !== undefined && !object(current))
    throw new Error(
      'Selected Claude account workspace configuration is malformed. Repair it before starting the expert.'
    );
  const project = { ...(current as Config | undefined) };
  for (const [key, value] of Object.entries({
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
    projectOnboardingSeenCount: 1,
  }))
    if (project[key] === undefined) project[key] = value;
  Object.defineProperty(projects, workingDir, { value: project, enumerable: true, configurable: true, writable: true });
  config.projects = projects;
  // Acknowledge only a permission mode that the owner-authorized launch already resolved.
  if (mode === 'dangerously-skip-permissions' && settings.skipDangerousModePermissionPrompt === undefined)
    settings.skipDangerousModePermissionPrompt = true;
  return { config, settings };
}
export function inlineWorkspaceTrustArgument(workingDir: string): string {
  if (!isAbsolute(workingDir) || /[\0\r\n]/.test(workingDir)) throw new Error('Invalid Codex trust workspace');
  // A whole inline table preserves exact path keys; dotted CLI keys split them.
  const value = `projects={${JSON.stringify(workingDir)}={trust_level="trusted"}}`;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
export const STARTUP_ACCOUNT_PROFILES: Readonly<Record<StartupAccountProfileName, Readonly<StartupAccountProfile>>> =
  Object.freeze({
    'anthropic-local-account-v1': Object.freeze({
      name: 'anthropic-local-account-v1',
      selectedAccount: Object.freeze({
        provider: 'anthropic',
        configFile: '.claude.json',
        settingsFile: 'settings.json',
        prepare: prepareSelectedAccount,
      }),
      bypassFlags: (mode: ClaudeMode | undefined) =>
        mode === 'dangerously-skip-permissions' ? [SELECTED_ACCOUNT_BYPASS_FLAG] : [],
    }),
    'openai-local-account-v1': Object.freeze({
      name: 'openai-local-account-v1',
      workspaceTrustArgument: inlineWorkspaceTrustArgument,
    }),
  });

/** Declarative config defaults respect an explicit embedded owner policy and every supplied value. */
export function fullAccessConfigDefaults(
  policy: Readonly<FullAccessDefaults> | undefined,
  config: Config | undefined
): Config {
  if (!policy) return {};
  const guard = policy.unlessJsonProperty,
    content = guard && config?.[guard.configField];
  if (guard && typeof content === 'string') {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === 'object' && guard.property in parsed) return {};
    } catch {
      /* Preserve the existing malformed-content handling; launch validation owns it. */
    }
  }
  return Object.fromEntries(Object.entries(policy.values).filter(([key]) => config?.[key] === undefined));
}
