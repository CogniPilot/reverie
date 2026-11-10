/**
 * @fileoverview Owner fleet resource settings. The API owns capabilities,
 * coverage, validation, rollout and completion; this view renders its decisions.
 * @dependency chat-app.js (the mounting shell and its literal DOM/API helpers)
 * @loadorder before the dynamically loaded conversation shell
 */
(() => {
  const ROOT = '/api/company/resources/fleet';
  const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
  const blockers = (value) =>
    Array.isArray(value) &&
    value.every(
      (row) => row && typeof row.code === 'string' && typeof row.message === 'string' && typeof row.remedy === 'string'
    );
  const policy = (value) =>
    value &&
    ['memoryHighMiB', 'memoryMaxMiB', 'cpuWeight'].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0) &&
    typeof value.perfEnabled === 'boolean';
  const observedPolicy = (value) =>
    value &&
    ['memoryHighMiB', 'memoryMaxMiB', 'cpuWeight'].every((key) => value[key] === null || Number.isFinite(value[key])) &&
    (value.perfEnabled === null || typeof value.perfEnabled === 'boolean');
  const pool = (value) =>
    value &&
    ['memoryMaxMiB', 'cpuWeight'].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0) &&
    (value.memoryHighMiB === null ||
      (Number.isSafeInteger(value.memoryHighMiB) &&
        value.memoryHighMiB > 0 &&
        value.memoryHighMiB < value.memoryMaxMiB)) &&
    Array.isArray(value.allowedCpus) &&
    value.allowedCpus.every((cpu) => Number.isSafeInteger(cpu) && cpu >= 0);
  const operation = (value) =>
    value &&
    id(value.id) &&
    typeof value.state === 'string' &&
    typeof value.blocksFurtherChanges === 'boolean' &&
    typeof value.message === 'string' &&
    Array.isArray(value.employees) &&
    value.employees.every(
      (row) =>
        id(row.employeeId) &&
        typeof row.state === 'string' &&
        typeof row.verified === 'boolean' &&
        (row.reason === null || typeof row.reason === 'string')
    );
  const memory = (value) => (value === null ? 'unbounded' : `${value.toLocaleString()} MiB`);
  const limits = (value) =>
    value
      ? `Soft RAM ${memory(value.memoryHighMiB)}; hard RAM ${memory(value.memoryMaxMiB)}; CPU weight ${value.cpuWeight === null ? 'not verified' : value.cpuWeight}${'perfEnabled' in value ? `; perf ${value.perfEnabled === null ? 'not tested' : value.perfEnabled ? 'enabled' : 'disabled'}` : ''}`
      : 'Not verified';
  const stable = (value) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]])
          )
        : item
    );

  class FleetPanel {
    constructor(shell, container, dialog, employeeId = null) {
      this.shell = shell;
      this.dialog = dialog;
      this.employeeId = employeeId;
      this.owner = null;
      this.pending = new Set();
      this.rows = new Map();
      this.preview = null;
      this.busy = false;
      this.failed = true;
      this.storageFailed = false;
      this.host = shell.el('section', 'ca-fleet-resources');
      this.host.setAttribute('aria-label', 'Laptop fleet resources');
      this.status = shell.el('p', 'ca-hint', 'Loading laptop fleet…');
      this.status.setAttribute('role', 'status');
      this.error = shell.el('p', 'ca-company-error');
      this.error.setAttribute('role', 'alert');
      this.content = shell.el('div', 'ca-fleet-content');
      this.setup = shell.el('section', 'ca-fleet-installation');
      this.setupBusy = false;
      this.native = shell.el('section', 'ca-fleet-native');
      this.nativeFeedback = shell.el('p', 'ca-hint');
      this.nativeFeedback.setAttribute('role', 'status');
      this.nativeFeedback.setAttribute('aria-live', 'polite');
      this.nativeFeedback.tabIndex = -1;
      this.nativeBusy = false;
      this.nativePreview = null;
      this.draft = shell.el('div', 'ca-fleet-preview');
      this.results = shell.el('div', 'ca-fleet-results');
      this.refresh = shell.button('ca-btn', 'Refresh laptop fleet status', () => this.load(), {
        text: 'Refresh status',
      });
      this.check = shell.button('ca-btn', 'Check laptop rollout status', () => this.checkOperations(), {
        text: 'Check rollout',
      });
      this.host.append(
        shell.el('h3', '', employeeId ? 'Laptop RAM and CPU' : 'Laptop fleet'),
        shell.el(
          'p',
          'ca-hint',
          'Preview image and resource changes before restarting laptops. Soft RAM requests reclaim pressure; the hard ceiling remains. CPU weight shares available CPU rather than imposing a quota.'
        ),
        this.status,
        this.error,
        this.setup,
        this.native,
        this.results,
        this.content,
        this.draft,
        this.refresh,
        this.check
      );
      this.setup.hidden = this.native.hidden = employeeId !== null;
      container.append(this.host);
      void this.load();
    }
    async identity() {
      const result = await this.shell.app._chatApi('/api/owner/status');
      const data = result.data,
        identity = data?.identity;
      if (
        !result.ok ||
        data?.configured !== true ||
        data.signedIn !== true ||
        identity?.role !== 'owner' ||
        !id(identity.id) ||
        (this.owner !== null && this.owner !== identity.id)
      ) {
        throw new Error(
          'Owner sign-in changed or could not be verified. Reopen Company settings; rollout records have been kept.'
        );
      }
      this.owner = identity.id;
    }
    key() {
      return `reverie:laptop-fleet:${this.owner}`;
    }
    readPending() {
      try {
        const values = JSON.parse(this.shell.doc.defaultView.localStorage.getItem(this.key()) || '[]');
        if (!Array.isArray(values) || values.length > 100 || values.some((value) => !id(value))) throw new Error();
        return values;
      } catch {
        this.storageFailed = true;
        throw new Error(
          'The local rollout recovery record is unavailable. Check owner operations before starting another rollout.'
        );
      }
    }
    savePending(remove) {
      const ids = new Set([...this.readPending(), ...this.pending]);
      if (remove) ids.delete(remove);
      try {
        this.shell.doc.defaultView.localStorage.setItem(this.key(), JSON.stringify([...ids]));
      } catch {
        this.storageFailed = true;
        throw new Error('The rollout recovery record could not be saved. No new Apply was sent.');
      }
    }
    requireNoPending() {
      for (const value of this.readPending()) this.pending.add(value);
      if (this.pending.size)
        throw new Error('A rollout is already in progress or unconfirmed. Check rollout before another change.');
    }
    sync() {
      const locked =
        this.busy ||
        this.failed ||
        this.storageFailed ||
        this.pending.size > 0 ||
        !this.data?.canPreview ||
        !Array.isArray(this.data?.operations) ||
        !Array.isArray(this.data?.unmanagedLaptops) ||
        !this.data?.revision ||
        !this.poolValues ||
        this.rows.size === 0 ||
        !this.data.images.length;
      this.content.querySelectorAll('input,select,textarea,button').forEach((node) => {
        node.disabled = node.hasAttribute('data-fleet-profile') ? this.busy : locked;
      });
      this.refresh.disabled = this.busy;
      this.check.disabled = this.busy;
      this.check.hidden = this.pending.size === 0;
      if (this.apply) this.apply.disabled = locked || this.preview?.canApply !== true || this.applied;
      this.setup.querySelectorAll('button').forEach((node) => {
        node.disabled = this.busy || this.setupBusy || this.storageFailed || this.pending.size > 0;
      });
      this.native.querySelectorAll('button').forEach((node) => {
        node.disabled = this.busy || this.nativeBusy || this.storageFailed || this.owner === null;
      });
    }
    invalidate() {
      this.preview = null;
      this.draft.replaceChildren();
      this.apply = null;
      this.applied = false;
    }
    async load() {
      if (this.busy) return;
      this.busy = true;
      this.invalidate();
      this.sync();
      this.error.textContent = '';
      try {
        await this.identity();
        for (const value of this.readPending()) this.pending.add(value);
        const result = await this.shell.app._chatApi(ROOT);
        await this.identity();
        if (!this.dialog.isConnected) return;
        if (!result.ok) throw new Error(result.error || 'Laptop fleet controls are unavailable on this server.');
        const data = result.data;
        if (
          !data ||
          data.version !== 1 ||
          !(data.revision === null || id(data.revision)) ||
          typeof data.canPreview !== 'boolean' ||
          !blockers(data.blockers) ||
          !Array.isArray(data.images) ||
          data.images.some((row) => !id(row.id) || typeof row.label !== 'string') ||
          !data.pool ||
          !(data.pool.desired === null || pool(data.pool.desired)) ||
          !(data.pool.observed === null || pool(data.pool.observed)) ||
          !Array.isArray(data.employees) ||
          data.employees.length > 1000 ||
          data.employees.some(
            (row) =>
              !id(row.employeeId) ||
              typeof row.name !== 'string' ||
              typeof row.state !== 'string' ||
              !(row.reason === null || typeof row.reason === 'string') ||
              !(row.desired === null || policy(row.desired)) ||
              !(row.observed === null || observedPolicy(row.observed)) ||
              !(row.desiredImageId === null || id(row.desiredImageId)) ||
              !(row.observedImageId === null || id(row.observedImageId))
          ) ||
          !(data.operations === null || (Array.isArray(data.operations) && data.operations.every(operation))) ||
          !(
            data.unmanagedLaptops === null ||
            (Array.isArray(data.unmanagedLaptops) &&
              data.unmanagedLaptops.every((row) => id(row.id) && typeof row.reason === 'string'))
          )
        ) {
          throw new Error('Laptop fleet status could not be verified. No rollout can be started.');
        }
        this.data = data;
        this.failed = false;
        for (const row of data.operations || []) this.recordOperation(row);
        this.render();
        this.renderOperations(data.operations || []);
        this.status.textContent = this.pending.size
          ? 'A rollout is in progress or unconfirmed. Check rollout before preparing another.'
          : !data.canPreview || data.operations === null || data.unmanagedLaptops === null
            ? 'Detailed fleet observations are unavailable. Review the host-selected migration separately.'
            : 'Requested settings and verified running values are shown separately.';
      } catch (error) {
        this.failed = true;
        this.error.textContent = error.message || 'Laptop fleet status is unavailable.';
      } finally {
        this.busy = false;
        this.sync();
      }
    }
    recordOperation(row) {
      if (row.blocksFurtherChanges) {
        this.pending.add(row.id);
        this.savePending();
      } else {
        this.pending.delete(row.id);
        this.savePending(row.id);
      }
    }
    renderBlockers(container, values) {
      for (const row of values)
        container.append(this.shell.el('p', 'ca-hint', `${row.message}${row.remedy ? ` ${row.remedy}` : ''}`));
    }
    number(container, label, value) {
      const wrap = this.shell.el('label', 'ca-label');
      const input = this.shell.el('input', 'ca-field');
      input.type = 'number';
      input.min = '1';
      input.step = '1';
      input.required = true;
      input.value = String(value);
      input.setAttribute('aria-label', label);
      wrap.append(this.shell.el('span', 'ca-label-text', label), input);
      container.append(wrap);
      return input;
    }
    policyFields(container, label, value) {
      const high = this.number(container, `${label} soft RAM (MiB)`, value.memoryHighMiB);
      const max = this.number(container, `${label} hard RAM (MiB)`, value.memoryMaxMiB);
      const cpu = this.number(container, `${label} CPU weight`, value.cpuWeight);
      const wrap = this.shell.el('label', 'ca-label');
      const perf = this.shell.el('input');
      perf.type = 'checkbox';
      perf.checked = value.perfEnabled;
      perf.setAttribute('aria-label', `${label} perf`);
      wrap.append(perf, this.shell.el('span', '', 'Enable perf'));
      container.append(wrap);
      return () => ({
        memoryHighMiB: Number(high.value),
        memoryMaxMiB: Number(max.value),
        cpuWeight: Number(cpu.value),
        perfEnabled: perf.checked,
      });
    }
    render() {
      this.content.replaceChildren();
      this.rows.clear();
      const s = this.shell,
        data = this.data;
      this.renderBlockers(this.content, data.blockers);
      this.renderSetup();
      this.renderNative();
      if (data.operations === null)
        this.content.append(
          s.el('p', 'ca-hint', 'Rollout history is unavailable. Existing operations have not been ruled out.')
        );
      if (data.unmanagedLaptops === null)
        this.content.append(s.el('p', 'ca-hint', 'Unmanaged laptop coverage has not been verified.'));
      else
        for (const laptop of data.unmanagedLaptops)
          this.content.append(s.el('p', 'ca-hint', `Unmanaged laptop ${laptop.id}: ${laptop.reason}`));
      this.form = s.el('form', 'ca-fleet-form');
      this.form.addEventListener('input', () => this.invalidate());
      this.form.addEventListener('change', () => this.invalidate());
      this.image = s.el('select', 'ca-field');
      this.image.required = true;
      this.image.setAttribute('aria-label', 'Target laptop image');
      for (const image of data.images) {
        const option = s.el('option', '', image.label);
        option.value = image.id;
        this.image.append(option);
      }
      const imageLabel = s.el('label', 'ca-label');
      imageLabel.append(s.el('span', '', 'Target laptop image'), this.image);
      this.form.append(imageLabel);
      this.form.append(this.renderPool());
      this.canary = s.el('select', 'ca-field');
      this.canary.required = true;
      this.canary.setAttribute('aria-label', 'Canary employee');
      const empty = s.el('option', '', 'Choose an employee for the first replacement');
      empty.value = '';
      this.canary.append(empty);
      const employees = this.employeeId
        ? data.employees.filter((employee) => employee.employeeId === this.employeeId)
        : data.employees;
      if (this.employeeId) {
        for (const employee of employees) this.form.append(this.renderEmployee(employee));
        if (!employees.length)
          this.form.append(
            s.el('p', 'ca-company-error', 'This employee has no verified fleet record. Refresh status.')
          );
        this.canary.value = this.employeeId;
        const imageId = employees[0]?.desiredImageId;
        if (imageId) this.image.value = imageId;
      } else {
        const scroll = s.el('div', 'ca-fleet-table-scroll');
        const table = s.el('table', 'ca-fleet-table');
        const head = s.el('thead'),
          headings = s.el('tr');
        for (const label of ['Employee', 'Status', 'Requested RAM / CPU', 'Verified RAM / CPU']) {
          const cell = s.el('th', '', label);
          cell.scope = 'col';
          headings.append(cell);
        }
        head.append(headings);
        const body = s.el('tbody');
        for (const employee of employees) body.append(this.renderEmployeeSummary(employee));
        table.append(head, body);
        scroll.append(table);
        this.form.append(scroll);
      }
      const canaryLabel = s.el('label', 'ca-label');
      canaryLabel.append(s.el('span', '', 'Canary employee'), this.canary);
      canaryLabel.hidden = this.employeeId !== null;
      this.note = s.el('textarea', 'ca-field');
      this.note.rows = 3;
      this.note.maxLength = 12000;
      this.note.required = true;
      this.note.setAttribute('aria-label', 'Fleet rollout handoff note');
      this.note.value = 'Resume your current task from your journal and board after the laptop restart.';
      const noteLabel = s.el('label', 'ca-label');
      noteLabel.append(s.el('span', '', 'Note for employees after restart'), this.note);
      this.submit = s.el('button', 'ca-btn', 'Preview fleet rollout');
      this.submit.type = 'submit';
      this.form.append(canaryLabel, noteLabel, this.submit);
      this.form.addEventListener('submit', (event) => {
        event.preventDefault();
        void this.prepare();
      });
      this.content.append(this.form);
    }
    nativeKey() {
      return `reverie:native-pool-migration:${this.owner}`;
    }
    readNativePending() {
      const raw = this.shell.doc.defaultView.localStorage.getItem(this.nativeKey());
      if (!raw) return null;
      const record = JSON.parse(raw);
      if (!record || !id(record.operationId)) throw new Error('Original migration recovery record is unavailable');
      return record;
    }
    renderNative() {
      const s = this.shell;
      this.native.replaceChildren(s.el('h4', '', 'Host-selected shared RAM and CPU pool'));
      this.native.append(
        s.el(
          'p',
          'ca-hint',
          'Review the host-approved pool policy on its original connection. This does not infer running laptop limits, image choices or rollout history from employee settings.'
        )
      );
      this.native.append(this.nativeFeedback);
      try {
        const pending = this.readNativePending();
        if (pending) {
          this.native.append(
            s.el(
              'p',
              'ca-hint',
              'An original migration was attempted. Check its outcome; consent and employee starts will not be replayed.'
            )
          );
          this.native.append(
            s.button('ca-btn', 'Check original shared-pool migration', () => this.checkNative(pending), {
              text: 'Check migration',
            }),
            s.button('ca-btn', 'Recover setup after a failed activation', () => this.recoverNative(pending), {
              text: 'Recover failed setup',
            })
          );
          return;
        }
        this.native.append(
          s.button('ca-btn', 'Review host-selected migration', () => this.prepareNative(), {
            text: 'Review shared RAM and CPU pool',
          })
        );
        const preview = this.nativePreview;
        if (!preview) return;
        const selected = preview.policy;
        this.native.append(
          s.el(
            'p',
            'ca-hint',
            `Host-selected pool: ${selected.memoryMaxMiB.toLocaleString()} MiB hard RAM; CPU weight ${selected.cpuWeight}; CPUs ${selected.allowedCpus.join(', ')}.`
          )
        );
        const details = s.el('details');
        details.append(s.el('summary', '', `Employee thresholds · ${Object.keys(selected.employeeMemoryHighMiB).length}`),
          s.el('p', 'ca-hint', 'Soft thresholds do not reserve RAM. They apply when each laptop is running.'));
        const rows = s.el('table', 'ca-fleet-table');
        for (const [employeeId, high] of Object.entries(selected.employeeMemoryHighMiB)) {
          const name = this.data?.employees.find((employee) => employee.employeeId === employeeId)?.name || employeeId;
          const row = s.el('tr');
          row.append(s.el('td', '', name), s.el('td', '', `${high.toLocaleString()} MiB soft RAM`));
          rows.append(row);
        }
        details.append(rows);
        this.native.append(
          details,
          s.el(
            'p',
            'ca-hint',
            `Preview expires ${new Date(preview.expiresAtEpochMs).toLocaleTimeString()}. Activation stops the approved laptops; ordinary startup then attempts only the approved employees who are still in office. Pool activation and employee recovery are reported separately.`
          )
        );
        this.native.append(
          s.button('ca-btn is-danger', 'Activate shared pool and recreate existing laptops', () => this.applyNative(), {
            text: 'Activate shared pool',
          })
        );
      } catch {
        this.storageFailed = true;
        this.native.append(
          s.el(
            'p',
            'ca-company-error',
            'The original migration recovery record cannot be read. No new consent will be sent.'
          )
        );
      } finally {
        if (this.nativeFeedback.getAttribute('role') === 'alert') this.focusNativeFailure();
      }
    }
    focusNativeFailure() {
      if (!this.nativeFeedback.isConnected) return;
      this.nativeFeedback.focus({ preventScroll: true });
      this.nativeFeedback.scrollIntoView?.({ block: 'nearest' });
    }
    reportNative(message, failed = false) {
      this.nativeFeedback.textContent = message;
      this.nativeFeedback.className = failed ? 'ca-company-error' : 'ca-hint';
      this.nativeFeedback.setAttribute('role', failed ? 'alert' : 'status');
      if (failed) this.focusNativeFailure();
    }
    async prepareNative() {
      if (this.nativeBusy || this.busy || this.storageFailed) return;
      this.nativeBusy = true;
      this.results.replaceChildren();
      this.reportNative('Checking the shared-pool setup…');
      this.sync();
      try {
        await this.identity();
        this.requireNoPending();
        if (this.readNativePending()) throw new Error('Check the original migration before preparing another');
        const reply = await this.shell.app._chatApi(`${ROOT}/native-preview`, { method: 'POST', body: {} });
        await this.identity();
        if (!reply.ok) throw new Error(reply.error || 'This host has not made native migration available');
        const value = reply.data;
        if (
          !value ||
          value.kind !== 'fleet-preview' ||
          value.purpose !== 'resource-fleet-maintenance-v1' ||
          value.version !== 1 ||
          value.status !== 'awaiting-maintenance-consent' ||
          !id(value.requestId) ||
          !id(value.approval?.previewId) ||
          !id(value.approval?.operationId) ||
          !/^[a-f0-9]{64}$/.test(value.approval?.revisionDigest) ||
          !Number.isSafeInteger(value.expiresAtEpochMs) ||
          value.expiresAtEpochMs <= Date.now() ||
          value.policy?.memoryMaxMiB !== 49152 ||
          !Number.isSafeInteger(value.policy.cpuWeight) ||
          !Array.isArray(value.policy.allowedCpus) ||
          !value.policy.employeeMemoryHighMiB
        )
          throw new Error('The host-selected migration preview could not be verified');
        this.nativePreview = value;
        this.error.textContent = '';
        this.reportNative('Review the proposed settings below. No activation has been sent.');
        this.renderNative();
      } catch (error) {
        this.nativePreview = null;
        this.error.textContent = error.message || 'Native migration preview is unavailable';
        this.reportNative(this.error.textContent, true);
      } finally {
        this.nativeBusy = false;
        this.sync();
      }
    }
    async applyNative() {
      const preview = this.nativePreview;
      if (!preview || this.nativeBusy || this.busy || this.storageFailed) return;
      const confirmed = await this.shell.confirmCompanyAction(
        'Shared RAM and CPU pool',
        'Activate the host-approved shared pool and recreate the approved laptops through normal startup? Employees who are stopped, away, retired or moved will not be started. An unconfirmed outcome must be inspected rather than retried.',
        'Activate shared pool and recreate existing laptops'
      );
      if (!confirmed || this.nativePreview !== preview || this.nativeBusy || this.busy || !this.dialog.isConnected)
        return;
      this.nativeBusy = true;
      this.results.replaceChildren();
      this.reportNative('Activating the shared pool. Employee startup will be reported separately…');
      this.sync();
      let sent = false;
      try {
        await this.identity();
        this.requireNoPending();
        if (this.readNativePending() || Date.now() >= preview.expiresAtEpochMs)
          throw new Error('Original migration is pending or its preview expired; no consent sent');
        const record = { operationId: preview.approval.operationId },
          raw = JSON.stringify(record);
        this.shell.doc.defaultView.localStorage.setItem(this.nativeKey(), raw);
        if (this.shell.doc.defaultView.localStorage.getItem(this.nativeKey()) !== raw)
          throw new Error('Migration recovery record could not be saved; no consent sent');
        this.nativePreview = null; // Local one-shot before the HTTP dispatch.
        sent = true;
        const reply = await this.shell.app._chatApi(`${ROOT}/native-apply`, {
          method: 'POST',
          body: {
            previewId: preview.approval.previewId,
            expectedRevision: preview.approval.revisionDigest,
            consent: true,
            verb: 'migrate-pool',
          },
        });
        await this.identity();
        if (!reply.ok) throw new Error(reply.error || 'Original migration remains unconfirmed; do not resend consent');
        this.showNativeResult(reply.data, record.operationId);
      } catch (error) {
        this.error.textContent = error.message || 'Original migration remains unconfirmed';
        this.reportNative(`${this.error.textContent}. ${sent ? 'Activation is unconfirmed; use Check migration to inspect this attempt.' : 'No activation request was sent.'}`, true);
      } finally {
        this.nativeBusy = false;
        this.renderNative();
        this.sync();
      }
    }
    async checkNative(record) {
      if (this.nativeBusy || this.busy) return;
      this.nativeBusy = true;
      this.reportNative('Checking the original activation…');
      this.sync();
      try {
        await this.identity();
        const reply = await this.shell.app._chatApi(`${ROOT}/native-result`, {
          method: 'POST',
          body: { operationId: record.operationId },
        });
        await this.identity();
        if (!reply.ok)
          throw new Error(reply.error || 'Original migration result is unavailable; its recovery record remains');
        this.showNativeResult(reply.data, record.operationId);
      } catch (error) {
        this.error.textContent = error.message || 'Original migration remains unconfirmed';
        this.reportNative(this.error.textContent, true);
      } finally {
        this.nativeBusy = false;
        this.renderNative();
        this.sync();
      }
    }
    async recoverNative(record) {
      if (this.nativeBusy || this.busy || this.storageFailed) return;
      const confirmed = await this.shell.confirmCompanyAction(
        'Shared RAM setup',
        'Preserve the previous attempt as unconfirmed, verify the current installation has no active shared pool, and prepare a fresh setup review.',
        'Recover failed setup'
      );
      if (!confirmed || this.nativeBusy || this.busy || !this.dialog.isConnected) return;
      this.nativeBusy = true;
      this.reportNative('Checking whether a fresh setup review is available…');
      this.sync();
      try {
        await this.identity();
        if (this.readNativePending()?.operationId !== record.operationId)
          throw new Error('Original migration reference changed; no recovery was requested');
        const reply = await this.shell.app._chatApi(`${ROOT}/native-reconcile`, {
          method: 'POST',
          body: { operationId: record.operationId, preserveUnconfirmedHistory: true },
        });
        await this.identity();
        const result = reply.data;
        if (!reply.ok) throw new Error(reply.error || 'Failed setup recovery is unavailable');
        if (
          !result ||
          result.operationId !== record.operationId ||
          result.priorOutcome !== 'unconfirmed' ||
          result.currentState !== 'pool-uninstalled' ||
          result.historyRecorded !== true ||
          result.activationAuthorized !== false ||
          result.startsAuthorized !== false ||
          !/^[a-f0-9]{64}$/.test(result.evidenceDigest) ||
          !id(result.observationNonce)
        )
          throw new Error('Current installation recovery evidence could not be verified');
        if (this.readNativePending()?.operationId !== record.operationId)
          throw new Error('Original migration reference changed; its record was kept');
        const storage = this.shell.doc.defaultView.localStorage;
        const historyKey = `${this.nativeKey()}:unconfirmed-history`;
        const history = JSON.parse(storage.getItem(historyKey) || '[]');
        if (!Array.isArray(history) || history.length >= 100)
          throw new Error('Local unconfirmed setup history is unavailable or full');
        const raw = JSON.stringify([
          ...history,
          {
            operationId: record.operationId,
            priorOutcome: 'unconfirmed',
            evidenceDigest: result.evidenceDigest,
            observationNonce: result.observationNonce,
          },
        ]);
        storage.setItem(historyKey, raw);
        if (storage.getItem(historyKey) !== raw) throw new Error('Unconfirmed setup history could not be preserved');
        storage.removeItem(this.nativeKey());
        this.nativePreview = null;
        this.error.textContent = '';
        this.results.replaceChildren();
        this.reportNative(
          'The shared pool is absent. The previous attempt remains unconfirmed in history. Review the shared-pool setup again to activate it.'
        );
      } catch (error) {
        this.error.textContent = error.message || 'Failed setup remains unconfirmed';
        this.reportNative(this.error.textContent, true);
      } finally {
        this.nativeBusy = false;
        this.renderNative();
        this.sync();
      }
    }
    showNativeResult(value, operationId) {
      if (
        !value ||
        value.operationId !== operationId ||
        !['previewed', 'pending', 'pool-configured', 'unknown'].includes(value.state) ||
        typeof value.blocksFurtherChanges !== 'boolean' ||
        !Array.isArray(value.restore)
      )
        throw new Error('Original migration result could not be verified');
      if (
        value.native !== null &&
        (value.native?.kind !== 'fleet-migration-result' ||
          value.native?.phase !== 'pool-configured' ||
          value.native?.approval?.operationId !== operationId)
      )
        throw new Error('Native activation result could not be verified');
      this.results.replaceChildren(this.shell.el('h4', '', 'Original shared-pool migration'));
      this.reportNative(
        value.state === 'unknown'
          ? 'Shared-pool activation or employee startup is unconfirmed. Check this migration before taking another action.'
          : value.native
            ? 'The host confirmed shared-pool activation. Employee startup results are below.'
            : 'Shared-pool activation is pending. Check this migration for its result.',
        value.state === 'unknown'
      );
      this.results.append(
        this.shell.el(
          'p',
          'ca-hint',
          value.native
            ? 'The native host confirmed shared-pool activation. Employee recovery is listed separately.'
            : 'Shared-pool activation is pending or unconfirmed. No consent will be replayed.'
        )
      );
      for (const row of value.restore) {
        if (
          !id(row.employeeId) ||
          !id(row.sessionId) ||
          !['wake-confirmed', 'skipped-current-intent', 'unknown'].includes(row.state)
        )
          throw new Error('Employee recovery result is unavailable');
        const name =
          this.data?.employees.find((employee) => employee.employeeId === row.employeeId)?.name || row.employeeId;
        this.results.append(
          this.shell.el(
            'p',
            'ca-hint',
            `${name}: ${row.state === 'wake-confirmed' ? 'normal startup confirmed' : row.state === 'skipped-current-intent' ? 'not started because current attendance or session changed' : 'startup unconfirmed; not retried'}.`
          )
        );
      }
      if (!value.blocksFurtherChanges && value.state === 'pool-configured' && value.native !== null)
        this.shell.doc.defaultView.localStorage.removeItem(this.nativeKey());
      this.error.textContent = '';
    }
    setupKey() {
      return `reverie:worker-pool-installation:${this.owner}`;
    }
    readSetupPending() {
      try {
        const raw = localStorage.getItem(this.setupKey());
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!id(value.viewId) || !id(value.offerNonce) || !/^[a-f0-9]{64}$/.test(value.requestDigest))
          throw new Error('Invalid installation record');
        return value;
      } catch {
        this.storageFailed = true;
        return { unavailable: true };
      }
    }
    renderSetup() {
      const s = this.shell;
      this.setup.replaceChildren();
      if (!this.data.blockers.some((row) => row.code === 'FLEET_HOST_SETUP_REQUIRED')) return;
      this.setup.append(s.el('h4', '', 'Native worker pool setup'));
      this.setup.append(
        s.el(
          'p',
          'ca-hint',
          'Review the OS-nominated installation before consenting. This installs the shared resource controller; laptop replacement is tracked separately.'
        )
      );
      const pending = this.readSetupPending();
      if (pending) {
        this.setup.append(
          s.el(
            'p',
            'ca-hint',
            'An installation was attempted or is unconfirmed. Check its original result; consent will not be sent again.'
          )
        );
        if (!pending.unavailable)
          this.setup.append(
            s.button('ca-btn', 'Check original pool installation', () => this.checkSetup(pending), {
              text: 'Check installation',
            })
          );
      } else {
        this.setup.append(
          s.button('ca-btn', 'Review native worker pool setup', () => this.openSetup(), {
            text: 'Review controller setup',
          })
        );
        this.setup.append(
          s.button('ca-btn', 'Enroll this owner account for native setup', () => this.enrollSetup(), {
            text: 'Enroll owner account',
          })
        );
      }
    }
    async enrollSetup() {
      if (this.setupBusy || this.readSetupPending()) return;
      const confirmed = await this.shell.confirmCompanyAction(
        'Owner account enrollment',
        'Add a stable registration identity to this owner account? This does not install or authorize a worker pool.',
        'Enroll account'
      );
      if (!confirmed || this.setupBusy || this.readSetupPending() || !this.dialog.isConnected) return;
      this.setupBusy = true;
      this.sync();
      try {
        await this.identity();
        const response = await this.shell.app._chatApi(`${ROOT}/installation/enroll`, {
          method: 'POST',
          body: { enroll: true },
        });
        await this.identity();
        if (!response.ok) throw new Error(response.error || 'Owner account enrollment unavailable');
        this.error.textContent = 'Owner account enrolled. Review the OS-nominated setup separately.';
      } catch (error) {
        this.error.textContent = error.message || 'Owner account enrollment unavailable';
      } finally {
        this.setupBusy = false;
        this.sync();
      }
    }
    async openSetup() {
      if (this.setupBusy || this.readSetupPending()) return;
      this.setupBusy = true;
      this.sync();
      this.error.textContent = '';
      try {
        await this.identity();
        const response = await this.shell.app._chatApi(`${ROOT}/installation/view`, { method: 'POST', body: {} });
        await this.identity();
        if (!response.ok) throw new Error(response.error || 'Native installation view unavailable');
        const view = response.data,
          policy = view?.policy;
        if (
          !view ||
          view.kind !== 'pool-installation-viewed' ||
          view.purpose !== 'host-pool-installation-consent-v1' ||
          view.version !== 1 ||
          !id(view.requestId) ||
          !id(view.offerNonce) ||
          !/^[a-f0-9]{64}$/.test(view.requestDigest) ||
          !Number.isSafeInteger(view.expiresAtEpochMs) ||
          view.expiresAtEpochMs <= Date.now() ||
          !policy ||
          policy.memoryMaxMiB !== 49152 ||
          !Array.isArray(policy.allowedCpus) ||
          !policy.allowedCpus.every((cpu) => Number.isSafeInteger(cpu) && cpu >= 0) ||
          !Number.isSafeInteger(policy.cpuWeight) ||
          !policy.employeeMemoryHighMiB ||
          typeof policy.employeeMemoryHighMiB !== 'object'
        )
          throw new Error('Native setup selection could not be verified');
        this.setup.replaceChildren(this.shell.el('h4', '', 'Review native worker pool setup'));
        this.setup.append(
          this.shell.el(
            'p',
            '',
            `Shared hard ceiling: 48 GiB. CPU weight: ${policy.cpuWeight}; allowed CPUs: ${policy.allowedCpus.join(', ')}. Laptops share the pool; setup alone does not restart or wake an employee.`
          )
        );
        for (const [employeeId, high] of Object.entries(policy.employeeMemoryHighMiB)) {
          if (!Number.isSafeInteger(high) || high <= 0 || high > 49152)
            throw new Error('Invalid native soft threshold');
          const employee = this.data.employees.find((row) => row.employeeId === employeeId);
          this.setup.append(
            this.shell.el(
              'p',
              'ca-hint',
              `${employee?.name || employeeId}: soft RAM ${high.toLocaleString()} MiB; hard maximum 48 GiB.`
            )
          );
        }
        this.setup.append(
          this.shell.el(
            'p',
            'ca-hint',
            `Installation expires ${new Date(view.expiresAtEpochMs).toLocaleString()}. Existing off and vacation intent remains separate from installation.`
          )
        );
        this.setup.append(
          this.shell.button(
            'ca-btn is-danger',
            'Consent to this native pool installation',
            () => this.consentSetup(view),
            { text: 'Install controller' }
          )
        );
      } catch (error) {
        this.error.textContent = error.message || 'Native installation unavailable';
      } finally {
        this.setupBusy = false;
        this.sync();
      }
    }
    async consentSetup(view) {
      if (this.setupBusy || this.readSetupPending()) return;
      if (Date.now() >= view.expiresAtEpochMs) {
        this.error.textContent = 'Installation view expired. No consent was sent.';
        return;
      }
      const confirmed = await this.shell.confirmCompanyAction(
        'Native worker pool',
        'Install the reviewed shared worker resource controller?',
        'Consent to installation'
      );
      if (!confirmed || this.setupBusy || this.readSetupPending() || !this.dialog.isConnected) return;
      this.setupBusy = true;
      this.sync();
      try {
        await this.identity();
        if (Date.now() >= view.expiresAtEpochMs) throw new Error('Installation view expired. No consent was sent.');
        const record = { viewId: view.requestId, offerNonce: view.offerNonce, requestDigest: view.requestDigest };
        const raw = JSON.stringify(record);
        localStorage.setItem(this.setupKey(), raw);
        if (localStorage.getItem(this.setupKey()) !== raw)
          throw new Error('Installation recovery record could not be saved; no consent sent');
        const response = await this.shell.app._chatApi(
          `${ROOT}/installation/${encodeURIComponent(view.requestId)}/consent`,
          {
            method: 'POST',
            body: { consent: true, offerNonce: view.offerNonce, requestDigest: view.requestDigest },
          }
        );
        await this.identity();
        if (!response.ok) throw new Error(response.error || 'Original installation outcome is retained');
        this.showSetupResult(response.data);
      } catch (error) {
        this.error.textContent = error.message || 'Installation is unconfirmed; do not resend consent';
      } finally {
        this.setupBusy = false;
        this.renderSetup();
        this.sync();
      }
    }
    async checkSetup(record) {
      if (this.setupBusy) return;
      this.setupBusy = true;
      this.sync();
      try {
        await this.identity();
        const response = await this.shell.app._chatApi(
          `${ROOT}/installation/${encodeURIComponent(record.viewId)}/result`,
          { method: 'POST', body: {} }
        );
        await this.identity();
        if (!response.ok) throw new Error(response.error || 'Installation history unavailable');
        this.showSetupResult(response.data);
      } catch (error) {
        this.error.textContent = error.message || 'Original installation remains unconfirmed';
      } finally {
        this.setupBusy = false;
        this.sync();
      }
    }
    showSetupResult(result) {
      if (
        !result ||
        !id(result.viewId) ||
        typeof result.blocksFurtherChanges !== 'boolean' ||
        !['viewed', 'pending', 'settled', 'unknown'].includes(result.state)
      )
        throw new Error('Installation result unavailable');
      this.error.textContent =
        result.state === 'settled'
          ? 'Native pool setup returned a verified result. Refresh fleet status to inspect controller observations and laptop coverage; rollout completion has not been inferred.'
          : 'Original native installation is pending or unconfirmed. No consent will be replayed.';
    }
    renderPool() {
      const s = this.shell,
        data = this.data;
      const poolBox = s.el('fieldset', 'ca-fleet-policy');
      poolBox.append(s.el('legend', '', 'Shared employee pool'));
      poolBox.append(
        s.el(
          'p',
          'ca-hint',
          `Running: ${limits(data.pool.observed)}${data.pool.observed ? `; allowed CPUs ${data.pool.observed.allowedCpus.join(', ')}` : ''}`
        )
      );
      if (data.pool.desired) {
        const value = data.pool.desired;
        if (this.employeeId) {
          this.poolValues = () => ({ ...value, allowedCpus: [...value.allowedCpus] });
          this.cpus = { value: value.allowedCpus.join(',') };
          poolBox.append(
            s.el(
              'p',
              'ca-hint',
              'Shared pool settings are managed in Company settings. This preview changes only this employee.'
            )
          );
          return poolBox;
        }
        let highValue = () => null;
        if (value.memoryHighMiB === null) {
          poolBox.append(s.el('p', 'ca-hint', 'Pool soft RAM is unbounded; the hard pool ceiling still applies.'));
        } else {
          const high = this.number(poolBox, 'Pool soft RAM (MiB)', value.memoryHighMiB);
          highValue = () => Number(high.value);
        }
        const max = this.number(poolBox, 'Pool hard RAM (MiB)', value.memoryMaxMiB);
        const cpu = this.number(poolBox, 'Pool CPU weight', value.cpuWeight);
        const label = s.el('label', 'ca-label');
        this.cpus = s.el('input', 'ca-field');
        this.cpus.required = true;
        this.cpus.value = value.allowedCpus.join(',');
        this.cpus.setAttribute('aria-label', 'Pool allowed CPUs (comma-separated)');
        label.append(s.el('span', '', 'Allowed CPUs (comma-separated)'), this.cpus);
        poolBox.append(label);
        this.poolValues = () => ({
          memoryHighMiB: highValue(),
          memoryMaxMiB: Number(max.value),
          cpuWeight: Number(cpu.value),
          allowedCpus: this.cpus.value.split(',').map((value) => Number(value.trim())),
        });
      } else {
        this.poolValues = null;
        poolBox.append(s.el('p', 'ca-hint', 'Live pool settings are unavailable from this server.'));
      }
      return poolBox;
    }
    renderEmployeeSummary(employee) {
      const s = this.shell,
        row = s.el('tr');
      const name = s.el('td');
      const open = s.button(
        'ca-btn',
        `Resource permissions for ${employee.name}`,
        async () => {
          const reply = await s.app._chatApi('/api/company');
          const current =
            reply.ok &&
            reply.data?.canManage === true &&
            reply.data.employees?.find((item) => item.id === employee.employeeId);
          if (!current) {
            this.error.textContent = 'Employee profile is unavailable. Refresh Company.';
            return;
          }
          s.openEmployeeProfile(current);
          s.doc.querySelector('[data-profile-tab="permissions"]')?.click();
        },
        { text: employee.name }
      );
      name.append(open);
      open.setAttribute('data-fleet-profile', '');
      row.append(
        name,
        s.el('td', '', `${employee.state}${employee.reason ? `: ${employee.reason}` : ''}`),
        s.el('td', '', employee.desired ? limits(employee.desired) : 'Unavailable'),
        s.el('td', '', limits(employee.observed))
      );
      row.title = `Requested image: ${employee.desiredImageId || 'Unavailable'}. Running image: ${employee.observedImageId || 'Not verified'}.`;
      if (employee.desired) {
        this.rows.set(employee.employeeId, () => ({ ...employee.desired }));
        const option = s.el('option', '', employee.name);
        option.value = employee.employeeId;
        this.canary.append(option);
      }
      return row;
    }
    renderEmployee(employee) {
      const s = this.shell;
      const box = s.el('fieldset', 'ca-fleet-policy');
      box.append(s.el('legend', '', employee.name));
      box.append(
        s.el('p', 'ca-hint', `${employee.state}${employee.reason ? `: ${employee.reason}` : ''}`),
        s.el('p', 'ca-hint', `Running: ${limits(employee.observed)}`)
      );
      box.append(
        s.el(
          'p',
          'ca-hint',
          `Requested image: ${employee.desiredImageId || 'Unavailable'}. Running image: ${employee.observedImageId || 'Not verified'}.`
        )
      );
      if (employee.desired) {
        this.rows.set(employee.employeeId, this.policyFields(box, employee.name, employee.desired));
        const option = s.el('option', '', employee.name);
        option.value = employee.employeeId;
        this.canary.append(option);
      } else box.append(s.el('p', 'ca-hint', 'No editable policy was provided for this laptop.'));
      return box;
    }
    async prepare() {
      if (
        this.busy ||
        this.failed ||
        this.storageFailed ||
        this.pending.size ||
        !this.data.canPreview ||
        !Array.isArray(this.data.operations) ||
        !Array.isArray(this.data.unmanagedLaptops) ||
        !this.form.reportValidity()
      )
        return;
      if (!this.poolValues || !this.data.revision || !this.image.value) return;
      this.busy = true;
      this.sync();
      this.invalidate();
      this.error.textContent = '';
      try {
        await this.identity();
        this.requireNoPending();
        const request = {
          expectedRevision: this.data.revision,
          targetImageId: this.image.value,
          policies: [...this.rows].map(([employeeId, values]) => ({ employeeId, ...values() })),
          pool: this.poolValues(),
          canaryEmployeeId: this.canary.value,
          handoff: this.note.value.trim(),
        };
        if (!/^\d+(?:\s*,\s*\d+)*$/.test(this.cpus.value) || !request.handoff)
          throw new Error('Enter a handoff note and comma-separated CPU numbers.');
        const result = await this.shell.app._chatApi(`${ROOT}/preview`, { method: 'POST', body: request });
        await this.identity();
        if (!this.dialog.isConnected) return;
        if (!result.ok)
          throw new Error(result.error || 'No fleet preview was created. Refresh status before trying again.');
        const preview = result.data;
        if (
          !preview ||
          !id(preview.previewId) ||
          !id(preview.operationId) ||
          preview.revision !== request.expectedRevision ||
          typeof preview.canApply !== 'boolean' ||
          !Number.isFinite(preview.expiresAt) ||
          !blockers(preview.blockers) ||
          !Array.isArray(preview.steps) ||
          preview.steps.some(
            (row) => !id(row.employeeId) || typeof row.name !== 'string' || typeof row.action !== 'string'
          ) ||
          stable(preview.request) !== stable(request)
        )
          throw new Error('The fleet preview could not be verified. No Apply was sent.');
        this.preview = preview;
        this.renderPreview();
        this.status.textContent = 'Preview only. No laptop has been changed.';
      } catch (error) {
        this.error.textContent = error.message || 'Fleet preview is unavailable.';
      } finally {
        this.busy = false;
        this.sync();
      }
    }
    renderPreview() {
      const s = this.shell,
        preview = this.preview;
      this.draft.replaceChildren(s.el('h4', '', 'Review rollout'));
      this.renderBlockers(this.draft, preview.blockers);
      this.draft.append(
        s.el(
          'p',
          'ca-hint',
          `Target image: ${preview.request.targetImageId}. Preview expires ${globalThis.ReverieTime?.format(preview.expiresAt) ?? new Date(preview.expiresAt).toISOString()}.`
        )
      );
      const steps = s.el('ol');
      for (const row of preview.steps) steps.append(s.el('li', '', `${row.name}: ${row.action}`));
      this.draft.append(steps);
      this.apply = s.button('ca-btn is-danger', 'Apply previewed fleet rollout', () => this.execute(), {
        text: 'Apply rollout',
      });
      this.draft.append(this.apply);
    }
    async execute() {
      const preview = this.preview;
      if (
        this.busy ||
        this.failed ||
        this.storageFailed ||
        this.pending.size ||
        this.applied ||
        preview?.canApply !== true
      )
        return;
      if (this.expired(preview)) return;
      if (
        !(await this.shell.confirmCompanyAction(
          'Laptop fleet',
          'Apply this previewed rollout? Affected laptops restart in the order shown and resume from the handoff note.',
          'Apply rollout'
        ))
      )
        return;
      if (!this.dialog.isConnected || this.busy || this.preview !== preview || this.applied || this.pending.size)
        return;
      this.busy = true;
      this.sync();
      this.error.textContent = '';
      try {
        await this.identity();
        if (!this.dialog.isConnected) return;
        if (this.expired(preview)) return;
        this.requireNoPending();
        this.pending.add(preview.operationId);
        this.savePending();
        this.applied = true;
        const result = await this.shell.app._chatApi(`${ROOT}/apply`, {
          method: 'POST',
          body: { previewId: preview.previewId, expectedRevision: preview.revision },
        });
        await this.identity();
        if (result.ok && operation(result.data) && result.data.id === preview.operationId) {
          this.recordOperation(result.data);
          this.renderOperations([result.data]);
          this.status.textContent = result.data.message;
        } else this.status.textContent = 'Rollout outcome is unconfirmed. Check rollout; do not apply another change.';
      } catch (error) {
        this.error.textContent = error.message || 'Rollout response unavailable.';
        this.status.textContent = this.applied
          ? 'Rollout outcome is unconfirmed. Check rollout; do not apply another change.'
          : 'No new Apply was sent. Check rollout status before another change.';
      } finally {
        this.busy = false;
        this.sync();
      }
    }
    expired(preview) {
      if (Date.now() < preview.expiresAt) return false;
      this.invalidate();
      this.error.textContent = 'The preview expired. Refresh status and prepare another preview.';
      return true;
    }
    renderOperations(values) {
      this.results.replaceChildren();
      for (const value of values) {
        const box = this.shell.el('section', 'ca-fleet-operation');
        box.append(this.shell.el('h4', '', `Rollout ${value.state}`), this.shell.el('p', 'ca-hint', value.message));
        const list = this.shell.el('ul');
        for (const row of value.employees) {
          const name =
            this.data?.employees.find((employee) => employee.employeeId === row.employeeId)?.name || row.employeeId;
          list.append(
            this.shell.el(
              'li',
              '',
              `${name}: ${row.state}; ${row.verified ? 'verified' : 'not verified'}${row.reason ? ` — ${row.reason}` : ''}`
            )
          );
        }
        box.append(list);
        this.results.append(box);
      }
    }
    async checkOperations() {
      if (this.busy || !this.pending.size) return;
      this.busy = true;
      this.sync();
      this.error.textContent = '';
      try {
        await this.identity();
        const results = [];
        for (const operationId of [...this.pending]) {
          const result = await this.shell.app._chatApi(`${ROOT}/result`, { method: 'POST', body: { operationId } });
          await this.identity();
          if (!result.ok || !operation(result.data) || result.data.id !== operationId)
            throw new Error('Rollout status is unavailable. Its outcome remains unknown; do not apply another change.');
          this.recordOperation(result.data);
          results.push(result.data);
        }
        this.renderOperations(results);
        this.status.textContent = results.map((row) => row.message).join(' ');
      } catch (error) {
        this.error.textContent = error.message || 'Rollout status is unavailable.';
      } finally {
        this.busy = false;
        this.sync();
      }
    }
  }
  window.ReverieFleetResources = {
    mount: (shell, container, dialog) => new FleetPanel(shell, container, dialog),
    mountEmployee: (shell, container, dialog, employeeId) => new FleetPanel(shell, container, dialog, employeeId),
  };
})();
