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
    constructor(shell, container, dialog) {
      this.shell = shell;
      this.dialog = dialog;
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
      this.draft = shell.el('div', 'ca-fleet-preview');
      this.results = shell.el('div', 'ca-fleet-results');
      this.refresh = shell.button('ca-btn', 'Refresh laptop fleet status', () => this.load(), {
        text: 'Refresh status',
      });
      this.check = shell.button('ca-btn', 'Check laptop rollout status', () => this.checkOperations(), {
        text: 'Check rollout',
      });
      this.host.append(
        shell.el('h3', '', 'Laptop fleet'),
        shell.el(
          'p',
          'ca-hint',
          'Preview image and resource changes before restarting laptops. Soft RAM requests reclaim pressure; the hard ceiling remains. CPU weight shares available CPU rather than imposing a quota.'
        ),
        this.status,
        this.error,
        this.content,
        this.draft,
        this.results,
        this.refresh,
        this.check
      );
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
        node.disabled = locked;
      });
      this.refresh.disabled = this.busy;
      this.check.disabled = this.busy;
      this.check.hidden = this.pending.size === 0;
      if (this.apply) this.apply.disabled = locked || this.preview?.canApply !== true || this.applied;
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
            ? 'Host setup or verification is incomplete. No rollout can be prepared.'
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
      for (const employee of data.employees) this.form.append(this.renderEmployee(employee));
      const canaryLabel = s.el('label', 'ca-label');
      canaryLabel.append(s.el('span', '', 'Canary employee'), this.canary);
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
        poolBox.append(s.el('p', 'ca-hint', 'Pool settings are unavailable until host setup is verified.'));
      }
      return poolBox;
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
  window.ReverieFleetResources = { mount: (shell, container, dialog) => new FleetPanel(shell, container, dialog) };
})();
