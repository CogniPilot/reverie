import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import { RuntimeRecipeSchema } from '../src/expert-runtime-recipe.js';

let directory: string;
let store: CompanyStore;
let company: CompanyService;
const sessions = new Map<string, {id: string; name: string; owner?: string}>();
const recipes = new Map<string, ReturnType<typeof RuntimeRecipeSchema.parse>>();
const replaceSession = vi.fn(async () => {});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'resource-binding-'));
  store = new CompanyStore(join(directory, 'company.json'));
  await store.init();
  sessions.clear(); recipes.clear(); replaceSession.mockReset();
  for (const id of ['old-session', 'reserved-session']) {
    sessions.set(id, {id, name: 'Worker'});
    recipes.set(id, RuntimeRecipeSchema.parse({mode: 'codex', workingDir: '/workspace', configs: {}}));
  }
  company = new CompanyService(store, {
    getSession: id => sessions.get(id), runtimeRecipeOf: id => recipes.get(id),
    chatrooms: {rooms: () => [], room: () => undefined, addMember: vi.fn(), replaceSession},
    research: {start: vi.fn(), inspect: vi.fn(), stop: vi.fn()},
  });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, {recursive: true, force: true}); });

async function approved() {
  const employee = await company.hire({name: 'Worker', icon: '🦊', position: 'Engineer',
    expertise: ['systems'], sessionId: 'old-session', researchEnabled: false});
  return {employee: structuredClone(store.snapshot().employees.find(row => row.id === employee.id)!),
    targetRecipe: structuredClone(recipes.get('reserved-session')!)};
}

it('publishes exactly the approved normal recipe and next generation through the real store', async () => {
  const expected = await approved();
  const result = await company.rebind(expected.employee.id, undefined, 'reserved-session', 'owner', undefined, expected);
  expect(result.sessionId).toBe('reserved-session');
  expect(result.sessionGeneration).toBe(expected.employee.sessionGeneration + 1);
  expect(result.runtimeRecipe).toEqual(expected.targetRecipe);
  const reopened = new CompanyStore(join(directory, 'company.json')); await reopened.init();
  expect(reopened.snapshot().employees[0]).toEqual(result);
});

it('refuses an owner intent change since approval without publishing the target', async () => {
  const expected = await approved();
  await store.update(state => { state.employees[0].onVacation = true; });
  await expect(company.rebind(expected.employee.id, undefined, 'reserved-session', 'owner', undefined, expected))
    .rejects.toThrow('Approved employee binding changed');
  expect(company.view().employees[0].sessionId).toBe('old-session');
  expect(replaceSession).not.toHaveBeenCalled();
});

it('refuses a replacement of the selected normal Session object during room migration', async () => {
  const expected = await approved();
  replaceSession.mockImplementationOnce(async () => {
    sessions.set('reserved-session', {id: 'reserved-session', name: 'Different incarnation'});
  });
  await expect(company.rebind(expected.employee.id, undefined, 'reserved-session', 'owner', undefined, expected))
    .rejects.toThrow('replacement session or recipe changed');
  // The reserved generation remains an explicit unfinished migration. It is
  // not silently rebound back or reported as a completed resource replacement.
  expect(company.view().employees[0].sessionId).toBe('old-session');
  expect(company.view().employees[0].bindingMigration).toBeDefined();
});

it('refuses recipe drift during room migration and preserves the pending generation', async () => {
  const expected = await approved();
  replaceSession.mockImplementationOnce(async () => {
    recipes.set('reserved-session', {...expected.targetRecipe, mode: 'claude'});
  });
  await expect(company.rebind(expected.employee.id, undefined, 'reserved-session', 'owner', undefined, expected))
    .rejects.toThrow('replacement session or recipe changed');
  expect(company.view().employees[0].sessionId).toBe('old-session');
  expect(company.view().employees[0].sessionGeneration).toBe(expected.employee.sessionGeneration + 1);
});
