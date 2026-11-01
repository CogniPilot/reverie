/* Owner dashboard. All authority and mutations remain in the existing bot/cron APIs. */
(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  let editingContent;
  let botAvatar = '';
  const avatarPath = (value) =>
    typeof value === 'string' &&
    /^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png(?:\?v=[a-f0-9]{64})?$/.test(value)
      ? value
      : '';
  const assetUrl = (path) => new URL('.' + path, location.href).href;
  let snapshot,
    busy = false,
    closed = false,
    editingId = null;
  let watchSnapshot = null,
    watchError = '',
    watchBusy = false,
    watchEdit = null;
  let credentials = [],
    credentialsAvailable = false;
  let credentialRepository = '',
    credentialBusy = false;
  let credentialEpoch = 0;
  let watchCadenceEdited = false;
  /** The disk-space watch status from GET /api/bot-watches (data.disk), or null while unavailable. */
  let disk = null,
    diskError = '',
    diskBusy = false;
  /** The bot the disk panel creates when no existing bot may post in the chosen channel. */
  const DISK_BOT = { id: 'disk-alarm', name: 'Disk Alarm', icon: '💾', maxPerHour: 6 };
  const requests = new Set();
  const terminal = new Set(['posted', 'failed', 'skipped', 'prompt_sent']);
  const active = (run) => run.finishedAt === null && !terminal.has(run.status);
  const time = (value) => (Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : '—');
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const validZone = (zone) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  };
  /** The company's time zone, else this browser's: the zone a new daily or weekly schedule starts in. */
  const defaultZone = () =>
    [snapshot?.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone].find((zone) => zone && validZone(zone)) ||
    'UTC';

  /**
   * A routine's schedule: every so many minutes, daily at a time, or weekly on chosen days at a time, read in a time zone.
   * The next runs show while it is filled in, worked out by the server's own schedule code (nothing is saved).
   */
  function scheduleEditor(host) {
    const field = (text, control) => {
      const label = node('label', text);
      label.append(control);
      return label;
    };
    const repeat = node('select');
    repeat.name = 'scheduleType';
    for (const [value, text] of [
      ['interval', 'Every few minutes'],
      ['daily', 'Daily'],
      ['weekly', 'Weekly'],
    ])
      repeat.append(new Option(text, value));
    const minutes = node('input');
    Object.assign(minutes, { name: 'intervalMinutes', type: 'number', min: '5', max: '525600', value: '60' });
    const at = node('input');
    Object.assign(at, { name: 'at', type: 'time', value: '09:00' });
    const days = node('fieldset', undefined, 'schedule-days');
    days.append(node('legend', 'On'));
    // Monday first, as a week is usually read; the values stay the server's 0 = Sunday.
    for (const day of [1, 2, 3, 4, 5, 6, 0]) {
      const box = node('input');
      Object.assign(box, { type: 'checkbox', name: 'weeklyDays', value: String(day) });
      const label = node('label', undefined, 'check');
      label.append(box, WEEKDAYS[day]);
      days.append(label);
    }
    const zone = node('input');
    Object.assign(zone, { name: 'timeZone', autocomplete: 'off', spellcheck: false, placeholder: 'America/New_York' });
    let list = byId('time-zones');
    if (!list) {
      list = node('datalist');
      list.id = 'time-zones';
      for (const name of Intl.supportedValuesOf?.('timeZone') || []) list.append(new Option(name));
      document.body.append(list);
    }
    zone.setAttribute('list', 'time-zones');
    const preview = node('p', '', 'hint schedule-preview');
    preview.setAttribute('aria-live', 'polite');
    const parts = {
      minutes: field('Every (minutes)', minutes),
      at: field('At', at),
      days,
      zone: field('Time zone', zone),
    };
    host.replaceChildren(field('Repeat', repeat), parts.minutes, parts.days, parts.at, parts.zone, preview);
    let timer = 0,
      asked = 0;

    /** The schedule as the job holds it, or an Error saying what is missing. */
    function read() {
      const type = repeat.value;
      if (type === 'interval') {
        const value = Number(minutes.value);
        if (!Number.isInteger(value) || value < 5 || value > 525600) return new Error('Repeat every 5 to 525600 minutes.');
        return { scheduleType: 'interval', intervalMinutes: value };
      }
      if (!/^\d{2}:\d{2}$/.test(at.value)) return new Error('Choose a time.');
      const tz = zone.value.trim();
      if (!tz || !validZone(tz)) return new Error('Choose a time zone such as America/New_York.');
      if (type === 'daily') return { scheduleType: 'daily', dailyTime: at.value, timeZone: tz };
      const picked = [...days.querySelectorAll('input:checked')].map((box) => Number(box.value)).sort((a, b) => a - b);
      if (!picked.length) return new Error('Choose at least one day.');
      return { scheduleType: 'weekly', weeklyDays: picked, weeklyTime: at.value, timeZone: tz };
    }

    function sync() {
      const type = repeat.value;
      parts.minutes.hidden = type !== 'interval';
      minutes.required = type === 'interval';
      parts.at.hidden = parts.zone.hidden = type === 'interval';
      parts.days.hidden = type !== 'weekly';
      clearTimeout(timer);
      timer = setTimeout(showNext, 250);
    }

    async function showNext() {
      const schedule = read();
      const mine = ++asked;
      if (schedule instanceof Error) {
        preview.textContent = schedule.message;
        return;
      }
      preview.textContent = 'Next runs: working them out…';
      try {
        const { runs } = await api('cron/schedule-preview', { method: 'POST', body: JSON.stringify({ ...schedule, count: 3 }) });
        if (mine !== asked) return;
        const shown = new Intl.DateTimeFormat('en-US', {
          weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
          timeZoneName: 'short', ...(schedule.timeZone ? { timeZone: schedule.timeZone } : {}),
        });
        preview.textContent = runs.length
          ? `Next runs${schedule.scheduleType === 'interval' ? ' if saved now' : ''}: ${runs.map((at) => shown.format(at)).join(' · ')}`
          : 'This schedule has no next run.';
      } catch (error) {
        if (mine === asked) preview.textContent = 'Next runs unavailable: ' + error.message;
      }
    }

    /** Show a job's schedule, or the defaults for a new one. */
    function write(job) {
      repeat.value = job?.scheduleType === 'daily' || job?.scheduleType === 'weekly' ? job.scheduleType : 'interval';
      minutes.value = String(job?.intervalMinutes || 60);
      // A routine keeps the other kind's time after a change of kind, so the time shown is the one its kind uses.
      at.value = (job?.scheduleType === 'weekly' ? job.weeklyTime : job?.dailyTime) || '09:00';
      zone.value = job?.timeZone || defaultZone();
      const chosen = new Set(job?.weeklyDays || [1, 2, 3, 4, 5]);
      for (const box of days.querySelectorAll('input')) box.checked = chosen.has(Number(box.value));
      sync();
    }

    host.addEventListener('input', sync);
    host.addEventListener('change', sync);
    return { read, write };
  }
  async function api(path, options = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(new URL('./api/' + path, location.href), {
        ...options,
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      });
      const result = await response.json();
      if (!response.ok || result?.success === false) {
        const error = new Error(result?.error?.message || result?.error || `Request failed (${response.status})`);
        error.status = response.status;
        // Only a route that refused before acting marks its answer notRun; any other failure may follow an effect.
        error.notRun = result?.notRun === true;
        throw error;
      }
      return result?.success === true ? result.data : result;
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }
  async function refresh() {
    if (busy || closed) return;
    busy = true;
    byId('refresh').disabled = true;
    try {
      const [bots, jobs, runs, rooms, company, executing, watchers, tokenMetadata, watches] = await Promise.all([
        api('chat-bots'),
        api('cron/jobs'),
        api('cron/runs'),
        api('chatrooms'),
        api('company').catch(() => null),
        api('cron/active'),
        api('bot-watches/github').then(
          (data) => ({ data }),
          (error) => ({ error })
        ),
        api('publication/tokens').then(
          (data) => ({ data }),
          () => ({ data: null })
        ),
        api('bot-watches').then(
          (data) => ({ data }),
          (error) => ({ error })
        ),
      ]);
      if (closed) return;
      if (
        !Array.isArray(bots.bots) ||
        !Array.isArray(jobs) ||
        !Array.isArray(runs) ||
        !Array.isArray(rooms.rooms) ||
        !Array.isArray(executing.jobs)
      )
        throw new Error('Unexpected bot data. Refresh to try again.');
      snapshot = {
        bots: bots.bots,
        jobs,
        runs,
        rooms: rooms.rooms.filter((room) => !room.dm && room.kind !== 'dm' && !room.archivedAt),
        employees: company?.employees || [],
        executing: executing.jobs,
        timeZone: company?.settings?.timeZone,
      };
      credentialsAvailable = Array.isArray(tokenMetadata.data?.tokens);
      credentials = credentialsAvailable ? tokenMetadata.data.tokens.slice(0, 64) : [];
      if (watchers.error) {
        watchSnapshot = null;
        watchError =
          watchers.error.status === 403
            ? 'Sign in as the owner to manage repository watchers.'
            : 'Repository watchers are unavailable. Refresh to try again.';
      } else {
        try {
          acceptWatchSnapshot(watchers.data);
        } catch {
          watchSnapshot = null;
          watchError = 'Repository watcher data is unavailable. Refresh to try again.';
        }
      }
      acceptDisk(watches);
      byId('status').className = '';
      byId('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
      render();
    } catch (error) {
      if (closed) return;
      snapshot = undefined;
      byId('status').className = 'error';
      byId('status').textContent =
        error.status === 403 ? 'Sign in as the owner to manage bots.' : 'Bot status unavailable: ' + error.message;
      watchSnapshot = null;
      watchError =
        error.status === 403
          ? 'Sign in as the owner to manage repository watchers.'
          : 'Repository watchers are unavailable. Refresh to try again.';
      for (const id of ['summary', 'routines', 'bots', 'history', 'github-watches']) byId(id).replaceChildren();
      renderWatchers();
      acceptDisk({ error });
      renderDisk();
    } finally {
      busy = false;
      byId('refresh').disabled = false;
      byId('new-bot').disabled = byId('new-routine').disabled = !snapshot;
    }
  }
  const roomName = (id) => snapshot.rooms.find((room) => room.id === id)?.name || id || 'No channel';
  function acceptWatchSnapshot(data) {
    if (
      !data ||
      data.version !== 1 ||
      !Number.isInteger(data.revision) ||
      data.revision < 0 ||
      !Array.isArray(data.watches) ||
      data.watches.length > 8 ||
      data.watches.some((w) => !w?.config || !w?.status || typeof w.config.id !== 'string')
    )
      throw new Error('Unexpected repository watcher data.');
    if (!watchSnapshot || data.revision >= watchSnapshot.revision) watchSnapshot = data;
    watchError = '';
  }
  const eventLabels = {
    issues: 'Issues',
    pullRequests: 'Pull requests',
    workflowFailures: 'Failed GitHub Actions runs',
  };
  const watchState = {
    active: 'Enabled',
    disabled: 'Disabled',
    'auth-required': 'Credential required',
    hold: 'Needs attention',
    error: 'Check failed',
    'not-run': 'Not checked yet',
  };
  function renderWatchers() {
    const list = byId('github-watches');
    list.replaceChildren();
    const count = watchSnapshot?.watches.length ?? 0;
    byId('new-watch').disabled = !snapshot || !watchSnapshot || watchBusy || count >= 8;
    byId('watch-status').textContent =
      watchError ||
      (watchSnapshot
        ? count
          ? `${count} ${count === 1 ? 'repository watcher' : 'repository watchers'}`
          : 'No repository watchers yet.'
        : 'Repository watchers are unavailable.');
    if (!watchSnapshot) return;
    for (const { config, status } of watchSnapshot.watches) {
      const title = `${config.owner}/${config.repo}`;
      const element = card(
        title,
        watchState[status.state] || 'Status unavailable',
        ['error', 'hold', 'auth-required'].includes(status.state) ? 'failed' : ''
      );
      element.append(
        node(
          'p',
          `#${roomName(config.roomId)} · ${snapshot.bots.find((b) => b.id === config.botId)?.name || 'Bot unavailable'} · Every ${config.intervalMinutes} minutes`
        )
      );
      element.append(
        node(
          'p',
          Object.entries(eventLabels)
            .filter(([key]) => config.events?.[key])
            .map(([, label]) => label)
            .join(' · ') || 'No events selected',
          'github-watch-detail'
        )
      );
      element.append(
        node(
          'p',
          `Last successful check: ${time(status.lastSuccessAt)} · Next: ${config.enabled ? time(status.nextPollAt) : 'Disabled'}`,
          'github-watch-detail'
        )
      );
      if (status.state === 'auth-required')
        element.append(node('p', 'Choose a named credential with access to this repository.', 'github-watch-error'));
      if (status.lastError) element.append(node('p', status.lastError, 'github-watch-error'));
      if (status.pendingCount > 0)
        element.append(
          node('p', `${status.pendingCount} update(s) awaiting delivery confirmation.`, 'github-watch-detail')
        );
      if (config.events?.workflowFailures && status.ciCoverage)
        element.append(
          node(
            'p',
            `GitHub Actions: new activity and recent reruns (31 days) · ${status.ciCoverage.complete ? 'Last check complete' : 'Needs attention: coverage incomplete'}.`,
            'github-watch-detail'
          )
        );
      const actions = node('div', undefined, 'card-actions');
      const edit = node('button', 'Edit watcher');
      edit.type = 'button';
      edit.disabled = watchBusy;
      edit.setAttribute('aria-label', `Edit watcher for ${title}`);
      edit.addEventListener('click', () => openWatcher(config.id));
      const toggle = node('button', config.enabled ? 'Disable watcher' : 'Enable watcher');
      toggle.type = 'button';
      toggle.disabled = watchBusy;
      toggle.setAttribute('aria-label', `${config.enabled ? 'Disable' : 'Enable'} watcher for ${title}`);
      toggle.addEventListener('click', () =>
        changeWatchers(
          watchSnapshot.revision,
          watchSnapshot.watches.map((w) => ({
            ...w.config,
            ...(w.config.id === config.id ? { enabled: !config.enabled } : {}),
          }))
        )
      );
      const remove = node('button', 'Remove watcher');
      remove.type = 'button';
      remove.disabled = watchBusy;
      remove.setAttribute('aria-label', `Remove watcher for ${title}`);
      remove.addEventListener('click', () => {
        if (confirm(`Remove the watcher for ${title}? Existing channel messages will remain.`))
          void changeWatchers(
            watchSnapshot.revision,
            watchSnapshot.watches.filter((w) => w.config.id !== config.id).map((w) => w.config)
          );
      });
      actions.append(edit, toggle, remove);
      element.append(actions);
      list.append(element);
    }
  }
  async function putWatchers(revision, configs) {
    await api('bot-watches/github', {
      method: 'PUT',
      body: JSON.stringify({ version: 1, expectedRevision: revision, watches: configs }),
    });
    acceptWatchSnapshot(await api('bot-watches/github'));
  }
  async function changeWatchers(revision, configs) {
    if (watchBusy || !watchSnapshot || closed) return;
    watchBusy = true;
    renderWatchers();
    try {
      await putWatchers(revision, configs);
    } catch (error) {
      if (error.status === 403) watchSnapshot = null;
      watchError =
        error.status === 403
          ? 'Sign in as the owner to manage repository watchers.'
          : error.status === 409
            ? 'Watchers changed elsewhere. Refresh before editing again.'
            : 'Could not confirm the watcher change. Refresh before trying again.';
    } finally {
      watchBusy = false;
      if (!closed && snapshot) render();
    }
  }
  function fillWatchRooms(selected) {
    const form = byId('watch-form'),
      bot = snapshot?.bots.find((b) => b.id === form.elements.botId.value);
    const rooms = snapshot?.rooms.filter((room) => !room.archivedAt && bot?.rooms.includes(room.id)) || [];
    form.elements.roomId.replaceChildren(...rooms.map((room) => new Option('#' + room.name, room.id)));
    if (selected && rooms.some((room) => room.id === selected)) form.elements.roomId.value = selected;
  }
  function repositoryParts(value) {
    const match = value
      .trim()
      .match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/?$/i);
    if (!match) throw new Error('Enter a repository as owner/repository or its GitHub URL.');
    return [match[1], match[2]];
  }
  function fillWatchCredentials(selected = '') {
    const field = byId('watch-form').elements.credentialId;
    field.replaceChildren(
      new Option('Public repository — no credential', ''),
      ...credentials.map((token) => new Option(token.label ? `${token.name} · ${token.label}` : token.name, token.id))
    );
    if (selected && !credentials.some((token) => token.id === selected))
      field.append(new Option('Current credential (metadata unavailable)', selected));
    field.value = selected;
    if (watchEdit && !watchEdit.id && !watchCadenceEdited)
      byId('watch-form').elements.intervalMinutes.value = selected ? '15' : '30';
    byId('watch-credential-field').hidden = !credentialsAvailable && !selected;
    byId('watch-credential-hint').textContent = credentialsAvailable
      ? 'Only credential names are shown. Repository access depends on their GitHub permissions.'
      : 'Credential names are unavailable. Public repositories need no credential; private repositories require one before checks can run.';
  }
  function openWatcher(id = null) {
    if (!snapshot || !watchSnapshot || watchBusy) return;
    const config = watchSnapshot.watches.find((w) => w.config.id === id)?.config;
    if (id && !config) return;
    watchEdit = {
      id,
      revision: watchSnapshot.revision,
      configs: JSON.parse(JSON.stringify(watchSnapshot.watches.map((w) => w.config))),
    };
    watchCadenceEdited = false;
    const form = byId('watch-form');
    form.reset();
    byId('watch-title').textContent = config ? 'Edit repository watcher' : 'Watch a repository';
    form.elements.repository.value = config ? `${config.owner}/${config.repo}` : '';
    form.elements.repository.readOnly = !!config;
    form.elements.botId.replaceChildren(...snapshot.bots.map((bot) => new Option(bot.name, bot.id)));
    if (config) form.elements.botId.value = config.botId;
    else if (snapshot.bots.some((b) => b.id === 'github-issues')) form.elements.botId.value = 'github-issues';
    fillWatchRooms(config?.roomId);
    form.elements.visibility.value = config?.visibility || 'public';
    form.elements.intervalMinutes.value = String(config?.intervalMinutes || 30);
    form.elements.intervalMinutes.min = String(
      config?.id === 'github-issues' && config.intervalMinutes < 15 ? config.intervalMinutes : 15
    );
    form.elements.enabled.checked = config?.enabled ?? true;
    for (const input of form.querySelectorAll('[name=events]'))
      input.checked = config ? !!config.events[input.value] : true;
    fillWatchCredentials(config?.credentialId || '');
    byId('watch-error').textContent = '';
    byId('watch-dialog').showModal();
    form.elements.repository.focus();
  }
  const schedule = (job) => {
    if (job.scheduleType === 'interval') return `Every ${job.intervalMinutes} minutes`;
    if (job.scheduleType === 'once') return 'Once: ' + time(job.runAt);
    return `${job.scheduleType === 'weekly' ? 'Weekly ' + (job.weeklyDays || []).map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ') : 'Daily'} at ${(job.scheduleType === 'weekly' ? job.weeklyTime : job.dailyTime) || '—'}${job.timeZone ? ' · ' + job.timeZone : ''}`;
  };
  function card(title, state, className = '') {
    const element = node('article', undefined, 'card');
    const head = node('div', undefined, 'card-head');
    head.append(node('h3', title), node('span', state, 'badge ' + className));
    element.append(head);
    return element;
  }
  function empty(parent, text) {
    parent.append(node('p', text, 'empty'));
  }
  function contentOf(job) {
    if (job.action === 'post')
      return { field: 'postText', label: job.postSource ? 'Message template' : 'Message', value: job.postText || '' };
    if (job.launchCommand) return { field: 'launchCommand', label: 'Launch command', value: job.launchCommand };
    if (job.promptMode === 'prompt_file_path')
      return { field: 'promptFilePath', label: 'Prompt file path', value: job.promptFilePath || '' };
    return { field: 'promptText', label: 'Agent prompt', value: job.promptText || '' };
  }
  function openContent(job) {
    if (!snapshot) return;
    const content = contentOf(job);
    editingContent = { id: job.id, ...content };
    byId('content-title').textContent = 'Edit ' + content.label.toLowerCase() + ' · ' + job.name;
    const textarea = byId('content-form').elements.content;
    textarea.setAttribute('aria-label', content.label);
    textarea.value = content.value;
    byId('content-error').textContent = '';
    byId('content-dialog').showModal();
    textarea.focus();
  }
  // Preview, then an explicit Run once: the preview writes and posts nothing; the run is the real thing, shown as it lands.
  let trial;
  let trialGeneration = 0;
  const runLabels = { post: 'Post now', 'dry-run': 'Record a dry run', skip: 'Run once', launch: 'Start session', 'not-previewed': 'Run once' };
  function list(id, items) {
    const element = byId(id);
    element.replaceChildren(...items.map(([text, className]) => node('li', text, className)));
  }
  async function openTrial(job) {
    const id = job.id;
    // Each opening is its own generation: a late response from an earlier opening never paints this one.
    const generation = ++trialGeneration;
    trial = { id, generation, ran: false };
    const current = () => trial?.generation === generation;
    byId('trial-title').textContent = 'Preview · ' + (job.name || 'Unnamed routine');
    byId('trial-summary').textContent = 'Checking what Run once would do…';
    byId('trial-text').hidden = true;
    byId('trial-result').hidden = true;
    byId('trial-error').textContent = byId('trial-note').textContent = '';
    list('trial-checks', []);
    list('trial-effects', []);
    const go = byId('trial-go');
    go.disabled = true;
    go.textContent = 'Run once';
    byId('trial-dialog').showModal();
    let preview;
    try {
      ({ preview } = await api('cron/jobs/' + encodeURIComponent(id) + '/preview'));
    } catch (error) {
      if (!current()) return;
      byId('trial-summary').textContent = 'Preview unavailable.';
      byId('trial-error').textContent = error.message;
      return;
    }
    if (!current() || !preview) return;
    const where = preview.roomId ? ' in #' + roomName(preview.roomId) : '';
    byId('trial-summary').textContent = {
      post: `Run once would post this as ${preview.sender}${where}:`,
      'dry-run': `This routine is in dry-run mode: Run once records a dry run and posts nothing. It would post as ${preview.sender}${where}:`,
      skip: `Run once would post nothing now: ${preview.reason}`,
      launch: 'Run once would start a session with this prompt:',
      blocked: 'Run once would fail now' + (preview.reason ? ': ' + preview.reason : '; see the checks.'),
      'not-previewed': preview.reason,
    }[preview.outcome] || 'Unknown outcome.';
    if (typeof preview.text === 'string' && preview.outcome !== 'skip') {
      byId('trial-text').textContent = preview.text || '(empty)';
      byId('trial-text').hidden = false;
    }
    list('trial-checks', preview.checks.map((c) => [c.label + (c.detail ? ': ' + c.detail : ''), c.ok ? 'ok' : 'fail']));
    list('trial-effects', preview.effects.map((e) => [e]));
    byId('trial-note').textContent =
      'This preview posted nothing and recorded nothing' +
      (preview.readsSource ? `; it read the data source “${preview.readsSource}”.` : '.');
    go.textContent = runLabels[preview.outcome] || 'Run once';
    go.disabled = preview.outcome === 'blocked';
  }
  async function runTrial() {
    if (!trial || trial.ran) return;
    const { id, generation } = trial;
    const current = () => trial?.generation === generation;
    const go = byId('trial-go');
    trial.ran = true;
    go.disabled = true;
    byId('trial-error').textContent = '';
    byId('trial-summary').textContent = 'Running once…';
    let data;
    try {
      data = await api('cron/jobs/' + encodeURIComponent(id) + '/run', { method: 'POST', body: '{}' });
    } catch (error) {
      if (!current()) return;
      // Only the route's own refusal, made before it acts, means nothing ran. A server error, a lost connection or a
      // timeout after the request went out leaves the outcome unknown: the run may have happened.
      if (error.notRun) {
        byId('trial-summary').textContent = 'Run once was refused; nothing ran.';
      } else {
        byId('trial-summary').textContent =
          'Outcome unknown: Run once was sent but not confirmed, so it may have run. Check Run history before trying again.';
        await refresh();
        if (!current()) return;
      }
      byId('trial-error').textContent = error.message;
      return;
    }
    if (!current()) return;
    const run = data?.run;
    const rows = run
      ? [
          ['Status', run.status],
          ['Started', time(run.startedAt)],
          ['Finished', run.finishedAt ? time(run.finishedAt) : 'Still running'],
          ...(run.errorMessage ? [['Log', run.errorMessage]] : []),
          ['Run', run.id],
        ]
      : [['Status', 'Not started: this watcher is already running']];
    const dl = byId('trial-run');
    dl.replaceChildren();
    for (const [term, value] of rows) dl.append(node('dt', term), node('dd', value));
    if (run?.createdSessionUrl) {
      const link = node('a', 'Open the session');
      link.href = run.createdSessionUrl;
      dl.append(node('dt', 'Session'), node('dd'));
      dl.lastChild.append(link);
    }
    byId('trial-result').hidden = false;
    byId('trial-summary').textContent =
      run?.status === 'failed' ? 'Run once failed; see the log.' : 'Run once finished. It also appears in Run history.';
    go.textContent = 'Done';
    await refresh();
  }
  function acceptDisk(result) {
    const status = result?.data?.disk;
    if (result?.error || !status || typeof status !== 'object') {
      disk = null;
      diskError =
        result?.error?.status === 403
          ? 'Sign in as the owner to manage the disk alarm.'
          : 'The disk alarm is unavailable. Refresh to try again.';
    } else if (status.state === 'HOLD') {
      disk = null;
      diskError = 'The disk alarm is held until the server reconciles its state.';
    } else {
      disk = status;
      diskError = '';
    }
  }
  const levelLabel = { ok: 'OK', warn: 'Warning', critical: 'Critical' };
  function renderDisk() {
    const config = disk?.config;
    const bot = config && snapshot?.bots.find((b) => b.id === config.botId);
    byId('disk-status').textContent =
      diskError ||
      (!config
        ? 'The disk alarm is not set up.'
        : `${config.enabled ? 'On' : 'Off'}: warns at ${config.warnPercent}%, critical at ${config.criticalPercent}%, ` +
          `checked every ${config.intervalMinutes} min, posts in #${snapshot ? roomName(config.roomId) : config.roomId}` +
          ` as ${bot?.name || config.botId}${config.mention ? `, mentioning @${config.mention}` : ''}.`);
    const volumes = Object.values(disk?.volumes || {});
    const notes = [];
    if (disk?.failures) notes.push(node('p', `Disk readings failed ${disk.failures} time(s) in a row.`, 'github-watch-error'));
    if (disk && disk.durable === false)
      notes.push(node('p', 'Alarm state is not being saved; alarms continue until the server restarts.', 'github-watch-error'));
    byId('disk-volumes').replaceChildren(
      ...volumes.map((volume) => {
        const element = node('article', undefined, 'card');
        element.append(
          node('h3', (volume.labels || []).join(' / ') || 'Disk'),
          node('p', levelLabel[volume.level] || 'Unknown', 'github-watch-detail')
        );
        return element;
      }),
      ...notes
    );
    const edit = byId('disk-edit'),
      toggle = byId('disk-toggle');
    edit.textContent = config ? 'Edit disk alarm' : 'Set up the disk alarm';
    edit.disabled = !snapshot || !disk || diskBusy;
    toggle.hidden = !config;
    toggle.textContent = config?.enabled ? 'Turn off' : 'Turn on';
    toggle.disabled = !snapshot || !disk || diskBusy;
  }
  /** Bots that may post in the room, plus the dedicated disk bot when it cannot yet. */
  function fillDiskBots(selected) {
    const form = byId('disk-form'),
      roomId = form.elements.roomId.value;
    const allowed = (snapshot?.bots || []).filter((bot) => bot.rooms.includes(roomId));
    const options = allowed.map((bot) => new Option(bot.name, bot.id));
    if (!allowed.some((bot) => bot.id === DISK_BOT.id)) {
      const existing = snapshot?.bots.some((bot) => bot.id === DISK_BOT.id);
      options.unshift(new Option(`${DISK_BOT.name} (${existing ? 'also post here' : 'new'})`, DISK_BOT.id));
    }
    form.elements.botId.replaceChildren(...options);
    form.elements.botId.value = options.some((o) => o.value === selected) ? selected : options[0]?.value || '';
  }
  function openDisk() {
    if (!snapshot || !disk || diskBusy) return;
    const config = disk.config,
      form = byId('disk-form');
    form.reset();
    form.elements.roomId.replaceChildren(...snapshot.rooms.map((room) => new Option('#' + room.name, room.id)));
    if (config && snapshot.rooms.some((room) => room.id === config.roomId)) form.elements.roomId.value = config.roomId;
    fillDiskBots(config?.botId || DISK_BOT.id);
    form.elements.warnPercent.value = String(config?.warnPercent ?? 90);
    form.elements.criticalPercent.value = String(config?.criticalPercent ?? 99);
    form.elements.intervalMinutes.value = String(config?.intervalMinutes ?? 5);
    form.elements.mention.value = config?.mention || '';
    byId('disk-error').textContent = '';
    byId('disk-dialog').showModal();
  }
  /** Saves through the owner-only bot-watch route; the server validates and refuses anything out of range. */
  async function saveDisk(config) {
    diskBusy = true;
    renderDisk();
    try {
      const data = await api('bot-watches/disk-space', { method: 'PUT', body: JSON.stringify(config) });
      acceptDisk({ data });
      return true;
    } finally {
      diskBusy = false;
      if (!closed) renderDisk();
    }
  }
  function render() {
    if (!snapshot) return;
    renderWatchers();
    renderDisk();
    const { bots, jobs, runs } = snapshot;
    const running = new Set(snapshot.executing.map((job) => job.id));
    byId('summary').replaceChildren(
      ...[
        `${bots.length} bot ${bots.length === 1 ? 'identity' : 'identities'}`,
        `${jobs.filter((job) => job.enabled).length} enabled routines`,
        `${running.size} running now`,
      ].map((text) => node('span', text))
    );
    const query = byId('search').value.trim().toLowerCase(),
      filter = byId('filter').value;
    const list = byId('routines');
    list.replaceChildren();
    for (const job of [...jobs].sort(
      (a, b) =>
        Number(running.has(b.id)) - Number(running.has(a.id)) ||
        (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) ||
        a.name.localeCompare(b.name)
    )) {
      const isRunning = running.has(job.id);
      const bot = bots.find((bot) => bot.id === job.botId);
      const sender =
        job.postAs === 'author'
          ? 'Employee routine'
          : bot?.name || (job.action === 'post' ? 'Bot not found' : 'Agent session');
      if (!`${job.name} ${sender} ${roomName(job.roomId)}`.toLowerCase().includes(query)) continue;
      if (
        (filter === 'running' && !isRunning) ||
        (filter === 'enabled' && !job.enabled) ||
        (filter === 'disabled' && job.enabled)
      )
        continue;
      const element = card(
        job.name || 'Unnamed routine',
        isRunning ? 'Running' : job.enabled ? 'Enabled' : 'Disabled',
        isRunning ? 'running' : ''
      );
      element.append(node('p', `${sender}${job.roomId ? ' · #' + roomName(job.roomId) : ''} · ${schedule(job)}`));
      element.append(
        node(
          'p',
          `Next: ${job.enabled ? time(job.nextRunAt) : 'Disabled'} · Last: ${time(job.lastRunAt)} · ${job.lastStatus || 'Not run yet'}`
        )
      );
      const creatorId = job.createdBy?.employeeId;
      const creator = snapshot.employees.find((employee) => employee.id === creatorId)?.name;
      element.append(
        node(
          'p',
          'Created by: ' + (creatorId ? creator || creatorId : job.createdByOwner === true ? 'Owner' : 'Not recorded')
        )
      );
      const content = contentOf(job),
        details = node('details');
      details.append(node('summary', content.label), node('pre', content.value || '(empty)'));
      if (job.postSource) details.append(node('p', 'Data source: ' + job.postSource));
      element.append(details);
      const actions = node('div', undefined, 'card-actions');
      const toggle = node('button', job.enabled ? 'Disable schedule' : 'Enable schedule');
      toggle.type = 'button';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await api('cron/jobs/' + encodeURIComponent(job.id) + '/enabled', {
            method: 'PUT',
            body: JSON.stringify({ enabled: !job.enabled }),
          });
          await refresh();
        } catch (error) {
          byId('status').className = 'error';
          byId('status').textContent = error.message;
        } finally {
          toggle.disabled = false;
        }
      });
      actions.append(toggle);
      const edit = node('button', 'Edit content');
      edit.type = 'button';
      edit.addEventListener('click', () => openContent(job));
      // A one-time job and the fixed repository watcher keep their schedules in Advanced schedules and the watcher form.
      if (job.scheduleType !== 'once' && job.postSourceArgs?.pull === undefined) {
        const reschedule = node('button', 'Edit schedule');
        reschedule.type = 'button';
        reschedule.addEventListener('click', () => openSchedule(job));
        actions.append(reschedule);
      }
      const preview = node('button', 'Preview or run once');
      preview.type = 'button';
      preview.addEventListener('click', () => openTrial(job));
      actions.append(preview);
      const remove = node('button', 'Delete routine');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (
          !confirm(
            `Delete routine “${job.name}”? Future scheduled runs will be removed. Existing agent sessions keep running.`
          )
        )
          return;
        remove.disabled = true;
        try {
          await api('cron/jobs/' + encodeURIComponent(job.id), { method: 'DELETE' });
          await refresh();
        } catch (error) {
          byId('status').className = 'error';
          byId('status').textContent = error.message;
        } finally {
          remove.disabled = false;
        }
      });
      actions.append(edit, remove);
      element.append(actions);
      list.append(element);
    }
    for (const job of snapshot.executing) {
      if (
        jobs.some((saved) => saved.id === job.id) ||
        filter === 'disabled' ||
        filter === 'enabled' ||
        !job.name.toLowerCase().includes(query)
      )
        continue;
      const element = card(job.name, 'Running', 'running');
      element.append(node('p', 'Schedule removed; the current execution is finishing.'));
      list.append(element);
    }
    if (!list.children.length)
      empty(list, jobs.length ? 'No routines match this view.' : 'No routines yet. Choose New routine to set one up.');
    const identities = byId('bots');
    identities.replaceChildren();
    for (const bot of bots) {
      if (query && !`${bot.name} ${bot.id} ${bot.rooms.map(roomName).join(' ')}`.toLowerCase().includes(query))
        continue;
      const linked = jobs.filter((job) => job.botId === bot.id && job.action === 'post');
      const linkedWatches = watchSnapshot?.watches.filter((w) => w.config.botId === bot.id) || [];
      const image = avatarPath(bot.icon);
      const element = card(
        image ? bot.name : `${bot.icon || '⚙'} ${bot.name}`,
        linkedWatches.length
          ? `${linked.filter((job) => job.enabled).length} enabled routines · ${linkedWatches.filter((w) => w.config.enabled).length} enabled watchers`
          : `${linked.filter((job) => job.enabled).length} enabled`
      );
      if (image) {
        const icon = node('img');
        icon.src = assetUrl(image);
        icon.alt = '';
        icon.className = 'bot-card-icon';
        element.querySelector('h3').prepend(icon);
      }
      element.append(
        node(
          'p',
          `${bot.rooms.length ? bot.rooms.map((id) => '#' + roomName(id)).join(', ') : 'No allowed channels'} · Up to ${bot.maxPerHour} posts/hour`
        )
      );
      const edit = node('button', 'Edit bot');
      edit.type = 'button';
      edit.addEventListener('click', () => openBot(bot));
      const actions = node('div', undefined, 'card-actions');
      actions.append(edit);
      const remove = node('button', 'Delete bot');
      remove.type = 'button';
      remove.disabled = linked.length > 0 || linkedWatches.length > 0;
      if (linked.length) element.append(node('p', "Delete this bot's routines first to remove it.", 'hint'));
      if (linkedWatches.length)
        element.append(node('p', "Remove this bot's repository watchers first to remove it.", 'hint'));
      remove.addEventListener('click', async () => {
        if (!confirm(`Delete bot “${bot.name}”?`)) return;
        remove.disabled = true;
        try {
          await api('chat-bots/' + encodeURIComponent(bot.id), { method: 'DELETE' });
          await refresh();
        } catch (error) {
          byId('status').textContent = error.message;
          byId('status').className = 'error';
          remove.disabled = false;
        }
      });
      actions.append(remove);
      element.append(actions);
      identities.append(element);
    }
    if (!identities.children.length)
      empty(
        identities,
        bots.length ? 'No bots match your search.' : 'No bot identities yet. Employee routines can still appear above.'
      );
    const history = byId('history');
    history.replaceChildren();
    for (const run of [...runs]
      .sort((a, b) => b.startedAt - a.startedAt)
      .filter((run) => {
        const job = jobs.find((job) => job.id === run.cronJobId);
        return !query || `${job?.name || ''} ${roomName(job?.roomId)}`.toLowerCase().includes(query);
      })
      .slice(0, 12)) {
      const job = jobs.find((job) => job.id === run.cronJobId);
      const element = card(
        job?.name || 'Removed routine',
        active(run) ? 'Unfinished' : run.status,
        run.status === 'failed' ? 'failed' : ''
      );
      element.append(
        node('p', `${time(run.startedAt)} · ${run.triggerType === 'manual_run_now' ? 'Manual' : 'Scheduled'}`)
      );
      if (run.errorMessage) element.append(node('p', run.errorMessage, 'error'));
      history.append(element);
    }
    if (!history.children.length) empty(history, 'No recorded runs in this view.');
  }
  function openBot(bot) {
    if (!snapshot) return;
    const form = byId('bot-form');
    form.reset();
    editingId = bot?.id || null;
    byId('bot-title').textContent = bot ? 'Edit bot' : 'Set up a bot';
    byId('bot-error').textContent = '';
    for (const name of ['id', 'name', 'icon', 'maxPerHour'])
      form.elements[name].value = bot?.[name] ?? (name === 'maxPerHour' ? 30 : '');
    botAvatar = avatarPath(bot?.icon);
    if (botAvatar) form.elements.icon.value = '';
    paintBotIcon();
    form.elements.id.readOnly = !!bot;
    const rooms = new Map(snapshot.rooms.map((room) => [room.id, room.name]));
    for (const id of bot?.rooms || []) if (!rooms.has(id)) rooms.set(id, id + ' (not listed)');
    byId('bot-rooms').replaceChildren();
    for (const [id, name] of rooms) {
      const label = node('label', undefined, 'check'),
        input = node('input');
      input.type = 'checkbox';
      input.name = 'rooms';
      input.value = id;
      input.checked = !!bot?.rooms.includes(id);
      label.append(input, node('span', '#' + name));
      byId('bot-rooms').append(label);
    }
    byId('bot-dialog').showModal();
    form.elements.name.focus();
  }
  function paintBotIcon() {
    const preview = byId('bot-icon-preview');
    preview.replaceChildren();
    byId('bot-form').elements.icon.disabled = !!botAvatar;
    byId('clear-bot-avatar').hidden = !botAvatar;
    if (botAvatar) {
      const image = node('img');
      image.src = assetUrl(botAvatar);
      image.alt = 'Selected bot avatar';
      preview.append(image);
    } else preview.textContent = byId('bot-form').elements.icon.value || '⚙';
  }
  byId('bot-form').elements.icon.addEventListener('input', paintBotIcon);
  byId('clear-bot-avatar').addEventListener('click', () => {
    botAvatar = '';
    paintBotIcon();
  });
  byId('choose-bot-avatar').addEventListener('click', async () => {
    const dialog = byId('bot-avatar-dialog');
    if (dialog.open) return;
    byId('bot-avatar-list').replaceChildren();
    byId('bot-avatar-status').textContent = 'Loading avatars…';
    dialog.showModal();
    try {
      const response = await fetch(assetUrl('/assets/avatars/pack-manifest.json'), {
        cache: 'no-cache',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Avatar pack unavailable.');
      const manifest = await response.json();
      if (!dialog.open) return;
      // The manifest decides what is offered: every listed pack avatar except its one "withheld" line.
      const withheld = new Set(Array.isArray(manifest.withheld) ? manifest.withheld : []);
      const avatars = (Array.isArray(manifest.avatars) ? manifest.avatars : [])
        .filter(
          (avatar) =>
            /^pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])$/.test(avatar?.id) &&
            !withheld.has(avatar.id) &&
            avatarPath(avatar?.src) &&
            avatar.src.split('?')[0] === `/assets/avatars/${avatar.id}.png`
        )
        .slice(0, 160);
      byId('bot-avatar-status').textContent = avatars.length ? '' : 'No avatars available.';
      for (const avatar of avatars) {
        const button = node('button');
        button.type = 'button';
        button.setAttribute('aria-label', `Use ${avatar.name}`);
        button.title = avatar.name;
        const image = node('img');
        const thumb =
          typeof avatar.thumb === 'string' &&
          new RegExp(`^/assets/avatars/thumbs/${avatar.id}\\.webp\\?v=[a-f0-9]{64}$`).test(avatar.thumb)
            ? avatar.thumb
            : avatar.src;
        image.src = assetUrl(thumb);
        image.alt = '';
        image.loading = 'lazy';
        image.width = image.height = 56;
        button.append(image);
        button.addEventListener('click', () => {
          botAvatar = avatar.src;
          paintBotIcon();
          dialog.close();
          byId('choose-bot-avatar').focus();
        });
        byId('bot-avatar-list').append(button);
      }
    } catch {
      byId('bot-avatar-status').textContent = 'Avatar pack unavailable. You can still use an emoji.';
    }
  });
  function fillRoutineRooms() {
    const form = byId('routine-form'),
      bot = snapshot?.bots.find((bot) => bot.id === form.elements.botId.value);
    form.elements.roomId.replaceChildren(...(bot?.rooms || []).map((id) => new Option('#' + roomName(id), id)));
  }
  byId('new-bot').addEventListener('click', () => openBot());
  byId('new-watch').addEventListener('click', () => openWatcher());
  byId('disk-edit').addEventListener('click', () => openDisk());
  byId('disk-form').elements.roomId.addEventListener('change', () => fillDiskBots(byId('disk-form').elements.botId.value));
  byId('disk-toggle').addEventListener('click', async () => {
    const config = disk?.config;
    if (!config || diskBusy || closed) return;
    try {
      await saveDisk({ ...config, enabled: !config.enabled });
    } catch (error) {
      byId('disk-status').textContent = 'The disk alarm was not changed: ' + error.message;
    }
  });
  byId('disk-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!snapshot || !disk || diskBusy || closed) return;
    byId('disk-error').textContent = '';
    try {
      const roomId = form.elements.roomId.value,
        botId = form.elements.botId.value;
      const warnPercent = Number(form.elements.warnPercent.value),
        criticalPercent = Number(form.elements.criticalPercent.value),
        intervalMinutes = Number(form.elements.intervalMinutes.value),
        mention = form.elements.mention.value.trim().replace(/^@/, '');
      if (!snapshot.rooms.some((room) => room.id === roomId)) throw new Error('Choose a channel.');
      if (!Number.isInteger(warnPercent) || !Number.isInteger(criticalPercent) || warnPercent >= criticalPercent)
        throw new Error('The warning level must be a whole percent below the critical level.');
      if (mention && !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/.test(mention))
        throw new Error('A mention is a name of letters, digits, spaces, dots, dashes or underscores.');
      let bot = snapshot.bots.find((b) => b.id === botId);
      if (botId === DISK_BOT.id && !bot?.rooms.includes(roomId)) {
        // The dedicated bot is created for this channel, or allowed in it as well; nothing else about it changes.
        const body = bot
          ? { name: bot.name, ...(bot.icon ? { icon: bot.icon } : {}), rooms: [...bot.rooms, roomId], maxPerHour: bot.maxPerHour }
          : { name: DISK_BOT.name, icon: DISK_BOT.icon, rooms: [roomId], maxPerHour: DISK_BOT.maxPerHour };
        bot = (await api('chat-bots/' + DISK_BOT.id, { method: 'PUT', body: JSON.stringify(body) })).bot || { id: DISK_BOT.id, ...body };
        snapshot.bots = [...snapshot.bots.filter((b) => b.id !== DISK_BOT.id), bot];
      }
      if (!bot?.rooms.includes(roomId)) throw new Error('Choose a bot that may post in this channel.');
      await saveDisk({
        version: 1,
        type: 'disk-space',
        enabled: true,
        botId: bot.id,
        roomId,
        warnPercent,
        criticalPercent,
        rearmMarginPercent: disk.config?.rearmMarginPercent ?? 1,
        intervalMinutes,
        ...(mention ? { mention } : {}),
      });
      byId('disk-dialog').close();
    } catch (error) {
      byId('disk-error').textContent = error.message;
    }
  });
  byId('watch-form').elements.botId.addEventListener('change', () => fillWatchRooms());
  byId('watch-form').elements.intervalMinutes.addEventListener('input', () => {
    watchCadenceEdited = true;
  });
  byId('watch-form').elements.credentialId.addEventListener('change', (event) => {
    if (watchEdit && !watchEdit.id && !watchCadenceEdited)
      byId('watch-form').elements.intervalMinutes.value = event.target.value ? '15' : '30';
  });
  byId('watch-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      submit = form.querySelector('[type=submit]');
    if (!watchEdit || watchBusy || !watchSnapshot || closed) return;
    byId('watch-error').textContent = '';
    let config;
    try {
      const [owner, repo] = repositoryParts(form.elements.repository.value);
      const events = Object.fromEntries(
        Object.keys(eventLabels).map((key) => [key, !!form.querySelector(`[name=events][value="${key}"]`)?.checked])
      );
      if (!Object.values(events).some(Boolean)) throw new Error('Choose at least one event.');
      const bot = snapshot.bots.find((b) => b.id === form.elements.botId.value);
      if (!bot || !bot.rooms.includes(form.elements.roomId.value))
        throw new Error('Choose a bot and one of its allowed channels.');
      const intervalMinutes = Number(form.elements.intervalMinutes.value);
      const original = watchEdit.configs.find((w) => w.id === watchEdit.id);
      const unchangedLegacy =
        original?.id === 'github-issues' &&
        original.intervalMinutes === intervalMinutes &&
        original.owner === owner &&
        original.repo === repo &&
        original.botId === bot.id &&
        original.roomId === form.elements.roomId.value &&
        original.visibility === form.elements.visibility.value &&
        original.credentialId === (form.elements.credentialId.value || null) &&
        Object.keys(eventLabels).every((key) => original.events[key] === events[key]);
      if (!Number.isInteger(intervalMinutes) || (!unchangedLegacy && intervalMinutes < 15) || intervalMinutes > 1440)
        throw new Error('Choose a check interval from 15 to 1440 minutes.');
      if (!watchEdit.id && watchEdit.configs.length >= 8)
        throw new Error('Up to 8 repositories can be watched. Remove one before adding another.');
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (value) =>
        value.toString(16).padStart(2, '0')
      ).join('');
      const id =
        watchEdit.id ||
        `${owner}-${repo}`
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-')
          .slice(0, 30) +
          '-' +
          suffix;
      config = {
        id,
        enabled: form.elements.enabled.checked,
        botId: bot.id,
        roomId: form.elements.roomId.value,
        owner,
        repo,
        visibility: form.elements.visibility.value,
        intervalMinutes,
        events,
        credentialId: form.elements.credentialId.value || null,
      };
    } catch (error) {
      byId('watch-error').textContent = error.message;
      return;
    }
    watchBusy = true;
    submit.disabled = true;
    renderWatchers();
    try {
      const configs = watchEdit.id
        ? watchEdit.configs.map((w) => (w.id === watchEdit.id ? config : w))
        : [...watchEdit.configs, config];
      await putWatchers(watchEdit.revision, configs);
      byId('watch-dialog').close();
      watchEdit = null;
    } catch (error) {
      if (error.status === 403) watchSnapshot = null;
      byId('watch-error').textContent =
        error.status === 409
          ? 'Watchers changed elsewhere. Close this dialog and refresh before saving again.'
          : error.status === 403
            ? 'Sign in as the owner to save repository watchers.'
            : 'Could not confirm the save. Refresh before trying again.';
    } finally {
      watchBusy = false;
      submit.disabled = false;
      if (!closed && snapshot) render();
    }
  });
  byId('add-watch-credential').addEventListener('click', () => {
    if (credentialBusy || !watchEdit || closed) return;
    try {
      credentialRepository = repositoryParts(byId('watch-form').elements.repository.value).join('/');
    } catch (error) {
      byId('watch-error').textContent = error.message;
      return;
    }
    const form = byId('watch-credential-form');
    credentialEpoch++;
    form.reset();
    byId('watch-credential-repository').textContent = 'For ' + credentialRepository;
    byId('watch-credential-error').textContent = '';
    byId('watch-credential-dialog').showModal();
    form.elements.name.focus();
  });
  byId('watch-credential-dialog').addEventListener('close', () => {
    credentialEpoch++;
    byId('watch-credential-form').elements.token.value = '';
  });
  byId('watch-dialog').addEventListener('close', () => {
    watchEdit = null;
    credentialEpoch++;
    if (byId('watch-credential-dialog').open) byId('watch-credential-dialog').close();
  });
  byId('watch-credential-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      submit = form.querySelector('[type=submit]');
    if (credentialBusy || !credentialRepository || closed) return;
    const requestEpoch = credentialEpoch,
      requestWatch = watchEdit,
      requestRepository = credentialRepository;
    const currentRequest = () => {
      if (
        closed ||
        credentialEpoch !== requestEpoch ||
        watchEdit !== requestWatch ||
        !byId('watch-dialog').open ||
        !byId('watch-credential-dialog').open
      )
        return false;
      try {
        return repositoryParts(byId('watch-form').elements.repository.value).join('/') === requestRepository;
      } catch {
        return false;
      }
    };
    credentialBusy = true;
    byId('add-watch-credential').disabled = true;
    submit.disabled = true;
    byId('watch-credential-error').textContent = '';
    try {
      const label = form.elements.label.value.trim();
      const data = await api('publication/tokens', {
        method: 'POST',
        body: JSON.stringify({
          name: form.elements.name.value.trim(),
          token: form.elements.token.value,
          ...(label ? { label } : {}),
          repositories: [requestRepository],
        }),
      });
      if (!currentRequest()) return;
      const token = data?.token;
      if (!token || typeof token.id !== 'string' || typeof token.name !== 'string')
        throw new Error('Missing saved credential metadata');
      credentials = [
        ...credentials.filter((item) => item.id !== token.id),
        {
          id: token.id,
          name: token.name,
          ...(typeof token.label === 'string' ? { label: token.label } : {}),
          repositories: token.repositories,
        },
      ];
      credentialsAvailable = true;
      fillWatchCredentials(token.id);
      byId('watch-credential-dialog').close();
      byId('watch-form').elements.credentialId.focus();
    } catch (error) {
      if (!currentRequest()) return;
      byId('watch-credential-error').textContent =
        error.status === 403
          ? 'Sign in as the owner to save a credential.'
          : 'Could not confirm the credential save. Refresh credential names before trying again.';
    } finally {
      if (credentialEpoch === requestEpoch) form.elements.token.value = '';
      credentialBusy = false;
      submit.disabled = false;
      byId('add-watch-credential').disabled = false;
    }
  });
  byId('new-routine').addEventListener('click', () => {
    if (!snapshot) return;
    if (!snapshot.bots.length) {
      byId('status').textContent = 'Set up a bot identity first, then add its routine.';
      openBot();
      return;
    }
    const form = byId('routine-form');
    form.reset();
    routineSchedule.write(null);
    byId('routine-error').textContent = '';
    form.elements.botId.replaceChildren(...snapshot.bots.map((bot) => new Option(bot.name, bot.id)));
    fillRoutineRooms();
    byId('routine-dialog').showModal();
    form.elements.name.focus();
  });
  byId('routine-form').elements.botId.addEventListener('change', fillRoutineRooms);
  const routineSchedule = scheduleEditor(byId('routine-schedule'));
  const editSchedule = scheduleEditor(byId('edit-schedule'));
  let editingSchedule = null;
  function openSchedule(job) {
    editingSchedule = job;
    byId('schedule-error').textContent = '';
    byId('schedule-title').textContent = 'Edit schedule: ' + (job.name || 'Unnamed routine');
    editSchedule.write(job);
    byId('schedule-dialog').showModal();
  }
  byId('schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('[type=submit]');
    if (!editingSchedule || submit.disabled) return;
    const schedule = editSchedule.read();
    if (schedule instanceof Error) {
      byId('schedule-error').textContent = schedule.message;
      return;
    }
    submit.disabled = true;
    byId('schedule-error').textContent = '';
    try {
      await api('cron/jobs/' + encodeURIComponent(editingSchedule.id), { method: 'PUT', body: JSON.stringify(schedule) });
      byId('schedule-dialog').close();
      await refresh();
    } catch (error) {
      byId('schedule-error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  byId('content-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      submit = form.querySelector('[type=submit]');
    if (!editingContent || !snapshot || submit.disabled) return;
    submit.disabled = true;
    byId('content-error').textContent = '';
    try {
      await api('cron/jobs/' + encodeURIComponent(editingContent.id), {
        method: 'PUT',
        body: JSON.stringify({ [editingContent.field]: form.elements.content.value }),
      });
      byId('content-dialog').close();
      await refresh();
    } catch (error) {
      byId('content-error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  for (const kind of ['bot', 'routine'])
    byId(kind + '-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget,
        submit = form.querySelector('[type=submit]');
      if (submit.disabled || !snapshot) return;
      submit.disabled = true;
      byId(kind + '-error').textContent = '';
      const fields = new FormData(form);
      try {
        if (kind === 'bot') {
          const id = String(fields.get('id')).trim();
          if (!editingId && snapshot.bots.some((bot) => bot.id === id))
            throw new Error('That identifier already exists. Choose Edit bot to change it.');
          await api('chat-bots/' + encodeURIComponent(id), {
            method: 'PUT',
            body: JSON.stringify({
              name: fields.get('name'),
              icon: botAvatar || fields.get('icon'),
              rooms: fields.getAll('rooms'),
              maxPerHour: Number(fields.get('maxPerHour')),
            }),
          });
        } else {
          const schedule = routineSchedule.read();
          if (schedule instanceof Error) throw schedule;
          await api('cron/jobs', {
            method: 'POST',
            body: JSON.stringify({
              name: fields.get('name'),
              action: 'post',
              botId: fields.get('botId'),
              roomId: fields.get('roomId'),
              postText: fields.get('postText'),
              ...schedule,
              enabled: fields.has('enabled'),
            }),
          });
        }
        byId(kind + '-dialog').close();
        await refresh();
      } catch (error) {
        byId(kind + '-error').textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    });
  byId('advanced').addEventListener('click', () => {
    try {
      if (
        parent !== window &&
        parent.location.origin === location.origin &&
        typeof parent.app?.openCron === 'function'
      ) {
        parent.app.openCron();
        return;
      }
    } catch {
      /* The dashboard never sends authority to another origin. */
    }
    byId('advanced-hint').textContent = 'Open Bots from the chat sidebar to access the advanced schedule editor.';
  });
  for (const button of document.querySelectorAll('[data-close]'))
    button.addEventListener('click', () => byId(button.dataset.close).close());
  byId('trial-go').addEventListener('click', runTrial);
  byId('trial-dialog').addEventListener('close', () => {
    trial = undefined;
  });
  byId('search').addEventListener('input', render);
  byId('filter').addEventListener('change', render);
  byId('refresh').addEventListener('click', refresh);
  byId('new-bot').disabled = byId('new-routine').disabled = true;
  const poll = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 10000);
  addEventListener('pagehide', () => {
    closed = true;
    credentialEpoch++;
    clearInterval(poll);
    for (const request of requests) request.abort();
    byId('watch-credential-form').elements.token.value = '';
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  void refresh();
})();
