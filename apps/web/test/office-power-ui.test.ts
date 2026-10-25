import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function fixture({ confirmed = true, available = true, fails = false } = {}) {
  const output = { textContent: '', style: { display: 'none' } };
  class App {
    declare officePower: (action: string, output?: unknown) => Promise<void>;
    _api = vi.fn(async (path: string) => path === '/api/system/laptops'
      ? { ok: true, json: async () => ({ success: true, data: { available, runningLaptops: 3 } }) }
      : { ok: !fails, json: async () => fails ? { success: false, error: 'Laptops did not stop' } : { success: true } });
  }
  const confirm = vi.fn(() => confirmed);
  const context = vm.createContext({ ReverieApp: App, window: { confirm }, document: { getElementById: () => output } });
  vm.runInContext(readFileSync(new URL('../src/web/public/settings-ui.js', import.meta.url), 'utf8'), context);
  return { app: new App(), output, confirm };
}

describe('office power UI uses the authenticated host-backed workflow', () => {
  it('confirms full shutdown explicitly and reports host acknowledgement to the initiating page', async () => {
    const { app, confirm } = fixture();
    const output = { textContent: '', style: { display: 'none' } };
    await app.officePower('shutdown', output);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('agent CLIs will stop before the website shuts down'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('without a fresh handoff'));
    expect(app._api).toHaveBeenNthCalledWith(2, '/api/system/shutdown', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }),
    });
    expect(output.textContent).toBe('All laptops stopped. Reverie is shutting down.');
  });

  it.each([{ confirmed: false }, { available: false }])('never submits a shutdown without availability and confirmation (%j)', async options => {
    const { app } = fixture(options); await app.officePower('shutdown');
    expect(app._api).toHaveBeenCalledExactlyOnceWith('/api/system/laptops');
  });

  it('does not claim a failed stop completed', async () => {
    const { app, output } = fixture({ fails: true }); await app.officePower('shutdown');
    expect(output.textContent).toBe('Laptops did not stop');
    expect(output.textContent).not.toContain('shutting down');
  });

  it('keeps website-only restart distinct from a complete shutdown', async () => {
    const { app, output, confirm } = fixture(); await app.officePower('restart-website');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('laptop(s) will keep working'));
    expect(app._api.mock.calls[1][0]).toBe('/api/system/restart-website');
    expect(output.textContent).toContain('agents are continuing');
  });
});
