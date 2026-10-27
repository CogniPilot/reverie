/** Company roster and genuine nightly research receipts. All supplied text uses textContent. */
Object.assign(ReverieApp.prototype, {
  async _companyApi(path, method = 'GET', body) {
    const response = await this._api(`/api/company${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    if (!response) throw new Error('Connection unavailable');
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(result.error || 'Company request failed');
    return result.data ?? result;
  },

  async openCompany(roomId) {
    if (this._chatApp?.built && this._chatApp.openCompany) return this._chatApp.openCompany();
    return this.openLegacyCompany(roomId);
  },

  async openLegacyCompany(roomId) {
    if (!this._companyPanel) {
      const panel = document.createElement('dialog');
      panel.setAttribute('aria-label', 'Company agents');
      panel.className = 'reverie-company-dialog';
      Object.assign(panel.style, {
        overflow: 'auto',
        color: 'var(--text-primary, #eee)',
        background: 'var(--bg-primary, #18191f)',
        border: '1px solid #555',
        borderRadius: '12px',
        padding: '24px',
      });
      document.body.append(panel);
      this._companyPanel = panel;
    }
    this._companyRoomId = roomId;
    if (!this._companyPanel.open) this._companyPanel.showModal();
    await this._renderCompany();
  },

  async _renderCompany() {
    const panel = this._companyPanel;
    const el = (tag, text) => {
      const node = document.createElement(tag);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const button = (text, action) => {
      const node = el('button', text);
      node.type = 'button';
      node.addEventListener('click', async () => {
        node.disabled = true;
        try {
          await action();
        } catch (error) {
          status.textContent = error.message;
        } finally {
          node.disabled = false;
        }
      });
      return node;
    };
    panel.replaceChildren();
    panel.append(
      button('Close', () => panel.close()),
      el('h2', 'Company agents')
    );
    const status = el('p');
    status.setAttribute('role', 'status');
    panel.append(status);
    try {
      const data = await this._companyApi('');
      panel.append(
        el(
          'p',
          'Permanent employees are explicitly registered experts with stable identities. Temporary workers get an Agent identifier and icon and join their parent’s channel when it is unambiguous. Personal memories remain with the configured agent runtime.'
        )
      );
      // Owner header
      if (data.settings.ownerName || data.settings.ownerTitle) {
        const ownerHeader = el('section');
        ownerHeader.style.cssText = 'margin:12px 0;padding:12px 16px;border:1px solid #444;border-radius:8px;background:rgba(255,255,255,0.03);';
        ownerHeader.append(el('h3', `${data.settings.ownerName || 'Owner'} · ${data.settings.ownerTitle || ''}`));
        panel.append(ownerHeader);
      }
      // Org chart
      const orgChart = el('section');
      orgChart.append(el('h3', 'Reverie organization'));
      const tree = el('pre');
      tree.style.cssText = 'font-size:0.9em;line-height:1.6;color:var(--text-secondary,#bbb);';
      const lines = [];
      lines.push(`${data.settings.ownerName || 'Owner'} (${data.settings.ownerTitle || 'CEO'})`);
      const coordinator = data.employees.find((e) => e.id === data.settings.coordinatorEmployeeId);
      const otherEmployees = data.employees.filter((e) => e.id !== data.settings.coordinatorEmployeeId);
      for (const emp of otherEmployees) {
        lines.push(`├── ${emp.icon} ${emp.name} (${emp.position})`);
      }
      if (coordinator) {
        lines.push(`└── ${coordinator.icon} ${coordinator.name} (${coordinator.position})`);
        const tempWorkers = data.temporaryAgents || [];
        for (const tw of tempWorkers) {
          lines.push(`    └── ${tw.icon} ${tw.name} (temporary)`);
        }
      }
      tree.textContent = lines.join('\n');
      orgChart.append(tree);
      panel.append(orgChart);
      const roster = el('section');
      roster.append(el('h3', 'Registered experts'));
      if (!data.employees.length) roster.append(el('p', 'No permanent employees have been hired.'));
      for (const employee of data.employees) {
        const card = el('article');
        card.append(
          el('h4', `${employee.icon} ${employee.name} · ${employee.position}`),
          el('p', employee.expertise.join(', ')),
          el('p', employee.available ? 'Registered session available' : 'Registered session disconnected')
        );
        const form = el('form');
        const channel = el('input');
        channel.placeholder = 'Channel ID to invite this expert';
        channel.setAttribute('aria-label', `Channel for ${employee.name}`);
        channel.value = this._companyRoomId || '';
        form.addEventListener('submit', (event) => event.preventDefault());
        form.append(
          channel,
          button('Invite to channel', async () => {
            await this._companyApi(`/employees/${employee.id}/invite`, 'POST', { roomId: channel.value.trim() });
            status.textContent = `${employee.name} joined the channel.`;
          })
        );
        card.append(form);
        if (data.canManage) {
          const ownerControls = el('details'); ownerControls.append(el('summary', 'Edit profile and permissions'));
          const recoveryLabel = el('label', ' May recover disconnected employee sessions ');
          const recovery = el('input');
          recovery.type = 'checkbox';
          recovery.checked = employee.permissions?.recoverEmployees === true;
          recovery.setAttribute('aria-label', `Recovery permission for ${employee.name}`);
          recoveryLabel.prepend(recovery);
          ownerControls.append(
            recoveryLabel,
            button('Save permissions', async () => {
              const result = await this._companyApi(`/employees/${employee.id}`, 'PUT', {
                permissions: { recoverEmployees: recovery.checked },
              });
              if (result.employee?.id !== employee.id || result.employee.permissions?.recoverEmployees !== recovery.checked)
                throw new Error('Save not confirmed. Reopen Company to check the current value.');
              employee.permissions = { ...employee.permissions, recoverEmployees: recovery.checked };
              status.textContent = 'Employee permissions saved.';
            })
          );
          const permissions = el('fieldset'); permissions.append(el('legend', 'Board and plan permissions'));
          const fields = [
            ['editBoardIssues', 'Update own board work', 'File triage cards, update own cards, and record own wins and focus.', true],
            ['manageBoard', 'Manage company board', 'Edit and reassign all cards, milestones, blockers and schedules. Includes updating own board work.', true],
            ['manageDecisions', 'Prepare decision cards', 'Prepare, annotate and dismiss decisions and poll notes. Only the owner chooses answers; creating choices also requires the site’s decision-write setting.', true],
            ['moveOwnPlan', 'Move own plan', 'Requires your handoff and approval; grants no provider account administration.', false],
            ['managePlans', 'Manage team plans', 'Requests still require the affected expert’s handoff and approval.', false],
          ];
          const inputs = {}, pending = new Set();
          const paintPermissions = () => {
            for (const [key, , detail, board] of fields) {
              const { input, note } = inputs[key];
              const value = board ? employee.effectiveBoardPermissions?.[key] : employee.permissions?.[key] === true;
              const included = key === 'editBoardIssues' && employee.effectiveBoardPermissions?.manageBoard === true;
              input.checked = value === true;
              input.disabled = pending.has(key) || (board && fields.some(([field, , , isBoard]) => isBoard && pending.has(field))) || included || typeof value !== 'boolean';
              note.textContent = !board ? '' : typeof value !== 'boolean' ? 'Current access unavailable; reopen Company after updating the server.'
                : included ? 'Included with Manage company board.' : employee.boardPermissionSources?.[key] === 'legacy'
                  ? 'Inherited current policy. Toggle to set an explicit choice.' : 'Owner-selected permission.';
              input.closest('label').title = detail;
            }
          };
          for (const [key, text, , board] of fields) {
            const wrap = el('label'), input = el('input'), note = el('small');
            input.type = 'checkbox'; input.setAttribute('aria-label', `${text} for ${employee.name}`);
            wrap.append(input, document.createTextNode(` ${text} `), note); permissions.append(wrap);
            inputs[key] = { input, note };
            input.addEventListener('change', async () => {
              if (input.disabled) return;
              const value = input.checked; pending.add(key); input.disabled = true; status.textContent = 'Saving permissions…';
              if (board) for (const [field, , , isBoard] of fields) if (isBoard) inputs[field].input.disabled = true;
              try {
                const result = await this._companyApi(`/employees/${employee.id}`, 'PUT', { permissions: { [key]: value } });
                const saved = result.employee;
                if (saved?.id !== employee.id || saved.permissions?.[key] !== value)
                  throw new Error('Save not confirmed. Reopen Company to check the current value.');
                if (board && !fields.filter(([, , , isBoard]) => isBoard).every(([field]) =>
                  typeof saved.effectiveBoardPermissions?.[field] === 'boolean' &&
                  ['explicit', 'legacy', 'included'].includes(saved.boardPermissionSources?.[field])))
                  throw new Error('Permission saved, but current access could not be read. Reopen Company to check it.');
                employee.permissions = { ...employee.permissions, [key]: value };
                if (board) {
                  employee.effectiveBoardPermissions = saved.effectiveBoardPermissions;
                  employee.boardPermissionSources = saved.boardPermissionSources;
                }
                status.textContent = 'Employee permissions saved.';
              } catch (error) { status.textContent = `Could not save permissions: ${error.message}`; }
              finally { pending.delete(key); paintPermissions(); }
            });
          }
          paintPermissions(); ownerControls.append(permissions);
          const reconnect = el('input');
          reconnect.placeholder = 'Owned session ID for this permanent identity';
          reconnect.setAttribute('aria-label', `Registered session for ${employee.name}`);
          reconnect.value = employee.sessionId || '';
          ownerControls.append(
            reconnect,
            button('Reconnect registered session', async () => {
              await this._companyApi(`/employees/${employee.id}/session`, 'PUT', { sessionId: reconnect.value.trim() });
              await this._renderCompany();
            })
          );
          ownerControls.append(
            button('Assign briefing coordinator', async () => {
              await this._companyApi('/settings', 'PUT', { ...data.settings, coordinatorEmployeeId: employee.id });
              await this._renderCompany();
            })
          );
          const memory = el('textarea');
          memory.placeholder = 'Company note for this employee (personal memory stays in their runtime)';
          memory.setAttribute('aria-label', `Company note for ${employee.name}`);
          ownerControls.append(
            memory,
            button('Save company note', async () => {
              await this._companyApi(`/employees/${employee.id}/memories`, 'POST', {
                text: memory.value,
                kind: 'note',
              });
              memory.value = '';
              status.textContent = 'Company note saved.';
            })
          );
          card.append(ownerControls);
        }
        roster.append(card);
      }
      panel.append(roster);
      if (data.canManage) {
        const hire = el('form');
        hire.append(el('h3', 'Hire a permanent expert'));
        const fields = {};
        for (const [key, label] of [
          ['name', 'Human name'],
          ['icon', 'Icon'],
          ['position', 'Company position'],
          ['expertise', 'Expertise (comma separated)'],
          ['sessionId', 'Existing owned agent session ID'],
        ]) {
          const labelNode = el('label', `${label} `);
          const input = el('input');
          input.name = key;
          input.required = true;
          labelNode.append(input);
          hire.append(labelNode, el('br'));
          fields[key] = input;
        }
        const hireBoard = {}, boardChoices = el('fieldset'); boardChoices.append(el('legend', 'Board permissions'));
        for (const [key, text, detail] of [
          ['editBoardIssues', 'Update own board work', 'File triage cards and update own cards, wins and focus.'],
          ['manageBoard', 'Manage company board', 'Manage everyone’s cards and schedules; includes own board work.'],
          ['manageDecisions', 'Prepare decision cards', 'Prepare decision proposals; only the owner chooses answers.'],
        ]) {
          const wrap = el('label'), input = el('input'); input.type = 'checkbox'; input.checked = key === 'editBoardIssues';
          input.setAttribute('aria-label', `${text} for new expert`); wrap.title = detail;
          wrap.append(input, document.createTextNode(` ${text} `)); boardChoices.append(wrap); hireBoard[key] = input;
        }
        let basicBoardChoice = true;
        hireBoard.editBoardIssues.addEventListener('change', () => { basicBoardChoice = hireBoard.editBoardIssues.checked; });
        hireBoard.manageBoard.addEventListener('change', () => {
          hireBoard.editBoardIssues.checked = hireBoard.manageBoard.checked || basicBoardChoice;
          hireBoard.editBoardIssues.disabled = hireBoard.manageBoard.checked;
        });
        hire.append(boardChoices);
        hire.addEventListener('submit', (event) => event.preventDefault());
        hire.append(
          button('Hire registered session', async () => {
            if (!hire.reportValidity()) return;
            await this._companyApi('/employees', 'POST', {
              name: fields.name.value,
              icon: fields.icon.value,
              position: fields.position.value,
              expertise: fields.expertise.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
              sessionId: fields.sessionId.value.trim(),
              permissions: { editBoardIssues: basicBoardChoice, manageBoard: hireBoard.manageBoard.checked, manageDecisions: hireBoard.manageDecisions.checked },
              researchEnabled: true,
            });
            await this._renderCompany();
          })
        );
        panel.append(hire);
        const ownerForm = el('form');
        ownerForm.append(el('h3', 'Owner record'));
        const ownerNameInput = el('input');
        ownerNameInput.placeholder = 'Owner display name';
        ownerNameInput.value = data.settings.ownerName || '';
        ownerNameInput.setAttribute('aria-label', 'Owner display name');
        const ownerTitleInput = el('input');
        ownerTitleInput.placeholder = 'Owner title (e.g. CEO)';
        ownerTitleInput.value = data.settings.ownerTitle || '';
        ownerTitleInput.setAttribute('aria-label', 'Owner title');
        ownerForm.append(
          el('label', 'Name '), ownerNameInput, el('br'),
          el('label', 'Title '), ownerTitleInput, el('br')
        );
        ownerForm.addEventListener('submit', (event) => event.preventDefault());
        ownerForm.append(
          button('Save owner record', async () => {
            await this._companyApi('/settings', 'PUT', {
              ...data.settings,
              ownerName: ownerNameInput.value.trim(),
              ownerTitle: ownerTitleInput.value.trim(),
            });
            await this._renderCompany();
          })
        );
        panel.append(ownerForm);
        const settings = el('form');
        settings.append(el('h3', 'Nightly exploration & morning briefing'));
        const enabled = el('input');
        enabled.type = 'checkbox';
        enabled.checked = data.settings.enabled;
        const enableLabel = el('label', 'Enable dedicated tool-capable research sessions ');
        enableLabel.append(enabled);
        settings.append(enableLabel, el('br'));
        const controls = {};
        for (const [key, label, type] of [
          ['timeZone', 'IANA timezone', 'text'],
          ['nightHour', 'Night hour (0–23)', 'number'],
          ['morningHour', 'Morning hour (0–23)', 'number'],
          ['researchMinutes', 'Research minutes per employee (1–120)', 'number'],
          ['briefingMinutes', 'company briefing minutes (1–30)', 'number'],
        ]) {
          const input = el('input');
          input.type = type;
          input.value = data.settings[key];
          const labelNode = el('label', `${label} `);
          labelNode.append(input);
          settings.append(labelNode, el('br'));
          controls[key] = input;
        }
        settings.addEventListener('submit', (event) => event.preventDefault());
        settings.append(
          button('Save research schedule', async () => {
            const changes = { ...data.settings, enabled: enabled.checked };
            for (const [key, input] of Object.entries(controls))
              changes[key] = input.type === 'number' ? Number(input.value) : input.value;
            await this._companyApi('/settings', 'PUT', changes);
            await this._renderCompany();
          })
        );
        panel.append(
          settings,
          el(
            'p',
            `Briefing coordinator: ${data.employees.find((e) => e.id === data.settings.coordinatorEmployeeId)?.name || 'Unassigned'}. Research uses separate sessions and cannot interrupt an employee’s working session.`
          )
        );
      }
      const reports = el('section');
      reports.append(
        el('h3', 'Research receipts & company briefings'),
        el(
          'p',
          'Observed results below are agent reports with evidence for review. Hypotheses and imagination are unverified. No completion is shown until an actual agent session returns a report.'
        )
      );
      if (!data.cycles.length) reports.append(el('p', 'No research cycles yet.'));
      for (const cycle of [...data.cycles].reverse().slice(0, 50)) {
        const details = el('details');
        details.append(
          el(
            'summary',
            `${cycle.date} · ${data.employees.find((e) => e.id === cycle.employeeId)?.name || 'Employee'} · ${cycle.kind} · ${cycle.state}`
          )
        );
        if (cycle.error) details.append(el('p', cycle.error));
        if (cycle.result) {
          details.append(el('p', cycle.result.summary));
          for (const finding of cycle.result.findings) {
            details.append(
              el('p', `${finding.status === 'observed' ? 'Observed (agent reported)' : 'Hypothesis'}: ${finding.text}`)
            );
            for (const evidence of finding.evidence) details.append(el('pre', evidence));
          }
        }
        reports.append(details);
      }
      reports.append(button('Refresh reports', () => this._renderCompany()));
      panel.append(reports);
    } catch (error) {
      status.textContent = error.message;
    }
  },
});

window.CompanyUI = {
  init(app) {
    this.app = app;
  },
  open(roomId) {
    return this.app?.openCompany(roomId);
  },
};
