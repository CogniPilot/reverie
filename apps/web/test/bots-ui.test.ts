import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CronJobSchema, CronJobUpdateSchema } from '../src/web/schemas.js';
import { parseBot } from '../src/chat-bots.js';
const read = (file: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', file), 'utf8');
const doms: JSDOM[] = [];
const tick = async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
};
function fixture({ fail = false, runs = true, live = true, linked = true } = {}) {
  const dom = new JSDOM(read('bots.html'), { url: 'http://example.test/bots', runScripts: 'outside-only' });
  doms.push(dom);
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
    this.dispatchEvent(new w.Event('close'));
  };
  const jobs = [
    {
      id: 'job1',
      name: '<img src=x onerror=unsafe()>',
      action: 'post',
      botId: 'build',
      roomId: 'r1',
      scheduleType: 'interval',
      intervalMinutes: 5,
      enabled: true,
      nextRunAt: 50000,
      lastStatus: 'created',
      postText: 'Build status <img src=x>',
      createdBy: { employeeId: 'expert1' },
    },
    { id: 'job2', name: 'Quiet routine', scheduleType: 'interval', intervalMinutes: 20, enabled: false },
  ];
  const data: Record<string, unknown> = {
    'cron/active': { jobs: live ? [{ id: 'job1', name: 'Build Watch' }] : [] },
    company: { success: true, data: { employees: [{ id: 'expert1', name: 'Example expert' }] } },
    'chat-bots': {
      success: true,
      data: { bots: [{ id: 'build', name: 'Build Watch', rooms: ['r1'], maxPerHour: 30 }] },
    },
    'cron/jobs': linked ? jobs : jobs.filter(job => !job.botId),
    'cron/runs': runs
      ? [
          { id: 'run1', cronJobId: 'job1', startedAt: 100, finishedAt: null, status: 'created' },
          {
            id: 'run2',
            cronJobId: 'job2',
            startedAt: 50,
            finishedAt: 60,
            status: 'failed',
            errorMessage: '<script>unsafe()</script>',
          },
        ]
      : [],
    chatrooms: {
      success: true,
      data: {
        rooms: [
          { id: 'r1', name: 'office' },
          { id: 'dm', name: 'private', dm: true },
        ],
      },
    },
  };
  const fetch = vi.fn(
    async (url: URL, options: { method?: string; body?: string; headers?: Record<string, string> }) => {
      if (new URL(url).pathname === '/assets/avatars/pack-manifest.json') return { ok: true, json: async () => ({ avatars: [...Array.from({ length: 50 }, (_, i) => i + 1), ...Array.from({ length: 50 }, (_, i) => i + 102), 101].map((id) => ({ id: `pack-${String(id).padStart(2, '0')}`, name: id === 151 ? 'Merry Dragon' : id === 101 ? 'Sly Jester' : `Avatar ${id}`, src: `/assets/avatars/pack-${String(id).padStart(2, '0')}.png` })) }) };
      const path = new URL(url).pathname.slice('/api/'.length);
      if (options.method === 'DELETE') return { ok: true, json: async () => ({ success: true, data: {} }) };
      if (options.method === 'PUT' || options.method === 'POST') {
        const body = JSON.parse(options.body!);
        if (path === 'cron/jobs') CronJobSchema.parse(body);
        if (options.method === 'PUT' && /^cron\/jobs\/[^/]+$/.test(path)) CronJobUpdateSchema.parse(body);
        if (path.startsWith('chat-bots/')) parseBot(body, path.split('/')[1]);
        if (path.endsWith('/enabled')) jobs[0].enabled = body.enabled;
        return { ok: true, json: async () => ({ success: true, data: {} }) };
      }
      return {
        ok: !fail,
        status: fail ? 503 : 200,
        json: async () => (fail ? { success: false, error: 'Unavailable' } : data[path]),
      };
    }
  );
  Object.assign(w, { fetch });
  w.eval(read('bots.js'));
  return { w, fetch, get: (id: string) => w.document.getElementById(id)! };
}
afterEach(() => {
  for (const dom of doms.splice(0)) dom.window.close();
});
describe('Bots overview behavior', () => {
  it('does not label stale unfinished run history as currently running', async () => {
    const p = fixture({ live: false });
    await tick();
    expect(p.get('summary').textContent).toContain('0 running now');
    expect(p.get('history').textContent).toContain('Unfinished');
    expect(p.get('routines').querySelector('.running')).toBeNull();
  });
  it('distinguishes waiting schedules, unfinished runs, disabled jobs and failures without executing markup', async () => {
    const p = fixture();
    await tick();
    expect(p.get('summary').textContent).toContain('1 running now');
    expect(p.get('routines').textContent).toContain('Quiet routine');
    expect(p.get('history').textContent).toContain('<script>unsafe()</script>');
    expect(p.w.document.querySelector('main img, main script')).toBeNull();
    const filter = p.get('filter') as HTMLSelectElement;
    filter.value = 'running';
    filter.dispatchEvent(new p.w.Event('change'));
    expect(p.get('routines').textContent).not.toContain('Quiet routine');
    expect(p.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });
  it('reports unavailable status and disables setup rather than showing a false zero or idle fleet', async () => {
    const p = fixture({ fail: true });
    await tick();
    expect(p.get('status').textContent).toContain('unavailable');
    expect(p.get('summary').textContent).toBe('');
    expect((p.get('new-bot') as HTMLButtonElement).disabled).toBe(true);
  });
  it('filters by room and changes only the selected schedule after an explicit click', async () => {
    const p = fixture();
    await tick();
    const search = p.get('search') as HTMLInputElement;
    search.value = 'office';
    search.dispatchEvent(new p.w.Event('input'));
    expect(p.get('routines').textContent).not.toContain('Quiet routine');
    (p.get('routines').querySelector('button') as HTMLButtonElement).click();
    await tick();
    const writes = p.fetch.mock.calls.filter(([, options]) => options.method);
    expect(writes).toHaveLength(1);
    expect(String(writes[0][0])).toContain('/cron/jobs/job1/enabled');
    expect(JSON.parse(writes[0][1].body!)).toEqual({ enabled: false });
  });
  it('creates a schema-valid disabled post routine, never launches a session or runs it on save', async () => {
    const p = fixture();
    await tick();
    p.get('new-routine').click();
    const form = p.get('routine-form') as HTMLFormElement;
    (form.elements.namedItem('name') as HTMLInputElement).value = 'Status note';
    (form.elements.namedItem('postText') as HTMLInputElement).value = 'Please check the board';
    form.dispatchEvent(new p.w.Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    const writes = p.fetch.mock.calls.filter(([, options]) => options.method);
    expect(writes).toHaveLength(1);
    expect(new URL(writes[0][0]).pathname).toBe('/api/cron/jobs');
    expect(JSON.parse(writes[0][1].body!)).toMatchObject({
      action: 'post',
      botId: 'build',
      roomId: 'r1',
      enabled: false,
    });
    expect(p.get('routine-error').textContent).toBe('');
  });
  it('edits a bot with its room allowlist intact and refuses accidental replacement in new-bot setup', async () => {
    const p = fixture();
    await tick();
    (p.get('bots').querySelector('button') as HTMLButtonElement).click();
    const form = p.get('bot-form') as HTMLFormElement;
    expect((form.elements.namedItem('id') as HTMLInputElement).readOnly).toBe(true);
    expect(form.querySelector('input[value="r1"]:checked')).not.toBeNull();
    expect(form.querySelector('input[value="dm"]')).toBeNull();
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.fetch.mock.calls.filter(([, options]) => options.method)).toHaveLength(1);
    p.get('new-bot').click();
    (form.elements.namedItem('id') as HTMLInputElement).value = 'build';
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    expect(p.get('bot-error').textContent).toContain('already exists');
    expect(p.fetch.mock.calls.filter(([, options]) => options.method)).toHaveLength(1);
  });
  it('shows recorded creator/content, edits only the chosen content field and confirms deletion', async () => {
    const p = fixture();
    await tick();
    expect(p.get('routines').textContent).toContain('Created by: Example expert');
    expect(p.get('routines').textContent).toContain('Created by: Not recorded');
    expect(p.get('routines').querySelector('pre')!.textContent).toBe('Build status <img src=x>');
    const buttons = [...p.get('routines').querySelectorAll('button')];
    buttons.find((button) => button.textContent === 'Edit content')!.click();
    const form = p.get('content-form') as HTMLFormElement;
    (form.elements.namedItem('content') as HTMLTextAreaElement).value = 'Updated message';
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await tick();
    let writes = p.fetch.mock.calls.filter(([, options]) => options.method);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body!)).toEqual({ postText: 'Updated message' });
    const remove = [...p.get('routines').querySelectorAll('button')].find(
      (button) => button.textContent === 'Delete routine'
    )!;
    p.w.confirm = () => false;
    remove.click();
    await tick();
    expect(p.fetch.mock.calls.filter(([, options]) => options.method)).toHaveLength(1);
    p.w.confirm = () => true;
    remove.click();
    await tick();
    writes = p.fetch.mock.calls.filter(([, options]) => options.method);
    expect(writes).toHaveLength(2);
    expect(writes[1][1].method).toBe('DELETE');
    expect(writes[1][1].headers?.['Content-Type']).toBeUndefined();
    expect(new URL(writes[1][0]).pathname).toBe('/api/cron/jobs/job1');
  });
});

it('chooses a catalog avatar while preserving bot room and rate limits', async () => {
  const p = fixture(); await tick();
  (p.get('bots').querySelector('button') as HTMLButtonElement).click();
  p.get('choose-bot-avatar').click(); await tick();
  expect(p.get('bot-avatar-list').querySelectorAll('button')).toHaveLength(100);
  expect(p.get('bot-avatar-list').querySelector('[aria-label="Use Sly Jester"]')).toBeNull();
  (p.get('bot-avatar-list').querySelector('[aria-label="Use Merry Dragon"]') as HTMLButtonElement).click();
  expect(p.get('bot-icon-preview').querySelector('img')!.getAttribute('src')).toContain('/assets/avatars/pack-151.png');
  p.get('bot-form').dispatchEvent(new p.w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  const saved = p.fetch.mock.calls.find(([url, options]) => new URL(url).pathname === '/api/chat-bots/build' && options.method === 'PUT')!;
  expect(JSON.parse(saved[1].body!)).toMatchObject({ icon: '/assets/avatars/pack-151.png', rooms: ['r1'], maxPerHour: 30 });
});
it('offers confirmed deletion for unused bots and explains why linked bots cannot be deleted', async () => {
  const linked = fixture(); await tick();
  const disabled = [...linked.get('bots').querySelectorAll('button')].find(button => button.textContent === 'Delete bot')!;
  expect(disabled.disabled).toBe(true);
  expect(linked.get('bots').textContent).toContain("Delete this bot's routines first");
  const p = fixture({ linked: false }); await tick();
  const remove = [...p.get('bots').querySelectorAll('button')].find(button => button.textContent === 'Delete bot')!;
  p.w.confirm = vi.fn(() => false); remove.click(); await tick();
  expect(p.fetch.mock.calls.some(([, options]) => options.method === 'DELETE')).toBe(false);
  p.w.confirm = vi.fn(() => true); remove.click(); await tick();
  const request = p.fetch.mock.calls.find(([, options]) => options.method === 'DELETE')!;
  expect(new URL(request[0]).pathname).toBe('/api/chat-bots/build');
  expect(request[1].body).toBeUndefined();
});
