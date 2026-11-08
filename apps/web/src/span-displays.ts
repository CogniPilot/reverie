/**
 * @fileoverview Open a Reverie window stretched across ALL displays, so in-page floating session
 * panels can be dragged from one physical monitor to the other. macOS only.
 *
 * Used by the header "multi-monitor" button (POST /api/system/span-displays), which opens the
 * window on the SERVER's displays, and by `reverie span [url]`, which a user runs on their own Mac
 * against a remote server so the window lands on their monitors.
 *
 * Prerequisite (one-time, manual): System Settings → Desktop & Dock → turn OFF "Displays have
 * separate Spaces", then log out and back in. Until then macOS keeps every window on one display.
 * (Equivalent CLI: `defaults write com.apple.spaces spans-displays -bool true`, still needing a
 * re-login.)
 *
 * Why a windowed `--app` and not fullscreen: browser fullscreen is per-display and will NOT span,
 * so the window is sized to the union of all displays instead.
 *
 * @module span-displays
 */

import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The union of all displays in top-left-origin points, as Chromium's geometry flags expect. */
export interface DisplayUnion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Chromium-family browsers, in preference order. Brave leads: plain Google Chrome bounced when
 * launched this way on the desk machine (created its profile, then exited without a window).
 */
export const SPAN_BROWSERS = ['Brave Browser', 'Google Chrome', 'Google Chrome Beta', 'Chromium', 'Microsoft Edge'];

/** What spanning touches outside this module. */
export interface SpanHost {
  /** Finder's desktop window bounds: `left, top, right, bottom`. */
  desktopBounds(): Promise<string>;
  executable(path: string): boolean;
  /** Starts `bin` detached, so the caller is not blocked for the window's life; returns its pid. */
  launch(bin: string, args: string[]): number | undefined;
  home: string;
  /** A browser application name to force, e.g. "Google Chrome" (the BROWSER variable). */
  browser?: string;
}

/**
 * Finder's desktop window already encloses every monitor, including one placed left of or above
 * the main display (a negative origin), so no per-display math or coordinate flipping is needed.
 */
export function parseDesktopBounds(text: string): DisplayUnion {
  const parts = text.trim().split(/,\s*/).map(Number);
  if (parts.length !== 4 || !parts.every(Number.isInteger))
    throw new Error(`Unexpected desktop bounds: ${text.trim()}`);
  const [x, y, right, bottom] = parts;
  if (right <= x || bottom <= y) throw new Error(`Empty desktop bounds: ${text.trim()}`);
  return { x, y, width: right - x, height: bottom - y };
}

export function browserBinary(app: string): string {
  return `/Applications/${app}.app/Contents/MacOS/${app}`;
}

/** The forced browser if one is named, else the first installed one from SPAN_BROWSERS. */
export function chooseBrowser(
  forced: string | undefined,
  executable: (path: string) => boolean
): { app: string; bin: string } {
  const app = forced || SPAN_BROWSERS.find((candidate) => executable(browserBinary(candidate)));
  if (!app || !executable(browserBinary(app)))
    throw new Error(`No Chrome-family browser found (BROWSER='${app ?? ''}')`);
  return { app, bin: browserBinary(app) };
}

/**
 * A dedicated profile per browser forces a fresh instance: a running browser would take the URL
 * itself and silently ignore the geometry flags. Per browser, so a Chrome-made profile cannot
 * confuse Brave or the reverse.
 */
export function spanProfile(home: string, app: string): string {
  return join(home, `.reverie-gesture-${app.toLowerCase().replace(/ /g, '-')}`);
}

export function spanArgs(url: string, profile: string, union: DisplayUnion): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    `--window-position=${union.x},${union.y}`,
    `--window-size=${union.width},${union.height}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** What a launch did, for the caller to report. */
export interface SpanLaunch {
  url: string;
  union: DisplayUnion;
  bin: string;
  pid?: number;
}

/** Measures the displays, picks a browser and opens the spanning window at `url`. */
export async function spanDisplays(url: string, host: SpanHost): Promise<SpanLaunch> {
  const union = parseDesktopBounds(await host.desktopBounds());
  const { app, bin } = chooseBrowser(host.browser, (path) => host.executable(path));
  const pid = host.launch(bin, spanArgs(url, spanProfile(host.home, app), union));
  return { url, union, bin, pid };
}

/** The real macOS host: osascript, the filesystem and a detached spawn. */
export function systemSpanHost(env: NodeJS.ProcessEnv = process.env): SpanHost {
  return {
    desktopBounds: () =>
      new Promise((resolve, reject) => {
        execFile(
          'osascript',
          ['-e', 'tell application "Finder" to get bounds of window of desktop'],
          (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
        );
      }),
    executable: (path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    launch: (bin, args) => {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return child.pid;
    },
    home: env.HOME || homedir(),
    browser: env.BROWSER || undefined,
  };
}
