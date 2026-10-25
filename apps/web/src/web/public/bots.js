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
    typeof value === 'string' && /^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png(?:\?v=[a-f0-9]{64})?$/.test(value) ? value : '';
  const assetUrl = (path) => new URL('.' + path, location.href).href;
  let snapshot,
    busy = false,
    closed = false,
    editingId = null;
  const requests = new Set();
  const terminal = new Set(['posted', 'failed', 'skipped', 'prompt_sent']);
  const active = (run) => run.finishedAt === null && !terminal.has(run.status);
  const time = (value) => (Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : '—');
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
      if (!response.ok || result.success === false)
        throw new Error(result.error?.message || result.error || `Request failed (${response.status})`);
      return result.success === true ? result.data : result;
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
      const [bots, jobs, runs, rooms, company, executing] = await Promise.all([
        api('chat-bots'),
        api('cron/jobs'),
        api('cron/runs'),
        api('chatrooms'),
        api('company').catch(() => null),
        api('cron/active'),
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
        rooms: rooms.rooms.filter((room) => !room.dm),
        employees: company?.employees || [],
        executing: executing.jobs,
      };
      byId('status').className = '';
      byId('status').textContent = 'Updated ' + new Date().toLocaleTimeString();
      render();
    } catch (error) {
      if (closed) return;
      snapshot = undefined;
      byId('status').className = 'error';
      byId('status').textContent = 'Bot status unavailable: ' + error.message;
      for (const id of ['summary', 'routines', 'bots', 'history']) byId(id).replaceChildren();
    } finally {
      busy = false;
      byId('refresh').disabled = false;
      byId('new-bot').disabled = byId('new-routine').disabled = !snapshot;
    }
  }
  const roomName = (id) => snapshot.rooms.find((room) => room.id === id)?.name || id || 'No channel';
  const schedule = (job) => {
    if (job.scheduleType === 'interval') return `Every ${job.intervalMinutes} minutes`;
    if (job.scheduleType === 'once') return 'Once: ' + time(job.runAt);
    return `${job.scheduleType === 'weekly' ? 'Weekly ' + (job.weeklyDays || []).map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ') : 'Daily'} at ${job.dailyTime || job.weeklyTime || '—'}${job.timeZone ? ' · ' + job.timeZone : ''}`;
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
  function render() {
    if (!snapshot) return;
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
      const image = avatarPath(bot.icon);
      const element = card(
        image ? bot.name : `${bot.icon || '⚙'} ${bot.name}`,
        `${linked.filter((job) => job.enabled).length} enabled`
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
      remove.disabled = linked.length > 0;
      if (linked.length) element.append(node('p', "Delete this bot's routines first to remove it.", 'hint'));
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
      const avatars = (Array.isArray(manifest.avatars) ? manifest.avatars : [])
        .filter((avatar) => /^pack-(?:0[1-9]|[1-4][0-9]|50|10[2-9]|1[1-4][0-9]|15[01])$/.test(avatar?.id) && avatarPath(avatar?.src) && avatar.src.split('?')[0] === `/assets/avatars/${avatar.id}.png`)
        .slice(0, 100);
      byId('bot-avatar-status').textContent = avatars.length ? '' : 'No avatars available.';
      for (const avatar of avatars) {
        const button = node('button');
        button.type = 'button';
        button.setAttribute('aria-label', `Use ${avatar.name}`);
        button.title = avatar.name;
        const image = node('img');
        image.src = assetUrl(avatar.src);
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
  byId('new-routine').addEventListener('click', () => {
    if (!snapshot) return;
    if (!snapshot.bots.length) {
      byId('status').textContent = 'Set up a bot identity first, then add its routine.';
      openBot();
      return;
    }
    const form = byId('routine-form');
    form.reset();
    byId('routine-error').textContent = '';
    form.elements.botId.replaceChildren(...snapshot.bots.map((bot) => new Option(bot.name, bot.id)));
    fillRoutineRooms();
    byId('routine-dialog').showModal();
    form.elements.name.focus();
  });
  byId('routine-form').elements.botId.addEventListener('change', fillRoutineRooms);
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
          await api('cron/jobs', {
            method: 'POST',
            body: JSON.stringify({
              name: fields.get('name'),
              action: 'post',
              botId: fields.get('botId'),
              roomId: fields.get('roomId'),
              postText: fields.get('postText'),
              scheduleType: 'interval',
              intervalMinutes: Number(fields.get('intervalMinutes')),
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
  byId('search').addEventListener('input', render);
  byId('filter').addEventListener('change', render);
  byId('refresh').addEventListener('click', refresh);
  byId('new-bot').disabled = byId('new-routine').disabled = true;
  const poll = setInterval(() => {
    if (!document.hidden) void refresh();
  }, 10000);
  addEventListener('pagehide', () => {
    closed = true;
    clearInterval(poll);
    for (const request of requests) request.abort();
  });
  addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  void refresh();
})();
