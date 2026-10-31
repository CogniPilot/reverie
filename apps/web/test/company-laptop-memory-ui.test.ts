/**
 * Laptop memory from the Company profile: the owner previews a memory change through the protected
 * replacement routes (POST /api/company/resources/preview, apply, result), sees the limits that are kept, and restarts
 * the laptop with a handoff note. Apply is sent once and never retried; an unconfirmed answer says to check first.
 * The section exists only when the server reports the routes (resourceReplacement), and only to the verified owner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerCompanyRoutes } from '../src/web/routes/company-routes.js';
import { CompanyService } from '../src/company-service.js';
import { CompanyStore } from '../src/company-store.js';
import type { SessionPort } from '../src/web/ports/session-port.js';
import { createHarness, member, room } from './helpers/chat-app-harness.mjs';

describe('GET /api/company reports the laptop-memory routes', () => {
  const directories: string[] = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });
  const company = async (owner: boolean, enabled: boolean | undefined) => {
    const directory = await mkdtemp(join(tmpdir(), 'reverie-company-memory-'));
    directories.push(directory);
    const store = new CompanyStore(join(directory, 'company.json'));
    await store.init();
    const service = new CompanyService(store, {
      getSession: () => undefined,
      chatrooms: { rooms: () => [], room: () => undefined, addMember: vi.fn(), removeMember: vi.fn() },
      research: { start: vi.fn(), inspect: vi.fn(), stop: vi.fn() },
    } as never);
    const app = Fastify();
    registerCompanyRoutes(app, { sessions: new Map() } as unknown as SessionPort, service, undefined, undefined, undefined, {
      verifiedOwner: (() => owner) as never,
      ...(enabled === undefined ? {} : { resourceReplacement: enabled }),
    });
    await app.ready();
    const data = (await app.inject({ method: 'GET', url: '/api/company' })).json().data;
    await app.close();
    return data;
  };

  it('only to the verified owner, and only when the server enabled them', async () => {
    expect((await company(true, true)).resourceReplacement).toBe(true);
    expect(await company(true, false)).not.toHaveProperty('resourceReplacement');
    expect(await company(true, undefined)).not.toHaveProperty('resourceReplacement');
    expect(await company(false, true)).not.toHaveProperty('resourceReplacement');
  });
});

describe('the Laptop memory section of the owner profile', () => {
  const sessionId = '0000002d-0035-4000-8000-000000000047';
  const employeeId = '11111111-2222-4333-8444-555555555555';
  const opened: any[] = [];
  afterEach(() => {
    for (const h of opened.splice(0)) h.dom.window.close();
  });
  const draft = {
    draftId: 'aaaaaaaa-0000-4000-8000-000000000001', operationId: 'aaaaaaaa-0000-4000-8000-000000000002',
    sourceMemoryMiB: 4096,
    resources: { budgetMode: 'admission', memoryMiB: 8192, pidsLimit: 1024, cpus: 4, poolMemoryMiB: 65536, poolTasksMax: 8192 },
  };

  async function setup(enabled: boolean, replies: Record<string, (body: any) => any> = {}) {
    const employee = { id: employeeId, name: 'River', icon: 'R', position: 'Reviewer', sessionId, available: true,
      reportsTo: 'owner', onVacation: false, permissions: {} };
    const data: any = { canManage: true, settings: { ownerName: 'Owner' }, employees: [employee],
      ...(enabled ? { resourceReplacement: true } : {}) };
    const h = await createHarness({
      sessions: [{ id: sessionId, name: employee.name, mode: 'codex' }],
      rooms: [room('office', 'Office', [member(sessionId, employee.name)])],
      company: data,
    });
    opened.push(h);
    const previous = h.app._chatApi.bind(h.app);
    const calls: Array<{ path: string; body: any }> = [];
    h.app._chatApi = async (path: string, opts: any) => {
      if (path === '/api/company' && !opts) return { ok: true, data };
      if (path === '/api/chatrooms/phone-status') return { ok: true, data: { self: 'owner', canSetOwn: true } };
      if (path === '/api/company/hire-options') return { ok: true, data: { sources: [], harnesses: [] } };
      if (path.startsWith('/api/company/resources/')) {
        if (!path.endsWith('/operations')) calls.push({ path, body: opts?.body });
        const reply = replies[path.slice('/api/company/resources/'.length)];
        return reply ? reply(opts?.body) : path.endsWith('/operations') ? { ok: true, data: [] } : { ok: false, status: 503, error: 'HTTP 503' };
      }
      return previous(path, opts);
    };
    const confirm = vi.spyOn(h.shell, 'confirmCompanyAction').mockResolvedValue(true);
    await h.shell.openCompany('people');
    h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click();
    await h.flush();
    const section = () => h.document.querySelector('.ca-expert-profile .ca-profile-memory') as HTMLElement | null;
    const button = (label: string) => section()!.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
    const status = () => section()!.querySelector('[role="status"]')!.textContent;
    return { h, calls, confirm, section, button, status };
  }

  it('is not shown when the server does not report the routes, and asks nothing', async () => {
    const { calls, section } = await setup(false);
    expect(section()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('previews, shows what is kept, restarts once with the note, and reads the result on request', async () => {
    const { h, calls, confirm, section, button, status } = await setup(true, {
      preview: () => ({ ok: true, data: draft }),
      apply: () => ({ ok: true, data: { id: draft.operationId, phase: 'starting' } }),
      result: () => ({ ok: true, data: { id: draft.operationId, phase: 'completed' } }),
    });
    const input = section()!.querySelector('input[type="number"]') as HTMLInputElement;
    input.value = '8192';
    button('Preview laptop memory for River').click();
    await h.flush();
    expect(calls).toEqual([{ path: '/api/company/resources/preview', body: { employeeId, memoryMiB: 8192 } }]);
    expect(status()).toBe('Preview: 4,096 MiB now, 8,192 MiB after the restart. Nothing has changed yet.');
    expect(section()!.textContent).toContain('Kept: 1024 processes, 4 CPUs. Shared pool: 65,536 MiB, 8192 tasks.');
    const note = section()!.querySelector('textarea') as HTMLTextAreaElement;
    expect(note.value).toContain('8,192 MiB');
    note.value = 'Resume the review from your journal.';
    const restart = button('Restart River with 8,192 MiB');
    restart.click();
    await h.flush();
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls[1]).toEqual({ path: '/api/company/resources/apply', body: { previewId: draft.draftId, handoff: 'Resume the review from your journal.' } });
    expect(status()).toContain('Restart started (starting)');
    // One Apply per preview: the button stays off, and a second click sends nothing.
    expect(restart.disabled).toBe(true);
    restart.click();
    await h.flush();
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    button('Check laptop memory change for River').click();
    await h.flush();
    expect(calls[2]).toEqual({ path: '/api/company/resources/result', body: { operationId: draft.operationId } });
    expect(status()).toBe("River's laptop now has the new memory.");
  });

  it('an unconfirmed Apply is never retried and says to check the status first', async () => {
    const { h, calls, section, button, status } = await setup(true, {
      preview: () => ({ ok: true, data: draft }),
      apply: () => ({ ok: false, status: 503, errorCode: 'RESOURCE_REPLACEMENT_UNCONFIRMED_INSPECT_BEFORE_RETRY' }),
      result: () => ({ ok: true, data: { id: draft.operationId, phase: 'recovery-required' } }),
    });
    (section()!.querySelector('input[type="number"]') as HTMLInputElement).value = '8192';
    button('Preview laptop memory for River').click();
    await h.flush();
    const restart = button('Restart River with 8,192 MiB');
    restart.click();
    await h.flush();
    expect(status()).toContain('Restart unconfirmed');
    expect(button('Preview laptop memory for River').disabled).toBe(true);
    expect(restart.disabled).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    button('Check laptop memory change for River').click();
    await h.flush();
    expect(status()).toContain('needs recovery');
  });

  it('an unavailable result retains the unknown operation instead of suggesting another Preview', async () => {
    const { h, section, button, status } = await setup(true, {
      preview: () => ({ ok: true, data: draft }),
      apply: () => ({ ok: false, status: 503, errorCode: 'RESOURCE_REPLACEMENT_UNCONFIRMED_INSPECT_BEFORE_RETRY' }),
      // No move record exists, so the result route answers 503 every time.
      result: () => ({ ok: false, status: 503, errorCode: 'RESOURCE_REPLACEMENT_UNCONFIRMED_INSPECT_BEFORE_RETRY' }),
    });
    (section()!.querySelector('input[type="number"]') as HTMLInputElement).value = '8192';
    button('Preview laptop memory for River').click();
    await h.flush();
    button('Restart River with 8,192 MiB').click();
    await h.flush();
    button('Check laptop memory change for River').click();
    await h.flush();
    expect(status()).toContain('outcome is unknown');
    expect(status()).not.toContain('preview again');
    expect(button('Preview laptop memory for River').disabled).toBe(true);
  });

  it('a refused preview changes nothing and says why', async () => {
    const { h, calls, section, button, status } = await setup(true, { preview: () => ({ ok: false, status: 404, error: 'HTTP 404' }) });
    (section()!.querySelector('input[type="number"]') as HTMLInputElement).value = '8192';
    button('Preview laptop memory for River').click();
    await h.flush();
    expect(status()).toBe('Laptop memory changes are not enabled on this server.');
    expect(section()!.querySelector('textarea')).toBeNull();
    expect(calls).toHaveLength(1);
  });
  it('retains identity before a thrown Apply and recovers it after closing and reopening the profile', async () => {
    const { h, section, button, status, calls } = await setup(true, {
      preview: () => ({ ok: true, data: draft }),
      apply: () => { throw new Error('lost transport'); },
      result: () => ({ ok: false, status: 503 }),
    });
    (section()!.querySelector('input') as HTMLInputElement).value = '8192';
    button('Preview laptop memory for River').click(); await h.flush();
    button('Restart River with 8,192 MiB').click(); await h.flush();
    expect(status()).toContain('unconfirmed');
    expect(JSON.parse(h.window.localStorage.getItem(`reverie:laptop-memory:${employeeId}`)!)).toEqual([draft.operationId]);
    const dialog = h.document.querySelector('.ca-expert-profile') as HTMLDialogElement;
    dialog.close();
    h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click(); await h.flush();
    expect(button('Preview laptop memory for River').disabled).toBe(true);
    button('Check laptop memory change for River').click(); await h.flush();
    expect(calls.filter(call => call.path.endsWith('/result')).at(-1)?.body).toEqual({operationId: draft.operationId});
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
  });

  it('discovers a pending server operation on a fresh page with no browser recovery state', async () => {
    const { h, button, status, calls } = await setup(true, {
      operations: () => ({ok: true, data: [{id: draft.operationId, employeeId, phase: 'recovery-required'}]}),
      result: () => ({ok: true, data: {id: draft.operationId, phase: 'completed'}}),
    });
    expect(button('Preview laptop memory for River').disabled).toBe(true);
    button('Check laptop memory change for River').click(); await h.flush();
    expect(status()).toContain('now has the new memory');
    expect(button('Preview laptop memory for River').disabled).toBe(false);
    expect(h.window.localStorage.getItem(`reverie:laptop-memory:${employeeId}`)).toBe('[]');
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
  });

  it('allows a fresh Preview only after authoritative not-started, never a 503', async () => {
    const { h, section, button, status } = await setup(true, {
      preview: () => ({ok: true, data: draft}), apply: () => ({ok: false, status: 503}),
      result: () => ({ok: true, data: {id: draft.operationId, phase: 'not-started'}}),
    });
    (section()!.querySelector('input') as HTMLInputElement).value = '8192';
    button('Preview laptop memory for River').click(); await h.flush();
    button('Restart River with 8,192 MiB').click(); await h.flush();
    expect(button('Preview laptop memory for River').disabled).toBe(true);
    button('Check laptop memory change for River').click(); await h.flush();
    expect(status()).toContain('not dispatched');
    expect(button('Preview laptop memory for River').disabled).toBe(false);
  });

  it('closing during Apply does not lose its pending identity or let a late reply unlock a reopened profile', async () => {
    let finish!: (value: unknown) => void;
    const { h, section, button, calls } = await setup(true, {
      preview: () => ({ok: true, data: draft}),
      apply: () => new Promise(resolve => {finish = resolve;}),
      result: () => ({ok: true, data: {id: draft.operationId, phase: 'completed'}}),
    });
    (section()!.querySelector('input') as HTMLInputElement).value = '8192';
    button('Preview laptop memory for River').click(); await h.flush();
    button('Restart River with 8,192 MiB').click(); await h.flush();
    (h.document.querySelector('.ca-expert-profile') as HTMLDialogElement).close();
    h.document.querySelector<HTMLButtonElement>('[aria-label="Edit profile for River"]')!.click(); await h.flush();
    expect(button('Preview laptop memory for River').disabled).toBe(true);
    finish({ok: true, data: {id: draft.operationId, phase: 'starting'}}); await h.flush();
    expect(button('Preview laptop memory for River').disabled).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    button('Check laptop memory change for River').click(); await h.flush();
    expect(button('Preview laptop memory for River').disabled).toBe(false);
  });

});
