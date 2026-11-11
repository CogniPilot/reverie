/**
 * @fileoverview Every external registry CLI must have an effective browser launch
 * descriptor, including CLIs with no legacy per-mode configuration table entry.
 * The selected endpoint must reach the request whenever the canonical catalog
 * advertises a custom-model recipe; a missing table entry must never drop it.
 *
 * Drives the real session-ui.js with the safe server projection of the stock
 * registry. Legacy install hints/configuration remain checked where present,
 * while labels and capability decisions come from that canonical catalog.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import { cliPublicDescriptor } from '../src/config/cli-registry/public-descriptor.js';

const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

interface RunModeLaunchEntry {
  label: string;
  installHint: string;
  supportsCustomModel: boolean;
  buildConfig: (globalSettings: Record<string, unknown>) => Record<string, unknown> | null;
}

function loadRunModeLaunch(): Record<string, RunModeLaunchEntry> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'dangerously' });
  const win = dom.window as unknown as Window & typeof globalThis & { ReverieApp: new () => unknown };
  (win as any).__reverieCliCatalog = STOCK_CLIS.map(cliPublicDescriptor);
  (win as unknown as { eval: (s: string) => void }).eval('window.ReverieApp = function ReverieApp() {};');
  // The assignment MUST be part of the same evaluated string as
  // SESSION_UI_JS — RUN_MODE_LAUNCH is a bare top-level `const`, so it only
  // exists in the lexical scope of THIS eval call.
  (win as unknown as { eval: (s: string) => void }).eval(
    `${SESSION_UI_JS}\nwindow.__TEST_RUN_MODE_LAUNCH = Object.fromEntries(window.__reverieCliCatalog.filter(entry => entry.kind === 'agent' && entry.external).map(entry => [entry.id, cliRunModeLaunch(entry.id)]));`
  );
  return (win as unknown as { __TEST_RUN_MODE_LAUNCH: Record<string, RunModeLaunchEntry> }).__TEST_RUN_MODE_LAUNCH;
}

describe('effective CLI launch settings stay in step with the public registry catalog', () => {
  const runModeLaunch = loadRunModeLaunch();
  const byId = new Map(STOCK_CLIS.map((e) => [e.id as string, e]));

  it('covers exactly the external agent CLIs from the stock registry', () => {
    const expectedIds = STOCK_CLIS.filter((entry) => entry.kind === 'agent' && entry.capabilities.external)
      .map((entry) => entry.id as string)
      .sort();
    expect(Object.keys(runModeLaunch).sort()).toEqual(expectedIds);
  });

  it('label matches CliEntry.label for every entry', () => {
    for (const [id, entry] of Object.entries(runModeLaunch)) {
      const stockEntry = byId.get(id);
      expect(stockEntry, `no stock entry for ${id}`).toBeTruthy();
      expect(entry.label, `${id} label drifted from stock.ts`).toBe(stockEntry!.label);
    }
  });

  it('installHint embeds the real linux install command', () => {
    for (const [id, entry] of Object.entries(runModeLaunch)) {
      const command = byId.get(id)!.discovery.install.command?.linux;
      if (!command) continue; // shell-less entries (none today) carry no command to check
      expect(entry.installHint, `${id} installHint no longer matches stock.ts's linux install command`).toContain(
        command
      );
    }
  });

  it('supportsCustomModel matches capabilities.customModelInjection.kind !== "unsupported"', () => {
    // This is the one that fails SILENTLY if it drifts (see file header):
    // window.__reverieCustomModelClis (server.ts) is built from this same
    // stock.ts field, so a mismatch here means the Run-menu picker and the
    // actual launch body disagree about which CLIs are custom-model-capable.
    for (const [id, entry] of Object.entries(runModeLaunch)) {
      const supported = byId.get(id)!.capabilities.customModelInjection.kind !== 'unsupported';
      expect(entry.supportsCustomModel, `${id}.supportsCustomModel drifted from stock.ts's capability`).toBe(supported);
    }
  });
});
