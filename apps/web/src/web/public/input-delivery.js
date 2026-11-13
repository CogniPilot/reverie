/** Durable browser input transport. Storage acceptance is distinct from delivery. */
(() => {
  'use strict';
  const sameIdentity = (a, b) => a.kind === b.kind && a.scopeId === b.scopeId && a.epoch === b.epoch;
  const final = (phase) => phase === 'confirmed' || phase === 'typed-unsent';
  const receiptOwner = Symbol('input-receipt-owner');
  const rawIntake = Symbol('raw-input-custody');
  const acceptanceReservation = Symbol('input-capacity-reservation');
  const receiptOwners = new WeakMap();
  const orphanedEditorReceipts = new WeakSet();
  Object.assign(ReverieApp.prototype, {
    async _readInputIdentity() {
      const response = await fetch('/api/input-identity', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const payload = await response.json();
      if (!response.ok || payload?.success !== true) throw new Error('Input identity could not be verified');
      return window.ReverieInputJournal.parseIdentity(payload.data);
    },

    _loadReliableState() {
      if (this._inputJournalReady) return this._inputJournalReady;
      this._inputFlights = new Map();
      this._inputOutcomes = new Map();
      this._inputDrainTasks = new Map();
      this._inputAcceptTail = Promise.resolve();
      this._inputHoldWrites = new Set();
      this._inputRetryAt = new Map();
      this._pendingDeliveries = new Map();
      this._unsavedInputDrafts = [];
      window.ReverieInputJournal.intake.observe(() => {
        // A projection of the one module-owned ledger, not a second custody owner.
        this._unsavedInputDrafts = [
          ...this._unsavedInputDrafts.filter((row) => row.kind === 'local-draft'),
          ...window.ReverieInputJournal.intake.snapshot().copies,
        ];
        this._syncRawInputAvailability();
        this._renderInputRecoveryBanner?.();
        this._renderUnqueuedInput();
      });
      let legacy,
        legacyUnavailable = false;
      // Device/SSE identity is deliberately unrelated to an input issuer.
      try {
        legacy = {
          raw: localStorage.getItem('reverie:pendingInput'),
          clientId: localStorage.getItem('reverie:clientId'),
        };
        this._clientId = legacy.clientId || window.ReverieInputJournal.createPageId();
        if (!localStorage.getItem('reverie:clientId')) localStorage.setItem('reverie:clientId', this._clientId);
      } catch {
        this._clientId = window.ReverieInputJournal.createPageId();
        legacyUnavailable = true;
      }
      this._inputJournalReady = (async () => {
        try {
          if (legacyUnavailable) throw new Error('Previous input storage could not be read');
          const descriptor = await this._readInputIdentity();
          this._inputJournal = await window.ReverieInputJournal.open(descriptor, {
            legacy,
            onChange: () => {
              void this._refreshInputJournal().catch(() => this._inputStorageFailed());
            },
          });
          await this._persistReliableNow();
          await this._refreshInputJournal();
          return true;
        } catch {
          this._inputStorageFailed();
          return false;
        }
      })();
      return this._inputJournalReady;
    },

    _inputStorageFailed() {
      this._inputStorageUnavailable = true;
      // Stop future physical xterm events; the event whose transaction failed
      // is retained below. Editable composer/IME drafts remain editable.
      if (this.terminal?.options) this.terminal.options.disableStdin = true;
      this._forEachTile?.((tile) => {
        if (tile.terminal?.options) tile.terminal.options.disableStdin = true;
      });
      this._renderInputStorageFailure();
      this._renderUnqueuedInput();
      try {
        this.showToast?.(
          'Browser input storage is unavailable. Sending is paused; keep or copy your draft before reloading.',
          'error'
        );
      } catch {
        /* Never change a storage outcome because a notification failed. */
      }
    },

    _renderInputStorageFailure() {
      const banner = document.getElementById?.('inputRecoveryBar');
      if (!banner) return;
      if (banner.dataset.storageFailure !== 'true') {
        banner.replaceChildren();
        banner.dataset.storageFailure = 'true';
        const message = document.createElement('div');
        message.className = 'input-recovery-message';
        message.setAttribute('role', 'alert');
        const title = document.createElement('strong');
        title.textContent = 'Browser input storage unavailable — terminal is read-only';
        const detail = document.createElement('span');
        detail.textContent =
          'Sending is paused. Copy your unqueued text and editable drafts before reloading. No automatic retry will be made.';
        message.append(title, detail);
        banner.append(message);
      }
      banner.hidden = false;
    },

    _noteInputReloadRequired(sid) {
      this._inputReloadRequired ||= new Set();
      this._inputReloadRequired.add(sid);
      this._holdInputRecovery(sid);
      const reason = document.getElementById?.('inputRecoveryBar')?.querySelector('.input-recovery-message span');
      if (sid === this.activeSessionId && reason)
        reason.textContent =
          'Reload this browser to update input handling. Unconfirmed input is retained and will not be sent again.';
      this.showToast?.('Browser update required. Copy any unqueued draft before reloading.', 'warning');
    },

    _retainUnqueuedInput(sid, text) {
      // An xterm onData event has no editable DOM draft. Keep its exact bytes
      // available for copying; this list is never automatically dispatched.
      window.ReverieInputJournal.intake.retain(sid, text);
      this._syncRawInputAvailability();
      this._renderUnqueuedInput();
    },

    _retainEditorDraft(sid, overlay, receipt, requireErasure = false) {
      const text = overlay?.recoverDraftText?.(receipt, requireErasure);
      if (typeof text !== 'string' || !text || orphanedEditorReceipts.has(receipt)) return;
      orphanedEditorReceipts.add(receipt);
      this._unsavedInputDrafts ||= [];
      this._unsavedInputDrafts.push({ sid, text, kind: 'local-draft' });
      // A read-only recovery copy grants no input authority and does not pause a replacement widget.
      this._renderUnqueuedInput();
    },

    _rawInputBlocked(sid) {
      return (
        typeof sid !== 'string' ||
        !sid ||
        this._inputStorageUnavailable === true ||
        window.ReverieInputJournal.intake.rawBlocked(sid) ||
        window.ReverieInputJournal.intake.pending(sid) ||
        this._rawInputPaused?.has(sid) === true ||
        this._sessionInputHeld(sid)
      );
    },

    _syncRawInputAvailability() {
      if (this.terminal?.options) this.terminal.options.disableStdin = this._rawInputBlocked(this.activeSessionId);
      this._forEachTile?.((tile) => {
        if (tile.terminal?.options) tile.terminal.options.disableStdin = this._rawInputBlocked(tile.sessionId);
      });
    },

    /** One original raw buffer. Selection and replacement never change its SID. */
    _createRawInputBuffer(sessionId, changed = () => {}) {
      const app = this;
      const intake = window.ReverieInputJournal.intake;
      let data = '',
        reservations = [],
        task = null,
        revision = 0;
      const owner = Object.freeze({
        sessionId,
        get data() {
          return data;
        },
        get revision() {
          return revision;
        },
        append(text) {
          if (typeof text !== 'string' || !text) return false;
          if (app._rawInputBlocked(sessionId)) return false;
          const reservation = intake.reserve(sessionId, text.length, Math.ceil(text.length / 65536));
          if (!reservation) {
            intake.captureOverflow(sessionId, text);
            return false;
          }
          reservations.push(reservation);
          data += text;
          revision++;
          changed(owner);
          return true;
        },
        flush() {
          if (task) return task;
          if (!data) return Promise.resolve(true);
          const original = data;
          const raw = intake.rawBuffer(reservations, sessionId, original);
          if (!raw) throw new Error('Original raw input reservation is unavailable');
          reservations = [];
          task = (async () => {
            let accepted = false;
            try {
              accepted = await app._sendInputAsync(sessionId, original, { [rawIntake]: raw });
            } catch {
              app._inputStorageFailed();
            }
            intake.completeRaw(raw, accepted);
            if (accepted) data = data.slice(original.length);
            else {
              const tail = data.slice(original.length);
              if (tail) {
                const remaining = intake.rawBuffer(reservations, sessionId, tail);
                if (!remaining) throw new Error('Original raw tail reservation is unavailable');
                intake.completeRaw(remaining, false);
              }
              reservations = [];
              data = '';
            }
            changed(owner);
            return accepted;
          })().finally(() => {
            task = null;
            if (data)
              queueMicrotask(() => {
                void owner.flush();
              });
          });
          return task;
        },
      });
      return owner;
    },

    _performRawInput(sid, text, action) {
      return window.ReverieInputJournal.intake
        .performRaw(sid, text, (raw) => action(raw, sid))
        .catch(() => {
          this._inputStorageFailed();
          return false;
        });
    },

    _sendRawInput(sid, text, raw) {
      return this._sendInputAsync(sid, text, { [rawIntake]: raw });
    },

    _renderInputIntake() {
      const banner = document.getElementById?.('inputRecoveryBar');
      if (!banner) return;
      const pending = window.ReverieInputJournal.intake.snapshot().pending;
      let notice = banner.querySelector('[data-input-acceptance-pending]');
      if (!pending.length) {
        notice?.remove();
        return;
      }
      if (!notice) {
        notice = document.createElement('div');
        notice.dataset.inputAcceptancePending = 'true';
        notice.className = 'input-recovery-message';
        notice.setAttribute('role', 'status');
        notice.setAttribute('aria-live', 'polite');
        notice.append(document.createElement('strong'), document.createElement('span'));
        banner.append(notice);
      }
      notice.querySelector('strong').textContent = pending.every((row) => row.accepted)
        ? 'Local input stored — status refresh is still pending'
        : 'Local input acceptance is still pending';
      notice.querySelector('span').textContent =
        'The original operation is still being checked. It may complete or restore after reload. Do not submit another copy.';
      banner.hidden = false;
    },

    _renderUnqueuedInput() {
      if (this._inputStorageUnavailable) this._renderInputStorageFailure();
      this._renderInputIntake();
      const banner = document.getElementById?.('inputRecoveryBar');
      if (!banner || !this._unsavedInputDrafts?.length) return;
      const allRaw = this._unsavedInputDrafts.filter((row) => row.kind !== 'local-draft');
      const raw = allRaw.filter((row) => row.sid === this.activeSessionId);
      let field = banner.querySelector('[data-unqueued-input]');
      if (allRaw.length && !field) {
        const label = document.createElement('label');
        label.textContent = 'Raw input paused — copy this unqueued draft before reloading';
        field = document.createElement('textarea');
        field.dataset.unqueuedInput = 'true';
        field.readOnly = true;
        label.append(field);
        banner.append(label);
      }
      if (field) {
        field.value = raw.map((row) => row.text).join('');
        if (field.parentElement?.firstChild)
          field.parentElement.firstChild.textContent = raw.length
            ? 'Raw input paused — copy this unqueued draft before reloading'
            : 'Raw input paused in original session ' +
              [...new Set(allRaw.map((row) => row.sid))].join(', ') +
              ' — select it to copy';
      }
      const recovered = this._unsavedInputDrafts.filter((row) => row.kind === 'local-draft');
      let copies = banner.querySelector('[data-local-editor-drafts]');
      if (recovered.length) {
        if (!copies) {
          copies = document.createElement('div');
          copies.dataset.localEditorDrafts = 'true';
          banner.append(copies);
        }
        copies.replaceChildren();
        for (const row of recovered) {
          const label = document.createElement('label');
          label.textContent = 'Recovered local draft — check terminal before using · ' + row.sid;
          const copy = document.createElement('textarea');
          copy.dataset.localEditorDraft = 'true';
          copy.dataset.originalSessionId = row.sid;
          copy.readOnly = true;
          copy.value = row.text;
          label.append(copy);
          copies.append(label);
        }
      }
      if (allRaw.length || recovered.length) banner.hidden = false;
    },

    async _refreshInputJournal() {
      if (!this._inputJournal) return;
      const snapshot = await this._inputJournal.snapshot();
      const pending = new Map();
      for (const record of snapshot.records) {
        if (final(record.phase)) continue;
        const list = pending.get(record.sid) || [];
        list.push(record);
        pending.set(record.sid, list);
      }
      for (const list of pending.values())
        list.sort(
          (a, b) =>
            Number(a.issuer === this._inputJournal.issuer) - Number(b.issuer === this._inputJournal.issuer) ||
            a.createdAt - b.createdAt ||
            a.issuer.localeCompare(b.issuer) ||
            a.seq - b.seq
        );
      this._pendingDeliveries = pending;
      this._inputRecoveryHolds ||= new Set();
      for (const hold of snapshot.holds) {
        if (hold.sid === '*') this._inputGlobalHold = true;
        else this._inputRecoveryHolds.add(hold.sid);
      }
      this._renderInputRecoveryBanner?.();
      this._renderUnqueuedInput();
      this._updateConnectionIndicator?.();
    },

    async _verifyInputIdentity() {
      const descriptor = await this._readInputIdentity();
      if (!this._inputJournal || !sameIdentity(descriptor, this._inputJournal.descriptor))
        throw new Error('Input identity changed');
    },

    _sendInputAsync(sid, input, opts) {
      const intake = window.ReverieInputJournal.intake;
      const selectedMux = opts && Object.prototype.hasOwnProperty.call(opts, 'useMux') ? opts.useMux : null;
      if (!sid || typeof input !== 'string' || !input || ![null, true, false].includes(selectedMux))
        return Promise.resolve(false);
      const max =
        selectedMux === true
          ? (window.ReverieInputLimit?.FRAME_MAX_CHARS ?? 65536)
          : (window.ReverieInputLimit?.PASTE_MAX_CHARS ?? 1048576);
      if (input.length > max) {
        this.showToast?.('Input too large; text has not been queued.', 'error');
        return Promise.resolve(false);
      }
      if (opts?.frames !== undefined) {
        let offset = 0;
        if (
          !Array.isArray(opts.frames) ||
          opts.frames.length > 4096 ||
          !opts.frames.length ||
          !opts.frames.every((frame) => {
            if (typeof frame !== 'string' || !frame || frame.length > 65536 || !input.startsWith(frame, offset))
              return false;
            offset += frame.length;
            return true;
          }) ||
          offset !== input.length
        )
          return Promise.resolve(false);
      }
      const reservation = intake.queue(
        sid,
        input.length,
        // The existing splitter may shorten a frame by one UTF-16 unit to keep a surrogate pair intact.
        Array.isArray(opts?.frames) ? opts.frames.length : Math.ceil(input.length / 65535),
        opts?.[acceptanceReservation],
        opts?.[rawIntake]
      );
      if (!reservation) {
        this.showToast?.(
          intake.pending(sid)
            ? 'Original input acceptance is still pending. Keep your new draft; no new operation was queued.'
            : 'Browser input capacity is full. Keep your editable draft; no new operation was queued.',
          'warning'
        );
        return Promise.resolve(false);
      }
      const selectedFrames = Array.isArray(opts?.frames) ? [...opts.frames] : undefined;
      const action = async () => {
        if (!sid || typeof input !== 'string' || !input || this._sessionInputHeld(sid) || this._inputGlobalHold)
          return false;
        if (!(await this._inputJournalReady) || this._inputStorageUnavailable) return false;
        const limit = window.ReverieInputLimit;
        const mux = selectedMux;
        if (![null, true, false].includes(mux)) return false;
        const max = mux === true ? (limit?.FRAME_MAX_CHARS ?? 65536) : (limit?.PASTE_MAX_CHARS ?? 1048576);
        if (input.length > max) {
          this.showToast?.('Input too large; text has not been queued.', 'error');
          return false;
        }
        let committed = false;
        try {
          await this._verifyInputIdentity();
          await this._persistReliableNow();
          if (this._sessionInputHeld(sid) || this._inputGlobalHold) return false;
          const frames =
            selectedFrames || (input.length > (limit?.FRAME_MAX_CHARS ?? 65536) ? limit.split(input) : [input]);
          if (
            !Array.isArray(frames) ||
            frames.join('') !== input ||
            frames.some(
              (frame) => typeof frame !== 'string' || !frame || frame.length > (limit?.FRAME_MAX_CHARS ?? 65536)
            )
          )
            return false;
          const result = await this._inputJournal.accept(sid, frames, mux, reservation);
          if (result.kind !== 'accepted') {
            if (result.reason === 'input-held') this._holdInputRecovery(sid);
            else if (result.reason === 'storage-unavailable' || result.reason === 'journal-corrupt')
              this._inputStorageFailed();
            else this.showToast?.('Input was not queued. Keep your draft and check browser input storage.', 'warning');
            return false;
          }
          committed = true;
          const receipt = receiptOwners.get(opts?.[receiptOwner]);
          if (receipt && receipt.app === this && receipt.sid === sid) {
            receipt.records = result.records;
            receipt.identity = this._inputJournal.descriptor;
          }
          try {
            await this._refreshInputJournal();
            void this._drainSession(sid);
          } catch {
            this._inputStorageFailed();
            this._holdInputRecovery(sid);
          }
          return true; // Only the complete storage transaction is acknowledged here.
        } catch {
          this._inputStorageFailed();
          return committed;
        }
      };
      const result = (this._inputAcceptTail || Promise.resolve()).then(action).then(
        (accepted) => {
          intake.finish(reservation, accepted);
          return accepted;
        },
        (error) => {
          intake.finish(reservation, false);
          throw error;
        }
      );
      this._inputAcceptTail = result.catch(() => false);
      return result;
    },

    _reliableSend(sid, data, useMux) {
      return this._sendInputAsync(sid, data, { useMux });
    },
    _queueInputFrames(sid, frames, useMux = null, raw) {
      if (
        !Array.isArray(frames) ||
        !frames.length ||
        frames.length > 4096 ||
        frames.some((frame) => typeof frame !== 'string' || !frame || frame.length > 65536)
      )
        return Promise.resolve(false);
      const reservation = window.ReverieInputJournal.intake.batch(
        sid,
        frames.reduce((n, frame) => n + frame.length, 0),
        frames.length,
        raw
      );
      if (!reservation) return Promise.resolve(false);
      const copy = [...frames];
      const result = this._sendInputAsync(sid, copy.join(''), {
        ...(useMux === null ? {} : { useMux }),
        frames: copy,
        [acceptanceReservation]: reservation,
      });
      // Early public-input validation may refuse before entering the async tail.
      return result.then((accepted) => {
        window.ReverieInputJournal.intake.finish(reservation, accepted);
        return accepted;
      });
    },

    async _queueOverlayInput(sid, text) {
      const owner = Object.freeze({});
      receiptOwners.set(owner, { app: this, sid, records: null, identity: this._inputJournal?.descriptor });
      if (!(await this._sendInputAsync(sid, text, { [receiptOwner]: owner }))) return null;
      const receipt = receiptOwners.get(owner);
      if (!receipt?.records?.length || !receipt.identity) return null;
      this._overlayDeliveryOwners ||= new Map();
      const owners = this._overlayDeliveryOwners.get(sid) || new Set();
      owners.add(owner);
      this._overlayDeliveryOwners.set(sid, owners);
      return owner;
    },

    async _confirmOverlayInput(sid) {
      const owners = this._overlayDeliveryOwners?.get(sid);
      if (!owners?.size) return true;
      try {
        await this._verifyInputIdentity();
        void this._drainSession(sid);
        for (const owner of [...owners]) {
          const receipt = receiptOwners.get(owner);
          if (
            !receipt ||
            receipt.app !== this ||
            receipt.sid !== sid ||
            !sameIdentity(receipt.identity, this._inputJournal.descriptor)
          )
            return false;
          for (const record of receipt.records) {
            const queued = this._pendingDeliveries.get(sid)?.find((row) => row.key === record.key);
            if (queued) {
              this.showToast?.(
                'Earlier text remains queued. Try this key again after delivery is confirmed.',
                'warning'
              );
              return false;
            }
            const state = await this._inspectInputRecord(record);
            if (state !== 'confirmed') {
              if (state !== 'pending') this._holdInputRecovery(sid);
              this.showToast?.(
                'Earlier text is not confirmed. Check the terminal before trying this key again.',
                'warning'
              );
              return false;
            }
            await this._queueInputOutcome(sid, () =>
              this._inputFlights.get(sid)?.record.key === record.key ? this._settleInput(sid, 'confirmed') : undefined
            );
          }
          owners.delete(owner);
        }
        return !this._sessionInputHeld(sid);
      } catch {
        this._holdInputRecovery(sid);
        return false;
      }
    },

    async _inspectInputRecord(original) {
      const query = new URLSearchParams({
        clientId: original.issuer,
        seq: String(original.seq),
        fingerprint: original.fingerprint,
      });
      const response = await fetch(`/api/sessions/${encodeURIComponent(original.sid)}/input-receipt?${query}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json(),
        data = body?.data;
      if (
        !response.ok ||
        body?.success !== true ||
        data?.version !== 1 ||
        data.clientId !== original.issuer ||
        data.seq !== original.seq ||
        data.fingerprint !== original.fingerprint ||
        !['confirmed', 'pending', 'typed-unsent', 'held', 'unknown'].includes(data.state)
      )
        throw new Error('Receipt unavailable');
      return data.state;
    },

    _drainSession(sid) {
      if (this._inputDrainTasks?.has(sid)) return this._inputDrainTasks.get(sid);
      const task = (async () => {
        if (
          !(await this._inputJournalReady) ||
          this._sessionInputHeld(sid) ||
          this._inputGlobalHold ||
          this._inputStorageUnavailable
        )
          return;
        if ((this._inputRetryAt.get(sid) || 0) > Date.now()) return;
        await this._persistReliableNow();
        if (this._inputStorageUnavailable) return;
        if (this._inputFlights.has(sid)) {
          await this._readInputReceipt(sid);
          return;
        }
        await this._refreshInputJournal();
        const record = this._pendingDeliveries.get(sid)?.[0];
        if (!record) return;
        if (!['prepared', 'not-issued'].includes(record.phase)) {
          this._holdInputRecovery(sid);
          return;
        }
        try {
          await this._verifyInputIdentity();
          if (this._sessionInputHeld(sid) || this._inputGlobalHold || this._inputStorageUnavailable) return;
          const claimed = await this._inputJournal.claim(record);
          if (!claimed) return;
          const flight = { record: claimed, transport: 'http' };
          this._inputFlights.set(sid, flight);
          // Authentication may have changed during the durable may-issued commit.
          await this._verifyInputIdentity();
          if (this._sessionInputHeld(sid) || this._inputGlobalHold) throw new Error('Input held');
          const socket = claimed.issuer === this._inputJournal.issuer ? this._inputSocketFor(sid) : null;
          if (socket) {
            flight.transport = 'ws';
            flight.socket = socket.ws;
            const dispatched = await this._inputJournal.dispatch(claimed, () => {
              if (
                this._sessionInputHeld(sid) ||
                this._inputGlobalHold ||
                this._inputStorageUnavailable ||
                this._inputFlights.get(sid) !== flight
              )
                throw new Error('Input admission changed before transport');
              socket.ws.send(
                JSON.stringify({
                  t: 'i',
                  d: claimed.data,
                  seq: claimed.seq,
                  cid: claimed.issuer,
                  ...(claimed.useMux === null ? {} : { useMux: claimed.useMux }),
                })
              );
            });
            if (!dispatched) throw new Error('Input custody changed');
            this._inputRetryAt.set(sid, Date.now() + 1000);
          } else {
            let response;
            const dispatched = await this._inputJournal.dispatch(claimed, () => {
              if (
                this._sessionInputHeld(sid) ||
                this._inputGlobalHold ||
                this._inputStorageUnavailable ||
                this._inputFlights.get(sid) !== flight
              )
                throw new Error('Input admission changed before transport');
              response = fetch(`/api/sessions/${encodeURIComponent(sid)}/input`, {
                method: 'POST',
                signal: AbortSignal.timeout(10000),
                headers: { 'Content-Type': 'application/json', 'X-Reverie-Input-Protocol': '2' },
                body: JSON.stringify({
                  input: claimed.data,
                  clientId: claimed.issuer,
                  seq: claimed.seq,
                  ...(claimed.useMux === null ? {} : { useMux: claimed.useMux }),
                }),
              });
            });
            if (!dispatched) throw new Error('Input custody changed');
            const result = await response;
            await this._queueInputOutcome(sid, () =>
              this._inputFlights.get(sid) === flight ? this._receiveInputResponse(sid, result) : undefined
            );
          }
        } catch {
          // Failure after may-issued is never permission to send the input again.
          if (this._inputFlights.has(sid))
            await this._queueInputOutcome(sid, () => this._settleInput(sid, 'unconfirmed'));
          else this._holdInputRecovery(sid);
        }
      })()
        .catch(() => {
          this._holdInputRecovery(sid);
        })
        .finally(() => this._inputDrainTasks.delete(sid));
      this._inputDrainTasks.set(sid, task);
      return task;
    },

    _queueInputOutcome(sid, action) {
      const result = (this._inputOutcomes.get(sid) || Promise.resolve()).then(action);
      this._inputOutcomes.set(
        sid,
        result.catch(() => {
          this._holdInputRecovery(sid);
        })
      );
      return result;
    },

    async _settleInput(sid, phase) {
      const flight = this._inputFlights.get(sid);
      if (!flight) return;
      if (this._sessionInputHeld(sid)) phase = 'unconfirmed';
      const next = await this._inputJournal.settle(flight.record, phase);
      if (!next) {
        this._holdInputRecovery(sid);
        return;
      }
      if (phase === 'pending') flight.record = next;
      else this._inputFlights.delete(sid);
      if (phase === 'unconfirmed') this._holdInputRecovery(sid);
      if (phase === 'confirmed') this.markIdleAlertSeen?.(sid);
      if (phase === 'typed-unsent')
        this.showToast?.('Text was typed but Enter was withheld. Check the terminal before submitting.', 'warning');
      this._inputRetryAt.set(sid, Date.now() + (['pending', 'not-issued'].includes(phase) ? 1000 : 80));
      await this._refreshInputJournal();
      if (final(phase))
        setTimeout(() => {
          void this._drainSession(sid);
        }, 80);
    },

    async _receiveInputResponse(sid, response) {
      let body;
      try {
        body = await response.json();
      } catch {
        return this._settleInput(sid, 'unconfirmed');
      }
      const data = body?.data;
      if (body?.reloadRequired === true || data?.reloadRequired === true) this._noteInputReloadRequired(sid);
      if (
        body?.recoveryRequired === true ||
        data?.recoveryRequired === true ||
        data?.held === true ||
        data?.unconfirmed === true ||
        this._sessionInputHeld(sid)
      )
        return this._settleInput(sid, 'unconfirmed');
      if (data?.typedUnsent === true && data.delivered === false && data.confirmed !== true && data.pending !== true)
        return this._settleInput(
          sid,
          (response.ok && body?.success === true) ||
            (response.status === 409 && body?.success === false && body.errorCode === 'SESSION_BUSY')
            ? 'typed-unsent'
            : 'unconfirmed'
        );
      if (
        response.status === 409 &&
        body?.success === false &&
        body.errorCode === 'SESSION_BUSY' &&
        data?.delivered === false &&
        data.typedUnsent !== true &&
        data.confirmed !== true &&
        data.pending !== true
      )
        return this._settleInput(sid, 'not-issued');
      if (response.ok && body?.success === true && data?.pending === true && Object.keys(data).length === 1)
        return this._settleInput(sid, 'pending');
      if (response.ok && body?.success === true && data && Object.keys(data).length === 0)
        return this._settleInput(sid, 'confirmed');
      return this._settleInput(sid, 'unconfirmed');
    },

    async _readInputReceipt(sid) {
      const flight = this._inputFlights.get(sid);
      if (!flight || (this._inputRetryAt.get(sid) || 0) > Date.now()) return;
      this._inputRetryAt.set(sid, Date.now() + 1000);
      try {
        await this._verifyInputIdentity();
        const state = await this._inspectInputRecord(flight.record);
        await this._queueInputOutcome(sid, () =>
          this._inputFlights.get(sid) === flight
            ? this._settleInput(sid, ['held', 'unknown'].includes(state) ? 'unconfirmed' : state)
            : undefined
        );
      } catch {
        await this._queueInputOutcome(sid, () =>
          this._inputFlights.get(sid) === flight ? this._settleInput(sid, 'unconfirmed') : undefined
        );
      }
    },

    _wsInputFlight(sid, seq) {
      const flight = this._inputFlights?.get(sid);
      return flight?.transport === 'ws' &&
        flight.record.issuer === this._inputJournal?.issuer &&
        flight.record.seq === seq
        ? flight
        : null;
    },
    _onWsInputAck(seq, msg, sid = this._wsSessionId) {
      const flight = this._wsInputFlight(sid, seq);
      if (!flight || msg?.t !== 'ia' || msg.seq !== seq) return;
      return this._queueInputOutcome(sid, () => {
        if (this._inputFlights.get(sid) !== flight) return;
        if (msg?.held === true || msg?.unconfirmed === true || this._sessionInputHeld(sid))
          return this._settleInput(sid, 'unconfirmed');
        if (msg?.typedUnsent === true && msg.delivered === false && msg.confirmed !== true && !msg.dup && !msg.err)
          return this._settleInput(sid, 'typed-unsent');
        if (msg?.confirmed === true && msg.typedUnsent !== true && msg.delivered !== false && !msg.err)
          return this._settleInput(sid, 'confirmed');
        return this._settleInput(sid, 'unconfirmed');
      });
    },
    _onWsInputPending(seq, msg, sid) {
      const flight = this._wsInputFlight(sid, seq);
      if (!flight || msg?.t !== 'ip' || msg.seq !== seq || Object.keys(msg).some((k) => !['t', 'seq'].includes(k)))
        return;
      return this._queueInputOutcome(sid, () =>
        this._inputFlights.get(sid) === flight ? this._settleInput(sid, 'pending') : undefined
      );
    },
    _onWsInputRefusal(seq, msg, sid) {
      const flight = this._wsInputFlight(sid, seq);
      if (
        !flight ||
        msg?.t !== 'ir' ||
        msg.seq !== seq ||
        msg.retryable !== true ||
        !['capacity', 'unavailable'].includes(msg.reason) ||
        msg.held === true ||
        msg.unconfirmed === true ||
        msg.confirmed === true ||
        this._sessionInputHeld(sid)
      )
        return;
      if (msg.reason === 'unavailable') this.showToast?.('Terminal not ready; input remains queued.', 'warning');
      return this._queueInputOutcome(sid, () =>
        this._inputFlights.get(sid) === flight ? this._settleInput(sid, 'not-issued') : undefined
      );
    },

    _onWsReady(sid) {
      void this._drainSession(sid);
    },
    _redeliverSweep() {
      for (const sid of this._pendingDeliveries.keys()) void this._drainSession(sid);
    },
    _pendingBytes() {
      let bytes = 0,
        count = 0;
      for (const rows of this._pendingDeliveries.values())
        for (const row of rows) {
          bytes += row.data.length;
          count++;
        }
      return { bytes, count };
    },
    _persistReliableState() {
      void this._persistReliableNow();
    },
    async _persistReliableNow() {
      if (!this._inputJournal) return;
      for (const sid of this._inputRecoveryHolds || []) {
        if (this._inputHoldWrites.has(sid)) continue;
        this._inputHoldWrites.add(sid);
        try {
          await this._inputJournal.hold(sid);
        } catch {
          this._inputHoldWrites.delete(sid);
          this._inputStorageFailed();
          return false;
        }
      }
      return true;
    },
  });
})();
