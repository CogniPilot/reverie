import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { resolve } from 'node:path';

describe('external chat owner flow in Chromium', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    });
    page = await browser.newPage();
    await page.route('http://fleet.test/', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' })
    );
    await page.goto('http://fleet.test/', { waitUntil: 'domcontentloaded' });
    await page.setContent('<!doctype html><html><body></body></html>', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: resolve(import.meta.dirname, '../src/web/public/external-chat-ui.js') });
    await page.addScriptTag({
      content: `
      window.__requests = [];
      window.__state = { connections: [], links: [], deliveries: [] };
      const app = {
        sessions: new Map([['agent-a', {id:'agent-a',name:'Maya',mode:'codex'}]]),
        _apiJson: async () => ({rooms:[{id:'room-a',name:'Team',members:[{sessionId:'agent-a'}]}]}),
        _api: async (path, opts = {}) => {
          window.__requests.push({path,method:opts.method,body:opts.body ? {...opts.body} : null});
          let data = window.__state;
          if (opts.method === 'POST' && path.endsWith('/connections')) {
            window.__state.connections.push({id:'connection-a',label:opts.body.label,provider:opts.body.provider,
              enabled:false,agentSessionId:opts.body.agentSessionId,verifiedAt:Date.now(),identity:{id:'BOT1',name:'Verified Maya'}});
          } else if (path.includes('/channel?')) data = {id:'CTEST',name:'chosen'};
          else if (opts.method === 'POST' && path.endsWith('/links')) {
            window.__state.links.push({id:'link-a',connectionId:'connection-a',channelName:'chosen',...opts.body});
          } else if (opts.method === 'PUT') window.__state.connections[0].enabled = opts.body.enabled;
          return {ok:true,json:async()=>({success:true,data})};
        }
      };
      window.ExternalChatUI.open(app);
    `,
    });
    await page.getByText('No external connections.', { exact: false }).waitFor();
  });
  afterAll(async () => {
    await browser?.close();
  });
  it('saves a disabled verified bot, previews a selected channel and enables only explicit links', async () => {
    await page.getByLabel('Agent', { exact: true }).selectOption('agent-a');
    await page.getByLabel('Connection name').fill('Maya Slack');
    await page.getByLabel('Bot token').fill('xoxb-test-secret');
    await page.getByRole('button', { name: 'Verify bot and save disabled' }).click();
    await page.getByRole('heading', { name: 'Maya Slack · slack · Disabled' }).waitFor();
    expect(await page.getByLabel('Bot token').inputValue()).toBe('');
    expect(await page.locator('body').innerText()).not.toContain('xoxb-test-secret');
    expect(await page.getByText('Verified bot: Verified Maya (BOT1)', { exact: false }).isVisible()).toBe(true);
    await page.getByLabel('Local room').selectOption('room-a');
    await page.getByLabel('External channel ID').fill('CTEST');
    expect(await page.getByRole('button', { name: 'Link this channel and room' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Look up channel' }).click();
    await page.getByText('Selected #chosen (CTEST).', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Link this channel and room' }).click();
    await page.getByText('#chosen ↔ Team', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Enable selected links' }).click();
    await page.getByRole('heading', { name: 'Maya Slack · slack · Enabled' }).waitFor();
    expect(await page.evaluate('window.__requests.filter(r=>r.method === "PUT").map(r=>r.body)')).toEqual([
      { enabled: true },
    ]);
    expect(await page.evaluate('window.__requests.find(r=>r.path.endsWith("/links")).body')).toEqual({
      channelId: 'CTEST',
      roomId: 'room-a',
    });
    expect(await page.evaluate('Object.keys(localStorage)')).toEqual([]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    expect(await page.locator('dialog').count()).toBe(0);
  });
});
