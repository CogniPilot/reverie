/** Browser-local input custody. No row, lock or status creates backend authority. */
(() => {
  'use strict';
  const DB_NAME = 'reverie-input-journal-v2';
  const DB_VERSION = 1;
  const LEGACY = '*legacy-unscoped*';
  const MAX_ROWS = 4096;
  const MAX_LEGACY = 64;
  const MAX_CHARS = 4 * 1024 * 1024;
  const FRAME_CHARS = 65536;
  const FINAL = new Set(['confirmed', 'typed-unsent']);
  const PHASES = new Set(['prepared', 'not-issued', 'may-issued', 'pending', 'unconfirmed', ...FINAL]);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const plain = (value) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  const key = (...parts) => JSON.stringify(parts);
  class JournalError extends Error {
    constructor(reason) {
      super(reason);
      this.name = 'InputJournalError';
      this.reason = reason;
    }
  }
  const nativeIntakePorts = new WeakMap();
  /** Page-local memory custody only. These handles never authorize a backend effect. */
  class Intake {
    #tokens = new WeakMap();
    #groups = new WeakMap();
    #live = new Set();
    #chars = 0;
    #units = 0;
    #observer = null;
    #bound = null;
    #overflow = null;
    #copies = [];
    #rawPaused = false;
    #pausedSids = new Set();
    constructor() {
      nativeIntakePorts.set(
        this,
        Object.freeze({
          claimStorage: (token, sid, chars, units) => this.#claimStorage(token, sid, chars, units),
          settled: (token, accepted) => this.#storageSettled(token, accepted),
        })
      );
    }
    #notify() {
      try {
        this.#observer?.();
      } catch {
        /* Presentation cannot settle custody. */
      }
    }
    observe(observer) {
      this.#observer = observer;
      this.#notify();
    }
    bind(journal) {
      if (this.#bound && this.#bound !== journal) throw new JournalError('intake-already-bound');
      this.#bound = journal;
    }
    bound(journal) {
      return this.#bound === journal;
    }
    #entry(token) {
      return token && this.#tokens.get(token);
    }
    #remove(token) {
      const entry = this.#entry(token);
      if (!entry || !this.#live.delete(entry)) return false;
      clearTimeout(entry.timer);
      this.#tokens.delete(token);
      this.#chars -= entry.chars;
      this.#units -= entry.units;
      return true;
    }
    #insert(sid, chars, units) {
      const token = Object.freeze({});
      const entry = {
        token,
        sid,
        chars,
        units,
        timer: null,
        deadline: 0,
        pending: false,
        noticed: false,
        accepted: false,
        stage: 'reserved',
        group: null,
      };
      this.#tokens.set(token, entry);
      this.#live.add(entry);
      this.#chars += chars;
      this.#units += units;
      return token;
    }
    reserve(sid, chars, units = 1) {
      if (
        !text(sid, 128) ||
        !Number.isSafeInteger(chars) ||
        chars <= 0 ||
        !Number.isSafeInteger(units) ||
        units <= 0 ||
        this.#chars + chars > MAX_CHARS ||
        this.#units + units > MAX_ROWS
      )
        return null;
      return this.#insert(sid, chars, units);
    }
    transfer(tokens, sid, chars, units) {
      if (!tokens.length || new Set(tokens).size !== tokens.length) return null;
      const entries = tokens.map((token) => this.#entry(token));
      if (entries.some((entry) => !entry || entry.sid !== sid || entry.stage !== 'reserved')) return null;
      const oldChars = entries.reduce((n, entry) => n + entry.chars, 0);
      const oldUnits = entries.reduce((n, entry) => n + entry.units, 0);
      const deadlines = entries.map((entry) => entry.deadline).filter(Boolean);
      if (
        !Number.isSafeInteger(chars) ||
        chars < oldChars ||
        !Number.isSafeInteger(units) ||
        units <= 0 ||
        this.#chars - oldChars + chars > MAX_CHARS ||
        this.#units - oldUnits + units > MAX_ROWS
      )
        return null;
      // One synchronous ownership transfer, without making capacity available to another caller.
      for (const token of tokens) this.#remove(token);
      const next = this.#insert(sid, chars, units);
      if (deadlines.length) this.#entry(next).deadline = Math.min(...deadlines);
      return next;
    }
    release(token) {
      if (this.#entry(token)?.pending) return false;
      const removed = this.#remove(token);
      if (removed) this.#notify();
      return removed;
    }
    begin(token) {
      const entry = this.#entry(token);
      if (!entry || entry.pending) return false;
      entry.pending = true;
      entry.deadline ||= performance.now() + 10000;
      const notice = () => {
        if (!this.#live.has(entry) || !entry.pending) return;
        entry.noticed = true;
        this.#notify();
      };
      const remaining = Math.max(0, entry.deadline - performance.now());
      if (remaining === 0) notice();
      else entry.timer = setTimeout(notice, remaining);
      return true;
    }
    rawBlocked(sid) {
      return this.#rawPaused || this.#pausedSids.has(sid);
    }
    pending(sid) {
      return [...this.#live].some((entry) => entry.noticed && entry.sid === sid);
    }
    #fits(token, sid, chars, units) {
      const entry = this.#entry(token);
      return (
        !!entry &&
        entry.sid === sid &&
        entry.chars === chars &&
        Number.isSafeInteger(units) &&
        units > 0 &&
        entry.units >= units &&
        entry.pending
      );
    }
    queue(sid, chars, units, prepared, group) {
      const token = prepared || this.batch(sid, chars, units, group);
      const entry = this.#entry(token);
      if (!this.#fits(token, sid, chars, units) || entry.stage !== 'prepared') return null;
      // Spend the prepared handle synchronously, before the App's asynchronous tail.
      this.#tokens.delete(token);
      entry.token = Object.freeze({});
      entry.stage = 'queued';
      this.#tokens.set(entry.token, entry);
      if (entry.group) this.#groups.get(entry.group).token = entry.token;
      return entry.token;
    }
    #claimStorage(token, sid, chars, units) {
      const entry = this.#entry(token);
      if (!this.#fits(token, sid, chars, units) || !['prepared', 'queued'].includes(entry.stage)) return false;
      // One allocation can enter exactly one Journal.accept, even before its serial callback runs.
      entry.stage = 'storing';
      return true;
    }
    #storageSettled(token, accepted) {
      const entry = this.#entry(token);
      if (!entry || entry.stage !== 'storing') return;
      entry.stage = 'storage-settled';
      entry.accepted = accepted;
      this.#notify();
    }
    captureOverflow(sid, value) {
      // Freeze all sources BEFORE retaining the one event already delivered by xterm.
      this.#rawPaused = true;
      if (!this.#overflow && typeof value === 'string' && value) this.#overflow = Object.freeze({ sid, text: value });
      this.#notify();
    }
    #group(token, sid, value) {
      const group = Object.freeze({});
      this.#groups.set(group, { token, sid, text: value, settled: false, batched: false });
      return group;
    }
    raw(sid, value) {
      if (this.rawBlocked(sid) || this.pending(sid) || typeof value !== 'string' || !value) return null;
      const token = this.reserve(sid, value.length, Math.ceil(value.length / FRAME_CHARS));
      if (!token) {
        this.captureOverflow(sid, value);
        return null;
      }
      return this.#group(token, sid, value);
    }
    rawBuffer(tokens, sid, value) {
      const token = this.transfer(tokens, sid, value.length, Math.ceil(value.length / FRAME_CHARS));
      return token ? this.#group(token, sid, value) : null;
    }
    batch(sid, chars, units, group) {
      const raw = group && this.#groups.get(group);
      if (group && (!raw || raw.settled || raw.batched || raw.sid !== sid)) return null;
      if (!raw && this.pending(sid)) return null;
      const token = raw ? this.transfer([raw.token], sid, chars, units) : this.reserve(sid, chars, units);
      if (!token) return null;
      this.#entry(token).stage = 'prepared';
      if (raw) {
        raw.batched = true;
        raw.token = token;
        this.#entry(token).group = group;
      }
      this.begin(token);
      return token;
    }
    completeRaw(group, accepted) {
      const raw = this.#groups.get(group);
      if (!raw || raw.settled) return;
      const entry = this.#entry(raw.token);
      if (!entry || entry.stage === 'storing') return;
      if (entry.stage === 'storage-settled') accepted = entry.accepted;
      raw.settled = true;
      clearTimeout(entry.timer);
      entry.noticed = false;
      entry.pending = false;
      if (accepted) this.#remove(raw.token);
      else {
        // Preserve the original physical event, not the editable prefix added to its batch.
        this.#chars -= entry.chars - raw.text.length;
        entry.chars = raw.text.length;
        // Retained custody is private. A stale batch/raw handle cannot refund its copy.
        this.#tokens.delete(raw.token);
        entry.token = Object.freeze({});
        entry.group = null;
        entry.stage = 'retained';
        this.#tokens.set(entry.token, entry);
        this.#copies.push(Object.freeze({ sid: raw.sid, text: raw.text }));
        this.#pausedSids.add(raw.sid);
      }
      raw.token = null;
      raw.text = ''; // The settled handle never retains a second, uncharged payload.
      this.#notify();
    }
    finish(token, accepted) {
      const entry = this.#entry(token);
      if (!entry || entry.stage === 'storing') return;
      if (entry.stage === 'storage-settled') accepted = entry.accepted;
      if (entry.group) this.completeRaw(entry.group, accepted);
      else {
        this.#remove(token);
        this.#notify();
      }
    }
    async performRaw(sid, value, action) {
      const group = this.raw(sid, value);
      if (!group) return false;
      const raw = this.#groups.get(group);
      this.begin(raw.token);
      let accepted = false;
      try {
        accepted = (await action(group)) === true;
        return accepted;
      } finally {
        this.completeRaw(group, accepted);
      }
    }
    retain(sid, value) {
      const group = this.raw(sid, value);
      if (group) this.completeRaw(group, false);
    }
    snapshot() {
      return Object.freeze({
        chars: this.#chars,
        units: this.#units,
        rawPaused: this.#rawPaused,
        pending: [...this.#live]
          .filter((entry) => entry.noticed)
          .map((entry) => Object.freeze({ sid: entry.sid, accepted: entry.accepted })),
        copies: [...this.#copies, ...(this.#overflow ? [this.#overflow] : [])],
      });
    }
  }
  const intake = new Intake();
  // Only Journal captures the original singleton's native proof port; it is never exported to the page.
  const nativeIntake = nativeIntakePorts.get(intake);
  function nextRevision(value) {
    if (!Number.isSafeInteger(value + 1)) throw new JournalError('revision-exhausted');
    return value + 1;
  }
  function identity(value) {
    if (
      !plain(value) ||
      Object.keys(value).sort().join(',') !== 'epoch,kind,scopeId,version' ||
      value.version !== 1 ||
      !['account', 'session', 'anonymous'].includes(value.kind) ||
      !text(value.scopeId) ||
      value.scopeId === LEGACY ||
      !integer(value.epoch)
    )
      throw new JournalError('identity-unavailable');
    return Object.freeze({ ...value });
  }
  function nonce(crypto) {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    if (typeof crypto?.getRandomValues !== 'function') throw new JournalError('secure-random-unavailable');
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function checkRow(row, scope) {
    if (
      !plain(row) ||
      row.version !== 2 ||
      row.scope !== scope ||
      !text(row.sid, 128) ||
      !uuid(row.issuer) ||
      !integer(row.seq) ||
      row.seq < 1 ||
      !integer(row.epoch) ||
      !integer(row.revision) ||
      row.revision < 1 ||
      !uuid(row.ownerToken) ||
      !PHASES.has(row.phase) ||
      typeof row.data !== 'string' ||
      row.data.length > FRAME_CHARS ||
      ![null, true, false].includes(row.useMux) ||
      !integer(row.createdAt) ||
      !/^[a-f0-9]{64}$/.test(row.fingerprint) ||
      row.key !== key(scope, row.issuer, row.sid, row.seq)
    )
      throw new JournalError('journal-corrupt');
    return row;
  }
  function checkIssuer(row, scope) {
    if (
      !plain(row) ||
      row.version !== 2 ||
      row.scope !== scope ||
      !uuid(row.issuer) ||
      !uuid(row.owner) ||
      !uuid(row.token) ||
      !integer(row.revision) ||
      row.revision < 1 ||
      !integer(row.epoch) ||
      row.key !== key(scope, row.issuer) ||
      !Array.isArray(row.sequences) ||
      row.sequences.length > MAX_ROWS ||
      row.sequences.some(
        (pair) => !Array.isArray(pair) || pair.length !== 2 || !text(pair[0], 128) || !integer(pair[1])
      ) ||
      new Set(row.sequences.map((pair) => pair[0])).size !== row.sequences.length
    )
      throw new JournalError('journal-corrupt');
    return row;
  }
  function checkHold(row) {
    if (
      !plain(row) ||
      row.version !== 2 ||
      !text(row.scope) ||
      !text(row.sid, 128) ||
      !text(row.reason, 80) ||
      row.key !== key(row.scope, row.sid)
    )
      throw new JournalError('journal-corrupt');
    return row;
  }
  function openDatabase(indexedDB) {
    return new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new JournalError('storage-unavailable'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of ['records', 'issuers', 'holds']) {
          const store = db.createObjectStore(name, { keyPath: 'key' });
          store.createIndex('scope', 'scope');
        }
        db.createObjectStore('legacy', { keyPath: 'key' });
      };
      request.onerror = () => reject(new JournalError('storage-unavailable'));
      request.onblocked = () => reject(new JournalError('storage-busy'));
      request.onsuccess = () => resolve(request.result);
    });
  }
  /** All writes happen in an IDB event task, never after an unrelated await. */
  function transaction(db, scope, mode, body, includeLegacy = false) {
    return new Promise((resolve, reject) => {
      let tx, result, failure;
      try {
        const names = ['records', 'issuers', 'holds', ...(includeLegacy ? ['legacy'] : [])];
        tx = db.transaction(names, mode, { durability: 'strict' });
        if (tx.durability !== 'strict') {
          tx.abort();
          throw new JournalError('strict-storage-unavailable');
        }
        const stores = Object.fromEntries(names.map((name) => [name, tx.objectStore(name)]));
        const requests = {
          records: stores.records.index('scope').getAll(scope, MAX_ROWS + 1),
          issuers: stores.issuers.index('scope').getAll(scope, MAX_ROWS + 1),
          holds: stores.holds.index('scope').getAll(scope, MAX_ROWS + 1),
          legacyHolds: stores.holds.index('scope').getAll(LEGACY, MAX_ROWS + 1),
          ...(includeLegacy ? { legacy: stores.legacy.getAllKeys(undefined, MAX_LEGACY + 1) } : {}),
        };
        let remaining = Object.keys(requests).length;
        const values = {};
        for (const [name, request] of Object.entries(requests))
          request.onsuccess = () => {
            values[name] = request.result;
            if (--remaining !== 0) return;
            try {
              if (
                Object.entries(values).some(([name, rows]) => rows.length > (name === 'legacy' ? MAX_LEGACY : MAX_ROWS))
              )
                throw new JournalError('journal-full');
              values.records.forEach((row) => checkRow(row, scope));
              values.issuers.forEach((row) => checkIssuer(row, scope));
              [...values.holds, ...values.legacyHolds].forEach(checkHold);
              for (const row of values.records) {
                const issuer = values.issuers.find((meta) => meta.issuer === row.issuer);
                if (
                  !issuer ||
                  (['prepared', 'not-issued', 'may-issued', 'pending'].includes(row.phase) &&
                    row.ownerToken !== issuer.token) ||
                  (row.phase === 'unconfirmed' && !blocked(values, row.sid))
                )
                  throw new JournalError('journal-corrupt');
              }
              result = body(stores, values);
            } catch (error) {
              failure = error;
              tx.abort();
            }
          };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => {
          failure ||= new JournalError('storage-unavailable');
        };
        tx.onabort = () => reject(failure || new JournalError('storage-unavailable'));
      } catch {
        reject(new JournalError('storage-unavailable'));
      }
    });
  }
  function acquire(locks, name, availableOnly = true) {
    return new Promise((resolve, reject) => {
      if (!locks?.request) return reject(new JournalError('locks-unavailable'));
      let release,
        active = false;
      const stopped = new Promise((done) => {
        release = done;
      });
      void locks
        .request(name, { mode: 'exclusive', ...(availableOnly ? { ifAvailable: true } : {}) }, async (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          active = true;
          const lease = {
            active: () => active,
            release: () => {
              active = false;
              release();
            },
          };
          resolve(lease);
          try {
            await stopped;
          } finally {
            active = false;
          }
        })
        .catch(() => reject(new JournalError('locks-unavailable')));
    });
  }
  const addHold = (store, scope, sid, reason, values) => {
    const rows = scope === LEGACY ? values.legacyHolds : values.holds;
    if (rows.some((row) => row.sid === '*')) return;
    if (!rows.some((row) => row.sid === sid) && rows.length >= MAX_ROWS - 1) {
      sid = '*';
      reason = 'hold-capacity'; // Reserve one deny-all slot; never evict uncertainty.
    }
    const next = { version: 2, key: key(scope, sid), scope, sid, reason };
    store.put(next);
    const previous = rows.findIndex((row) => row.sid === sid);
    if (previous < 0) rows.push(next);
    else rows[previous] = next;
  };
  const blocked = (rows, sid) => [...rows.holds, ...rows.legacyHolds].some((row) => row.sid === sid || row.sid === '*');
  async function fingerprint(crypto, data, useMux) {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        input: data,
        rawInput: data,
        useMux: useMux === null ? 'default' : useMux ? 'mux' : 'raw',
        ifIdle: false,
        agentInput: false,
      })
    );
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  }
  class Journal {
    #db;
    #identity;
    #page;
    #issuer;
    #leases = new Map();
    #crypto;
    #locks;
    #closed = false;
    #tail = Promise.resolve();
    #channel;
    #attempts = new WeakMap();
    constructor(db, descriptor, options) {
      this.#db = db;
      this.#identity = descriptor;
      this.#crypto = options.crypto;
      this.#locks = options.locks;
      this.#page = nonce(this.#crypto);
      this.#issuer = nonce(this.#crypto);
      this.onChange = options.onChange || (() => {});
      this.#channel = options.BroadcastChannel ? new options.BroadcastChannel(DB_NAME) : null;
      if (this.#channel) this.#channel.onmessage = () => this.onChange();
      db.onversionchange = () => this.close();
    }
    get descriptor() {
      return this.#identity;
    }
    get issuer() {
      return this.#issuer;
    }
    #attemptCurrent(record) {
      return !this.#closed && this.#attempts.get(record)?.lease.active() === true;
    }
    admitted(record) {
      return this.#attemptCurrent(record) && this.#attempts.get(record).phase === 'claimed';
    }
    async dispatch(record, effect) {
      if (!this.admitted(record) || typeof effect !== 'function') return false;
      const attempt = this.#attempts.get(record);
      attempt.phase = 'dispatching'; // Spent before waiting: concurrent calls cannot join/replay it.
      return this.#serial(() =>
        this.#exclusive(async () => {
          const current = await transaction(this.#db, this.#identity.scopeId, 'readonly', (_stores, rows) => {
            const row = rows.records.find((row) => row.key === record.key),
              meta = rows.issuers.find((row) => row.issuer === record.issuer);
            return (
              row?.revision === record.revision &&
              row.phase === 'may-issued' &&
              row.ownerToken === meta?.token &&
              row.data === record.data &&
              row.useMux === record.useMux &&
              row.fingerprint === record.fingerprint &&
              row.epoch === this.#identity.epoch &&
              this.#owned(meta) &&
              !blocked(rows, row.sid)
            );
          });
          if (!current || !this.#attemptCurrent(record)) return false;
          attempt.phase = 'invoked';
          effect(record); // No await between the last guard and the one initial network invocation.
          return true;
        })
      );
    }
    async #exclusive(action) {
      const lease = await acquire(this.#locks, `${DB_NAME}:dispatch`, false);
      if (!lease) throw new JournalError('dispatch-busy');
      try {
        if (this.#closed || !lease.active()) throw new JournalError('journal-closed');
        return await action();
      } finally {
        lease.release();
      }
    }
    #serial(action) {
      const result = this.#tail.then(() => {
        if (this.#closed) throw new JournalError('journal-closed');
        return action();
      });
      this.#tail = result.catch(() => {});
      return result;
    }
    #notify() {
      // Notification is not publication. A closed channel or failed observer
      // cannot turn an already committed record into a known-not-queued result.
      try {
        this.#channel?.postMessage('changed');
      } catch {
        /* Readers refresh independently. */
      }
      try {
        this.onChange();
      } catch {
        /* The actual storage outcome is unchanged. */
      }
    }
    async #lease(issuer) {
      const existing = this.#leases.get(issuer);
      if (existing?.active()) return existing;
      const lease = await acquire(this.#locks, `${DB_NAME}:issuer:${this.#identity.scopeId}:${issuer}`);
      if (lease) this.#leases.set(issuer, lease);
      return lease;
    }
    #owned(meta) {
      const lease = meta && this.#leases.get(meta.issuer);
      return meta?.owner === this.#page && lease?.active() === true && lease.token === meta.token;
    }
    async initialize(legacy) {
      await this.migrateLegacy(legacy);
      await this.restore();
      const lease = await this.#lease(this.#issuer);
      if (!lease) throw new JournalError('issuer-busy');
      const token = nonce(this.#crypto);
      await transaction(this.#db, this.#identity.scopeId, 'readwrite', (stores, rows) => {
        if (rows.issuers.some((row) => row.issuer === this.#issuer)) throw new JournalError('issuer-collision');
        if (rows.issuers.length >= MAX_ROWS) throw new JournalError('journal-full');
        stores.issuers.add({
          version: 2,
          key: key(this.#identity.scopeId, this.#issuer),
          scope: this.#identity.scopeId,
          issuer: this.#issuer,
          owner: this.#page,
          token,
          revision: 1,
          epoch: this.#identity.epoch,
          sequences: [],
        });
      });
      lease.token = token;
      return this;
    }
    async migrateLegacy(legacy) {
      if (!legacy?.raw) return;
      // This lock serializes real new clients; old JavaScript does not obey it.
      const lease = await acquire(this.#locks, `${DB_NAME}:legacy-migration`, false);
      if (!lease) throw new JournalError('legacy-migration-busy');
      try {
        const bytes = new TextEncoder().encode(JSON.stringify([legacy.clientId, legacy.raw]));
        if (bytes.length > 8 * 1024 * 1024) throw new JournalError('legacy-storage-too-large');
        const digest = [...new Uint8Array(await this.#crypto.subtle.digest('SHA-256', bytes))]
          .map((n) => n.toString(16).padStart(2, '0'))
          .join('');
        await this.#exclusive(() =>
          transaction(
            this.#db,
            this.#identity.scopeId,
            'readwrite',
            (stores, rows) => {
              if (!lease.active()) throw new JournalError('custody-changed');
              if (!rows.legacy.includes(digest)) {
                if (rows.legacy.length >= MAX_LEGACY) throw new JournalError('journal-full');
                stores.legacy.add({
                  key: digest,
                  raw: legacy.raw,
                  clientId: legacy.clientId || null,
                  attribution: 'unscoped-unknown',
                });
              }
              let saved;
              try {
                saved = JSON.parse(legacy.raw);
              } catch {
                addHold(stores.holds, LEGACY, '*', 'legacy-corrupt', rows);
                return;
              }
              if (!plain(saved)) {
                addHold(stores.holds, LEGACY, '*', 'legacy-corrupt', rows);
                return;
              }
              if (
                (Array.isArray(saved.heldSessions) && saved.heldSessions.length > MAX_ROWS) ||
                (plain(saved.pending) && Object.keys(saved.pending).length > MAX_ROWS)
              ) {
                addHold(stores.holds, LEGACY, '*', 'legacy-capacity', rows);
                return;
              }
              if (Array.isArray(saved.heldSessions))
                for (const sid of saved.heldSessions) {
                  if (text(sid, 128)) addHold(stores.holds, LEGACY, sid, 'legacy-unconfirmed', rows);
                  else addHold(stores.holds, LEGACY, '*', 'legacy-corrupt', rows);
                }
              else if (own(saved, 'heldSessions')) addHold(stores.holds, LEGACY, '*', 'legacy-corrupt', rows);
              if (plain(saved.pending))
                for (const [sid, records] of Object.entries(saved.pending)) {
                  if (!text(sid, 128) || !Array.isArray(records)) {
                    addHold(stores.holds, LEGACY, '*', 'legacy-corrupt', rows);
                    continue;
                  }
                  if (records.length) addHold(stores.holds, LEGACY, sid, 'legacy-unconfirmed', rows);
                }
              else if (own(saved, 'pending')) addHold(stores.holds, LEGACY, '*', 'legacy-corrupt', rows);
            },
            true
          )
        );
      } finally {
        lease.release();
      }
    }
    async restore() {
      const scope = this.#identity.scopeId;
      const issuers = await transaction(this.#db, scope, 'readonly', (_stores, rows) =>
        rows.issuers.map((row) => row.issuer)
      );
      for (const issuer of issuers) {
        if (issuer === this.#issuer) continue;
        const lease = await this.#lease(issuer);
        if (!lease) continue; // The actual original page is still the sole drainer.
        const token = nonce(this.#crypto);
        const keep = await this.#exclusive(() =>
          transaction(this.#db, scope, 'readwrite', (stores, rows) => {
            if (!lease.active()) throw new JournalError('custody-changed');
            const meta = rows.issuers.find((row) => row.issuer === issuer);
            if (!meta) return false;
            const originals = rows.records.filter((row) => row.issuer === issuer);
            if (originals.every((row) => FINAL.has(row.phase))) {
              for (const row of originals) stores.records.delete(row.key);
              stores.issuers.delete(meta.key);
              return false;
            }
            stores.issuers.put({ ...meta, owner: this.#page, token, revision: nextRevision(meta.revision) });
            let prepared = false;
            for (const row of rows.records.filter((row) => row.issuer === issuer && !FINAL.has(row.phase))) {
              if (
                this.#identity.kind === 'anonymous' ||
                row.epoch !== this.#identity.epoch ||
                !['prepared', 'not-issued'].includes(row.phase)
              ) {
                stores.records.put({ ...row, phase: 'unconfirmed', revision: nextRevision(row.revision) });
                addHold(
                  stores.holds,
                  scope,
                  row.sid,
                  this.#identity.kind === 'anonymous' ? 'anonymous-restored' : 'restored-unconfirmed',
                  rows
                );
              } else {
                stores.records.put({ ...row, ownerToken: token, revision: nextRevision(row.revision) });
                prepared = true;
              }
            }
            return prepared;
          })
        );
        lease.token = token;
        if (!keep) {
          lease.release();
          this.#leases.delete(issuer);
        }
      }
    }
    async snapshot() {
      return this.#serial(() =>
        transaction(this.#db, this.#identity.scopeId, 'readonly', (_stores, rows) => ({
          records: rows.records
            .filter(
              (row) => !FINAL.has(row.phase) && this.#owned(rows.issuers.find((meta) => meta.issuer === row.issuer))
            )
            .map((row) => Object.freeze({ ...row })),
          retained: rows.records
            .filter(
              (row) => !FINAL.has(row.phase) && !this.#owned(rows.issuers.find((meta) => meta.issuer === row.issuer))
            )
            .map((row) => Object.freeze({ ...row })),
          holds: [...rows.holds, ...rows.legacyHolds].map((row) => ({ sid: row.sid, reason: row.reason })),
        }))
      );
    }
    accept(sid, frames, useMux = null, reservation = null) {
      if (
        !text(sid, 128) ||
        sid === '*' ||
        !Array.isArray(frames) ||
        !frames.length ||
        frames.length > MAX_ROWS ||
        frames.some((data) => typeof data !== 'string' || !data.length || data.length > FRAME_CHARS) ||
        frames.reduce((n, data) => n + data.length, 0) > 1024 * 1024 ||
        ![null, true, false].includes(useMux)
      )
        return Promise.resolve({ kind: 'not-queued', reason: 'invalid-input' });
      const owned = !reservation;
      reservation ||= intake.batch(
        sid,
        frames.reduce((n, frame) => n + frame.length, 0),
        frames.length
      );
      if (
        !reservation ||
        !intake.bound(this) ||
        !nativeIntake.claimStorage(
          reservation,
          sid,
          frames.reduce((n, frame) => n + frame.length, 0),
          frames.length
        )
      ) {
        if (owned) intake.finish(reservation, false);
        return Promise.resolve({ kind: 'not-queued', reason: 'intake-capacity' });
      }
      frames = [...frames];
      const result = this.#serial(async () => {
        if (
          !text(sid, 128) ||
          sid === '*' ||
          !Array.isArray(frames) ||
          !frames.length ||
          frames.length > MAX_ROWS ||
          frames.some((data) => typeof data !== 'string' || !data.length || data.length > FRAME_CHARS) ||
          frames.reduce((n, data) => n + data.length, 0) > 1024 * 1024 ||
          ![null, true, false].includes(useMux)
        )
          return { kind: 'not-queued', reason: 'invalid-input' };
        try {
          const fingerprints = await Promise.all(frames.map((data) => fingerprint(this.#crypto, data, useMux)));
          const records = await transaction(this.#db, this.#identity.scopeId, 'readwrite', (stores, rows) => {
            if (blocked(rows, sid)) throw new JournalError('input-held');
            const meta = rows.issuers.find((row) => row.issuer === this.#issuer);
            if (!this.#owned(meta) || meta.epoch !== this.#identity.epoch) throw new JournalError('custody-changed');
            for (const row of rows.records.filter((row) => FINAL.has(row.phase))) stores.records.delete(row.key);
            const pending = rows.records.filter((row) => !FINAL.has(row.phase));
            if (
              pending.length + frames.length > MAX_ROWS ||
              pending.reduce((n, row) => n + row.data.length, 0) + frames.reduce((n, data) => n + data.length, 0) >
                MAX_CHARS
            )
              throw new JournalError('journal-full');
            const previous = meta.sequences.find((pair) => pair[0] === sid)?.[1] || 0;
            if (!meta.sequences.some((pair) => pair[0] === sid) && meta.sequences.length >= MAX_ROWS)
              throw new JournalError('journal-full');
            if (!Number.isSafeInteger(previous + frames.length)) throw new JournalError('sequence-exhausted');
            const records = frames.map((data, i) => ({
              version: 2,
              key: key(this.#identity.scopeId, this.#issuer, sid, previous + i + 1),
              scope: this.#identity.scopeId,
              issuer: this.#issuer,
              sid,
              seq: previous + i + 1,
              data,
              useMux,
              epoch: this.#identity.epoch,
              ownerToken: meta.token,
              phase: 'prepared',
              revision: 1,
              createdAt: Date.now(),
              fingerprint: fingerprints[i],
            }));
            for (const row of records) stores.records.add(row);
            stores.issuers.put({
              ...meta,
              revision: nextRevision(meta.revision),
              sequences: [...meta.sequences.filter((pair) => pair[0] !== sid), [sid, previous + frames.length]],
            });
            return records;
          });
          this.#notify();
          return { kind: 'accepted', records: records.map((row) => Object.freeze(row)) };
        } catch (error) {
          return { kind: 'not-queued', reason: error.reason || 'storage-unavailable' };
        }
      });
      return result.then(
        (value) => {
          nativeIntake.settled(reservation, value.kind === 'accepted');
          if (owned) intake.finish(reservation, value.kind === 'accepted');
          return value;
        },
        (error) => {
          nativeIntake.settled(reservation, false);
          if (owned) intake.finish(reservation, false);
          throw error;
        }
      );
    }
    claim(record) {
      return this.#serial(async () => {
        const expected = await fingerprint(this.#crypto, record.data, record.useMux);
        const row = await transaction(this.#db, this.#identity.scopeId, 'readwrite', (stores, rows) => {
          const found = rows.records.find((row) => row.key === record.key),
            meta = rows.issuers.find((row) => row.issuer === record.issuer);
          if (
            !found ||
            found.revision !== record.revision ||
            !['prepared', 'not-issued'].includes(found.phase) ||
            !this.#owned(meta) ||
            found.data !== record.data ||
            found.useMux !== record.useMux ||
            found.fingerprint !== expected ||
            found.ownerToken !== meta.token ||
            found.epoch !== this.#identity.epoch ||
            blocked(rows, found.sid)
          )
            return null;
          const next = { ...found, phase: 'may-issued', revision: nextRevision(found.revision) };
          stores.records.put(next);
          return next;
        });
        if (!row) return null;
        const result = Object.freeze(row),
          lease = this.#leases.get(row.issuer);
        if (this.#closed || !lease?.active()) return null;
        this.#attempts.set(result, { lease, phase: 'claimed' });
        this.#notify();
        return result;
      });
    }
    settle(record, phase) {
      return this.#serial(async () => {
        if (!['pending', 'confirmed', 'typed-unsent', 'unconfirmed', 'not-issued'].includes(phase))
          throw new JournalError('invalid-transition');
        if (
          !this.#attemptCurrent(record) ||
          (phase !== 'unconfirmed' && this.#attempts.get(record).phase !== 'invoked')
        )
          return null;
        const result = await this.#exclusive(() =>
          transaction(this.#db, this.#identity.scopeId, 'readwrite', (stores, rows) => {
            const found = rows.records.find((row) => row.key === record.key),
              meta = rows.issuers.find((row) => row.issuer === record.issuer);
            if (
              !found ||
              found.revision !== record.revision ||
              !['may-issued', 'pending'].includes(found.phase) ||
              !this.#owned(meta) ||
              found.ownerToken !== meta.token
            )
              return null;
            const next = { ...found, phase, revision: nextRevision(found.revision) };
            stores.records.put(next);
            if (phase === 'unconfirmed')
              addHold(stores.holds, this.#identity.scopeId, found.sid, 'input-unconfirmed', rows);
            return next;
          })
        );
        if (!result) return null;
        const frozen = Object.freeze(result);
        if (phase === 'pending') this.#attempts.set(frozen, this.#attempts.get(record));
        this.#attempts.delete(record);
        this.#notify();
        return frozen;
      });
    }
    hold(sid, reason = 'server-unconfirmed') {
      return this.#serial(async () => {
        if (!text(sid, 128)) throw new JournalError('invalid-input');
        await this.#exclusive(() =>
          transaction(this.#db, this.#identity.scopeId, 'readwrite', (stores, rows) =>
            addHold(stores.holds, this.#identity.scopeId, sid, reason, rows)
          )
        );
        this.#notify();
      });
    }
    close() {
      if (this.#closed) return;
      this.#closed = true;
      for (const lease of this.#leases.values()) lease.release();
      this.#leases.clear();
      this.#channel?.close();
      this.#db.close();
    }
  }
  async function open(descriptor, options = {}) {
    const parsed = identity(descriptor);
    const deps = {
      indexedDB: globalThis.indexedDB,
      locks: globalThis.navigator?.locks,
      crypto: globalThis.crypto,
      BroadcastChannel: globalThis.BroadcastChannel,
      ...options,
    };
    const db = await openDatabase(deps.indexedDB);
    const journal = new Journal(db, parsed, deps);
    try {
      intake.bind(journal);
      return await journal.initialize(deps.legacy);
    } catch (error) {
      journal.close();
      throw error;
    }
  }
  window.ReverieInputJournal = Object.freeze({
    open,
    parseIdentity: identity,
    createPageId: () => nonce(globalThis.crypto),
    JournalError,
    intake,
  });
})();
