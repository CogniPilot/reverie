/** Ordered persisted recipe correlation fields. DATA only; no runtime or provider grant. */
export const DOCKER_EMPLOYEE_PROVIDER_RECIPE_FIELDS = [
  'mode',
  'workingDir',
  'model',
  'effort',
  'advisorModel',
  'claudeMode',
  'allowedTools',
  'subscriptionProfile',
  'customModel',
  'runtimeThreads',
  'openCodeConfig',
  'codexConfig',
  'geminiConfig',
  'antigravityConfig',
  'piConfig',
  'grokConfig',
  'deepSeekConfig',
  'ompConfig',
  'resumeSessionId',
  'claudeSessionChain',
  '__envOverrides',
  '__customModel',
] as const;

export type DockerEmployeeProviderRecipe = Record<(typeof DOCKER_EMPLOYEE_PROVIDER_RECIPE_FIELDS)[number], unknown>;
