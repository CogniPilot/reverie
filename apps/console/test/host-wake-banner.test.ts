// Port: none (pure frontend module in a node VM with a fake DOM — no browser, no server).
//
// The remote-host wake banner (src/web/public/host-wake-ui.js) is a SINGLE global
// element that is shown only for the active remote session. The regression this
// guards: `refreshHostWakeBanner` clears `_hostWake` when the tab switches, but
// `_hostWakeTick`'s clear branch only re-rendered when IT was the one clearing —
// so switching from an unreachable remote session to a LOCAL one left the banner
// visible ("Hufflepuff is not reachable") on every chat until a full reload.
//
// The bug is a pure ordering problem between two methods, so it can be reproduced
// here without a browser: render the remote state, switch to a local session, and
// assert the banner is hidden again.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');

const REMOTE_ID = 'remote-session-0001';
const LOCAL_ID = 'local-session-0001';

type El = { hidden: boolean; textContent: string; disabled: boolean; classList: { add(): void; remove(): void } };

function fakeElement(): El {
  return { hidden: false, textContent: '', disabled: false, classList: { add() {}, remove() {} } };
}

const PROXIED_ID = 'remote-session-proxied';
const NOWOL_ID = 'remote-session-nowol';

/** Load `host-wake-ui.js` with the minimal DOM it touches, and return a wired app. */
function loadWakeApp() {
  const fetches: string[] = [];
  const elements = new Map<string, El>([
    ['hostWakeBanner', fakeElement()],
    ['hostWakeBannerText', fakeElement()],
    ['hostWakeBannerDetail', fakeElement()],
    ['hostWakeBannerAction', fakeElement()],
  ]);
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    CodemanApp,
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: (url: string) => {
      fetches.push(url);
      return Promise.resolve({ json: () => Promise.resolve({ success: false }) });
    },
    document: {
      visibilityState: 'visible',
      getElementById: (id: string) => elements.get(id) ?? null,
      addEventListener: () => {},
    },
    window: {},
  });
  vm.runInContext(readFileSync(resolve(PUBLIC, 'host-wake-ui.js'), 'utf8'), context, { filename: 'host-wake-ui.js' });

  const app = new (CodemanApp as new () => Record<string, unknown>)();
  app.$ = (id: string) => elements.get(id) ?? null;
  app.activeSessionId = REMOTE_ID;
  app.sessions = new Map<string, { remote?: Record<string, unknown> }>([
    [
      REMOTE_ID,
      { remote: { hostId: 'hufflepuff', host: '192.168.50.137', label: 'Hufflepuff', wakeMac: '04:d9:f5:80:c6:58' } },
    ],
    [
      PROXIED_ID,
      {
        remote: {
          hostId: 'bastioned',
          host: '10.20.0.5',
          label: 'Behind bastion',
          jumpHost: 'bastion',
          wakeMac: '04:d9:f5:80:c6:58',
        },
      },
    ],
    [NOWOL_ID, { remote: { hostId: 'plain', host: '10.0.0.9', label: 'Plain' } }],
    [LOCAL_ID, {}],
  ]);
  return {
    app,
    fetches,
    banner: elements.get('hostWakeBanner') as El,
    text: elements.get('hostWakeBannerText') as El,
  };
}

describe('host wake banner visibility', () => {
  it('hides the banner when switching from an unreachable remote session to a local one', () => {
    const { app, banner, text } = loadWakeApp();

    // The banner is up for the active, unreachable remote session.
    app._hostWake = {
      sessionId: REMOTE_ID,
      reachable: false,
      wakeConfigured: 'mac',
      host: '192.168.50.137',
      label: 'Hufflepuff',
      waking: false,
      error: '',
    };
    (app._renderHostWakeBanner as () => void)();
    expect(banner.hidden).toBe(false);
    expect(text.textContent).toBe('Hufflepuff is not reachable');

    // Switch to a LOCAL session. `refreshHostWakeBanner` clears the state, and the
    // tick that follows must still repaint the (now empty) banner as hidden.
    app.activeSessionId = LOCAL_ID;
    (app.refreshHostWakeBanner as (id: string) => void)(LOCAL_ID);

    expect(app._hostWake).toBeNull();
    expect(banner.hidden).toBe(true);
  });

  it('keeps the banner hidden on a later poller tick once the state is cleared', () => {
    const { app, banner } = loadWakeApp();
    app.activeSessionId = LOCAL_ID;
    app._hostWake = null;
    // A page-wide tick on a local session must be idempotent and leave it hidden.
    (app._hostWakeTick as () => void)();
    expect(banner.hidden).toBe(true);
  });

  it('shows the banner only while the active session is remote and unreachable', () => {
    const { app, banner } = loadWakeApp();
    app._hostWake = {
      sessionId: REMOTE_ID,
      reachable: false,
      wakeConfigured: 'mac',
      host: '192.168.50.137',
      label: 'Hufflepuff',
      waking: false,
      error: '',
    };
    (app._renderHostWakeBanner as () => void)();
    expect(banner.hidden).toBe(false);

    // Reachable again → hidden, state intact (the banner must not leak across the
    // reachable/unreachable transition either).
    app._hostWake.reachable = true;
    (app._renderHostWakeBanner as () => void)();
    expect(banner.hidden).toBe(true);
  });
});

describe('host wake banner polling', () => {
  // Each poll is a TCP connect to the host from the server. The timer is the one
  // trigger that is not a user action, so it must not fire for a host Codeman could
  // not wake anyway (it cannot wake it, but it can keep an activity-based suspend timer
  // from firing), and a proxied host is never polled: the probe cannot reach it.
  const tick = (app: Record<string, unknown>, periodic: boolean) =>
    (app._hostWakeTick as (o: { periodic: boolean }) => void)({ periodic });

  it('polls a wake-configured host on activation and on the timer', () => {
    const { app, fetches } = loadWakeApp();
    app.activeSessionId = REMOTE_ID;
    tick(app, false);
    tick(app, true);
    tick(app, true);
    expect(fetches).toHaveLength(3);
    expect(fetches[0]).toContain(`/api/sessions/${REMOTE_ID}/reachability`);
  });

  it('polls a host without a wake target once on activation, never on the timer', () => {
    const { app, fetches } = loadWakeApp();
    app.activeSessionId = NOWOL_ID;
    tick(app, false);
    tick(app, true);
    tick(app, true);
    expect(fetches).toHaveLength(1);
  });

  it('never polls a host behind a jump host or SOCKS proxy', () => {
    const { app, fetches } = loadWakeApp();
    app.activeSessionId = PROXIED_ID;
    tick(app, false);
    tick(app, true);
    expect(fetches).toHaveLength(0);
    expect((app._hostWake as { probeable: boolean }).probeable).toBe(false);
  });
});
