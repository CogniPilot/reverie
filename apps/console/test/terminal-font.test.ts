import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadFontHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTerminalFont: {
        DEFAULT_STACK: string;
        resolve: (custom?: unknown) => string;
        WEIGHT_DEFAULTS: { fontWeight: string; fontWeightBold: string };
        resolveWeights: (settings?: unknown) => { fontWeight: string | number; fontWeightBold: string | number };
      };
    }
  ).CodemanTerminalFont;
}

const font = loadFontHelper();

describe('CodemanTerminalFont', () => {
  it('returns the default stack for empty or missing input', () => {
    expect(font.resolve(undefined)).toBe(font.DEFAULT_STACK);
    expect(font.resolve('')).toBe(font.DEFAULT_STACK);
    expect(font.resolve('   ')).toBe(font.DEFAULT_STACK);
    expect(font.resolve(42)).toBe(font.DEFAULT_STACK);
  });

  it('keeps the symbols fallback ahead of monospace in the default stack', () => {
    const symbolsAt = font.DEFAULT_STACK.indexOf('"Symbols Nerd Font Mono"');
    const monoAt = font.DEFAULT_STACK.lastIndexOf('monospace');
    expect(symbolsAt).toBeGreaterThan(-1);
    expect(monoAt).toBeGreaterThan(symbolsAt);
  });

  it('prepends a custom family and preserves the full default stack', () => {
    expect(font.resolve('Menlo')).toBe(`Menlo, ${font.DEFAULT_STACK}`);
  });

  it('quotes names that need quoting for CSS', () => {
    expect(font.resolve('JetBrainsMono Nerd Font')).toBe(`"JetBrainsMono Nerd Font", ${font.DEFAULT_STACK}`);
  });

  it('normalizes already-quoted input instead of double-quoting', () => {
    expect(font.resolve('"JetBrainsMono Nerd Font"')).toBe(`"JetBrainsMono Nerd Font", ${font.DEFAULT_STACK}`);
    expect(font.resolve("'Iosevka Term'")).toBe(`"Iosevka Term", ${font.DEFAULT_STACK}`);
  });

  it('accepts a comma-separated list', () => {
    expect(font.resolve('Iosevka, MesloLGS NF')).toBe(`Iosevka, "MesloLGS NF", ${font.DEFAULT_STACK}`);
  });

  it('drops generic families so they cannot shadow the symbols fallback', () => {
    expect(font.resolve('monospace')).toBe(font.DEFAULT_STACK);
    expect(font.resolve('Hack, monospace')).toBe(`Hack, ${font.DEFAULT_STACK}`);
  });
});

describe('CodemanTerminalFont.resolveWeights', () => {
  const DEFAULTS = { fontWeight: 'normal', fontWeightBold: 'bold' };

  it("leaves an untouched install on xterm's own defaults", () => {
    // The whole feature has to be invisible until someone asks for it.
    expect(font.resolveWeights(undefined)).toEqual(DEFAULTS);
    expect(font.resolveWeights({})).toEqual(DEFAULTS);
    expect(font.resolveWeights('nonsense')).toEqual(DEFAULTS);
    expect(font.WEIGHT_DEFAULTS).toEqual(DEFAULTS);
  });

  it('resolves each slot independently', () => {
    expect(font.resolveWeights({ terminalFontWeight: 300 })).toEqual({ fontWeight: 300, fontWeightBold: 'bold' });
    expect(font.resolveWeights({ terminalFontWeightBold: 800 })).toEqual({ fontWeight: 'normal', fontWeightBold: 800 });
    expect(font.resolveWeights({ terminalFontWeight: 300, terminalFontWeightBold: 800 })).toEqual({
      fontWeight: 300,
      fontWeightBold: 800,
    });
  });

  it('never hands one slot the other slot default', () => {
    // A shared fallback would turn an unset bold weight into a visible change.
    for (const bad of [null, '', '   ', 'heavy', NaN, {}, [], true]) {
      expect(font.resolveWeights({ terminalFontWeight: bad, terminalFontWeightBold: bad })).toEqual(DEFAULTS);
    }
  });

  it('accepts the string values the select stores', () => {
    expect(font.resolveWeights({ terminalFontWeight: '300', terminalFontWeightBold: '900' })).toEqual({
      fontWeight: 300,
      fontWeightBold: 900,
    });
  });

  it('keeps a hand-set weight the picker does not offer', () => {
    expect(font.resolveWeights({ terminalFontWeight: '350' }).fontWeight).toBe(350);
  });

  it("passes through xterm's own keywords unchanged", () => {
    expect(font.resolveWeights({ terminalFontWeight: 'bold', terminalFontWeightBold: 'normal' })).toEqual({
      fontWeight: 'bold',
      fontWeightBold: 'normal',
    });
  });

  it('rejects what xterm would reject, rather than letting it silently reset the slot', () => {
    // OptionsService accepts a number in 1..1000 and falls back otherwise, so
    // anything outside that range must resolve to the default here instead of
    // reaching the terminal and being swapped out underneath the setting.
    expect(font.resolveWeights({ terminalFontWeight: 0 }).fontWeight).toBe('normal');
    expect(font.resolveWeights({ terminalFontWeight: -400 }).fontWeight).toBe('normal');
    expect(font.resolveWeights({ terminalFontWeight: 1001 }).fontWeight).toBe('normal');
    expect(font.resolveWeights({ terminalFontWeight: 1000 }).fontWeight).toBe(1000);
    expect(font.resolveWeights({ terminalFontWeight: 1 }).fontWeight).toBe(1);
  });
});
