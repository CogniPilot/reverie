/** Human client of the same Docker recovery API used by permitted agents.
 * All authority, resource decisions, and transitions remain on the server. */
(() => {
  const pending = new Map();
  const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
  const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const image = (v) => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
  const gib = (v) =>
    v === null ? 'No soft threshold' : Number.isSafeInteger(v) ? `${v / 1024 ** 3} GiB` : 'Unavailable';
  const copy = (v) => JSON.parse(JSON.stringify(v));
  class Panel {
    constructor(shell, host, dialog, employee) {
      this.shell = shell;
      this.dialog = dialog;
      this.employee = employee;
      this.binding = { id: employee.id, sessionId: employee.sessionId, generation: employee.sessionGeneration };
      this.key = JSON.stringify(this.binding);
      this.root = shell.el('section', 'ca-profile-docker-recovery');
      this.root.setAttribute('aria-label', 'Docker session recovery');
      this.status = shell.el('p', 'ca-hint', 'Checking Docker recovery status…');
      this.status.setAttribute('role', 'status');
      this.error = shell.el('p', 'ca-error');
      this.error.setAttribute('role', 'alert');
      this.policy = shell.el('div');
      this.controls = shell.el('div', 'ca-company-actions ca-fleet-actions');
      this.root.append(
        shell.el('h3', '', 'Docker session recovery'),
        this.status,
        this.error,
        this.policy,
        this.controls
      );
      host.append(this.root);
      this.busy = false;
      this.selection = null;
      this.operation = null;
      this.paint();
      void this.refresh();
    }
    live() {
      return (
        this.root.isConnected &&
        this.dialog.isConnected &&
        this.employee.id === this.binding.id &&
        this.employee.sessionId === this.binding.sessionId &&
        this.employee.sessionGeneration === this.binding.generation
      );
    }
    async api(suffix, body) {
      const response = await this.shell.app._chatApi(
        `/api/company/employees/${this.binding.id}/${suffix}`,
        body === undefined ? undefined : { method: 'POST', body }
      );
      if (!this.live()) throw Error('Employee profile changed. Reopen it to check the current session.');
      if (!response?.ok || !response.data || response.data.success === false) {
        const error = response?.data?.error;
        throw Error(typeof error === 'string' ? error : error?.code || 'Docker recovery request was not confirmed');
      }
      return response.data.data ?? response.data;
    }
    button(text, action) {
      const button = this.shell.button(
        'ca-btn',
        text,
        () => {
          void action();
        },
        { text }
      );
      button.disabled = this.busy;
      return button;
    }
    paint() {
      if (!this.live()) return;
      this.controls.replaceChildren(this.button('Refresh recovery status', () => this.refresh()));
      const held = pending.get(this.key);
      const operationId = held?.request.operationId ?? this.selection?.operationId;
      if (uuid(operationId)) {
        this.controls.append(this.button('Check original recovery', () => this.observe(operationId)));
        if (held && this.operation?.operationId === operationId && this.operation.allowedActions.includes('continue'))
          this.controls.append(this.button('Continue original recovery', () => this.start({ request: held.request })));
        return;
      }
      const s = this.selection;
      if (!s || s.state !== 'stopped') return;
      if (s.allowedActions.includes('continue') && s.policy && digest(s.policyDigest))
        this.controls.append(this.button('Recover and enter office', () => this.create(false)));
      else if (s.canApprovePolicy === true && s.proposedPolicy && digest(s.proposedPolicyDigest))
        this.controls.append(this.button('Approve displayed limits and recover', () => this.create(true)));
    }
    showPolicy(s) {
      this.policy.replaceChildren();
      const policy = s.policy ?? s.proposedPolicy;
      if (!policy) return;
      const table = this.shell.el('table', 'ca-fleet-table');
      const caption = this.shell.el(
        'caption',
        '',
        s.policy ? 'Approved resource policy' : 'Proposed resource policy — approval required'
      );
      table.append(caption);
      for (const [name, value] of [
        ['Soft RAM threshold', gib(policy.memoryHighBytes)],
        ['Employee hard RAM ceiling', gib(policy.memoryMaxBytes)],
        ['Shared pool hard RAM ceiling', gib(policy.pool?.memoryMaxBytes)],
        ['Swap allowance', gib(policy.swapMaxBytes)],
        ['CPU weight', String(policy.cpuWeight)],
        ['Allowed CPUs', Array.isArray(policy.allowedCpus) ? policy.allowedCpus.join(', ') : 'Unavailable'],
        ['Employee process limit', String(policy.pidsMax)],
        ['Shared pool process limit', String(policy.pool?.pidsMax)],
      ]) {
        const row = this.shell.el('tr');
        const heading = this.shell.el('th', '', name);
        heading.scope = 'row';
        row.append(heading, this.shell.el('td', '', value));
        table.append(row);
      }
      this.policy.append(
        table,
        this.shell.el(
          'p',
          'ca-hint',
          'These are requested limits. Recovery verifies enforcement before starting the employee. Soft RAM applies reclaim pressure; it does not reserve that amount of memory.'
        )
      );
    }
    async refresh() {
      if (this.busy || !this.live()) return;
      this.busy = true;
      this.operation = null;
      this.error.textContent = '';
      this.paint();
      try {
        const s = await this.api('docker-policy');
        if (
          s.sessionId !== this.binding.sessionId ||
          s.sessionGeneration !== this.binding.generation ||
          !digest(s.sourceDigest) ||
          !digest(s.containerId) ||
          !image(s.imageId) ||
          !image(s.destinationImageId) ||
          !Array.isArray(s.allowedActions)
        )
          throw Error('Recovery status does not match this employee session.');
        this.selection = copy(s);
        const original = s.originalRequest;
        if (uuid(s.operationId) && original) {
          if (
            original.operationId !== s.operationId ||
            original.sessionId !== s.sessionId ||
            original.sessionGeneration !== s.sessionGeneration ||
            original.containerId !== s.containerId ||
            original.imageId !== s.imageId ||
            original.expectedDestinationImageId !== s.destinationImageId ||
            !digest(original.expectedPolicyDigest) ||
            typeof original.enterOffice !== 'boolean'
          )
            throw Error('The original recovery request does not match this session.');
          if (!pending.has(this.key) && pending.size < 64) pending.set(this.key, { request: copy(original) });
        }
        this.showPolicy(s);
        this.status.textContent =
          uuid(s.operationId) || pending.has(this.key)
            ? 'An original recovery is retained. Check its outcome before starting anything else.'
            : s.state === 'running'
              ? 'A container is running. Provider readiness has not been verified by this status query.'
              : s.policy
                ? 'The employee is stopped. Recovery will verify these limits and enter the office.'
                : s.proposedPolicy
                  ? 'Review the proposed limits before approving recovery.'
                  : 'Owner resource policy approval is required. No reviewed policy proposal is available.';
        if (uuid(s.operationId) && s.operation) this.outcome(s.operation, s.operationId);
      } catch (error) {
        if (this.live()) {
          this.selection = null;
          this.status.textContent = 'Docker recovery status is unavailable.';
          this.error.textContent = error.message;
        }
      } finally {
        this.busy = false;
        this.paint();
      }
    }
    create(approve) {
      const s = this.selection;
      if (this.busy || !this.live() || !s || pending.has(this.key) || uuid(s.operationId)) return;
      if (pending.size >= 64) {
        this.error.textContent = 'Too many retained recovery outcomes. Check existing recoveries first.';
        return;
      }
      const body = {
        request: {
          operationId: crypto.randomUUID(),
          sessionId: s.sessionId,
          sessionGeneration: s.sessionGeneration,
          containerId: s.containerId,
          imageId: s.imageId,
          expectedDestinationImageId: s.destinationImageId,
          expectedPolicyDigest: approve ? s.proposedPolicyDigest : s.policyDigest,
          enterOffice: true,
        },
      };
      if (approve)
        body.policyApproval = {
          sessionId: s.sessionId,
          sessionGeneration: s.sessionGeneration,
          expectedSourceDigest: s.sourceDigest,
          policy: copy(s.proposedPolicy),
        };
      pending.set(this.key, copy(body)); // Before POST: a lost reply must never create a second operation.
      void this.start(body);
    }
    outcome(data, operationId) {
      if (
        data.operationId !== operationId ||
        !['ready', 'pending', 'held'].includes(data.state) ||
        typeof data.phase !== 'string' ||
        !Array.isArray(data.allowedActions)
      )
        throw Error('The recovery response is incomplete or belongs to another operation.');
      this.operation = copy(data);
      if (this.selection) this.selection.operationId = operationId;
      this.status.textContent =
        data.state === 'ready' ? 'Employee session recovery completed.' : `Recovery ${data.state}: ${data.phase}.`;
      this.error.textContent = typeof data.code === 'string' ? data.code : '';
      if (data.state === 'ready') pending.delete(this.key);
    }
    async start(body) {
      if (this.busy || !this.live()) return;
      this.busy = true;
      this.operation = null;
      this.error.textContent = '';
      this.status.textContent = 'Recovering this employee…';
      this.paint();
      try {
        this.outcome(await this.api('docker-continuation', copy(body)), body.request.operationId);
      } catch (error) {
        if (this.live()) {
          this.status.textContent = 'Recovery outcome is unconfirmed.';
          this.error.textContent = `${error.message}. Check the original recovery; no action was retried automatically.`;
        }
      } finally {
        this.busy = false;
        this.paint();
      }
    }
    async observe(operationId) {
      if (this.busy || !this.live()) return;
      this.busy = true;
      this.operation = null;
      this.error.textContent = '';
      this.paint();
      try {
        this.outcome(await this.api('docker-continuation/observe', { operationId }), operationId);
      } catch (error) {
        if (this.live()) {
          this.status.textContent = 'The original recovery could not be verified.';
          this.error.textContent = error.message;
        }
      } finally {
        this.busy = false;
        this.paint();
      }
    }
  }
  globalThis.ReverieDockerEmployeeRecovery = Object.freeze({
    mount: (shell, host, dialog, employee) => new Panel(shell, host, dialog, employee),
  });
})();
