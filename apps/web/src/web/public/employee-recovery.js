/** Human recovery controls over the same protected API used by Office agents.
 * The server supplies the original binding, retained operation and allowed actions.
 * Native observations describe progress; only application settlement can complete recovery.
 */
(() => {
  const actions = [
    ['reconcileOwned', 'reconcile-owned', 'Reconcile session'],
    ['stopProvider', 'stop-provider', 'Stop provider'],
    ['closeViewer', 'close-viewer', 'Close terminal viewer'],
    ['observeOriginal', null, 'Inspect original operation'],
    ['closeRetainedViewer', 'close-viewer', 'Close retained terminal viewer'],
  ];
  const reasons = {
    'no-native-channel': 'Native recovery is unavailable on this server.',
    'unsupported-provider': 'This session does not support native recovery.',
    'original-owner-unavailable': 'The original recovery owner is unavailable. Its record has been kept.',
    'recovery-preparing': 'The original recovery is being prepared. Refresh its status.',
    'existing-recovery': 'Inspect the existing recovery before starting another action.',
    'no-original-operation': 'There is no retained recovery operation to inspect.',
    'component-required': 'Inspect the original operation before closing its retained viewer.',
    'original-binding-unavailable': 'The original session binding could not be verified.',
    'action-approval-required': 'This action requires its own explicit recovery permission.',
  };
  const observations = {
    'original-handler-pending': 'The original session handler is still pending.',
    'original-handler-reconciled': 'The original handler has reconciled.',
    'provider-stop-pending': 'The provider stop is still pending.',
    'provider-stopped-viewer-pending': 'The provider has stopped; its terminal viewer still needs recovery.',
    'provider-stopped': 'The provider has stopped.',
    'viewer-close-pending': 'The terminal viewer close is still pending.',
    'viewer-closed': 'The terminal viewer has closed.',
    'custody-unavailable': 'The original resources could not be verified.',
    'refused-before-new-effect': 'The native action was refused before a new effect.',
    unconfirmed: 'The native outcome is unconfirmed.',
  };
  // Display-only closed data. Codes never change recovery state or action availability.
  const diagnosticMessages = (value) => {
    if (value === undefined) return [];
    const keys = ['primaryCode', 'secondaryCode'];
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      !keys.every(
        (key) =>
          Object.hasOwn(value, key) &&
          (value[key] === null || (typeof value[key] === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value[key])))
      ) ||
      keys.every((key) => value[key] === null)
    )
      return null;
    return [
      value.primaryCode === null ? '' : 'Primary recovery error: ' + value.primaryCode + '.',
      value.secondaryCode === null ? '' : 'Cleanup error: ' + value.secondaryCode + '.',
    ].filter(Boolean);
  };

  const approvalKeys = [
    'operationId',
    'sessionId',
    'sessionGeneration',
    'originalAttemptId',
    'parentOperationId',
    'action',
  ];
  const id = (value) => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
  const sameApproval = (left, right) => left && right && approvalKeys.every((key) => left[key] === right[key]);
  const approval = (value, binding) =>
    value &&
    id(value.operationId) &&
    value.sessionId === binding.sessionId &&
    value.sessionGeneration === binding.sessionGeneration &&
    (value.originalAttemptId === null || id(value.originalAttemptId)) &&
    (value.parentOperationId === null || id(value.parentOperationId)) &&
    ['reconcile-owned', 'stop-provider', 'close-viewer'].includes(value.action);
  const stoppedMessage = 'Recovery completed with its provider stopped. Enter office is a separate action.';
  const application = (value, original) => {
    if (
      !value ||
      !['not-applicable', 'known-unused-retired', 'issued-native-retired', 'unconfirmed'].includes(
        value.intentRetirement
      )
    )
      return false;
    if (value.state === 'recovery-required') return true;
    return (
      value.state === 'completed-stopped' &&
      original?.action === 'stop-provider' &&
      original.parentOperationId === null &&
      (original.originalAttemptId === null
        ? ['not-applicable', 'known-unused-retired'].includes(value.intentRetirement)
        : value.intentRetirement === 'issued-native-retired')
    );
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const failureSentence = (error) => `${(error?.message || 'Request failed').trim().replace(/[.!?]+$/, '')}.`;
  // UI correlation only. Keeping an uncertain request across profile reopen
  // prevents a lost reply from offering a fresh operation ID in the same page.
  // These records never grant action authority or clear a server fence.
  const uncertain = new Map();

  class RecoveryPanel {
    constructor(shell, container, dialog, employee) {
      this.shell = shell;
      this.dialog = dialog;
      this.employee = employee;
      this.origin = shell.companyPage;
      this.binding = Object.freeze({
        employeeId: employee.id,
        sessionId: employee.sessionId,
        sessionGeneration: String(employee.sessionGeneration),
      });
      const cached = shell.company?.employees?.find((row) => row.id === employee.id);
      this.cachedBinding =
        cached &&
        Object.freeze({
          sessionId: cached.sessionId,
          sessionGeneration: String(cached.sessionGeneration),
        });
      this.key = JSON.stringify(this.binding);
      this.path = `/api/company/employees/${encodeURIComponent(employee.id)}/recovery`;
      this.state = { kind: 'loading' };
      this.sequence = 0;
      this.host = shell.el('section', 'ca-employee-recovery');
      this.host.setAttribute('aria-label', `Session recovery for ${employee.name}`);
      this.status = shell.el('p', 'ca-hint', 'Checking recovery status…');
      this.status.setAttribute('role', 'status');
      this.error = shell.el('p', 'ca-company-error');
      this.error.setAttribute('role', 'alert');
      this.controls = shell.el('div', 'ca-company-actions');
      this.explanation = shell.el('p', 'ca-hint');
      this.refresh = shell.button('ca-btn', `Refresh recovery status for ${employee.name}`, () => this.load(), {
        text: 'Refresh recovery status',
      });
      this.host.append(
        shell.el('h4', '', 'Session recovery'),
        this.status,
        this.error,
        this.explanation,
        this.controls,
        this.refresh
      );
      container.append(this.host);
      dialog.addEventListener(
        'close',
        () => {
          this.state = { kind: 'closed' };
          this.sequence++;
          this.controller?.abort();
        },
        { once: true }
      );
      void this.load();
    }
    live() {
      const cached = this.shell.company?.employees?.find((row) => row.id === this.binding.employeeId);
      if (
        this.state.kind === 'closed' ||
        !this.dialog.isConnected ||
        (this.origin && this.shell.companyPage !== this.origin)
      )
        return false;
      const current =
        (!this.cachedBinding ||
          (cached?.sessionId === this.cachedBinding.sessionId &&
            String(cached.sessionGeneration) === this.cachedBinding.sessionGeneration)) &&
        this.employee.id === this.binding.employeeId &&
        this.employee.sessionId === this.binding.sessionId &&
        String(this.employee.sessionGeneration) === this.binding.sessionGeneration;
      if (!current) {
        this.state = { kind: 'unconfirmed' };
        this.status.textContent = 'The employee session changed.';
        this.error.textContent =
          'Reopen this profile to inspect the current session. The original recovery request has been kept.';
        for (const button of this.host.querySelectorAll('button')) button.disabled = true;
      }
      return current;
    }
    decode(value) {
      const b = this.binding;
      if (
        !value ||
        value.version !== 1 ||
        value.purpose !== 'employee-recovery-selection-v1' ||
        value.employeeId !== b.employeeId ||
        value.sessionId !== b.sessionId ||
        value.sessionGeneration !== b.sessionGeneration ||
        value.readOnly !== true ||
        !['retained-native-dispatch', 'saved-native-denial', 'unavailable'].includes(value.provider?.source) ||
        !(value.provider.originalAttemptId === null || id(value.provider.originalAttemptId)) ||
        value.provider.providerExecution !== 'unproved' ||
        !['acknowledged-never-claimed', 'none', 'unconfirmed'].includes(value.unusedIntent) ||
        !['none', 'preparing', 'retained', 'owner-unavailable'].includes(value.recovery?.kind) ||
        !actions.every(([key]) => {
          const item = value.availability?.[key];
          return (
            item &&
            ['available', 'unavailable'].includes(item.state) &&
            (item.reason === null || Object.hasOwn(reasons, item.reason))
          );
        })
      )
        throw Error('Recovery status does not match the current session.');
      if (['retained', 'owner-unavailable'].includes(value.recovery.kind)) {
        const retained = value.recovery,
          parent = retained.approval,
          child = retained.componentApproval;
        if (
          !approval(parent, b) ||
          parent.parentOperationId !== null ||
          !(
            child === null ||
            (approval(child, b) &&
              child.parentOperationId === parent.operationId &&
              child.action === 'close-viewer' &&
              child.originalAttemptId === parent.originalAttemptId)
          ) ||
          !application(retained.application, parent)
        )
          throw Error('The original recovery reference is unconfirmed.');
      }
      return copy(value);
    }
    canRun(key, action, selected) {
      if (selected.availability[key]?.state !== 'available') return false;
      const pending = uncertain.get(this.key);
      return (
        !pending ||
        key === 'observeOriginal' ||
        sameApproval(pending, selected.recovery.approval) ||
        sameApproval(pending, selected.recovery.componentApproval) ||
        (selected.recovery.kind === 'none' &&
          pending.parentOperationId === null &&
          pending.action === action &&
          pending.originalAttemptId === selected.provider.originalAttemptId) ||
        (key === 'closeRetainedViewer' && pending.parentOperationId === selected.recovery.approval?.operationId)
      );
    }
    async request(path, options) {
      const controller = new AbortController();
      this.controller = controller;
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const result = await this.shell.app._chatApi(path, { ...options, signal: controller.signal });
        if (!result.ok)
          throw Error(
            result.status === 401
              ? 'Sign in again as the owner. Your profile draft has been kept.'
              : result.error || 'Recovery request was not confirmed.'
          );
        return result.data;
      } finally {
        clearTimeout(timer);
        if (this.controller === controller) this.controller = null;
      }
    }
    paint() {
      this.controls.replaceChildren();
      this.explanation.textContent = '';
      const ready = this.state.kind === 'ready';
      this.refresh.disabled = ['loading', 'busy', 'closed'].includes(this.state.kind);
      const selected = this.state.selection;
      if (!selected) return;
      for (const [key, action, label] of actions) {
        const allowed = selected.availability[key];
        if (allowed.state !== 'available') continue;
        const button = this.shell.button(
          action === 'stop-provider' ? 'ca-btn is-danger' : 'ca-btn',
          `${label} for ${this.employee.name}`,
          () => this.run(key, action),
          { text: label }
        );
        button.disabled = !ready || !this.canRun(key, action, selected);
        if (allowed.reason) button.title = reasons[allowed.reason];
        this.controls.append(button);
      }
      this.explanation.textContent = [
        ...new Set(
          actions
            .map(([key]) => selected.availability[key].reason)
            .filter(
              (reason) =>
                reason && !['no-original-operation', 'component-required', 'existing-recovery'].includes(reason)
            )
            .map((reason) => reasons[reason])
        ),
      ].join(' ');
    }
    async load() {
      if (!this.live() || (['loading', 'busy'].includes(this.state.kind) && this.sequence > 0)) return;
      const sequence = ++this.sequence;
      this.state = { kind: 'loading' };
      this.status.textContent = 'Checking recovery status…';
      this.error.textContent = '';
      this.paint();
      try {
        const selection = this.decode(await this.request(this.path + '-selection'));
        if (!this.live() || sequence !== this.sequence) return;
        this.key = JSON.stringify([this.binding, selection.provider.originalAttemptId]);
        this.state = { kind: 'ready', selection };
        const kind = selection.recovery.kind;
        this.status.textContent =
          selection.recovery.application?.state === 'completed-stopped'
            ? stoppedMessage
            : kind === 'none'
              ? 'No recovery operation is registered.'
              : kind === 'preparing'
                ? 'The original recovery is being prepared.'
                : kind === 'owner-unavailable'
                  ? reasons['original-owner-unavailable']
                  : 'The original recovery is retained. Inspect its status before continuing.';
        const pending = uncertain.get(this.key);
        if (
          pending &&
          (sameApproval(pending, selection.recovery.approval) ||
            sameApproval(pending, selection.recovery.componentApproval))
        )
          uncertain.delete(this.key);
        else if (pending)
          this.error.textContent =
            'The previous request is unconfirmed. Its operation reference has been kept; an explicit continuation reuses that same operation.';
      } catch (error) {
        if (!this.live() || sequence !== this.sequence) return;
        this.state = { kind: 'unconfirmed' };
        this.status.textContent = 'Recovery status is unavailable.';
        this.error.textContent = `${failureSentence(error)} Refresh recovery status before continuing.`;
      }
      if (this.live() && sequence === this.sequence) this.paint();
    }
    operation(key, action, selection) {
      const retained = selection.recovery;
      if (key === 'observeOriginal') return retained.approval;
      const pending = uncertain.get(this.key);
      if (pending) return pending;
      if (key === 'closeRetainedViewer') {
        if (retained.componentApproval) return retained.componentApproval;
        return {
          ...retained.approval,
          operationId: globalThis.crypto.randomUUID(),
          parentOperationId: retained.approval.operationId,
          action,
        };
      }
      if (retained.kind === 'retained') return retained.approval;
      return {
        operationId: globalThis.crypto.randomUUID(),
        sessionId: selection.sessionId,
        sessionGeneration: selection.sessionGeneration,
        originalAttemptId: selection.provider.originalAttemptId,
        parentOperationId: null,
        action,
      };
    }
    async run(key, action) {
      if (!this.live() || this.state.kind !== 'ready') return;
      const selection = this.state.selection;
      if (!this.canRun(key, action, selection)) return;
      const originalState = this.state;
      this.state = { kind: 'busy', selection };
      this.error.textContent = '';
      this.paint();
      try {
        if (action && action !== 'reconcile-owned') {
          const stop = action === 'stop-provider';
          if (
            !(await this.shell.confirmCompanyAction(
              this.employee.name,
              stop
                ? `Stop the provider for ${this.employee.name}? Current agent work will be interrupted.`
                : `Close the original terminal viewer for ${this.employee.name}? This recovery action does not start a replacement viewer.`,
              stop ? 'Stop provider' : 'Close terminal viewer'
            ))
          ) {
            if (this.live()) {
              this.state = originalState;
              this.paint();
            }
            return;
          }
        }
        if (!this.live()) return;
        const input = copy(this.operation(key, action, selection));
        const pending = uncertain.get(this.key);
        if (
          !approval(input, this.binding) ||
          (action && input.action !== action) ||
          (action && pending && !sameApproval(pending, input))
        )
          throw Error('The previous operation still needs inspection.');
        if (action) {
          if (!pending && uncertain.size >= 128)
            throw Error('The retained recovery requests need inspection before starting another operation.');
          uncertain.set(this.key, input);
        }
        const sequence = ++this.sequence;
        this.status.textContent = action ? 'Requesting recovery…' : 'Inspecting the original operation…';
        const result = await this.request(this.path + (action ? '' : '/observe'), {
          method: 'POST',
          body: { approval: input },
        });
        if (!this.live() || sequence !== this.sequence) return;
        const native = result?.native,
          appResult = result?.application,
          details = diagnosticMessages(native?.diagnostics);
        if (
          !native ||
          native.version !== 1 ||
          native.purpose !== 'employee-recovery-v1' ||
          native.employeeId !== this.binding.employeeId ||
          !sameApproval(native.approval, input) ||
          !Object.hasOwn(observations, native.outcome) ||
          details === null ||
          !application(appResult, input) ||
          (appResult.state === 'completed-stopped' &&
            (key !== 'observeOriginal' || native.outcome !== 'provider-stopped'))
        )
          throw Error('The recovery response is incomplete or belongs to another operation.');
        if (sameApproval(uncertain.get(this.key), input)) uncertain.delete(this.key);
        this.state = { kind: 'unconfirmed' };
        this.status.textContent =
          appResult.state === 'completed-stopped'
            ? stoppedMessage
            : `${observations[native.outcome]} Recovery still requires attention. Refresh recovery status to inspect available actions.`;
        this.error.textContent = details.join(' ');
      } catch (error) {
        if (!this.live()) return;
        this.state = { kind: 'unconfirmed' };
        this.status.textContent = 'Recovery is unconfirmed.';
        this.error.textContent = `${failureSentence(error)} The original operation has been kept. Refresh recovery status; no action is retried automatically.`;
      }
      if (this.live()) this.paint();
    }
  }
  globalThis.ReverieEmployeeRecovery = Object.freeze({
    mount(shell, container, dialog, employee) {
      return new RecoveryPanel(shell, container, dialog, employee);
    },
  });
})();
