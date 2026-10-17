import { describe, expect, it, vi } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface FakeElement {
  className: string;
  textContent: string;
  innerHTML: string;
  children: FakeElement[];
  attrs: Record<string, string>;
  [key: string]: unknown;
}

function fakeElement(): FakeElement {
  const el: FakeElement = {
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    attrs: {},
    classList: { toggle() {} },
    append(...kids: FakeElement[]) {
      el.children.push(...kids);
    },
    replaceChildren(...kids: FakeElement[]) {
      el.children = kids;
    },
    setAttribute(name: string, value: string) {
      el.attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete el.attrs[name];
    },
    addEventListener() {},
  };
  return el;
}

function walk(el: FakeElement, out: FakeElement[] = []): FakeElement[] {
  out.push(el);
  for (const child of el.children) walk(child, out);
  return out;
}

function ui() {
  const selected = new Map<string, string>();
  const control = { hidden: true };
  const select = {
    value: '',
    dataset: {} as Record<string, string>,
    options: [] as unknown[],
    replaceChildren(...values: unknown[]) {
      this.options = values;
    },
    append(...values: unknown[]) {
      this.options.push(...values);
    },
  };
  class App {
    runMode = 'opencode';
    _apiJson = vi.fn();
  }
  const context = vm.createContext({
    CodemanApp: App,
    localStorage: {
      getItem: (key: string) => selected.get(key) ?? null,
      setItem: (key: string, value: string) => selected.set(key, value),
      removeItem: (key: string) => selected.delete(key),
    },
    document: {
      getElementById: (id: string) => (id === 'subscriptionProfileControls' ? control : select),
      createElement: () => fakeElement(),
    },
    Option: class {
      constructor(
        public text: string,
        public value: string
      ) {}
    },
  });
  vm.runInContext(readFileSync(resolve(import.meta.dirname, '../src/web/public/subscription-ui.js'), 'utf8'), context);
  return {
    app: new App() as App & {
      refreshSubscriptionAccounts(): Promise<void>;
      selectSubscriptionProfile(id: string): void;
      withSubscriptionProfile(body: object): Record<string, unknown>;
      renderSubscriptionUsage(chip: FakeElement, accounts: unknown[]): void;
      runMode: string;
    },
    control,
    select,
  };
}

describe('account picker launch integration', () => {
  it('loads through the real shared API contract and carries the chosen account into new-session requests', async () => {
    const { app, control, select } = ui();
    app._apiJson.mockResolvedValue({
      profiles: [{ id: 'work', label: 'Work', provider: 'openai', modes: ['opencode'] }],
    });
    await app.refreshSubscriptionAccounts();
    expect(app._apiJson).toHaveBeenCalledWith('/api/subscription-profiles');
    expect(control.hidden).toBe(false);
    // default, the account, then the trailing add-account and sign-in-help actions
    expect(select.options).toHaveLength(4);
    app.selectSubscriptionProfile('work');
    expect(app.withSubscriptionProfile({ mode: 'opencode' })).toEqual({
      mode: 'opencode',
      subscriptionProfileId: 'work',
    });
  });
  it('leaves custom endpoints independent and preserves a removed selection for backend refusal', async () => {
    const { app } = ui();
    app._apiJson.mockResolvedValue({ profiles: [] });
    await app.refreshSubscriptionAccounts();
    app.selectSubscriptionProfile('removed');
    expect(app.withSubscriptionProfile({ mode: 'opencode' }).subscriptionProfileId).toBe('removed');
    expect(
      app.withSubscriptionProfile({ mode: 'opencode', customModel: { endpointId: 'gpu' } }).subscriptionProfileId
    ).toBeUndefined();
  });
});

describe('compact header usage summary', () => {
  const account = (id: string, label: string, five: number | null) => ({
    id,
    label,
    provider: 'anthropic',
    status: 'ready',
    updatedAt: 1,
    usage: five === null ? null : { fiveHour: { usedPercentage: five, resetAt: 1 } },
  });
  const accounts = [account('a', 'Alpha', 10), account('b', 'Beta', 70), account('c', 'Gamma', 30)];
  const render = (selectedId?: string) => {
    const { app } = ui();
    if (selectedId)
      (app as unknown as { selectSubscriptionProfile(id: string): void }).selectSubscriptionProfile(selectedId);
    const chip = fakeElement();
    app.renderSubscriptionUsage(chip, accounts);
    return { chip, nodes: walk(chip) };
  };

  it('summarises the account selected for the run mode and counts the others', () => {
    const { chip, nodes } = render('c');
    expect(nodes.find((n) => n.className === 'pu-name')?.textContent).toBe('Gamma');
    expect(nodes.find((n) => n.className === 'pu-more')?.textContent).toBe('+2');
    expect(chip.attrs['aria-haspopup']).toBe('menu');
    expect(chip.attrs.role).toBe('button');
  });

  it('falls back to the account with the highest 5h usage', () => {
    const { nodes } = render();
    expect(nodes.find((n) => n.className === 'pu-name')?.textContent).toBe('Beta');
  });

  it('writes labels with textContent, never markup', () => {
    const { app } = ui();
    const chip = fakeElement();
    const hostile = '<img src=x onerror=alert(1)>';
    app.renderSubscriptionUsage(chip, [account('a', hostile, 5), account('b', 'B', 1)]);
    const nodes = walk(chip);
    expect(nodes.find((n) => n.className === 'pu-name')?.textContent).toBe(hostile);
    expect(nodes.some((n) => n.innerHTML.includes('onerror'))).toBe(false);
  });

  it('shows no badge or button role for a single account', () => {
    const { app } = ui();
    const chip = fakeElement();
    app.renderSubscriptionUsage(chip, [account('a', 'Solo', 5)]);
    expect(walk(chip).some((n) => n.className === 'pu-more')).toBe(false);
    expect(chip.attrs.role).toBeUndefined();
  });
});
