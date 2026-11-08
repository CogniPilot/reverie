/**
 * @fileoverview The multi-monitor launcher (src/span-displays.ts) against a fake host: desktop
 * bounds parsing, browser choice, the per-browser profile and the exact browser arguments. Nothing
 * here runs osascript or opens a browser.
 */
import { describe, it, expect } from 'vitest';
import {
  SPAN_BROWSERS,
  browserBinary,
  chooseBrowser,
  parseDesktopBounds,
  spanArgs,
  spanDisplays,
  spanProfile,
  type SpanHost,
} from '../src/span-displays.js';

describe('parseDesktopBounds', () => {
  it('turns Finder bounds into position and size, including a display left of or above the main one', () => {
    expect(parseDesktopBounds('0, 0, 3840, 1080\n')).toEqual({ x: 0, y: 0, width: 3840, height: 1080 });
    expect(parseDesktopBounds('-1920, -200, 1920, 1080')).toEqual({ x: -1920, y: -200, width: 3840, height: 1280 });
  });

  it.each(['', '0, 0, 10', '0, 0, x, 10', '0, 0, 0, 10', '0, 0, 10.5, 10', 'error'])('refuses %j', (text) => {
    expect(() => parseDesktopBounds(text)).toThrow();
  });
});

describe('chooseBrowser', () => {
  const installed =
    (...apps: string[]) =>
    (path: string) =>
      apps.some((app) => path === browserBinary(app));

  it('takes the first installed browser in order, Brave first', () => {
    expect(SPAN_BROWSERS[0]).toBe('Brave Browser');
    expect(chooseBrowser(undefined, installed('Google Chrome', 'Microsoft Edge')).app).toBe('Google Chrome');
    expect(chooseBrowser(undefined, installed('Brave Browser', 'Google Chrome')).bin).toBe(
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
    );
  });

  it('honours a forced browser, and refuses one that is not installed or when none is', () => {
    expect(chooseBrowser('Chromium', installed('Chromium', 'Brave Browser')).app).toBe('Chromium');
    expect(() => chooseBrowser('Arc', installed('Brave Browser'))).toThrow(
      "No Chrome-family browser found (BROWSER='Arc')"
    );
    expect(() => chooseBrowser(undefined, installed())).toThrow("BROWSER=''");
  });
});

describe('spanProfile and spanArgs', () => {
  it('gives each browser its own lowercase profile directory', () => {
    expect(spanProfile('/Users/zorblat', 'Google Chrome Beta')).toBe(
      '/Users/zorblat/.reverie-gesture-google-chrome-beta'
    );
    expect(spanProfile('/Users/zorblat', 'Brave Browser')).toBe('/Users/zorblat/.reverie-gesture-brave-browser');
  });

  it('builds exactly the old launcher flags', () => {
    expect(spanArgs('http://localhost:3000', '/p', { x: -1920, y: 0, width: 3840, height: 1080 })).toEqual([
      '--app=http://localhost:3000',
      '--user-data-dir=/p',
      '--window-position=-1920,0',
      '--window-size=3840,1080',
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });
});

describe('spanDisplays', () => {
  const host = (overrides: Partial<SpanHost> = {}) => {
    const launches: Array<{ bin: string; args: string[] }> = [];
    const value: SpanHost = {
      desktopBounds: async () => '0, 25, 2560, 1465',
      executable: (path) => path === browserBinary('Google Chrome'),
      launch: (bin, args) => {
        launches.push({ bin, args });
        return 4242;
      },
      home: '/Users/zorblat',
      ...overrides,
    };
    return { value, launches };
  };

  it('measures, picks a browser and launches once with the union geometry', async () => {
    const { value, launches } = host();
    const result = await spanDisplays('http://localhost:5000', value);
    expect(result).toEqual({
      url: 'http://localhost:5000',
      union: { x: 0, y: 25, width: 2560, height: 1440 },
      bin: browserBinary('Google Chrome'),
      pid: 4242,
    });
    expect(launches).toEqual([
      {
        bin: browserBinary('Google Chrome'),
        args: spanArgs('http://localhost:5000', '/Users/zorblat/.reverie-gesture-google-chrome', result.union),
      },
    ]);
  });

  it('launches nothing when the displays cannot be measured or no browser is installed', async () => {
    const unmeasured = host({ desktopBounds: async () => 'execution error' });
    await expect(spanDisplays('http://localhost:5000', unmeasured.value)).rejects.toThrow('Unexpected desktop bounds');
    expect(unmeasured.launches).toEqual([]);
    const noBrowser = host({ executable: () => false });
    await expect(spanDisplays('http://localhost:5000', noBrowser.value)).rejects.toThrow(
      'No Chrome-family browser found'
    );
    expect(noBrowser.launches).toEqual([]);
  });
});
