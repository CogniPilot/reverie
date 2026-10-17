/**
 * @fileoverview Cron Jobs UI mixed into
 * CodemanApp.prototype. Renders the job list + create/edit form in the
 * #cronModal, and reacts to cron:* SSE events.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js, api-client.js, constants.js (escapeHtml)
 */

Object.assign(CodemanApp.prototype, {
  // ── SSE handlers ──────────────────────────────────────────────────────────

  _onCronJobsChanged(data) {
    if (data && Array.isArray(data.jobs)) {
      this._cronJobs = data.jobs;
      if (this._isCronOpen()) this.renderCronJobs();
    } else if (this._isCronOpen()) {
      this.refreshCron();
    }
  },

  _onCronRunChanged() {
    // A run's status changed — refresh the list so lastStatus stays current.
    if (this._isCronOpen()) this.refreshCron();
  },

  // ── Modal open/close ──────────────────────────────────────────────────────

  _isCronOpen() {
    const el = document.getElementById('cronModal');
    return !!el && el.classList.contains('active');
  },

  openCron() {
    const el = document.getElementById('cronModal');
    if (!el) return;
    el.classList.add('active');
    this.cancelCronJobForm();
    this.refreshCron();
  },

  closeCron() {
    const el = document.getElementById('cronModal');
    if (el) el.classList.remove('active');
  },

  async refreshCron() {
    const jobs = await this._apiJson('/api/cron/jobs');
    this._cronJobs = Array.isArray(jobs) ? jobs : [];
    this.renderCronJobs();
  },

  // ── List rendering ────────────────────────────────────────────────────────

  renderCronJobs() {
    const list = document.getElementById('cronJobList');
    if (!list) return;
    const jobs = this._cronJobs || [];
    if (jobs.length === 0) {
      list.innerHTML = '<div class="form-hint">No cron jobs yet. Click “+ New Job”.</div>';
      return;
    }
    const rows = jobs.map((j) => {
      const next = j.enabled ? this._fmtTime(j.nextRunAt) : '—';
      const last = this._fmtTime(j.lastRunAt);
      const status = j.lastStatus ? escapeHtml(j.lastStatus) : '—';
      return `
        <div class="cron-job-row">
          <div class="cron-job-main">
            <div class="cron-job-name">${escapeHtml(j.name || '(unnamed)')}
              <span class="cron-badge">${escapeHtml(j.action === 'post' ? 'post' : j.agentType)}</span>
              <span class="cron-badge">${escapeHtml(this._fmtSchedule(j))}</span>
              ${j.enabled ? '' : '<span class="cron-badge cron-badge-off">disabled</span>'}
            </div>
            <div class="cron-job-meta">
              ${
                j.action === 'post'
                  ? `<span title="${escapeHtml(j.postText || '')}">${escapeHtml(j.dryRun ? '(dry run) ' : '')}${escapeHtml(j.postText || '')}</span>`
                  : `<span title="${escapeHtml(j.workingDir || '')}">${escapeHtml(j.workingDir || '')}</span>`
              }
              · next: ${escapeHtml(next)} · last: ${escapeHtml(last)} · status: ${status}
            </div>
          </div>
          <div class="cron-job-actions">
            <button class="btn-toolbar btn-sm btn-primary" onclick="app.runCronJob('${j.id}')">Run Now</button>
            <button class="btn-toolbar btn-sm" onclick="app.toggleCronJob('${j.id}', ${j.enabled ? 'false' : 'true'})">${j.enabled ? 'Disable' : 'Enable'}</button>
            <button class="btn-toolbar btn-sm" onclick="app.editCronJob('${j.id}')">Edit</button>
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.deleteCronJob('${j.id}')">Delete</button>
          </div>
        </div>`;
    });
    list.innerHTML = rows.join('');
  },

  _fmtTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return '—';
    }
  },

  _fmtSchedule(j) {
    switch (j.scheduleType) {
      case 'once':
        return 'once';
      case 'interval':
        return `every ${j.intervalMinutes}m`;
      case 'daily':
        return `daily ${j.dailyTime || ''}${j.timeZone ? ` ${j.timeZone}` : ''}`;
      case 'weekly': {
        const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const days = (j.weeklyDays || []).map((d) => names[d] || d).join(',');
        return `weekly ${days} ${j.weeklyTime || ''}${j.timeZone ? ` ${j.timeZone}` : ''}`;
      }
      default:
        return j.scheduleType || '';
    }
  },

  // ── Create / edit form ────────────────────────────────────────────────────

  /** Fill the bot and room pickers of the post action; keeps a saved choice that is no longer listed. */
  async _fillCronPostPickers(job) {
    const bots = await this._apiJson('/api/chat-bots');
    const rooms = await this._apiJson('/api/chatrooms');
    const botList = (bots && (bots.data ? bots.data.bots : bots.bots)) || [];
    const roomList = (rooms && (rooms.data ? rooms.data.rooms : rooms.rooms)) || [];
    const fill = (id, items, saved) => {
      const sel = document.getElementById(id);
      sel.replaceChildren();
      const seen = new Set();
      for (const it of items) {
        seen.add(it.id);
        sel.append(new Option(it.name || it.id, it.id));
      }
      if (saved && !seen.has(saved)) sel.append(new Option(`${saved} (not listed)`, saved));
      if (saved) sel.value = saved;
    };
    fill('schBotId', botList, job && job.botId);
    fill('schRoomId', roomList.filter((r) => !r.dm), job && job.roomId);
  },

  onCronActionChange() {
    const post = document.getElementById('schAction').value === 'post';
    document.getElementById('schPostFields').classList.toggle('hidden', !post);
    document.getElementById('schLaunchFields').classList.toggle('hidden', post);
    document.getElementById('schConcurrencyRow').classList.toggle('hidden', post);
    document.getElementById('schAutoCloseRow').classList.toggle('hidden', post);
  },

  _CRON_SOURCE_FIELDS: {
    'plans-pace': {
      numeric: ['accounts', 'maxWeekly', 'maxProjected', 'minHoursToRunOut', 'bankedAvailable', 'bankedSoonestExpiryHours'],
      text: ['worst', 'summary'],
    },
    'host-load': { numeric: ['load1', 'load5', 'load15', 'cpus', 'load15PerCpu'], text: [] },
    'burn-watch': { numeric: ['alerts'], text: ['message', 'lines'] },
  },

  onCronSourceChange(job) {
    const source = document.getElementById('schPostSource').value;
    const fields = this._CRON_SOURCE_FIELDS[source];
    document.getElementById('schSourceFields').classList.toggle('hidden', !fields);
    if (!fields) return;
    document.getElementById('schWhenField').innerHTML = fields.numeric
      .map((f) => `<option value="${f}">${f}</option>`)
      .join('');
    document.getElementById('schFieldHint').textContent = [...fields.numeric, ...fields.text].map((f) => `{${f}}`).join(' ');
    const when = job && job.postWhen;
    if (when) {
      document.getElementById('schWhenField').value = when.field;
      document.getElementById('schWhenOp').value = when.op;
    }
    document.getElementById('schWhenValue').value = when ? when.value : '';
  },

  openCronJobForm(job) {
    const form = document.getElementById('cronJobForm');
    if (!form) return;
    document.getElementById('schAction').value = job && job.action === 'post' ? 'post' : 'launch';
    // A saved job keeps what it does; only a new one chooses.
    document.getElementById('schAction').disabled = !!job;
    document.getElementById('schPostText').value = job ? job.postText || '' : '';
    document.getElementById('schDryRun').checked = !!(job && job.dryRun);
    document.getElementById('schPostSource').value = (job && job.postSource) || '';
    // A saved job keeps its source (like its action); only a new one chooses.
    document.getElementById('schPostSource').disabled = !!job;
    this.onCronSourceChange(job);
    document.getElementById('schChangeOnly').checked = !!(job && job.postChangeOnly);
    document.getElementById('schTimeZone').value = job ? job.timeZone || '' : '';
    this._fillCronPostPickers(job);
    document.getElementById('cronFormError').textContent = '';
    document.getElementById('cronFormTitle').textContent = job ? 'Edit Cron Job' : 'New Cron Job';
    document.getElementById('schJobId').value = job ? job.id : '';
    document.getElementById('schName').value = job ? job.name || '' : '';
    document.getElementById('schAgentType').value = job ? job.agentType || 'claude' : 'claude';
    document.getElementById('schWorkingDir').value = job ? job.workingDir || '' : '';
    document.getElementById('schLaunchCommand').value = job ? job.launchCommand || '' : '';
    document.getElementById('schPromptMode').value = job ? job.promptMode || 'inline_text' : 'inline_text';
    document.getElementById('schPromptText').value = job ? job.promptText || '' : '';
    document.getElementById('schPromptFilePath').value = job ? job.promptFilePath || '' : '';
    document.getElementById('schInputMode').value = job ? job.inputMode || 'typed' : 'typed';
    document.getElementById('schScheduleType').value = job ? job.scheduleType || 'once' : 'once';
    document.getElementById('schRunAt').value = job && job.runAt ? this._toLocalInput(job.runAt) : '';
    document.getElementById('schIntervalMinutes').value = job && job.intervalMinutes ? job.intervalMinutes : 60;
    document.getElementById('schDailyTime').value = job ? job.dailyTime || '' : '';
    document.getElementById('schWeeklyTime').value = job ? job.weeklyTime || '' : '';
    const weekly = (job && job.weeklyDays) || [];
    document.querySelectorAll('#schWeeklyDays input[type=checkbox]').forEach((cb) => {
      cb.checked = weekly.includes(Number(cb.value));
    });
    document.getElementById('schConcurrencyPolicy').value = job ? job.concurrencyPolicy || 'warn_only' : 'warn_only';
    document.getElementById('schAutoClosePrev').checked = job ? job.autoClosePreviousSession !== false : true;
    document.getElementById('schEnabled').checked = job ? !!job.enabled : true;
    document.getElementById('schNotes').value = job ? job.notes || '' : '';

    this.onCronActionChange();
    this.onCronAgentTypeChange();
    this.onCronPromptModeChange();
    this.onCronScheduleTypeChange();
    form.classList.remove('hidden');
  },

  editCronJob(id) {
    const job = (this._cronJobs || []).find((j) => j.id === id);
    if (job) this.openCronJobForm(job);
  },

  cancelCronJobForm() {
    const form = document.getElementById('cronJobForm');
    if (form) form.classList.add('hidden');
  },

  onCronAgentTypeChange() {
    // Launch command is only meaningful for shell mode (first input line).
    const isShell = document.getElementById('schAgentType').value === 'shell';
    document.getElementById('schLaunchCommandRow').classList.toggle('hidden', !isShell);
  },

  onCronPromptModeChange() {
    const mode = document.getElementById('schPromptMode').value;
    document.getElementById('schPromptTextRow').classList.toggle('hidden', mode !== 'inline_text');
    document.getElementById('schPromptFileRow').classList.toggle('hidden', mode !== 'prompt_file_path');
  },

  onCronScheduleTypeChange() {
    const t = document.getElementById('schScheduleType').value;
    document.getElementById('schRunAtRow').classList.toggle('hidden', t !== 'once');
    document.getElementById('schIntervalRow').classList.toggle('hidden', t !== 'interval');
    document.getElementById('schDailyRow').classList.toggle('hidden', t !== 'daily');
    document.getElementById('schWeeklyDaysRow').classList.toggle('hidden', t !== 'weekly');
    document.getElementById('schWeeklyTimeRow').classList.toggle('hidden', t !== 'weekly');
  },

  _toLocalInput(ts) {
    // epoch-ms → 'YYYY-MM-DDTHH:MM' in local time for <input datetime-local>.
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  _collectCronForm() {
    const t = document.getElementById('schScheduleType').value;
    const promptMode = document.getElementById('schPromptMode').value;
    const timeZone = document.getElementById('schTimeZone').value.trim();
    if (document.getElementById('schAction').value === 'post') {
      const body = {
        name: document.getElementById('schName').value.trim(),
        action: 'post',
        botId: document.getElementById('schBotId').value,
        roomId: document.getElementById('schRoomId').value,
        postText: document.getElementById('schPostText').value.trim(),
        dryRun: document.getElementById('schDryRun').checked,
        scheduleType: t,
        enabled: document.getElementById('schEnabled').checked,
        notes: document.getElementById('schNotes').value.trim() || undefined,
      };
      const source = document.getElementById('schPostSource').value;
      if (source && !document.getElementById('schPostSource').disabled) body.postSource = source;
      if (source || document.getElementById('schPostSource').disabled) {
        const raw = document.getElementById('schWhenValue').value;
        // null clears a saved condition on edit; a new job just omits it.
        body.postWhen =
          raw === '' || !source
            ? null
            : {
                field: document.getElementById('schWhenField').value,
                op: document.getElementById('schWhenOp').value,
                value: Number(raw),
              };
        body.postChangeOnly = document.getElementById('schChangeOnly').checked;
      }
      // Always sent: an emptied zone ('') clears a saved one on edit.
      body.timeZone = timeZone;
      return this._cronScheduleInto(body, t);
    }
    const body = {
      name: document.getElementById('schName').value.trim(),
      agentType: document.getElementById('schAgentType').value,
      workingDir: document.getElementById('schWorkingDir').value.trim(),
      promptMode,
      inputMode: document.getElementById('schInputMode').value,
      scheduleType: t,
      concurrencyPolicy: document.getElementById('schConcurrencyPolicy').value,
      autoClosePreviousSession: document.getElementById('schAutoClosePrev').checked,
      enabled: document.getElementById('schEnabled').checked,
      notes: document.getElementById('schNotes').value.trim() || undefined,
    };
    // Always sent for shell (an emptied field must clear a saved command on edit).
    if (body.agentType === 'shell') body.launchCommand = document.getElementById('schLaunchCommand').value.trim();
    if (promptMode === 'inline_text') {
      // Prompt delivery is single-line only; trailing newlines are harmless, strip them.
      body.promptText = document.getElementById('schPromptText').value.replace(/[\r\n]+$/, '');
    } else {
      body.promptFilePath = document.getElementById('schPromptFilePath').value.trim();
    }

    body.timeZone = timeZone;
    return this._cronScheduleInto(body, t);
  },

  _cronScheduleInto(body, t) {
    if (t === 'once') {
      const v = document.getElementById('schRunAt').value;
      body.runAt = v ? new Date(v).getTime() : undefined;
    } else if (t === 'interval') {
      body.intervalMinutes = Number(document.getElementById('schIntervalMinutes').value);
    } else if (t === 'daily') {
      body.dailyTime = document.getElementById('schDailyTime').value;
    } else if (t === 'weekly') {
      body.weeklyTime = document.getElementById('schWeeklyTime').value;
      body.weeklyDays = Array.from(document.querySelectorAll('#schWeeklyDays input:checked')).map((cb) =>
        Number(cb.value)
      );
    }
    return body;
  },

  async saveCronJob() {
    const errEl = document.getElementById('cronFormError');
    errEl.textContent = '';
    const body = this._collectCronForm();
    if (!body.name) {
      errEl.textContent = 'Name is required.';
      return;
    }
    if (body.action === 'post' && (!body.botId || !body.roomId || !body.postText)) {
      errEl.textContent = 'Bot, room and message are required.';
      return;
    }
    if (body.action !== 'post' && !body.workingDir) {
      errEl.textContent = 'Working directory is required.';
      return;
    }
    if (body.promptText !== undefined && /[\r\n]/.test(body.promptText)) {
      errEl.textContent = 'Prompt must be a single line — multi-line prompts are not supported.';
      return;
    }
    const id = document.getElementById('schJobId').value;
    const res = id ? await this._apiPut(`/api/cron/jobs/${id}`, body) : await this._apiPost('/api/cron/jobs', body);
    if (!res || !res.ok) {
      let msg = 'Failed to save job.';
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch {
        /* ignore */
      }
      errEl.textContent = msg;
      return;
    }
    this.showToast?.(id ? 'Cron job updated' : 'Cron job created', 'success');
    this.cancelCronJobForm();
    this.refreshCron();
  },

  // ── Actions ───────────────────────────────────────────────────────────────

  async runCronJob(id) {
    const job = (this._cronJobs || []).find((j) => j.id === id);
    if (job && job.action === 'post') {
      if (!confirm(job.dryRun ? 'Log a dry run of this post?' : 'Post this message now?')) return;
    } else if (job) {
      const active = this._countActiveAgents(job.agentType);
      if (active > 0 && !confirm(`${active} ${job.agentType} session(s) already active. Run this job anyway?`)) {
        return;
      }
    }
    const res = await this._apiPost(`/api/cron/jobs/${id}/run`, {});
    if (res && res.ok) {
      this.showToast?.(job && job.action === 'post' ? 'Run recorded' : 'Run started — opening session', 'success');
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }
      const run = data && (data.data ? data.data.run : data.run);
      if (run && run.sessionId) this._focusCronSession(run.sessionId);
      this.refreshCron();
    } else {
      this.showToast?.('Failed to run job', 'error');
    }
  },

  _focusCronSession(sessionId) {
    // Best-effort: switch to the created session tab if it exists.
    if (this.sessions && this.sessions.has(sessionId) && typeof this.switchSession === 'function') {
      this.closeCron();
      this.switchSession(sessionId);
    }
  },

  _countActiveAgents(agentType) {
    // Mirrors the server's countActiveAgents: only LIVE sessions count — a
    // tab whose CLI already exited (stopped/error) doesn't block anything.
    if (!this.sessions) return 0;
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s && s.mode === agentType && s.status !== 'stopped' && s.status !== 'error') n++;
    }
    return n;
  },

  async toggleCronJob(id, enabled) {
    const res = await this._apiPut(`/api/cron/jobs/${id}/enabled`, { enabled });
    if (res && res.ok) this.refreshCron();
    else this.showToast?.('Failed to update job', 'error');
  },

  async deleteCronJob(id) {
    if (!confirm('Delete this cron job and its run history?')) return;
    const res = await this._apiDelete(`/api/cron/jobs/${id}`);
    if (res && res.ok) {
      this.showToast?.('Cron job deleted', 'success');
      this.refreshCron();
    } else {
      this.showToast?.('Failed to delete job', 'error');
    }
  },
});
