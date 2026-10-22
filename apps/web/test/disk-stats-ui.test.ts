import { afterEach, expect, it, vi } from 'vitest';
import { createHarness } from './helpers/chat-app-harness.mjs';
const GiB = 1024 ** 3;
const disks = { available: true, filesystems: [
  { labels: ['Company data', 'Workspace', 'Home'], totalBytes: 1000 * GiB, usedBytes: 200 * GiB, availableBytes: 800 * GiB, percentUsed: 20 },
  { labels: ['Scratch', 'Temporary files'], totalBytes: 100 * GiB, usedBytes: 95 * GiB, availableBytes: 5 * GiB, percentUsed: 95 },
] };
const opened: any[] = [];
afterEach(() => { for (const h of opened.splice(0)) h.dom.window.close(); vi.restoreAllMocks(); });
async function setup() {
  const h = await createHarness(); opened.push(h); h.shell.stopStats();
  h.shell.stats = { cpu: 12, memory: { percent: 28, usedMB: 1024, totalMB: 4096 }, gpu: { available: true, utilization: 40 }, disks };
  h.shell.renderStats(); return h;
}
it('shows the fullest filesystem beside existing gauges, with capacity and available space on hover', async () => {
  const h = await setup(); const button = h.document.querySelector('button[data-stat="disk"]')!;
  expect(button.textContent).toBe('DISK95%'); expect(button.classList.contains('is-high')).toBe(true);
  expect(button.title).toContain('highest filesystem usage'); expect(button.title).toContain('Scratch · Temporary files: 95.0 GiB used, 5.0 GiB available, 100.0 GiB capacity');
  expect([...h.document.querySelectorAll('.ca-stat-label')].map(el => el.textContent)).toEqual(['CPU', 'MEM', 'GPU', 'DISK']);
});
it('opens styled filesystem details and closes safely with Close or Escape without changing anything', async () => {
  const h = await setup(); const api = vi.spyOn(h.app, '_chatApi'); api.mockClear();
  h.document.querySelector('[data-stat="disk"]').click();
  const dialog = h.document.querySelector('.ca-disk-dialog')!;
  expect(dialog.open).toBe(true); expect(dialog.querySelectorAll('dt')).toHaveLength(2);
  expect(dialog.textContent).toContain('Company data · Workspace · Home'); expect(dialog.textContent).toContain('800.0 GiB available');
  expect(dialog.textContent).toContain('Whole filesystem capacity'); expect(dialog.textContent).toContain('reserved space');
  expect(dialog.querySelectorAll('progress')).toHaveLength(2); expect(h.document.activeElement?.textContent).toBe('Close');
  dialog.querySelector('button').click(); expect(h.document.querySelector('.ca-disk-dialog')).toBeNull();
  expect(h.document.activeElement?.dataset.stat).toBe('disk');
  h.document.querySelector('[data-stat="disk"]').click(); h.document.querySelector('.ca-disk-dialog').dispatchEvent(new h.window.Event('cancel', { cancelable: true }));
  expect(h.document.querySelector('.ca-disk-dialog')).toBeNull(); expect(api).not.toHaveBeenCalled();
});
it('hides unavailable or nonsensical disk readings without hiding the CPU and memory gauges', async () => {
  const h = await setup();
  for (const value of [undefined, { available: false, filesystems: disks.filesystems }, { available: true, filesystems: [{ labels: ['Invalid'], totalBytes: 0, availableBytes: 10 }] }]) {
    h.shell.stats.disks = value; h.shell.renderStats(); expect(h.document.querySelector('[data-stat="disk"]')).toBeNull();
    expect(h.document.querySelector('.ca-stat-label')?.textContent).toBe('CPU');
  }
});
it('uses the existing system-stats polling response without a new disk request', async () => {
  const h = await setup(); h.server.sysStats = { cpu: 10, memory: { percent: 20 }, disks }; h.server.calls.length = 0;
  h.shell.startStats(); await h.flush(); h.shell.stopStats();
  expect(h.document.querySelector('[data-stat="disk"]')?.textContent).toBe('DISK95%');
  expect(h.server.calls.filter(call => call.path.startsWith('/api/system/')).map(call => call.path)).toEqual(['/api/system/stats', '/api/system/gpu']);
});
