/** Actual employee profile widget; simulated API, no hardware/host policy effect. */
import {afterEach, describe, expect, it} from 'vitest';
import {createHarness} from './helpers/chat-app-harness.mjs';
const EID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const employee = () => ({id: EID, sessionId: SID, sessionGeneration: 1, name: 'Synthetic Expert',
  position: 'Engineer', expertise: ['testing'], permissions: {}, responsibilities: [], personality: ''});
const status = () => ({version: 1, employeeId: EID, current: {sessionId: SID, sessionGeneration: 1, bindingDigest: 'b'.repeat(64)},
  revision: 0, choices: {known: true, devices: [{deviceUuid: DEVICE, model: 'Synthetic NVIDIA GPU'}]}, requested: null,
  applied: {known: true, enabled: true, deviceUuid: DEVICE, source: 'legacy-session'},
  active: {known: false, running: true, enabled: null, deviceUuid: null}, state: 'unchanged'});
const windows: Array<{close(): void}> = [];
afterEach(() => {for (const window of windows.splice(0)) window.close();});
async function fixture(exchange: (url: string, options?: {method?: string; body?: unknown}) => unknown) {
  const h = await createHarness({sessions: [], rooms: []});windows.push(h.window);
  h.app._chatApi = exchange;
  const dialog = h.document.createElement('dialog');dialog.open = true;
  const container = h.document.createElement('section');dialog.append(container);h.document.body.append(dialog);
  h.shell.employeeGpuFields(container, employee(), dialog);await h.flush();
  return {...h, dialog, container};
}

describe('employee GPU settings', () => {
  it('preserves a legacy applied grant without inventing a false request or active proof', async () => {
    const calls: string[] = [];
    const h = await fixture(url => {calls.push(url);return Promise.resolve({ok: true, data: {gpuAccess: status()}});});
    const input = h.container.querySelector<HTMLInputElement>('input')!;
    expect(input.checked).toBe(true);expect(input.indeterminate).toBe(false);
    expect(h.container.textContent).toContain('No explicit request');
    expect(h.container.textContent).toContain('session override');
    expect(h.container.textContent).toContain('Active device accessUnknown');
    expect(calls).toEqual([`/api/company/employees/${EID}/gpu-access`]);
  });
  it('shows no-grant/new defaults off without sending an implicit disable', async () => {
    const calls: unknown[] = [];
    const off = {...status(), applied: {known: true, enabled: false, deviceUuid: null, source: 'none'},
      active: {known: true, running: false, enabled: false, deviceUuid: null}};
    const h = await fixture((_url, options) => {calls.push(options);return Promise.resolve({ok: true, data: {gpuAccess: off}});});
    const input = h.container.querySelector<HTMLInputElement>('input')!;
    expect(input.checked).toBe(false);expect(input.indeterminate).toBe(false);
    expect(calls).toEqual([undefined]);expect(h.container.textContent).toContain('Host policyOff');
  });

  it('sends an explicit CAS request and preserves active/policy facts while pending', async () => {
    const calls: Array<{url: string; options?: {method?: string; body?: unknown}}> = [];
    const h = await fixture((url, options) => {
      calls.push({url, options});return Promise.resolve({ok: true, data: {gpuAccess: options?.method === 'POST'
        ? {...status(), revision: 1, requested: {enabled: false, deviceUuid: null, revision: 1}, state: 'pending'} : status()}});
    });
    const input = h.container.querySelector<HTMLInputElement>('input')!;input.checked = false;
    input.dispatchEvent(new h.window.Event('change', {bubbles: true}));
    h.container.querySelector<HTMLButtonElement>('[aria-label="Save GPU request for Synthetic Expert"]')!.click();await h.flush();
    expect(calls[1].options).toEqual({method: 'POST', body: {expected: {...status().current, revision: 0}, enabled: false}});
    expect(h.container.textContent).toContain('host policy is pending');
    expect(h.container.textContent).toContain('Host policyOn');
    expect(h.container.textContent).toContain('Current work keeps running');
    expect(calls.every(call => call.url.endsWith('/gpu-access'))).toBe(true);
  });
  it('keeps unknown access indeterminate and never retries an unconfirmed request', async () => {
    let posts = 0;
    const unknown = {...status(), applied: {known: false, enabled: null, deviceUuid: null, source: 'unknown'},
      choices: {known: false, devices: []}};
    const h = await fixture((_url, options) => {if (options?.method === 'POST') {posts++;return Promise.resolve({ok: false, error: 'Not confirmed'});}
      return Promise.resolve({ok: true, data: {gpuAccess: unknown}});});
    const input = h.container.querySelector<HTMLInputElement>('input')!;
    expect(input.indeterminate).toBe(true);expect(h.container.textContent).toContain('Host policyUnknown');
    expect(h.container.querySelector<HTMLButtonElement>('[aria-label="Save GPU request for Synthetic Expert"]')!.disabled).toBe(true);
    // An explicit off request is allowed without inventing a device choice.
    input.checked = false;input.dispatchEvent(new h.window.Event('change', {bubbles: true}));
    h.container.querySelector<HTMLButtonElement>('[aria-label="Save GPU request for Synthetic Expert"]')!.click();await h.flush();
    expect(posts).toBe(1);expect(h.container.textContent).toContain('not retried automatically');
    expect(h.container.querySelector<HTMLButtonElement>('[aria-label="Save GPU request for Synthetic Expert"]')!.disabled).toBe(true);
  });
  it('does not paint an old closed widget when its status response arrives late', async () => {
    let resolve!: (value: unknown) => void;
    const h = await fixture(() => new Promise(done => {resolve = done;}));
    const oldText = h.container.textContent;
    h.dialog.open = false;h.dialog.dispatchEvent(new h.window.Event('close'));h.dialog.remove();
    h.app._chatApi = () => Promise.resolve({ok: true, data: {gpuAccess: status()}});
    const fresh = h.document.createElement('dialog');fresh.open = true;
    const group = h.document.createElement('section');fresh.append(group);h.document.body.append(fresh);
    h.shell.employeeGpuFields(group, employee(), fresh);await h.flush();
    resolve({ok: true, data: {gpuAccess: {...status(), applied: {known: true, enabled: false, deviceUuid: null, source: 'none'}}}});await h.flush();
    expect(h.container.textContent).toBe(oldText);expect(group.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
  });
  it('does not send GPU changes with an unrelated ordinary profile save', async () => {
    const h = await createHarness({sessions: [], rooms: []});windows.push(h.window);
    const person = employee(), calls: Array<{url: string; options?: {method?: string; body?: unknown}}> = [];
    h.app._chatApi = async (url: string, options?: {method?: string; body?: unknown}) => {
      calls.push({url, options});
      if (url === '/api/company') return {ok: true, data: {canManage: true, employees: [person], settings: {}}};
      if (url === '/api/chatrooms/phone-status') return {ok: true, data: {self: 'owner', canSetOwn: true}};
      if (url.endsWith('/gpu-access')) return {ok: true, data: {gpuAccess: status()}};
      return {ok: true, data: {employee: person}};
    };
    h.shell.openEmployeeProfile(person);await h.flush();
    h.document.querySelector<HTMLFormElement>('.ca-profile-form')!.dispatchEvent(new h.window.Event('submit', {bubbles: true, cancelable: true}));await h.flush();
    const saved = calls.find(call => call.url === `/api/company/employees/${EID}` && call.options?.method === 'PUT');
    expect(saved).toBeDefined();expect(saved!.options!.body).not.toHaveProperty('gpuAccess');
    expect(calls.some(call => call.url.endsWith('/gpu-access') && call.options?.method === 'POST')).toBe(false);
  });
});
