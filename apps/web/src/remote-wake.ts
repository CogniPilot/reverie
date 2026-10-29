/**
 * @fileoverview Wake a SLEEPING remote host from user input (user-triggered Wake-on-LAN).
 *
 * A durable remote session survives SSH drops (COD-104) and auto-reconnects
 * (COD-108), but nothing brings the HOST back: if the remote machine suspended,
 * the local tmux pane's `ssh` child stalls silently. `tmux send-keys` then
 * SUCCEEDS against a pane that will never deliver the bytes, so typed input is
 * lost with no error anywhere — the failure this module exists to close.
 *
 * Design (deliberately narrow, see docs/remote-sessions.md §Wake-on-LAN):
 *  - An EXPLICIT request wakes a host, and nothing else: user input on an
 *    established session (`handleInput`), the wake button (`ensureAwake`), or the
 *    user's own session create/attach request (`ensureHostAwake`, wired in the HTTP
 *    routes). Everything that runs on a TIMER — the auto-reconnect watcher, boot
 *    recovery, the reachability probe, session discovery — must never wake one, or
 *    a host would be re-woken ~45 s after each suspend and could never stay asleep
 *    (the "keepalive pings a sleeping host" failure already solved for a different
 *    consumer by `hufflepuff-mcp-lazy`). The create path is deliberately wired in
 *    `session-routes.ts` and NOT in the shared session service, because
 *    `cron-service.ts` builds sessions there without a user waiting on the answer.
 *  - Detection is a cheap TCP connect to the SSH port (no auth, no ssh client,
 *    a few hundred bytes — below any meaningful activity threshold), throttled
 *    per session. No SSH keepalive is added to the launch command: keepalives
 *    would move bytes into an otherwise idle connection every interval, which is
 *    exactly the "an open pipe keeps the host awake" bug the remote-side idle
 *    detector was rewritten to avoid.
 *  - While a wake is in flight, input is BUFFERED and flushed in order once the
 *    pane is reattached, so the user's first characters after a long pause are
 *    not the ones that get eaten.
 *
 * The pure decisions and the IO are separated so the decision table can be
 * unit-tested without tmux, ssh, or a real host.
 *
 * @module remote-wake
 */

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { MAX_WAKE_MACS } from './config/remote-wake-limits.js';

/** Minimum spacing between two reachability probes for the same session. */
export const REMOTE_WAKE_PROBE_MIN_INTERVAL_MS = 30_000;
/** TCP-connect timeout for a reachability probe (host awake ≈ a few ms). */
export const REMOTE_WAKE_PROBE_TIMEOUT_MS = 1_500;
/** Poll spacing while waiting for a woken host to accept SSH again. */
export const REMOTE_WAKE_READY_INTERVAL_MS = 1_500;
/** Bounded wait for the host to come back after the wake command ran. */
export const REMOTE_WAKE_READY_TIMEOUT_MS = 90_000;
/**
 * Budget for a wake that an HTTP REQUEST is waiting on (session create/attach).
 * Deliberately shorter than {@link REMOTE_WAKE_READY_TIMEOUT_MS}: the dashboard is
 * served through a reverse proxy whose default `proxy_read_timeout` is 60 s, so a
 * 90 s wait would be cut off AT THE PROXY while the session was still being built —
 * the browser reports a failure for a session that exists. The budget has to cover
 * the WHOLE request, not just the wait: 40 s here + the 1.5 s reachability probe +
 * the tmux prereq probe's own 15 s timeout = 56.5 s worst case, still under 60 s.
 * ⚠ The wake ITSELF counts against this, which the original arithmetic omitted: a
 * `command` target can spend REMOTE_WAKE_COMMAND_TIMEOUT_MS before the readiness poll
 * begins, which would have made the real worst case ~68 s. `_wakeAndWait` therefore
 * subtracts the wake's measured elapsed time from this budget rather than adding to it.
 * A warm S3 resume measures ~12 s, so 40 s is >3× the observed wake.
 */
export const REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS = 40_000;
/** The wake command itself must not hang the wake flow. */
export const REMOTE_WAKE_COMMAND_TIMEOUT_MS = 10_000;
/**
 * Settle time between respawning the ssh pane and flushing buffered input: the
 * respawned `ssh` needs a moment to run `tmux -L reverie-remote … -A` and attach,
 * and bytes written into a still-connecting pane land in nothing.
 */
export const REMOTE_WAKE_ATTACH_SETTLE_MS = 1_500;
/**
 * Cap on buffered input per session while a host is being woken. 4 KB is a lot
 * of typing for a ~10 s wake; beyond it the OLDEST bytes are dropped (keeping the
 * tail preserves what the user just typed, and a silently unbounded buffer would
 * be a memory leak keyed on user input).
 */
export const REMOTE_WAKE_PENDING_MAX_BYTES = 4096;
/** Default SSH port used when the host config has no explicit `port`. */
export const DEFAULT_SSH_PORT = 22;

/** What the input path should do with a chunk of user input. Pure. */
export type RemoteInputAction = 'deliver' | 'probe' | 'buffer';
/**
 * The caller-facing outcome of {@link RemoteWakeRegistry.handleInput}: either the
 * caller writes the bytes as usual, or the registry took ownership of them.
 */
export type RemoteInputOutcome = 'deliver' | 'buffered' | 'dropped';

/**
 * Decide what to do with an input chunk on an input route. Mirrors
 * {@link RemoteWakeRegistry.handleInput} so the throttle table has exactly ONE
 * definition and is unit-testable:
 *
 *  - a wake already in flight → buffer (the flush owns delivery),
 *  - no wake command configured → deliver (feature off, today's behavior),
 *  - the last probe said "down" → buffer (no second probe; re-probing a known
 *    sleeping host on every keystroke would add seconds of latency per character),
 *  - never probed / throttle window elapsed → probe,
 *  - probed "up" inside the window → deliver.
 *
 * Pure — no clock, no IO.
 */
export function decideRemoteInputAction(args: {
  hasWakeTarget: boolean;
  waking: boolean;
  probeAgeMs: number;
  lastReachable?: boolean;
  minProbeIntervalMs?: number;
}): RemoteInputAction {
  if (args.waking) return 'buffer';
  if (!args.hasWakeTarget) return 'deliver';
  if (args.lastReachable === false) return 'buffer';
  const interval = args.minProbeIntervalMs ?? REMOTE_WAKE_PROBE_MIN_INTERVAL_MS;
  if (args.probeAgeMs >= interval) return 'probe';
  return 'deliver';
}

/**
 * Append `data` to the pending buffer, dropping the OLDEST whole chunks when the cap
 * is exceeded. Returns the resulting buffer — the SAME array reference when the chunk
 * was rejected, so the caller can tell the two apart. Pure.
 *
 * A chunk LARGER than the cap is dropped outright rather than trimmed: one paste is
 * one `input` value, and it was never typed character by character, so delivering its
 * tail would execute a fragment of it (with the trailing carriage return, if the paste
 * had one) — a partial command the user never sent. Keeping the tail is right for
 * typing, where the newest bytes are the ones the user just produced, and wrong for a
 * chunk that arrived whole.
 */
export function appendBoundedPending<T extends string | PendingChunk>(
  pending: T[],
  data: T,
  maxBytes = REMOTE_WAKE_PENDING_MAX_BYTES
): T[] {
  if (chunkBytes(data) > maxBytes) return pending;
  const next = [...pending, data];
  let total = next.reduce((sum, chunk) => sum + chunkBytes(chunk), 0);
  while (next.length > 1 && total > maxBytes) {
    total -= chunkBytes(next[0]);
    next.shift();
  }
  return next;
}

/** One buffered input chunk and who sent it: an agent's keeps the move-hold check and its guard through the deferred flush. */
export interface PendingChunk {
  data: string;
  agentInput: boolean;
}
const chunkBytes = (chunk: string | PendingChunk) => Buffer.byteLength(typeof chunk === 'string' ? chunk : chunk.data);

/** The remote fields the wake flow needs. Structurally satisfied by `SessionRemote`. */
export interface WakeableRemote {
  wakeCommand?: string;
  wakeMac?: string;
  hostId: string;
  label: string;
  host: string;
  port?: number;
  /** SSH jump host (`-J`): the host is reached THROUGH it, never directly. */
  jumpHost?: string;
  /** SOCKS5 proxy (`ProxyCommand=nc -X 5 …`): same, the direct address may not even route. */
  socksProxy?: string;
  /** Extra `-o KEY=VALUE` options; a `ProxyCommand`/`ProxyJump` in here proxies the host too. */
  extraSshOptions?: string[];
}

/**
 * Whether the bare TCP probe can answer for this host at all. Pure.
 *
 * The probe connects straight to `host:port`. A host behind a jump host or a SOCKS
 * proxy (the cloudflared case) is reachable ONLY through that proxy, so the direct
 * connect fails while ssh works — and every consumer of the verdict would then act on
 * a "sleeping" host that is fine: a permanent banner, a create-path gate that hides the
 * real ssh error, and (with a wake target) input buffered for the life of the session
 * because the readiness poll can never succeed. Such a host is reachability-UNKNOWN:
 * the registry never buffers for it, never gates on it, and reports `null` rather than
 * `false`. A wake target can still be fired for it, blind.
 */
export function isProbeable(remote: WakeableRemote): boolean {
  if (remote.jumpHost || remote.socksProxy) return false;
  return !(remote.extraSshOptions ?? []).some((option) => /^\s*proxy(command|jump)\s*=/i.test(option));
}

/**
 * A resolved wake path for a host. `command` wins over `mac` (an explicit override
 * beats the default path), and `null` means the host cannot be woken at all — which
 * is what the UI turns into "configure WoL" instead of "wake".
 */
export type WakeTarget = { kind: 'command'; command: string } | { kind: 'mac'; macs: number[][] } | null;

/**
 * Resolve the wake target from host config. Pure.
 *
 * A malformed `wakeMac` resolves to `null` rather than throwing: the schema
 * already rejects one at config time, so this can only be reached with a config
 * written by hand, and a broken MAC must not break the input route.
 */
export function resolveWakeTarget(remote: WakeableRemote | undefined): WakeTarget {
  if (!remote) return null;
  if (remote.wakeCommand) return { kind: 'command', command: remote.wakeCommand };
  if (remote.wakeMac) {
    const macs = parseMacList(remote.wakeMac);
    if (macs && macs.length > 0) return { kind: 'mac', macs };
  }
  return null;
}

/**
 * Parse a comma-separated MAC list into byte arrays. Pure; returns null when any
 * entry is malformed (all-or-nothing, so a typo cannot half-arm a host).
 */
export function parseMacList(value: string, maxMacs = MAX_WAKE_MACS): number[][] | null {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > maxMacs) return null;
  const macs: number[][] = [];
  for (const part of parts) {
    const match =
      /^([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})[:-]([0-9a-fA-F]{2})$/.exec(
        part
      );
    if (!match) return null;
    macs.push(match.slice(1).map((hex) => Number.parseInt(hex, 16)));
  }
  return macs;
}

/**
 * Build a Wake-on-LAN "magic packet": six `0xFF` bytes then the MAC repeated 16
 * times. Pure — the shape is asserted byte-for-byte in the tests because a packet
 * that is off by one byte simply never wakes anything.
 */
export function buildMagicPacket(mac: number[]): Buffer {
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let repeat = 0; repeat < 16; repeat++) {
    Buffer.from(mac).copy(packet, 6 + repeat * 6);
  }
  return packet;
}

/**
 * The slice of `Session` the wake flow uses — an interface rather than the
 * concrete class so the registry is testable without a tmux server.
 */
export interface WakeableSession {
  readonly id: string;
  readonly remote: WakeableRemote | undefined;
  /** COD-108 reattach: respawns the local ssh pane, idempotently attaching the durable remote tmux. */
  reattachRemote(): Promise<boolean>;
  /** Write bytes to the session's pane. `fromUser` marks input a person typed (or an agent sent for them). */
  writeViaMux(data: string, options?: { fromUser?: boolean; opencodeGuard?: boolean | 'person'; agentInput?: boolean;
    onMoveHeld?: () => void; onTypedUnsent?: () => void }): Promise<boolean>;
}

/** Injected IO so the registry holds no direct dependency on ssh/net/child_process in tests. */
export interface RemoteWakeDeps {
  /** Cheap reachability probe. Must resolve false (never throw) for a sleeping host. */
  probe(remote: WakeableRemote): Promise<boolean>;
  /** Run the resolved wake target (magic packet or host command). Resolves false on failure. */
  wake(target: NonNullable<WakeTarget>): Promise<boolean>;
  /** Poll until the woken host accepts connections again. */
  waitUntilReady(remote: WakeableRemote, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<boolean>;
  /** Sleep helper (injected for tests). */
  delay(ms: number): Promise<void>;
  /** Notify the COD-108 watcher so an exhausted backoff is reset. */
  noteReconnected?(sessionId: string, success: boolean): void;
  /** SSE broadcast. */
  broadcast?(
    event: 'remote:hostWaking' | 'remote:hostWakeFailed' | 'remote:sessionReconnected',
    payload: Record<string, unknown>
  ): void;
  /** Structured diagnostics. */
  log?(message: string): void;
  /**
   * Resolve the host's CURRENT wake config for a session whose persisted `remote`
   * snapshot predates it (or was configured after launch). Called at most once per
   * `REMOTE_WAKE_RESOLVE_TTL_MS` per session, and only when the session's own copy
   * has no wake target — so a config saved in the UI works without restarting the
   * session, without a per-keystroke config read.
   */
  resolveRemote?(session: WakeableSession): Promise<WakeableRemote | undefined>;
}

/** Probe freshness for the UI's reachability check (a tab switch is not a hammer). */
export const REMOTE_WAKE_REACHABILITY_TTL_MS = 5_000;
/** How long a resolved host config is trusted before asking the resolver again. */
export const REMOTE_WAKE_RESOLVE_TTL_MS = 30_000;

/**
 * What the UI is allowed to offer for a host: how it can be woken, if at all. The
 * `'none'` case is what the banner turns into "configure WoL" instead of "wake".
 */
export type WakeConfigured = 'command' | 'mac' | 'none';

/** Which wake path a host config provides (mirrors {@link resolveWakeTarget}). Pure. */
export function wakeConfigured(remote: WakeableRemote | undefined): WakeConfigured {
  const target = resolveWakeTarget(remote);
  if (!target) return 'none';
  return target.kind;
}

/**
 * Outcome of waking a host for a caller that has NO session yet (the create/attach
 * routes). A union rather than a boolean because the cases need different handling:
 * `'no-target'` must leave the caller's behavior byte-identical (no probe, no extra
 * latency for a host without WoL), `'unprobeable'` likewise (a proxied host, see
 * {@link isProbeable} — the probe cannot tell asleep from awake, so nothing is gated on
 * it), and only `'failed'` is an error that deserves its own message instead of the
 * caller's usual one.
 */
export type HostWakeOutcome = 'no-target' | 'unprobeable' | 'ready' | 'failed';

/**
 * State key for a host-scoped wake. Prefixed so it can never collide with a session
 * id, and keyed on the HOST rather than the case: two cases on one host share a
 * single in-flight wake and one probe verdict. Such an entry is tiny (no input
 * buffer) and bounded by the number of configured hosts, so it is never dropped.
 */
function hostWakeKey(hostId: string): string {
  return `host:${hostId}`;
}

/** Per-session wake bookkeeping. */
interface WakeState {
  probedAt: number;
  reachable?: boolean;
  waking: Promise<boolean> | null;
  pending: PendingChunk[];
  /** Host config resolved after launch (see `RemoteWakeDeps.resolveRemote`). */
  resolvedRemote?: WakeableRemote;
  resolvedAt: number;
}

/**
 * Per-session wake state + single-flight wake flow.
 *
 * One instance per web server (module singleton in the routes file, like the
 * signal-wait registry). State is keyed by session id and dropped with the
 * session.
 */
export class RemoteWakeRegistry {
  private readonly states = new Map<string, WakeState>();
  /**
   * Aborted by {@link stop} on shutdown. Every in-flight readiness poll is holding an
   * HTTP request open (the wake route blocks on it), and Fastify's `close()` waits for
   * in-flight requests — so without this a restart during a wake sits out the full 90 s
   * budget. The same problem `sessionWaits.cancelEverything()` exists for.
   */
  private readonly shutdown = new AbortController();
  private stopped = false;

  constructor(private readonly deps: RemoteWakeDeps) {}

  /** Drop a session's state (session closed/killed). The pending buffer goes with it. */
  drop(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /**
   * Resolve every in-flight wake as failed and refuse new ones (server shutdown).
   *
   * Called from `WebServer.stop()`: an in-flight wake is awaited by a request, and the
   * server's own `app.close()` does not abort in-flight requests, so shutdown would wait
   * out the poll. Nothing is lost by failing them — the state flush happens earlier in
   * `stop()`, and the process is going away.
   */
  stop(): void {
    this.stopped = true;
    this.shutdown.abort();
  }

  /** Whether a wake is currently in flight (diagnostics/tests). */
  isWaking(sessionId: string): boolean {
    return this.states.get(sessionId)?.waking != null;
  }

  /** Buffered input bytes for a session (diagnostics/tests). */
  pendingBytes(sessionId: string): number {
    const state = this.states.get(sessionId);
    if (!state) return 0;
    return state.pending.reduce((sum, chunk) => sum + chunkBytes(chunk), 0);
  }

  /**
   * Number of keys with wake state (diagnostics/tests). Pins that a LOCAL session never
   * gets an entry: the input gate runs on every keystroke, so an entry per local session
   * would be a map the size of the session list, swept only on cleanup.
   */
  stateCount(): number {
    return this.states.size;
  }

  /** Whether this session's host has any wake path configured at all. */
  async hasWakeTarget(session: WakeableSession): Promise<boolean> {
    return resolveWakeTarget(await this._effectiveRemote(session)) !== null;
  }

  /** Which wake path is configured (`'none'` when the UI should offer configuration). */
  async wakeConfigured(session: WakeableSession): Promise<WakeConfigured> {
    return wakeConfigured(await this._effectiveRemote(session));
  }

  /**
   * Reachability for the UI: probe unless a recent result is still fresh. `null` for a
   * host the probe cannot reach (see {@link isProbeable}): unknown is not unreachable.
   *
   * Shares the per-session probe state with the input path on purpose — a fresh
   * answer is exactly what the input ladder wants, and an `unreachable` verdict here
   * makes the next keystroke buffer + wake instead of vanishing into a stalled pane.
   */
  async checkReachable(
    session: WakeableSession,
    opts: { force?: boolean; ttlMs?: number } = {}
  ): Promise<boolean | null> {
    const remote = await this._effectiveRemote(session);
    if (!remote) return true;
    // `null`, never `false`: the UI keys the banner on a PROVEN unreachable host.
    if (!isProbeable(remote)) return null;
    const state = this._state(session.id);
    const ttl = opts.force ? 0 : (opts.ttlMs ?? REMOTE_WAKE_REACHABILITY_TTL_MS);
    if (Date.now() - state.probedAt >= ttl) {
      state.probedAt = Date.now();
      state.reachable = await this.deps.probe(remote);
    }
    return state.reachable === true;
  }

  /**
   * Decide + act for one input chunk.
   *
   * `'deliver'` means the caller writes it as usual (today's path, zero added
   * cost). `'buffered'` means the registry took ownership of the bytes: it either
   * queued them behind an in-flight wake or started a wake, and will flush them
   * in order once the pane is reattached.
   */
  async handleInput(session: WakeableSession, data: string, origin: { agentInput?: boolean } = {}): Promise<RemoteInputOutcome> {
    const chunk: PendingChunk = { data, agentInput: !!origin.agentInput };
    const remote = await this._effectiveRemote(session);
    // A proxied host can never pass the readiness poll, so buffering for it would hold
    // the bytes for the life of the session (reproduced upstream: three inputs, nothing
    // written, no reattach). Deliver, as if the feature were off.
    if (remote && !isProbeable(remote)) return 'deliver';
    const state = this._state(session.id);
    const target = resolveWakeTarget(remote);
    const action = decideRemoteInputAction({
      hasWakeTarget: target !== null,
      waking: state.waking != null,
      probeAgeMs: Date.now() - state.probedAt,
      lastReachable: state.reachable,
    });

    if (action === 'deliver') return 'deliver';
    if (action === 'buffer') {
      const queued = this._enqueue(session.id, chunk);
      // A buffered verdict with no wake in flight still has to DRIVE a wake (the
      // previous one failed and reset the probe state, or the ladder landed here
      // directly) — otherwise the bytes would sit in the buffer forever.
      if (state.waking == null && target) void this.wake(session);
      return queued;
    }

    // action === 'probe' — the throttle window elapsed, so one TCP connect is owed.
    state.probedAt = Date.now();
    state.reachable = remote ? await this.deps.probe(remote) : true;
    if (state.reachable) return 'deliver';

    const queued = this._enqueue(session.id, chunk);
    void this.wake(session);
    return queued;
  }

  /**
   * Block until the host is reachable and the pane is reattached — the
   * send-and-wait path, where the HTTP response stays open anyway and buffering
   * would break the wait contract.
   */
  async ensureAwake(session: WakeableSession, opts: { force?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
    if (this.stopped) return false;
    const remote = await this._effectiveRemote(session);
    const target = resolveWakeTarget(remote);
    if (!remote || !target) return true;
    // A proxied host: the send-and-wait path has nothing to gate on (unknown is not
    // asleep), so it delivers; the manual button still wakes, blind (see `wake`).
    if (!isProbeable(remote)) return opts.force ? this.wake(session, opts) : true;
    const state = this._state(session.id);
    // `force` is the manual path (a user pressed "wake"): a cached "reachable" from
    // seconds ago must not talk the button out of waking a host that just slept.
    if (opts.force || (state.reachable !== false && Date.now() - state.probedAt >= REMOTE_WAKE_PROBE_MIN_INTERVAL_MS)) {
      state.probedAt = Date.now();
      state.reachable = await this.deps.probe(remote);
    }
    if (state.reachable) return true;
    // The manual button is pressed from the SAME dashboard the create/attach paths are,
    // so it holds its request open under the same reverse proxy — it needs the request
    // budget, not the 90 s session default (see REMOTE_WAKE_REQUEST_READY_TIMEOUT_MS).
    return this.wake(session, { timeoutMs: opts.timeoutMs });
  }

  /**
   * Host-scoped reachability, for a caller that has no session yet (create/attach).
   * Shares the per-HOST probe state with {@link ensureHostAwake}, so the probe the
   * wake flow just paid for also answers "was that ssh failure really a sleeping
   * machine?". Never wakes anything — it is a question, not an action. `null` when the
   * question cannot be answered (see {@link isProbeable}).
   */
  async checkHostReachable(
    remote: WakeableRemote,
    opts: { force?: boolean; ttlMs?: number } = {}
  ): Promise<boolean | null> {
    // `null` for a proxied host: callers gate on `=== false` (proven unreachable), so an
    // unknown verdict leaves their ordinary error path — "needs tmux" — intact.
    if (!isProbeable(remote)) return null;
    const state = this._state(hostWakeKey(remote.hostId));
    const ttl = opts.force ? 0 : (opts.ttlMs ?? REMOTE_WAKE_REACHABILITY_TTL_MS);
    if (Date.now() - state.probedAt >= ttl) {
      state.probedAt = Date.now();
      state.reachable = await this.deps.probe(remote);
    }
    return state.reachable === true;
  }

  /**
   * Wake a host for a REQUEST that is waiting on it — the session create/attach
   * routes, where there is no session to reattach and no input to buffer yet.
   *
   * `'no-target'` returns without probing, so a host without WoL config costs
   * nothing and behaves exactly as before. Single-flight per host, so a double click
   * (or two cases on the same host) sends one packet and shares one readiness poll.
   */
  async ensureHostAwake(
    remote: WakeableRemote,
    opts: { timeoutMs?: number; requestedBy?: string } = {}
  ): Promise<HostWakeOutcome> {
    if (!resolveWakeTarget(remote)) return 'no-target';
    // The probe cannot tell a proxied host asleep from awake, and a wake that cannot
    // verify readiness would only delay the request by its whole budget. Not gated.
    if (!isProbeable(remote)) return 'unprobeable';
    if (this.stopped) return 'failed';
    const state = this._state(hostWakeKey(remote.hostId));
    if (state.waking) return (await state.waking) ? 'ready' : 'failed';

    state.probedAt = Date.now();
    state.reachable = await this.deps.probe(remote);
    if (state.reachable) return 'ready';
    this.deps.log?.(`[RemoteWake] ${remote.label} (${remote.host}) is unreachable — waking it for a new session`);
    return (await this.wakeHost(remote, opts)) ? 'ready' : 'failed';
  }

  /**
   * Single-flight wake for a host with no session (see {@link ensureHostAwake}). Uses the
   * same single-flight `waking` slot the session flow uses — but a DIFFERENT key
   * (`host:<id>` vs the session id), so a session wake and a create-path wake for the same
   * host are two independent flows rather than one shared poll. Harmless (both are
   * user-initiated and the host only wakes once), and keying them together would mean a
   * create request joining an unrelated session's wake and inheriting its budget.
   */
  private async wakeHost(remote: WakeableRemote, opts: { timeoutMs?: number; requestedBy?: string }): Promise<boolean> {
    const state = this._state(hostWakeKey(remote.hostId));
    if (state.waking) return state.waking;
    state.waking = (async (): Promise<boolean> => {
      try {
        return await this._wakeAndWait(remote, state, {
          timeoutMs: opts.timeoutMs,
          forNewSession: true,
          requestedBy: opts.requestedBy,
        });
      } catch (err) {
        // Injected IO is documented not to throw, but a rejected promise here would
        // surface as an unhandled rejection AND take the route down with it (the
        // session path catches for exactly this reason). A broken wake target must
        // fail the wake, never the create route beyond its own error response.
        this.deps.log?.(`[RemoteWake] unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        state.waking = null;
      }
    })();
    return state.waking;
  }

  /**
   * Single-flight wake: probe-free (the caller already knows the host is down),
   * run the wake command, poll for readiness, reattach the pane, flush the buffer.
   */
  async wake(session: WakeableSession, opts: { timeoutMs?: number } = {}): Promise<boolean> {
    if (this.stopped) return false;
    const remote = await this._effectiveRemote(session);
    const target = resolveWakeTarget(remote);
    if (!remote || !target) return true;
    if (!isProbeable(remote)) return this._wakeBlind(remote, target);
    const state = this._state(session.id);
    if (state.waking) return state.waking;

    state.waking = (async (): Promise<boolean> => {
      const id = session.id;
      try {
        const ready = await this._wakeAndWait(remote, state, { sessionId: id, timeoutMs: opts.timeoutMs });
        if (!ready) return false;

        const reattached = await session.reattachRemote();
        if (!reattached) {
          this.deps.log?.(`[RemoteWake] ${remote.label} is up but the pane could not be reattached`);
          return false;
        }
        // The reset also clears an EXHAUSTED COD-108 backoff, which otherwise
        // never fires again for this session (see remote-reconnect.ts).
        this.deps.noteReconnected?.(id, true);
        this.deps.broadcast?.('remote:sessionReconnected', { sessionId: id });
        this.deps.log?.(`[RemoteWake] ${remote.label} reattached for session ${id}`);

        await this.deps.delay(REMOTE_WAKE_ATTACH_SETTLE_MS);
        await this._flush(state, session);
        return true;
      } catch (err) {
        this.deps.log?.(`[RemoteWake] unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        state.waking = null;
      }
    })();

    return state.waking;
  }

  /**
   * Fire the wake target for a host whose readiness cannot be verified (see
   * {@link isProbeable}): no readiness poll (it could never succeed), no reattach (the
   * COD-108 watcher owns the pane once ssh works again), no `hostWaking` broadcast (its
   * toast promises a wait that does not happen). The caller learns only whether the
   * packet/command went out — and a wake IO that throws is a failed wake, never a
   * rejected route.
   */
  private async _wakeBlind(remote: WakeableRemote, target: NonNullable<WakeTarget>): Promise<boolean> {
    this.deps.log?.(`[RemoteWake] waking ${remote.label} (${remote.host}) via ${target.kind}, blind: proxied host`);
    try {
      return await this.deps.wake(target);
    } catch (err) {
      this.deps.log?.(`[RemoteWake] unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Broadcast + run the wake target + wait for SSH. Shared by the session flow (which
   * then reattaches and flushes the buffer) and the create/attach flow (which has no
   * pane yet). On failure the probe state is reset so the NEXT attempt probes and
   * retries instead of trusting a stale "down" verdict forever.
   */
  private async _wakeAndWait(
    remote: WakeableRemote,
    state: WakeState,
    opts: { sessionId?: string; timeoutMs?: number; forNewSession?: boolean; requestedBy?: string } = {}
  ): Promise<boolean> {
    const target = resolveWakeTarget(remote);
    if (!target) return true;
    const forWhat = opts.sessionId ? `for session ${opts.sessionId}` : 'for a new session';
    // Routing for multi-user mode (server.ts `deriveSseHint`): a session-scoped event
    // reaches its owner, and the create/attach wake has no session yet — so it names
    // the requesting user instead, or it would reach admins only. The payload carries
    // `hostId`/`label`, which non-admins are not shown elsewhere, so it must not go global.
    const scope = opts.sessionId
      ? { sessionId: opts.sessionId }
      : { forNewSession: true, ...(opts.requestedBy ? { username: opts.requestedBy } : {}) };
    // No `sessionId` for a create-path wake: the toast handler is then the only one
    // that acts (a banner for a session that does not exist yet would have no target),
    // which is exactly the `forNewSession` distinction the UI renders.
    //
    // `queuedInput` is true only on the typing path, where bytes are actually held for
    // this session. The wake BUTTON and the send-and-wait path hold nothing, so a UI
    // that keyed "input is queued until it is back" off "a wake is running" would promise
    // something the user can disprove by typing (browser keystrokes go over the
    // WebSocket, which never passes through this registry).
    this.deps.broadcast?.('remote:hostWaking', {
      ...scope,
      hostId: remote.hostId,
      label: remote.label,
      queuedInput: state.pending.length > 0,
    });
    this.deps.log?.(`[RemoteWake] waking ${remote.label} (${remote.host}) via ${target.kind} ${forWhat}`);

    const wakeStartedAt = Date.now();
    const woke = await this.deps.wake(target);
    if (!woke) {
      this.deps.log?.(
        `[RemoteWake] wake failed for ${remote.label}: ${target.kind === 'command' ? target.command : 'magic packet'}`
      );
    }

    // The request-scoped budget has to cover the WHOLE request, and the wake is part
    // of it. A `command` target is bounded by REMOTE_WAKE_COMMAND_TIMEOUT_MS, so a slow
    // one burned 10 s before the readiness poll even started and pushed a wakeCommand
    // host's worst case to ~68 s, past the 60 s proxy_read_timeout this budget exists to
    // stay under. A magic packet is effectively instant, so this subtracts nothing there.
    // Floored at one poll interval so a wake that ate the whole budget still gets one
    // probe rather than being declared unreachable without asking.
    const wakeElapsedMs = Date.now() - wakeStartedAt;
    const readyTimeoutMs =
      opts.timeoutMs === undefined
        ? undefined
        : Math.max(REMOTE_WAKE_READY_INTERVAL_MS, opts.timeoutMs - wakeElapsedMs);

    const ready = await this.deps.waitUntilReady(remote, {
      timeoutMs: readyTimeoutMs,
      signal: this.shutdown.signal,
    });
    if (!ready) {
      this.deps.log?.(
        `[RemoteWake] ${remote.label} did not come back — ${opts.forNewSession ? 'the session was not started' : 'input stays buffered'}`
      );
      this.deps.broadcast?.('remote:hostWakeFailed', {
        ...scope,
        hostId: remote.hostId,
        label: remote.label,
        queuedInput: state.pending.length > 0,
      });
      state.probedAt = 0;
      state.reachable = undefined;
      return false;
    }

    state.reachable = true;
    state.probedAt = Date.now();
    return true;
  }

  private _state(sessionId: string): WakeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { probedAt: 0, reachable: undefined, waking: null, pending: [], resolvedAt: 0 };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /**
   * The host config to act on: the session's own `remote` when it is fresh enough, else a
   * freshly resolved one.
   *
   * The persisted `remote` snapshot is taken at launch, so a wake target configured AFTER
   * the session started (e.g. through the banner's config dialog, or by adding `wakeMac`
   * to `remote-hosts.json`) is invisible to it. Recovery rehydration (server.ts) covers
   * restarts; this covers the live session, and it is why saving the dialog takes effect
   * without restarting anything.
   *
   * ⚠️ The host config wins in BOTH directions, so the resolver is consulted on the TTL
   * regardless of whether the session already carries a target. Preferring the snapshot
   * whenever it HAD one meant removing a MAC/command in the config (or the dialog) never
   * took effect for a running session — the feature stayed on with a target nobody could
   * see in the config any more, which is exactly the "host config is authoritative"
   * promise failing in the one direction a user can observe.
   */
  private async _effectiveRemote(session: WakeableSession): Promise<WakeableRemote | undefined> {
    // The local-session return comes FIRST, before `_state`: this runs on every input
    // chunk (`hasWakeTarget` gates the route), so allocating state here would put an
    // entry in the map for every local session the user types in — sessions the feature
    // can never apply to, and whose pending buffers would then have to be swept.
    if (!session.remote) return undefined;
    const state = this._state(session.id);
    if (!this.deps.resolveRemote) return state.resolvedRemote ?? session.remote;
    if (state.resolvedAt !== 0 && Date.now() - state.resolvedAt < REMOTE_WAKE_RESOLVE_TTL_MS) {
      return state.resolvedRemote ?? session.remote;
    }
    state.resolvedAt = Date.now();
    try {
      const resolved = await this.deps.resolveRemote(session);
      if (resolved) state.resolvedRemote = resolved;
    } catch (err) {
      this.deps.log?.(
        `[RemoteWake] host config lookup failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return state.resolvedRemote ?? session.remote;
  }

  /** Queue a chunk; `'dropped'` when it was over the cap and never entered the buffer. */
  private _enqueue(sessionId: string, chunk: PendingChunk): 'buffered' | 'dropped' {
    const state = this._state(sessionId);
    const next = appendBoundedPending(state.pending, chunk);
    if (next === state.pending) {
      // Oversized chunk: dropped whole (see `appendBoundedPending`), so the buffer is
      // untouched and nothing is delivered as a fragment. Logged, and reported to the
      // route, which answers `dropped:true` — the user's paste is gone and a bare 200
      // could not say so.
      this.deps.log?.(
        `[RemoteWake] dropped a ${chunkBytes(chunk)}-byte input chunk for session ${sessionId} — over the ${REMOTE_WAKE_PENDING_MAX_BYTES}-byte wake buffer, and a truncated paste must not be delivered as a fragment`
      );
      return 'dropped';
    }
    const before = state.pending.reduce((sum, c) => sum + chunkBytes(c), 0);
    const after = next.reduce((sum, c) => sum + chunkBytes(c), 0);
    if (before + chunkBytes(chunk) > after) {
      this.deps.log?.(`[RemoteWake] pending buffer cap reached for session ${sessionId} — oldest input dropped`);
    }
    state.pending = next;
    return 'buffered';
  }

  private async _flush(state: WakeState, session: WakeableSession): Promise<void> {
    while (state.pending.length > 0) {
      const chunk = state.pending[0];
      // Take the chunk OUT before awaiting the write. Input arriving during the await is
      // enqueued by `handleInput` (a wake is still in flight, so it takes the buffer
      // path), and `appendBoundedPending` may then drop the OLDEST chunk to stay under
      // the cap — which would be this one, already on its way to the pane. Shifting
      // afterwards removed the NEXT chunk instead, so the drop-oldest bookkeeping lost a
      // chunk that was never written while the log line blamed the one that was.
      state.pending = state.pending.slice(1);
      // `fromUser`: these bytes came through the input route as a person's prompt, so
      // they may name the tab — without it a session whose FIRST prompt was buffered
      // through a wake could never be auto-named.
      // An agent's chunk keeps its origin: its guard, and the plan-move hold checked at the write (agentInput), so a move
      // that took the composer after the buffered ACK gets nothing typed. Refused before any byte, that chunk alone is
      // dropped (it was ACKed as buffered, so it is never replayed) and the person's chunks behind it still go out.
      let heldByMove = false;
      const ok = await session.writeViaMux(chunk.data, chunk.agentInput
        ? { fromUser: true, opencodeGuard: true, agentInput: true, onMoveHeld: () => { heldByMove = true; } }
        : { fromUser: true, opencodeGuard: 'person' }).catch(() => false);
      if (!ok && heldByMove) {
        this.deps.log?.(`[RemoteWake] a buffered agent chunk for session ${session.id} was dropped: a plan move owns the composer`);
        continue;
      }
      if (!ok) {
        // Drop the rest, and say so. Retaining it looked safer but was worse: the wake
        // still resolves and marks the host reachable, so the NEXT input takes the
        // deliver path while the old chunks sit here — to be replayed by the next wake,
        // possibly hours later, after everything typed since, and maybe ending in a
        // carriage return. Same policy as the oversized paste: gone, with a log line.
        const dropped = state.pending.length + 1;
        state.pending = [];
        this.deps.log?.(
          `[RemoteWake] flush failed for session ${session.id} — ${dropped} buffered chunk(s) dropped rather than replayed on a later wake`
        );
        return;
      }
    }
  }
}

// ========== Default IO ==========

/**
 * Under vitest none of this may do real IO (a TCP connect, a child process, a UDP
 * broadcast) — mirrors `remote-files.ts`. Every consumer injects its deps
 * (`RemoteWakeDeps`, the socket factory); this is what makes that seam non-optional
 * instead of a convention the next test can forget.
 */
function assertNotUnderTest(what: string): void {
  if (process.env.VITEST) {
    throw new Error(`remote-wake: ${what} is disabled under test — inject a fake (RemoteWakeDeps / WakeSocketFactory)`);
  }
}

/**
 * Cheap reachability probe: a bare TCP connect to the SSH port. Only meaningful for a
 * host the registry deems probeable (see {@link isProbeable}); the registry never asks
 * it about a proxied host.
 *
 * Deliberately NOT an `ssh … true` probe: that opens a full session (auth,
 * remote log, process) every throttle window for a question a SYN already
 * answers. Any byte count it does move is a few hundred bytes per probe, far
 * below the remote idle detector's traffic threshold, so probing cannot keep a
 * host awake.
 */
export function probeRemoteHostReachable(
  remote: WakeableRemote,
  timeoutMs = REMOTE_WAKE_PROBE_TIMEOUT_MS
): Promise<boolean> {
  assertNotUnderTest('the TCP probe');
  const port = remote.port ?? DEFAULT_SSH_PORT;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host: remote.host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Run a host's wake command (e.g. a Wake-on-LAN wrapper script). No shell — the
 * value is a single executable path, so nothing in it can be interpreted.
 * Resolves false on any failure (missing binary, non-zero exit, timeout) rather
 * than throwing: a broken wake command must not break the input route.
 */
export function runRemoteWakeCommand(command: string, timeoutMs = REMOTE_WAKE_COMMAND_TIMEOUT_MS): Promise<boolean> {
  assertNotUnderTest('the wake command');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [], { stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Send Wake-on-LAN magic packets for every MAC, over UDP to the broadcast address.
 *
 * This is the whole reason `wakeMac` exists: the common case needs no external
 * script. Broadcast on 255.255.255.255 is what the CLI `wakeonlan` does and what the
 * NICs here answer to; the socket is closed as soon as the packets are queued, so a
 * sleeping host cannot leave a handle behind. Resolves false on any failure (no
 * interface to broadcast on, permission) rather than throwing — a broken network
 * must not break the wake flow, which reports the failure itself.
 */
export function sendWakePackets(
  addresses: number[][],
  port = 9,
  createSocket: WakeSocketFactory = () => {
    assertNotUnderTest('the UDP broadcast');
    return dgram.createSocket('udp4');
  }
): Promise<boolean> {
  if (addresses.length === 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createSocket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    socket.once('error', () => finish(false));
    // ⚠️ `setBroadcast` BEFORE the socket is bound fails with EBADF on Linux, and the
    // send that follows fails with EACCES — i.e. the packet silently never leaves the
    // machine. So the broadcast flag is set in the bind callback, always. (Found by
    // the live test: macOS/BSD tolerate the wrong order, Linux does not.)
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        finish(false);
        return;
      }
      let pending = addresses.length;
      let failed = false;
      for (const mac of addresses) {
        socket.send(buildMagicPacket(mac), port, '255.255.255.255', (err?: Error | null) => {
          if (err) failed = true;
          pending--;
          if (pending === 0) finish(!failed);
        });
      }
    });
  });
}

/** The `dgram` surface {@link sendWakePackets} uses — injectable so the bind/setBroadcast ORDER is testable. */
export interface WakeSocket {
  bind(callback: () => void): void;
  setBroadcast(flag: boolean): void;
  send(msg: Buffer, port: number, address: string, callback: (err?: Error | null) => void): void;
  close(): void;
  once(event: 'error', listener: (err: Error) => void): void;
}

export type WakeSocketFactory = () => WakeSocket;

/** Poll the host until it accepts connections again, or the bound is hit. */
export async function waitUntilRemoteReady(
  remote: WakeableRemote,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    probe?: (remote: WakeableRemote) => Promise<boolean>;
  } = {}
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? REMOTE_WAKE_READY_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? REMOTE_WAKE_READY_TIMEOUT_MS;
  const probe = opts.probe ?? probeRemoteHostReachable;
  const deadline = Date.now() + timeoutMs;
  // Probe immediately: WoL from a warm S3 is fast (~7.5 s measured on this setup),
  // and the first poll is what turns "just woke" into a sub-interval response.
  for (;;) {
    if (opts.signal?.aborted) return false;
    if (await probe(remote)) return true;
    if (Date.now() + intervalMs > deadline) return false;
    // Abortable sleep, so a shutdown does not wait out the current interval either.
    await delayOrAbort(intervalMs, opts.signal);
  }
}

/** `delay`, but it also ends the moment `signal` aborts (so cancellation is immediate). */
function delayOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return delay(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Production wiring: all IO defaults, overridable for tests.
 *
 * The readiness poll uses the SAME probe as the rest of the deps, overridden or not.
 * Wiring it to the module default instead let a caller that injected `probe` still
 * poll the real host during the wait — under vitest, a TCP connect to a production
 * address on every shutdown test (which the vitest guard is what finally caught).
 */
export function createDefaultRemoteWakeDeps(overrides: Partial<RemoteWakeDeps> = {}): RemoteWakeDeps {
  const probe = overrides.probe ?? probeRemoteHostReachable;
  return {
    probe,
    wake: (target) => (target.kind === 'command' ? runRemoteWakeCommand(target.command) : sendWakePackets(target.macs)),
    waitUntilReady: (remote, opts) => waitUntilRemoteReady(remote, { ...opts, probe }),
    delay,
    ...overrides,
  };
}
