import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) dom.window.close(); });

function fixture(decision: object, writesEnabled: boolean | undefined = true) {
  const html = readFileSync(new URL('../src/web/public/board.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
  const dom = new JSDOM('<section id="sec-decisions"><div id="cards"></div><div id="waitingHint"></div><details id="decidedBox"><summary id="decidedSum"></summary><ul id="decided"></ul></details></section>', { pretendToBeVisual: true });
  windows.push(dom);
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }));
  const load = vi.fn(async () => {});
  const context = vm.createContext({ document: dom.window.document, CSS: { escape: (value: string) => value }, fetch, load, boardActive: true, readyForActions: true,
    B: { rev: 7, decisions: [decision], polls: [], structuredDecisionWrites: writesEnabled }, when: () => 'Today' });
  new vm.Script(`${/const esc = .*/.exec(script)![0]}\n${script.slice(script.indexOf('const cardErr = {}'))}\ncards();`).runInContext(context);
  return { document: dom.window.document, fetch, load, context };
}

it('renders real choice buttons and recommendation; a click sends the exact owner choice with the revision', async () => {
  const f = fixture({ id: 'snapshot', text: 'Publish?', at: 1, options: ['Approve', 'Hold', 'Reject'], recommendation: { option: 'Hold', reason: 'Review first', by: 'Reviewer' } });
  expect([...f.document.querySelectorAll('[data-decide]')].map(button => button.textContent)).toEqual(['Approve', 'Hold', 'Reject']);
  expect(f.document.querySelector('.rec')!.textContent).toContain('Recommended: Hold — Review first');
  expect([...f.document.querySelectorAll('[data-decide]')].every(button => button.className === 'btn')).toBe(true);
  expect(f.document.querySelector('[data-decide][aria-pressed="true"], [data-decide][aria-selected="true"]')).toBeNull();
  expect(f.fetch).not.toHaveBeenCalled();
  (f.document.querySelector('[data-opt="Hold"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  expect(f.fetch).toHaveBeenCalledWith('/api/board/decisions/snapshot/choose', expect.objectContaining({ credentials: 'same-origin', body: JSON.stringify({ option: 'Hold', ifRev: 7 }) }));
  expect(f.document.querySelector('.hint')!.textContent).toContain('does not execute');
});

it('preserves legacy prose without inventing choices, and explains how its author can repair it', () => {
  const f = fixture({ id: 'old', text: 'Approve, Hold, or Reject in prose', at: 1 });
  expect(f.document.querySelectorAll('[data-decide]')).toHaveLength(0);
  expect(f.document.querySelector('[data-clear]')!.textContent).toBe('Mark decided');
  expect(f.document.querySelector('.dcard')!.textContent).toContain('reverie board decision update');
  expect(f.fetch).not.toHaveBeenCalled();
});

it('escapes choices and preserves the recorded choice in decided history', () => {
  const f = fixture({ id: 'done', text: 'Question', at: 1, options: ['<img src=x>', 'Hold'], chosen: '<img src=x>', clearedAt: 2 });
  expect(f.document.querySelector('#decided b')!.textContent).toBe('<img src=x>');
  expect(f.document.querySelector('img')).toBeNull();
});

it('shows a refused choice as unsaved and leaves the card available to retry', async () => {
  const f = fixture({ id: 'snapshot', text: 'Publish?', at: 1, options: ['Approve', 'Hold'] });
  f.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Revision changed' }) } as never);
  (f.document.querySelector('[data-opt="Hold"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  new vm.Script('cards();').runInContext(f.context);
  expect(f.document.querySelector('.err')!.textContent).toBe('Choice not saved: Revision changed');
  expect((f.document.querySelector('[data-opt="Hold"]') as HTMLButtonElement).disabled).toBe(false);
});

it('fallback disables choices and dispatch while keeping dismissal and saved history visible', async () => {
  const f = fixture({ id: 'waiting', text: 'Question?', at: 1, options: ['Approve', 'Hold'] }, false);
  const button = f.document.querySelector('[data-opt="Hold"]') as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(f.document.querySelector('.dcard')!.textContent).toContain('Saved answers are preserved');
  expect((f.document.querySelector('[data-clear]') as HTMLButtonElement).disabled).toBe(false);
  button.disabled = false;
  button.click();
  await Promise.resolve();
  expect(f.fetch).not.toHaveBeenCalled();
  const saved = fixture({ id: 'saved', text: 'Previous?', at: 1, options: ['Approve', 'Hold'], chosen: 'Hold', clearedAt: 2 }, false);
  expect(saved.document.querySelector('#decided b')!.textContent).toBe('Hold');
});

it('fallback does not tell legacy-card authors to repair options while writes are unavailable', () => {
  const f = fixture({ id: 'legacy', text: 'Legacy prose', at: 1 }, false);
  expect(f.document.querySelectorAll('[data-decide]')).toHaveLength(0);
  expect(f.document.querySelector('.dcard')!.textContent).toContain('temporarily unavailable');
  expect(f.document.querySelector('.dcard')!.textContent).not.toContain('reverie board decision update');
});

it('treats an absent availability projection as OFF in the UI', () => {
  const f = fixture({ id: 'waiting', text: 'Question?', at: 1, options: ['Approve', 'Hold'] });
  new vm.Script('delete B.structuredDecisionWrites; cards();').runInContext(f.context);
  expect((f.document.querySelector('[data-opt="Hold"]') as HTMLButtonElement).disabled).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(['boardActive', 'readyForActions'])('refuses decision writes when %s becomes false', async (guard) => {
  const f = fixture({ id: 'snapshot', text: 'Publish?', at: 1, options: ['Approve', 'Hold'] });
  new vm.Script(`${guard} = false;`).runInContext(f.context);
  (f.document.querySelector('[data-opt="Hold"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
  new vm.Script('cards();').runInContext(f.context);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.document.querySelector('.err')!.textContent).toContain('Refresh the visible board');
});
