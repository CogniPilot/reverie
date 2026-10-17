/**
 * @fileoverview Ultracode / Workflow run visualization — master-detail dock panel.
 *
 * Mirrors Claude Code's "working agents" TUI: LEFT pane = runs and their phases
 * (selectable "tasks"), RIGHT pane = the selected run's agents with model, live
 * state, TOKENS burned, and TOOL CALLS. Opt-in via the `showUltracodeAgents`
 * setting; the launcher button + panel are hidden until enabled.
 *
 * Data: run SUMMARIES arrive via getLightState (`data.workflowRuns`) and the
 * `workflow:run_*` SSE events (LEFT list). The full run (with agents[]) is fetched
 * per-run from GET /api/workflows/:runId when a run is selected (RIGHT pane).
 *
 * Standalone: reads only the workflow-run endpoints; never touches subagent state.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @loadorder 11.5 (after panels-ui.js, before session-ui.js)
 */
/* global CodemanApp, SSE_EVENTS, escapeHtml */

Object.assign(CodemanApp.prototype, {
  /** Ensure workflow state maps exist (lazy — constructor also seeds them). */
  _ensureWorkflowState() {
    if (!this.workflowRuns) this.workflowRuns = new Map(); // runId -> summary
    if (!this.workflowRunDetails) this.workflowRunDetails = new Map(); // runId -> full run (with agents)
    if (this.activeWorkflowRunId === undefined) this.activeWorkflowRunId = null;
    if (this.activeWorkflowPhaseIndex === undefined) this.activeWorkflowPhaseIndex = null;
  },

  /** Seed the LEFT list from a getLightState snapshot (array of run summaries). */
  seedWorkflowRuns(summaries) {
    this._ensureWorkflowState();
    this.workflowRuns.clear();
    (summaries || []).forEach((s) => this.workflowRuns.set(s.runId, s));
    // Restore floating windows for runs that are still active & recent (additional layer).
    if (typeof this._syncUltracodeFloatingWindow === 'function') {
      (summaries || []).forEach((s) => this._syncUltracodeFloatingWindow(s, { fromSeed: true }));
    }
    this.renderUltracodeAgentsPanel();
  },

  // ----- SSE handlers (wired in app.js _SSE_HANDLER_MAP) -----
  _onWorkflowRunDiscovered(data) {
    this._upsertWorkflowRun(data);
  },
  _onWorkflowRunUpdated(data) {
    this._upsertWorkflowRun(data);
  },
  _onWorkflowRunRemoved(data) {
    this._ensureWorkflowState();
    if (!data || !data.runId) return;
    this.workflowRuns.delete(data.runId);
    this.workflowRunDetails.delete(data.runId);
    if (this.activeWorkflowRunId === data.runId) this.activeWorkflowRunId = null;
    // Retire the floating run window too (additional layer — ultracode-windows.js).
    if (typeof this.closeUltracodeWindow === 'function') this.closeUltracodeWindow(data.runId, false);
    this.renderUltracodeAgentsPanel();
  },

  _upsertWorkflowRun(summary) {
    this._ensureWorkflowState();
    if (!summary || !summary.runId) return;
    this.workflowRuns.set(summary.runId, summary);
    // If the live-updating run is the one open in the detail pane, refresh its agents.
    if (this.activeWorkflowRunId === summary.runId) {
      this._fetchWorkflowRunDetail(summary.runId);
    }
    // Auto-pop / refresh the floating run window for active runs (additional layer).
    if (typeof this._syncUltracodeFloatingWindow === 'function') this._syncUltracodeFloatingWindow(summary);
    this.renderUltracodeAgentsPanel();
  },

  // ----- Panel open/close -----
  toggleUltracodeAgentsPanel() {
    const panel = document.getElementById('ultracodeAgentsPanel');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) this.renderUltracodeAgentsPanel();
  },
  closeUltracodeAgentsPanel() {
    // The X must FULLY hide the panel. Removing only `open` drops it to the
    // collapsed peek state (header strip still visible), so add `hidden`
    // (display:none) too — mirrors closeSubagentsPanel. Not the showUltracodeAgents
    // setting: that also gates the watcher + floating windows; the launcher reopens.
    const panel = document.getElementById('ultracodeAgentsPanel');
    if (panel) {
      panel.classList.remove('open');
      panel.classList.add('hidden');
    }
  },

  // ----- Selection -----
  selectWorkflowRun(runId) {
    this._ensureWorkflowState();
    this.activeWorkflowRunId = runId;
    this.activeWorkflowPhaseIndex = null; // reset phase filter on run change
    this._fetchWorkflowRunDetail(runId);
    this.renderUltracodeAgentsPanel();
    // Clicking a run also pops its floating window (with connector line to the
    // session tab), like the auto-popped one — an explicit open, so it ignores the
    // floating-windows auto-pop toggle (ultracode-windows.js).
    if (typeof this.openUltracodeWindowForRun === 'function') this.openUltracodeWindowForRun(runId);
  },
  selectWorkflowPhase(phaseIndex) {
    this._ensureWorkflowState();
    // phaseIndex null => show all phases
    this.activeWorkflowPhaseIndex = phaseIndex === null || phaseIndex === undefined ? null : Number(phaseIndex);
    this._renderUltracodeDetail();
  },

  async _fetchWorkflowRunDetail(runId) {
    // De-dupe concurrent fetches for the same run — selecting a run can trigger both
    // a panel refresh and a floating-window open, which would otherwise double-fetch.
    if (!this._wfDetailInFlight) this._wfDetailInFlight = new Set();
    if (this._wfDetailInFlight.has(runId)) return;
    this._wfDetailInFlight.add(runId);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(runId)}`);
      const env = await res.json();
      const run = env && env.success ? env.data : null;
      if (run) {
        this.workflowRunDetails.set(runId, run);
        if (this.activeWorkflowRunId === runId) this._renderUltracodeDetail();
        // Refresh the floating window (if one is open for this run) with the fetched agents[].
        if (this.ultracodeWindows && this.ultracodeWindows.has(runId)) this.renderUltracodeWindowContent(runId);
      }
    } catch {
      /* transient — next update retries */
    } finally {
      this._wfDetailInFlight.delete(runId);
    }
  },

  // Phase 4: fetch an agent's live transcript by agentId. The workflow agent's
  // agentId is byte-identical to the agent-<id>.jsonl stem already tracked by
  // subagent-watcher, so we reuse the existing transcript route — no watcher edits.
  // Returns { formatted: string[], entryCount } or null when nothing is available
  // (queued / aged out of tracking / tracking disabled). Rendering into a connected
  // in-page floating window lives in ultracode-windows.js (openUltracodeAgentWindow) —
  // we no longer spawn a detached browser popup.
  async _fetchWorkflowAgentTranscript(agentId) {
    if (!agentId) return null;
    let data = null;
    try {
      const res = await fetch(`/api/subagents/${encodeURIComponent(agentId)}/transcript?format=formatted`);
      data = await res.json();
    } catch {
      data = null;
    }
    const ok = data && data.success && data.data;
    const formatted = ok ? data.data.formatted : null;
    const entryCount = ok ? data.data.entryCount || 0 : 0;
    if (!formatted || !entryCount) return null;
    return { formatted, entryCount };
  },

  // ----- Render (debounced) -----
  renderUltracodeAgentsPanel() {
    clearTimeout(this._ultracodeRenderTimer);
    this._ultracodeRenderTimer = setTimeout(() => this._renderUltracodeAgentsPanelImmediate(), 150);
  },

  _renderUltracodeAgentsPanelImmediate() {
    this._ensureWorkflowState();
    const panel = document.getElementById('ultracodeAgentsPanel');
    if (!panel) return;
    const badge = document.getElementById('ultracodeCountBadge');
    if (badge) badge.textContent = this.workflowRuns.size ? String(this.workflowRuns.size) : '';
    this._renderUltracodeRunList();
    this._renderUltracodeDetail();
  },

  _renderUltracodeRunList() {
    const list = document.getElementById('ultracodeRunList');
    if (!list) return;
    const runs = Array.from(this.workflowRuns.values()).sort(
      (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    );
    if (!runs.length) {
      list.innerHTML = '<div class="subagent-empty">No ultracode runs detected</div>';
      return;
    }
    list.innerHTML = runs.map((r) => this._workflowRunRowHtml(r)).join('');
  },

  _workflowRunRowHtml(r) {
    const active = r.runId === this.activeWorkflowRunId;
    const name = escapeHtml(r.workflowName || r.summary || r.runId);
    const status = String(r.status || '');
    const statusCls = this._workflowStatusClass(status);
    const stats = `${r.agentCount ?? 0} agents · ${this._fmtNum(r.totalTokens)} tok · ${r.totalToolCalls ?? 0} tools`;
    let phasesHtml = '';
    if (active && Array.isArray(r.phases) && r.phases.length) {
      const allActive = this.activeWorkflowPhaseIndex === null ? ' selected' : '';
      const chips = [
        `<div class="ultracode-phase-chip${allActive}" onclick="event.stopPropagation();app.selectWorkflowPhase(null)">All</div>`,
      ];
      r.phases.forEach((p, i) => {
        const sel = this.activeWorkflowPhaseIndex === i + 1 ? ' selected' : '';
        chips.push(
          `<div class="ultracode-phase-chip${sel}" title="${escapeHtml(p.detail || '')}" onclick="event.stopPropagation();app.selectWorkflowPhase(${i + 1})">${escapeHtml(p.title || 'Phase ' + (i + 1))}</div>`
        );
      });
      phasesHtml = `<div class="ultracode-phase-list">${chips.join('')}</div>`;
    }
    return (
      `<div class="ultracode-run-item${active ? ' selected' : ''}" onclick="app.selectWorkflowRun(${escapeHtml(JSON.stringify(r.runId))})">` +
      `<div class="ultracode-run-head"><span class="ultracode-run-name">${name}</span>` +
      `<span class="ultracode-status ${statusCls}">${escapeHtml(status || '—')}</span></div>` +
      `<div class="ultracode-run-stats">${escapeHtml(stats)}</div>` +
      phasesHtml +
      `</div>`
    );
  },

  _renderUltracodeDetail() {
    const detail = document.getElementById('ultracodeAgentGrid');
    if (!detail) return;
    const runId = this.activeWorkflowRunId;
    if (!runId) {
      detail.innerHTML = '<div class="subagent-empty">Select a run to view its agents</div>';
      return;
    }
    const run = this.workflowRunDetails.get(runId);
    if (!run) {
      detail.innerHTML = '<div class="subagent-empty">Loading agents…</div>';
      return;
    }
    const phases = Array.isArray(run.phases) ? run.phases : [];
    let agents = Array.isArray(run.agents) ? run.agents : [];
    if (this.activeWorkflowPhaseIndex !== null) {
      agents = agents.filter((a) => a.phaseIndex === this.activeWorkflowPhaseIndex);
    }
    if (!agents.length) {
      detail.innerHTML = '<div class="subagent-empty">No agents in this view</div>';
      return;
    }
    // Group agents by phaseIndex, in phase order.
    const groups = new Map();
    agents.forEach((a) => {
      const key = a.phaseIndex || 0;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });
    const orderedKeys = Array.from(groups.keys()).sort((a, b) => a - b);
    const html = orderedKeys
      .map((key) => {
        const group = groups.get(key);
        const title = (phases[key - 1] && phases[key - 1].title) || `Phase ${key}`;
        const tok = group.reduce((s, a) => s + (a.tokens || 0), 0);
        const tools = group.reduce((s, a) => s + (a.toolCalls || 0), 0);
        const header =
          `<div class="ultracode-phase-header"><span>${escapeHtml(title)}</span>` +
          `<span class="ultracode-phase-sub">${this._fmtNum(tok)} tok · ${tools} tools</span></div>`;
        return header + group.map((a) => this._workflowAgentCardHtml(a, runId)).join('');
      })
      .join('');
    detail.innerHTML = html;
  },

  _workflowAgentCardHtml(a, runId) {
    const state = String(a.state || 'start');
    const stateCls = this._workflowAgentStateClass(state);
    const stateLabel = state === 'start' ? 'queued' : state === 'progress' ? 'running' : state;
    const model = this._modelShort(a.model);
    const tokens = a.tokens === undefined ? '—' : this._fmtNum(a.tokens);
    const tools = a.toolCalls === undefined ? '—' : String(a.toolCalls);
    let secondary = '';
    if (state === 'done' && a.resultPreview) {
      secondary = escapeHtml(a.resultPreview);
    } else if (a.lastToolName) {
      secondary = escapeHtml(a.lastToolName + (a.lastToolSummary ? ' · ' + a.lastToolSummary : ''));
    }
    // Phase 4: cards with an agentId open the live transcript (the agentId is byte-identical
    // to the agent-<id>.jsonl stem already tracked by subagent-watcher). 'start' agents have
    // no agentId yet, so they stay non-clickable.
    const clickable = !!a.agentId;
    // At-a-glance state tint on the whole card: green when done, yellow while working.
    const cardStateCls = state === 'done' ? ' uw-state-done' : state === 'progress' ? ' uw-state-working' : '';
    const cardAttrs = clickable
      ? ` class="ultracode-agent-card ultracode-agent-card--clickable${cardStateCls}" role="button" tabindex="0"` +
        ` title="View transcript" onclick="app.openUltracodeAgentWindow(${escapeHtml(JSON.stringify(a.agentId))},${escapeHtml(JSON.stringify(runId || ''))})"`
      : ` class="ultracode-agent-card${cardStateCls}"`;
    return (
      `<div${cardAttrs}>` +
      `<div class="ultracode-agent-top">` +
      `<span class="ultracode-agent-label">${escapeHtml(a.label || 'agent')}</span>` +
      `<span class="ultracode-agent-state ${stateCls}">${escapeHtml(stateLabel)}</span>` +
      `</div>` +
      `<div class="ultracode-agent-meta">` +
      `<span class="ultracode-chip" title="model">${escapeHtml(model)}</span>` +
      `<span class="ultracode-chip ultracode-chip-tok" title="tokens burned">${tokens} tok</span>` +
      `<span class="ultracode-chip ultracode-chip-tool" title="tool calls">${tools} tools</span>` +
      `</div>` +
      (secondary ? `<div class="ultracode-agent-sub">${secondary}</div>` : '') +
      `</div>`
    );
  },

  // ----- helpers -----
  _workflowStatusClass(status) {
    if (status === 'completed') return 'completed';
    if (status === 'running') return 'active';
    if (status === 'killed' || status === 'failed') return 'failed';
    return '';
  },
  _workflowAgentStateClass(state) {
    if (state === 'done') return 'completed';
    if (state === 'progress') return 'active';
    return 'idle'; // start / queued
  },
  _modelShort(model) {
    if (!model) return '';
    return String(model)
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '');
  },
  _fmtNum(n) {
    if (n === undefined || n === null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  },
});
