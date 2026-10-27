import { afterEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');
const doms: JSDOM[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const credentialId = '66666666-6666-4666-8666-666666666666';
function configuration(extra: Record<string, unknown> = {}) {
  return {
    id: 'github-issues',
    enabled: true,
    botId: 'github-issues',
    roomId: 'updates',
    owner: 'Example',
    repo: 'project',
    visibility: 'public',
    intervalMinutes: 10,
    events: { issues: true, pullRequests: false, workflowFailures: false },
    credentialId: null,
    ...extra,
  };
}
function fixture() {
  const dom = new JSDOM(read('bots.html'), { url: 'https://fixture.test/bots', runScripts: 'outside-only' });
  doms.push(dom);
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  w.confirm = () => true;
  const state = {
    revision: 1,
    configs: [configuration()],
    watchFailure: 0,
    writeFailure: 0,
    tokenFailure: false,
    tokenGate: null as Promise<void> | null,
    tokens: [] as any[],
    lastError: null as string | null,
  };
  const status = () => ({
    version: 1,
    revision: state.revision,
    watches: state.configs.map((config) => ({
      config,
      status: {
        state: config.enabled
          ? config.visibility === 'private' && !config.credentialId
            ? 'auth-required'
            : 'active'
          : 'disabled',
        lastSuccessAt: 1700000000000,
        nextPollAt: 1700000600000,
        failures: 0,
        pendingCount: 0,
        lastError: state.lastError,
        legacyAdopted: config.id === 'github-issues',
      },
    })),
  });
  const writes: { path: string; body: any }[] = [];
  const fetch = vi.fn(async (url: URL, options: any) => {
    const path = new URL(url).pathname.slice('/api/'.length);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const response = (data: unknown, code = 200) => ({
      ok: code < 400,
      status: code,
      json: async () =>
        JSON.parse(JSON.stringify(code < 400 ? { success: true, data } : { success: false, error: data })),
    });
    if (options.method) {
      writes.push({ path, body });
      if (path === 'bot-watches/github') {
        if (state.writeFailure) return response('Denied', state.writeFailure);
        if (body.expectedRevision !== state.revision) return response('Stale revision', 409);
        state.configs = body.watches;
        state.revision++;
        return response(status());
      }
      if (path === 'publication/tokens') {
        if (state.tokenGate) await state.tokenGate;
        if (state.tokenFailure) return response('Refused ' + body.token, 400);
        const token = { id: credentialId, name: body.name, label: body.label, repositories: body.repositories };
        state.tokens.push(token);
        return response({ token });
      }
      throw Error('Unexpected write ' + path);
    }
    if (path === 'bot-watches/github')
      return state.watchFailure ? response('Unavailable', state.watchFailure) : response(status());
    const data: Record<string, unknown> = {
      'chat-bots': {
        bots: [
          {
            id: 'github-issues',
            name: 'Repository updates',
            rooms: ['updates', 'private', 'archived'],
            maxPerHour: 30,
          },
        ],
      },
      'cron/jobs': [],
      'cron/runs': [],
      'cron/active': { jobs: [] },
      chatrooms: {
        rooms: [
          { id: 'updates', name: 'updates' },
          { id: 'private', name: 'Private', kind: 'dm' },
          { id: 'archived', name: 'Archived', archivedAt: 1 },
        ],
      },
      company: { canManage: true, employees: [] },
      'publication/tokens': { tokens: state.tokens },
    };
    return response(data[path]);
  });
  Object.assign(w, { fetch });
  w.eval(read('bots.js'));
  const get = (id: string) => w.document.getElementById(id)!;
  const form = () => get('watch-form') as HTMLFormElement;
  const field = (name: string) => form().elements.namedItem(name) as HTMLInputElement;
  const open = async () => {
    get('new-watch').click();
    await tick();
  };
  const submit = async () => {
    form().dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
  };
  return { w, state, writes, fetch, get, form, field, open, submit };
}
afterEach(() => {
  for (const d of doms.splice(0)) d.window.close();
});
it('loads the real watcher API and makes the existing legacy watcher visible without calling it healthy', async () => {
  const p = fixture();
  await tick();
  expect(p.fetch.mock.calls.some(([url]) => new URL(url).pathname === '/api/bot-watches/github')).toBe(true);
  expect(p.get('github-watches').textContent).toContain('Example/project');
  expect(p.get('github-watches').textContent).toContain('Every 10 minutes');
  expect(p.get('github-watches').textContent).toContain('Last successful check:');
  expect(p.get('github-watches').textContent).not.toContain('Pull requests');
  expect(p.writes).toEqual([]);
});
it('creates a watcher from ordinary controls and preserves the unchanged legacy cadence and all other watchers', async () => {
  const p = fixture();
  await tick();
  await p.open();
  p.field('repository').value = 'https://github.com/Other/new-project';
  (p.form().querySelector('[value=issues]') as HTMLInputElement).checked = false;
  await p.submit();
  expect(p.writes).toHaveLength(1);
  const put = p.writes[0];
  expect(put.path).toBe('bot-watches/github');
  expect(put.body.expectedRevision).toBe(1);
  expect(put.body.watches[0]).toEqual(configuration());
  expect(put.body.watches[1]).toMatchObject({
    enabled: true,
    owner: 'Other',
    repo: 'new-project',
    botId: 'github-issues',
    roomId: 'updates',
    visibility: 'public',
    intervalMinutes: 30,
    credentialId: null,
    events: { issues: false, pullRequests: true, workflowFailures: true },
  });
  expect(put.body.watches[1].id).toMatch(/^[a-z0-9][a-z0-9_-]{0,39}$/);
  expect(p.get('watch-dialog').hasAttribute('open')).toBe(false);
});
it('edits only the chosen watcher and keeps its repository target read-only', async () => {
  const p = fixture();
  await tick();
  (p.get('github-watches').querySelector('button') as HTMLButtonElement).click();
  await tick();
  expect(p.field('repository').readOnly).toBe(true);
  p.field('intervalMinutes').value = '30';
  p.field('enabled').checked = false;
  await p.submit();
  expect(p.writes[0].body.watches).toEqual([configuration({ intervalMinutes: 30, enabled: false })]);
});
it('does not rebase an open edit onto a refreshed revision or overwrite a concurrent watcher', async () => {
  const p = fixture();
  await tick();
  await p.open();
  p.field('repository').value = 'Other/new';
  p.state.revision = 2;
  p.state.configs.push(configuration({ id: 'concurrent', owner: 'Concurrent', repo: 'work', intervalMinutes: 15 }));
  p.get('refresh').click();
  await tick();
  await p.submit();
  expect(p.writes[0].body.expectedRevision).toBe(1);
  expect(p.get('watch-error').textContent).toContain('changed elsewhere');
  expect(p.get('watch-dialog').hasAttribute('open')).toBe(true);
  expect(p.state.configs.some((c) => c.id === 'concurrent')).toBe(true);
});
it('shows explicit unavailable or owner-required status instead of a false empty watcher list', async () => {
  const p = fixture();
  await tick();
  p.state.watchFailure = 503;
  p.get('refresh').click();
  await tick();
  expect(p.get('watch-status').textContent).toContain('unavailable');
  expect((p.get('new-watch') as HTMLButtonElement).disabled).toBe(true);
  p.state.watchFailure = 403;
  p.get('refresh').click();
  await tick();
  expect(p.get('watch-status').textContent).toContain('Sign in as the owner');
});
it('does not optimistically show a revoked owner change as saved', async () => {
  const p = fixture();
  await tick();
  p.state.writeFailure = 403;
  await p.open();
  p.field('repository').value = 'Other/new';
  await p.submit();
  expect(p.get('watch-error').textContent).toContain('Sign in as the owner');
  expect(p.get('watch-dialog').hasAttribute('open')).toBe(true);
  expect(p.state.configs).toHaveLength(1);
});
it('excludes private messages and archived channels from the allowed bot channels', async () => {
  const p = fixture();
  await tick();
  await p.open();
  const rooms = p.form().elements.namedItem('roomId') as HTMLSelectElement;
  expect([...rooms.options].map((x) => x.value)).toEqual(['updates']);
});
it('renders error metadata as text and never executes repository or status markup', async () => {
  const p = fixture();
  await tick();
  p.state.lastError = '<img src=x onerror=unsafe()>';
  p.get('refresh').click();
  await tick();
  expect(p.get('github-watches').textContent).toContain('<img src=x onerror=unsafe()>');
  expect(p.get('github-watches').querySelector('img,script')).toBeNull();
});
it('uses only credential handles in watcher configuration and honestly shows auth-required', async () => {
  const p = fixture();
  await tick();
  p.state.configs = [configuration({ visibility: 'private', intervalMinutes: 15 })];
  p.state.tokens.push({ id: credentialId, name: 'read-repo', repositories: ['Example/project'] });
  p.get('refresh').click();
  await tick();
  expect(p.get('github-watches').textContent).toContain('Credential required');
  (p.get('github-watches').querySelector('button') as HTMLButtonElement).click();
  await tick();
  p.field('credentialId').value = credentialId;
  await p.submit();
  expect(p.writes[0].body.watches[0].credentialId).toBe(credentialId);
  expect(p.fetch.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/material'))).toBe(false);
});
it.each([false, true])(
  'clears a newly entered write-only PAT on success or failure, with no secret echo (failure=%s)',
  async (failure) => {
    const p = fixture();
    p.state.tokenFailure = failure;
    await tick();
    await p.open();
    p.field('repository').value = 'Other/private-project';
    p.get('add-watch-credential').click();
    const f = p.get('watch-credential-form') as HTMLFormElement;
    (f.elements.namedItem('name') as HTMLInputElement).value = 'private-repo';
    const input = f.elements.namedItem('token') as HTMLInputElement;
    input.value = 'FAKE_FIXTURE_PAT_12345';
    f.dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(input.value).toBe('');
    expect(p.w.document.body.textContent).not.toContain('FAKE_FIXTURE_PAT_12345');
    expect(p.writes).toHaveLength(1);
    expect(p.writes[0]).toMatchObject({
      path: 'publication/tokens',
      body: { name: 'private-repo', repositories: ['Other/private-project'] },
    });
    if (failure) expect(p.get('watch-credential-error').textContent).toContain('Could not confirm');
    else expect(p.field('credentialId').value).toBe(credentialId);
  }
);
it('removes only the explicitly selected watcher without posting or launching a routine', async () => {
  const p = fixture();
  await tick();
  (
    p.get('github-watches').querySelector('[aria-label="Remove watcher for Example/project"]') as HTMLButtonElement
  ).click();
  await tick();
  expect(p.writes).toEqual([{ path: 'bot-watches/github', body: { version: 1, expectedRevision: 1, watches: [] } }]);
});
it('allows an enabled-only legacy edit at its unchanged cadence but requires an explicit new cadence for new events', async () => {
  const p = fixture();
  await tick();
  (p.get('github-watches').querySelector('button') as HTMLButtonElement).click();
  await tick();
  p.field('enabled').checked = false;
  await p.submit();
  expect(p.writes[0].body.watches[0]).toEqual(configuration({ enabled: false }));
  (p.get('github-watches').querySelector('button') as HTMLButtonElement).click();
  await tick();
  (p.form().querySelector('[value=pullRequests]') as HTMLInputElement).checked = true;
  await p.submit();
  expect(p.writes).toHaveLength(1);
  expect(p.get('watch-error').textContent).toContain('15 to 1440');
});
it('keeps an explicit cadence when a credential is selected and defaults only untouched new forms', async () => {
  const p = fixture();
  await tick();
  p.state.tokens.push({ id: credentialId, name: 'read-repo', repositories: ['Other/project'] });
  p.get('refresh').click();
  await tick();
  await p.open();
  expect(p.field('intervalMinutes').value).toBe('30');
  p.field('credentialId').value = credentialId;
  p.field('credentialId').dispatchEvent(new p.w.Event('change'));
  expect(p.field('intervalMinutes').value).toBe('15');
  p.field('intervalMinutes').value = '45';
  p.field('intervalMinutes').dispatchEvent(new p.w.Event('input'));
  p.field('credentialId').value = '';
  p.field('credentialId').dispatchEvent(new p.w.Event('change'));
  expect(p.field('intervalMinutes').value).toBe('45');
  expect(p.writes).toEqual([]);
});
it('keeps an in-use watcher bot from being deleted and updates its linked watcher count after save', async () => {
  const p = fixture();
  await tick();
  const remove = () =>
    [...p.get('bots').querySelectorAll('button')].find((b) => b.textContent === 'Delete bot') as HTMLButtonElement;
  expect(remove().disabled).toBe(true);
  expect(p.get('bots').textContent).toContain('1 enabled watchers');
  await p.open();
  p.field('repository').value = 'Other/second';
  await p.submit();
  expect(p.get('bots').textContent).toContain('2 enabled watchers');
  expect(remove().disabled).toBe(true);
});
it('ignores a delayed credential result after cancellation and does not attach it to a later watcher dialog', async () => {
  const p = fixture();
  await tick();
  let release!: () => void;
  p.state.tokenGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await p.open();
  p.field('repository').value = 'Example/first';
  p.get('add-watch-credential').click();
  const form = p.get('watch-credential-form') as HTMLFormElement;
  (form.elements.namedItem('name') as HTMLInputElement).value = 'first';
  const secret = form.elements.namedItem('token') as HTMLInputElement;
  secret.value = 'FAKE_FIRST_SECRET';
  form.dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  (p.get('watch-credential-dialog') as HTMLDialogElement).close();
  (p.get('watch-dialog') as HTMLDialogElement).close();
  expect(secret.value).toBe('');
  await p.open();
  p.field('repository').value = 'Example/second';
  expect((p.get('add-watch-credential') as HTMLButtonElement).disabled).toBe(true);
  p.get('add-watch-credential').click();
  expect(p.get('watch-credential-dialog').hasAttribute('open')).toBe(false);
  release();
  await tick();
  expect(p.get('watch-dialog').hasAttribute('open')).toBe(true);
  expect(p.field('repository').value).toBe('Example/second');
  expect(p.field('credentialId').value).toBe('');
  expect(p.get('watch-credential-dialog').hasAttribute('open')).toBe(false);
  expect((p.get('add-watch-credential') as HTMLButtonElement).disabled).toBe(false);
  expect(p.state.tokens[0].repositories).toEqual(['Example/first']);
  expect(p.writes).toHaveLength(1);
});
