/**
 * Replies xterm makes to terminal probes must never reach the PTY as typed input.
 *
 * TUIs probe the terminal (device attributes, cursor position, DECRQM modes,
 * DECRQSS settings). xterm.js answers through onData, and the answer is
 * forwarded unless it is recognised. Two cases matter:
 * - live: an answer to a probe the running program just sent is dropped when
 *   its family is known (DA, DSR, CPR, OSC, DECRPM, DCS);
 * - replay: re-writing a stored buffer re-feeds every probe a TUI ever printed,
 *   and every answer xterm makes until the last replayed byte is parsed is
 *   dropped, whatever its family, because the program now running asked for
 *   none of them. Without this, opening a debug terminal typed the answers into
 *   the idle prompt.
 *
 * Strategy: constants.js + terminal-ui.js in a vm (the harness shape of
 * test/terminal-osc52-clipboard.test.ts) driving the REAL chunkedTerminalWrite
 * into a real @xterm/headless terminal, so replies are judged at the moment
 * xterm emits them, with the replay state they really see.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';

type Term = { write(data: string, cb?: () => void): void; onData(cb: (data: string) => void): void; dispose(): void };
const { Terminal } = xtermHeadless as unknown as { Terminal: new (opts: Record<string, unknown>) => Term };

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

function loadHarness() {
  const ReverieApp = function ReverieApp(this: unknown) {};
  const win: Record<string, any> = {};
  const context = vm.createContext({
    ReverieApp,
    window: win,
    globalThis: win,
    document: { getElementById: () => null, querySelector: () => null, hasFocus: () => true, activeElement: null },
    console: { ...console, log() {} },
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    Object,
    performance,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  });
  vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('src/web/public/terminal-ui.js'), context, { filename: 'terminal-ui.js' });
  const app = new (ReverieApp as unknown as new () => Record<string, any>)();
  app._chunkedWriteGen = 0;
  const input = win.ReverieTerminalInput as {
    shouldSuppressTerminalQueryResponse(data: string, terminal?: unknown): boolean;
    beginTerminalReplay(terminal: unknown): () => void;
    isTerminalReplaying(terminal: unknown): boolean;
  };
  return { app, input };
}

const ESC = '\x1b';
const BEL = '\x07';
const ST = ESC + '\\';
// The probes TUIs send at startup. xterm.js 6 answers nine of them.
const PROBES = [
  ESC + '[c', ESC + '[>c', ESC + '[5n', ESC + '[6n',
  ESC + ']10;?' + BEL, ESC + ']11;?' + ST, ESC + ']4;1;?' + BEL,
  ESC + '[?2026$p', ESC + '[?2004$p', ESC + '[4$p',
  ESC + '[>0q', ESC + 'P$qm' + ST, ESC + 'P$qr' + ST,
  ESC + '[14t', ESC + '[16t', ESC + '[18t', ESC + '[?u',
];
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Every onData chunk, with what the primary pane's filter decided at the moment xterm emitted it. */
function record(input: ReturnType<typeof loadHarness>['input'], term: Term) {
  const seen: { data: string; forwarded: boolean }[] = [];
  term.onData((data) => seen.push({ data, forwarded: !input.shouldSuppressTerminalQueryResponse(data, term) }));
  return seen;
}

describe('terminal probe replies', () => {
  it('drops every live reply xterm 6 makes to the startup probes, DECRPM and DCS included', async () => {
    const { input } = loadHarness();
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const seen = record(input, term);
    await new Promise<void>((done) => term.write(PROBES.join(''), () => done()));
    await flush();
    expect(seen.map((s) => s.data)).toEqual([
      ESC + '[?1;2c', ESC + '[>0;276;0c', ESC + '[0n', ESC + '[1;1R',
      ESC + '[?2026;2$y', ESC + '[?2004;2$y', ESC + '[4;2$y',
      ESC + 'P1$r0m' + ST, ESC + 'P1$r1;24r' + ST,
    ]);
    expect(seen.filter((s) => s.forwarded)).toEqual([]);
    term.dispose();
  });

  // The text-area size report (CSI 18 t) matches no live pattern, so only the
  // replay rule can drop it: it proves the replay rule, not the list.
  const sizeReporting = { cols: 80, rows: 24, allowProposedApi: true, scrollback: 1000, windowOptions: { getWinSizeChars: true } };

  it('forwards nothing xterm says while a stored buffer replays, through the small and the chunked write', async () => {
    for (const chunkSize of [undefined, 16]) {
      const { app, input } = loadHarness();
      const term = new Terminal(sizeReporting);
      app.terminal = term;
      const seen = record(input, term);
      await app.chunkedTerminalWrite('banner\r\n' + PROBES.join('') + 'prompt> ', chunkSize);
      await new Promise<void>((done) => term.write('', () => done()));
      await flush();
      expect(seen.map((s) => s.data)).toContain(ESC + '[8;24;80t');
      expect(seen.length).toBe(10);
      expect(seen.filter((s) => s.forwarded)).toEqual([]);
      expect(input.isTerminalReplaying(term)).toBe(false);
      term.dispose();
    }
  });

  it('still forwards a live reply outside the known families once the replay is over', async () => {
    const { app, input } = loadHarness();
    const term = new Terminal(sizeReporting);
    app.terminal = term;
    const seen = record(input, term);
    await app.chunkedTerminalWrite(PROBES.join(''));
    await new Promise<void>((done) => term.write(ESC + '[18t', () => done()));
    await flush();
    expect(seen.filter((s) => s.forwarded).map((s) => s.data)).toEqual([ESC + '[8;24;80t']);
    term.dispose();
  });

  it('during a replay drops a reply of any family, but never what a person can be sending', () => {
    const { input } = loadHarness();
    const term = {};
    const windowReport = ESC + '[8;24;80t';
    expect(input.shouldSuppressTerminalQueryResponse(windowReport, term)).toBe(false);
    const end = input.beginTerminalReplay(term);
    expect(input.shouldSuppressTerminalQueryResponse(windowReport, term)).toBe(true);
    for (const typed of ['a', 'hello', '\r', ESC, ESC + '[A', ESC + 'OB', ESC + '[1;5C', ESC + '[3~',
      ESC + '[200~pasted' + ESC + '[201~', ESC + '[<0;3;4M', ESC + '[I']) {
      expect(input.shouldSuppressTerminalQueryResponse(typed, term), JSON.stringify(typed)).toBe(false);
    }
    end();
    end();
    expect(input.isTerminalReplaying(term)).toBe(false);
    expect(input.shouldSuppressTerminalQueryResponse(windowReport, term)).toBe(false);
  });

  it('keeps a replay open until every overlapping replay into the same terminal has ended', () => {
    const { input } = loadHarness();
    const term = {};
    const first = input.beginTerminalReplay(term);
    const second = input.beginTerminalReplay(term);
    first();
    expect(input.isTerminalReplaying(term)).toBe(true);
    second();
    expect(input.isTerminalReplaying(term)).toBe(false);
    expect(input.isTerminalReplaying({})).toBe(false);
  });

  it('passes the terminal at both send sites, and the tile pane counts its own replay', () => {
    const ui = read('src/web/public/terminal-ui.js');
    const tile = read('src/web/public/terminal-tile.js');
    expect(ui).toContain('shouldSuppressTerminalQueryResponse(data, this.terminal)');
    expect(tile).toContain('shouldSuppressTerminalQueryResponse?.(data, this.terminal)');
    const writer = tile.slice(tile.indexOf('function writeChunked('), tile.indexOf('class TerminalTile'));
    expect(writer).toContain('beginTerminalReplay?.(terminal)');
    expect(writer.slice(writer.indexOf('const settle'))).toContain('endReplay();');
  });
});
