/**
 * @fileoverview Remote-host wake-on-LAN: the "host unreachable" banner + its config dialog.
 *
 * A sleeping remote host does not fail loudly. The local tmux pane runs `ssh`, and when
 * the machine suspends, that ssh child stalls: `tmux send-keys` still SUCCEEDS, so typed
 * input disappears with no error and the pane looks alive. The server side
 * (`src/remote-wake.ts`) buffers input and wakes the host when the user types; this
 * module makes the state VISIBLE and gives it a button, which is what turns "why is
 * nothing happening" into one click.
 *
 * Behavior:
 *  - Asks `GET /api/sessions/:id/reachability` for the ACTIVE remote session only:
 *    once when the tab is activated (a user action), and every `POLL_MS` while the tab
 *    is visible ONLY for a host with a wake target. The timer is the one thing here that
 *    is not user-driven, and each poll is a TCP connect to the host — the same
 *    timer-driven traffic invariant #2 rejects keepalives for: it cannot wake a host,
 *    but it can keep an activity-based suspend timer from firing. So a host Reverie
 *    could not wake anyway is never polled on a timer. A host behind a jump host or
 *    SOCKS proxy (`probeable: false`) is never polled at all: the probe cannot reach
 *    it, so its answer would only ever be a false "asleep". The endpoint shares the
 *    server's probe cache with the input path, so opening the tab also primes the
 *    wake path.
 *  - Unreachable + a configured wake target → "Wake" button → `POST /api/sessions/:id/wake`
 *    (which wakes, waits, reattaches the pane and flushes buffered input).
 *  - Unreachable + NO wake target → "Configure WoL" → `#wakeConfigModal`, a small form
 *    for this host's MAC/command that saves via `PUT /api/remote-hosts/:id`. The server
 *    re-resolves host config while the session is live, so saving takes effect without
 *    restarting the session.
 *  - SSE (`remote:hostWaking`, `remote:hostWakeFailed`, `remote:sessionReconnected`)
 *    keeps the banner in sync while a wake is running.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.sessions, this.activeSessionId, showToast)
 * @dependency constants.js (SSE_EVENTS — the remote:hostWaking / remote:hostWakeFailed names)
 * @loadorder 12.2 — loaded after session-ui.js, before webview-tabs.js
 */

const HOST_WAKE_POLL_MS = 30_000;

Object.assign(CodemanApp.prototype, {
  /** Per-tab banner state (single active session at a time). */
  _hostWake: null,
  /** The page-wide poller interval (created once, see `_ensureHostWakePoller`). */
  _hostWakeTimer: null,

  /** Fresh state for a session we just switched to. */
  _hostWakeState() {
    return {
      sessionId: null,
      /** Last reachability answer, or null before the first poll. */
      reachable: null,
      /** 'command' | 'mac' | 'none' — what the banner action should do. */
      wakeConfigured: 'none',
      host: '',
      label: '',
      /**
       * False for a host the server's probe cannot reach (behind a jump host or SOCKS
       * proxy): its reachability is unknown, so there is no banner and no polling.
       */
      probeable: true,
      /** True between clicking Wake and the answer coming back. */
      waking: false,
      /**
       * True only when the server is actually holding bytes for this session (the typing
       * path buffers them). Browser keystrokes go over the WebSocket, which never passes
       * through the wake registry — so the Wake BUTTON must not claim input is queued.
       */
      queuedInput: false,
      /** Set when the last wake attempt or poll failed. */
      error: '',
    };
  },

  /**
   * Entry point from the session switcher — called for every active session, remote or
   * not, so it must be cheap and must clear the banner for local sessions.
   *
   * ⚠️ The POLLER is page-wide and independent of this call on purpose: a session
   * switch is not the only way the active tab changes (boot restore, a page loaded with
   * the tab already active, and `selectSession`'s own early return for the tab you are
   * already on), and the banner must not depend on any single one of those paths
   * running — that is exactly how it could silently never appear.
   */
  refreshHostWakeBanner(sessionId) {
    this._ensureHostWakePoller();
    const state = this._hostWake;
    if (state && state.sessionId && state.sessionId !== sessionId) this._hostWake = null;
    this._hostWakeTick();
  },

  /** Create the page-wide poller once (interval + a visibility wake-up). */
  _ensureHostWakePoller() {
    if (this._hostWakeTimer) return;
    this._hostWakeTimer = setInterval(() => this._hostWakeTick({ periodic: true }), HOST_WAKE_POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this._hostWakeTick({ periodic: true });
    });
  },

  /**
   * One poller tick: resolve the ACTIVE session, reset the banner when it changed, and
   * ask the server. No-op while the page is hidden (a background tab must not poll).
   *
   * `periodic` marks the timer (and the visibility wake-up) as opposed to a tab
   * activation: a periodic tick polls only a host with a wake target, see the module
   * comment. The activation poll is what still offers "Configure WoL" for a sleeping
   * host that has none — one connect, on a user action.
   */
  _hostWakeTick({ periodic = false } = {}) {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const sessionId = this.activeSessionId;
    const session = sessionId && this.sessions ? this.sessions.get(sessionId) : null;
    if (!sessionId || !session || !session.remote) {
      // Render unconditionally: `refreshHostWakeBanner` clears `_hostWake` BEFORE
      // calling this tick, so a guard here would skip the repaint and leave the
      // banner up on every chat (the clear and the repaint must not be coupled to
      // whoever cleared the state). Idempotent — with a null state it just hides.
      this._hostWake = null;
      this._renderHostWakeBanner();
      return;
    }
    let state = this._hostWake;
    let fresh = false;
    if (!state || state.sessionId !== sessionId) {
      fresh = true;
      state = this._hostWake = this._hostWakeState();
      state.sessionId = sessionId;
      state.host = session.remote.host || '';
      state.label = session.remote.label || 'Remote host';
      // Text from the session payload first (instant, no round trip), corrected by the
      // poll — a session whose wake config was added after launch only knows it after
      // the server resolves host config. The kind matters: the payload can say WHICH
      // path is configured, so a command-only host is not mislabelled 'mac' until the
      // first poll lands.
      state.wakeConfigured = session.remote.wakeMac ? 'mac' : session.remote.wakeCommand ? 'command' : 'none';
      // Known from the payload already: a proxied host is not probeable (the server
      // says so too, on every answer), so not even the activation poll is worth a
      // round trip whose verdict could only be a wrong "asleep".
      state.probeable = !(session.remote.jumpHost || session.remote.socksProxy);
      this._renderHostWakeBanner();
    }
    if (!state.probeable) return;
    if (periodic && !fresh && state.wakeConfigured === 'none') return;
    this._pollHostReachability();
  },

  /** One reachability check for the active remote session. */
  async _pollHostReachability(force = false) {
    const state = this._hostWake;
    if (!state || !state.sessionId) return;
    const sessionId = state.sessionId;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reachability${force ? '?force=1' : ''}`);
      const data = await res.json();
      if (!data.success) return;
      // The tab may have changed while this was in flight.
      if (this._hostWake !== state || state.sessionId !== sessionId) return;
      // `reachable` is `null` (unknown, not unreachable) for a host the probe cannot
      // reach — only a PROVEN `false` may raise the banner.
      state.reachable = data.data.reachable !== false;
      if (data.data.probeable === false) state.probeable = false;
      state.wakeConfigured = data.data.wakeConfigured || 'none';
      if (data.data.host) state.host = data.data.host;
      if (data.data.label) state.label = data.data.label;
      if (state.reachable) {
        state.waking = false;
        state.error = '';
      }
      this._renderHostWakeBanner();
    } catch {
      /* A failed poll is not a state change: leave the banner as it was. */
    }
  },

  /** Draw the banner from `_hostWake`. */
  _renderHostWakeBanner() {
    const state = this._hostWake;
    const banner = this.$('hostWakeBanner');
    const text = this.$('hostWakeBannerText');
    const detail = this.$('hostWakeBannerDetail');
    const action = this.$('hostWakeBannerAction');
    if (!banner || !text || !action) return;

    const visible = Boolean(state && state.sessionId && state.reachable === false);
    banner.hidden = !visible;
    if (!visible) return;

    const hasTarget = state.wakeConfigured !== 'none';
    const target = state.label || state.host || 'Remote host';
    if (state.waking) {
      text.textContent = `Waking ${target} …`;
    } else if (state.error) {
      text.textContent = `${target} did not wake up`;
    } else {
      text.textContent = `${target} is not reachable`;
    }
    if (detail) {
      detail.textContent = state.waking
        ? state.queuedInput
          ? 'input is queued until it is back'
          : 'waiting for the host to come back'
        : hasTarget
          ? `ssh ${state.host}`
          : 'no wake-on-LAN configured';
    }
    // After a FAILED wake the only useful next step is fixing the target (wrong MAC,
    // host moved NIC, command gone) — otherwise a configured-but-broken host would be
    // stuck behind a button that keeps failing with no way to edit it.
    const offerConfig = !hasTarget || Boolean(state.error);
    action.textContent = state.waking ? 'Waking …' : offerConfig ? 'Configure WoL' : 'Wake';
    action.disabled = state.waking;
  },

  /** Banner button: wake the host, or open the setup dialog when nothing is configured. */
  hostWakeAction() {
    const state = this._hostWake;
    if (!state || !state.sessionId || state.waking) return;
    if (state.wakeConfigured === 'none' || state.error) {
      this.openWakeConfigDialog();
      return;
    }
    this.wakeRemoteHost();
  },

  /** POST the manual wake for the active session and follow the result. */
  async wakeRemoteHost() {
    const state = this._hostWake;
    if (!state || !state.sessionId) return;
    const sessionId = state.sessionId;
    state.waking = true;
    // The button path holds nothing: whatever the user typed went into the stalled pane
    // over the WebSocket and is gone. Saying otherwise is a promise the next keystroke
    // disproves.
    state.queuedInput = false;
    state.error = '';
    this._renderHostWakeBanner();
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/wake`, { method: 'POST' });
      const data = await res.json();
      if (this._hostWake !== state || state.sessionId !== sessionId) return;
      state.waking = false;
      if (!data.success) {
        // The ROUTE is the authority on whether a target is configured, so ask it again
        // (`/reachability` reports `wakeConfigured`) rather than pattern-matching the
        // error message: the message is prose, and the code is generic (`INVALID_INPUT`
        // covers "Not a remote session" too).
        state.error = data.error || 'Wake failed';
        this._renderHostWakeBanner();
        await this._pollHostReachability(true);
        return;
      }
      state.reachable = data.data.reachable !== false;
      state.wakeConfigured = data.data.wakeConfigured || state.wakeConfigured;
      if (state.reachable) {
        this.showToast(`${state.label || 'Remote host'} is awake`, 'success');
      } else {
        state.error = 'timeout';
      }
      this._renderHostWakeBanner();
    } catch (err) {
      if (this._hostWake !== state) return;
      state.waking = false;
      state.error = err && err.message ? err.message : 'Wake failed';
      this._renderHostWakeBanner();
    }
  },

  /**
   * Why the host could not be read. In multi-user mode `GET /api/remote-hosts` returns
   * `[]` to a non-admin, so "Remote host not found" would blame a config the user simply
   * is not allowed to see — the save is admin-only, and that is what it should say.
   */
  _wakeConfigUnavailableMessage() {
    const me = window.__codemanUser || {};
    return me.multiUser && me.role !== 'admin' ? 'Wake-on-LAN configuration is admin-only' : 'Remote host not found';
  },

  /** Open the small WoL dialog for the banner's host, pre-filled from the host config. */
  async openWakeConfigDialog() {
    const state = this._hostWake;
    const session = state && state.sessionId && this.sessions ? this.sessions.get(state.sessionId) : null;
    if (!session || !session.remote) return;
    const hostId = session.remote.hostId;
    const label = this.$('wakeConfigHostLabel');
    const mac = this.$('wakeConfigMac');
    const command = this.$('wakeConfigCommand');
    const status = this.$('wakeConfigStatus');
    if (!mac || !command) return;

    mac.value = session.remote.wakeMac || '';
    command.value = session.remote.wakeCommand || '';
    if (label) label.textContent = session.remote.label || hostId;
    if (status) status.textContent = '';
    this._wakeConfigHostId = hostId;
    const modal = this.$('wakeConfigModal');
    if (modal) modal.classList.add('active');

    // Read the saved host so the dialog shows what is actually persisted (the session
    // payload may predate a change made in another tab).
    try {
      const res = await fetch('/api/remote-hosts');
      const data = await res.json();
      const hosts = data.success ? data.data : [];
      const host = Array.isArray(hosts) ? hosts.find((item) => item.id === hostId) : null;
      if (host && this._wakeConfigHostId === hostId) {
        mac.value = host.wakeMac || '';
        command.value = host.wakeCommand || '';
      } else if (!host && this._wakeConfigHostId === hostId && status) {
        // Say it up front rather than only when Save fails.
        status.textContent = this._wakeConfigUnavailableMessage();
      }
    } catch {
      /* The form is already usable from the session payload. */
    }
  },

  closeWakeConfigDialog() {
    const modal = this.$('wakeConfigModal');
    if (modal) modal.classList.remove('active');
    this._wakeConfigHostId = null;
  },

  /** Save MAC/command for the host, then re-check whether the session can wake now. */
  async saveWakeConfig() {
    const hostId = this._wakeConfigHostId;
    const mac = this.$('wakeConfigMac');
    const command = this.$('wakeConfigCommand');
    const status = this.$('wakeConfigStatus');
    const save = this.$('wakeConfigSave');
    if (!hostId || !mac || !command) return;

    const macValue = mac.value.trim();
    const commandValue = command.value.trim();
    if (
      macValue &&
      !/^[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5}(\s*,\s*[0-9a-fA-F]{2}([:-][0-9a-fA-F]{2}){5})*$/.test(macValue)
    ) {
      if (status) status.textContent = 'MAC must look like 04:d9:f5:80:c6:58 (comma-separated for several).';
      return;
    }
    if (commandValue && /\s/.test(commandValue)) {
      if (status) status.textContent = 'The wake command must be a single executable path (no arguments).';
      return;
    }

    if (save) save.disabled = true;
    if (status) status.textContent = 'Saving …';
    try {
      const listRes = await fetch('/api/remote-hosts');
      const listData = await listRes.json();
      const hosts = listData.success ? listData.data : [];
      const host = Array.isArray(hosts) ? hosts.find((item) => item.id === hostId) : null;
      if (!host) throw new Error(this._wakeConfigUnavailableMessage());
      // PUT takes the whole host (schema-validated), so send back everything we know and
      // only replace the wake fields. `undefined` drops the key entirely.
      const payload = {
        ...host,
        wakeMac: macValue || undefined,
        wakeCommand: commandValue || undefined,
      };
      const res = await fetch(`/api/remote-hosts/${encodeURIComponent(hostId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Save failed');
      this.showToast('Wake settings saved', 'success');
      this.closeWakeConfigDialog();
      // The server re-resolves host config for live sessions, so the banner can offer
      // the wake right away — probe fresh instead of waiting out the poll interval.
      await this._pollHostReachability(true);
    } catch (err) {
      if (status) status.textContent = err && err.message ? err.message : 'Save failed';
    } finally {
      if (save) save.disabled = false;
    }
  },

  /**
   * SSE `remote:hostWaking` — a wake is running (ours or one started by typing).
   *
   * ⚠️ The ONLY definition of this handler: `panels-ui.js` must not define it too.
   * Both mix into `CodemanApp.prototype` and this file loads later, so a second copy
   * would be silently shadowed (the guard in `sse-dispatch-table.test.ts` sees that a
   * handler exists, not that two modules claim the same name). The toast is
   * deliberately UNCONDITIONAL — a wake can start for a background session (input on
   * a non-active tab) where there is no banner to update.
   */
  _onRemoteHostWaking(data) {
    const label = data && data.label ? data.label : 'Remote host';
    // A create-path wake (the user pressed Run / Attach) has no session yet, so
    // nothing is queued behind it — the wording has to say what actually happens.
    const forNewSession = Boolean(data && data.forNewSession);
    // Only the typing path buffers bytes; the wake button and the send-and-wait path
    // hold none, and a browser keystroke never reaches the registry at all.
    const queuedInput = Boolean(data && data.queuedInput);
    // Long enough to cover the wake + attach (~10s measured on a warm S3), and it
    // is replaced by `remote:sessionReconnected` the moment the pane is back.
    this.showToast(
      forNewSession
        ? `Waking ${label} … the session starts when it is back`
        : queuedInput
          ? `Waking ${label} … input is queued`
          : `Waking ${label} … waiting for it to come back`,
      'info',
      { duration: 12000 }
    );
    const state = this._hostWake;
    if (!state || !data || state.sessionId !== data.sessionId) return;
    state.waking = true;
    state.queuedInput = queuedInput;
    state.error = '';
    if (data.label) state.label = data.label;
    this._renderHostWakeBanner();
  },

  /** SSE `remote:hostWakeFailed` — the host did not come back in time. */
  _onRemoteHostWakeFailed(data) {
    const label = data && data.label ? data.label : 'Remote host';
    const forNewSession = Boolean(data && data.forNewSession);
    const queuedInput = Boolean(data && data.queuedInput);
    this.showToast(
      forNewSession
        ? `${label} did not wake up — no session was started`
        : queuedInput
          ? `${label} did not wake up — queued input is still held`
          : `${label} did not wake up`,
      'error',
      { duration: 15000 }
    );
    const state = this._hostWake;
    if (!state || !data || state.sessionId !== data.sessionId) return;
    state.waking = false;
    state.queuedInput = queuedInput;
    state.error = 'timeout';
    state.reachable = false;
    this._renderHostWakeBanner();
  },
});
