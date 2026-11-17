/** CI fixture DATA only. The ordinary boxed owner recovery must earn every
 * binding, helper acknowledgement, worker credential and provider observation. */
import { constants, promises as fs } from 'node:fs';
import { z } from 'zod';
import { CompanyStore } from '../../src/company-store.js';
import { EmployeeSchema, EmployeePermissionsSchema, CompanySettingsSchema } from '../../src/company-types.js';
import { StateStore } from '../../src/state-store.js';
import { subscriptionProfileSchema } from '../../src/subscription-profiles.js';
import type { SessionState } from '../../src/types.js';

const uuid = z.string().uuid();
export const PlanOfficeBootstrap = z
  .object({
    version: z.literal(1),
    purpose: z.literal('reverie-ci-plan-office-bootstrap-v1'),
    employees: z
      .array(
        z
          .object({
            employeeId: uuid,
            sessionId: uuid,
            nativeThreadId: uuid,
            name: z.string().regex(/^CI [A-Za-z0-9 ]{1,30}$/),
            account: z.enum(['ci-plan-a', 'ci-plan-b']),
            permissions: EmployeePermissionsSchema,
          })
          .strict()
      )
      .min(1)
      .max(4),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.employees.map((e) => e.employeeId)).size === value.employees.length &&
      new Set(value.employees.map((e) => e.sessionId)).size === value.employees.length
  );

async function privateDirectory(path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await fs.realpath(path)) !== path
  )
    throw Error('Private disposable office directory required');
}
async function createFile(path: string, value: unknown): Promise<void> {
  const handle = await fs.open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600
  );
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Called once inside the owned disposable Docker control, before its ordinary
 * product web entry starts. There is no application fake-provider switch. */
export async function seedPlanOffice(input: unknown) {
  const contract = PlanOfficeBootstrap.parse(input);
  if (
    !process.getuid ||
    process.getuid() <= 0 ||
    process.env.HOME !== '/fixture/home' ||
    process.env.REVERIE_DATA_DIR !== '/fixture/data' ||
    process.env.REVERIE_RUNTIME_BACKEND !== 'boxed-docker-v1' ||
    process.env.REVERIE_OWNER_SETUP !== '1' ||
    process.env.VITEST !== undefined
  )
    throw Error('Use the isolated Docker control fixture, never the host or Vitest process');
  await fs.access('/.dockerenv');
  for (const directory of ['/fixture', '/fixture/home', '/fixture/data', '/fixture/accounts'])
    await privateDirectory(directory);
  for (const file of ['company.json', 'state.json', 'subscription-profiles.json']) {
    try {
      await fs.lstat('/fixture/data/' + file);
      throw Error('Office seed already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const profiles = ['a', 'b'].map((letter) =>
    subscriptionProfileSchema.parse({
      id: 'ci-plan-' + letter,
      label: 'CI Plan ' + letter.toUpperCase(),
      provider: 'anthropic',
      configDir: '/fixture/accounts/plan-' + letter,
      openCodeDataDir: '/fixture/accounts/plan-' + letter + '/opencode-data',
    })
  );
  for (const profile of profiles) {
    await privateDirectory(profile.configDir);
    await createFile(profile.configDir + '/.credentials.json', {
      claudeAiOauth: {
        accessToken: 'synthetic-original-' + profile.id,
        refreshToken: 'synthetic-refresh-' + profile.id,
        expiresAt: 4102444800000,
      },
    });
  }
  await createFile('/fixture/data/subscription-profiles.json', profiles);
  const store = new StateStore('/fixture/data/state.json');
  const employees = contract.employees.map((input) => {
    const profile = profiles.find((p) => p.id === input.account)!;
    const subscriptionProfile = { id: profile.id, label: profile.label, provider: profile.provider };
    const recipe = {
      mode: 'claude',
      workingDir: '/reverie_workspace/cases/boxed-canary',
      subscriptionProfile,
      configs: {},
    };
    store.setSession(input.sessionId, {
      id: input.sessionId,
      name: input.name,
      mode: 'claude',
      workingDir: recipe.workingDir,
      status: 'stopped',
      pid: null,
      pinned: true,
      desiredRunning: false,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      currentTaskId: null,
      claudeSessionChain: [input.nativeThreadId],
      resumeSessionId: input.nativeThreadId,
      subscriptionProfile,
      __envOverrides: { CLAUDE_CONFIG_DIR: '/home/agent/.claude' },
    } as SessionState);
    return EmployeeSchema.parse({
      id: input.employeeId,
      sessionId: input.sessionId,
      name: input.name,
      icon: '🔭',
      position: 'CI worker',
      expertise: ['Synthetic isolated office acceptance'],
      permissions: input.permissions,
      runtimeRecipe: recipe,
      desiredRunning: false,
      researchEnabled: false,
      createdAt: Date.now(),
    });
  });
  store.flush();
  const company = new CompanyStore('/fixture/data/company.json');
  await company.init();
  await company.update((state) => {
    state.settings.push(CompanySettingsSchema.parse({ ownerName: 'CI owner', enabled: true, autoWakeEnabled: false }));
    state.employees.push(...employees);
  });
  if (company.snapshot().dockerEmployeeContinuations?.length || employees.some((e) => e.dockerBinding))
    throw Error('Bootstrap must never fabricate native runtime evidence');
  return {
    version: 1,
    purpose: 'reverie-ci-plan-office-seeded-v1',
    employeeIds: employees.map((e) => e.id),
    accountIds: profiles.map((p) => p.id),
    nativeBindings: 0,
    desiredRunning: false,
    limitation: 'Inactive canonical fixture only; normal owner API recovery must earn all physical runtime facts.',
  };
}
