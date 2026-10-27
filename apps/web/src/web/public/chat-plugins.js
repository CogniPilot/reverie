/** Shared, owner-controlled chat extensions. Snippet drafts never enter storage. */
(function (root) {
  'use strict';
  const plugins = new Map();
  const mounted = new Map();
  let preferences = {};
  let canManage = false;
  let queued = false;
  let saving = false;
  const endpoint = `${root.__REVERIE_BASE__ || ''}/api/chat-plugins`;
  const enabled = (id) => preferences[id] === true && (id === 'latex' || canManage);
  const schedule = () => {
    if (queued) return;
    queued = true;
    root.queueMicrotask(() => {
      queued = false;
      if (root.document?.body) scan();
    });
  };
  function clear(id) {
    for (const [code, entries] of mounted) {
      for (const [name, cleanup] of entries) {
        if ((id && name === id) || !code.isConnected) {
          try {
            cleanup?.();
          } finally {
            entries.delete(name);
          }
        }
      }
      if (!entries.size) mounted.delete(code);
    }
  }
  function scan(scope = root.document) {
    clear();
    if (![...plugins.values()].some((plugin) => enabled(plugin.id) && plugin.enhanceBlock)) return;
    for (const code of scope.querySelectorAll('pre > code')) {
      const language = [...code.classList]
        .find((name) => name.startsWith('language-'))
        ?.slice(9)
        .toLowerCase();
      for (const plugin of plugins.values()) {
        if (!enabled(plugin.id) || !plugin.enhanceBlock || !plugin.languages?.includes(language)) continue;
        const entries = mounted.get(code) || new Map();
        if (entries.has(plugin.id)) continue;
        entries.set(plugin.id, null);
        mounted.set(code, entries);
        entries.set(plugin.id, plugin.enhanceBlock({ code, pre: code.parentElement, language, host }));
      }
    }
  }
  function apply(data) {
    const before = new Map([...plugins.keys()].map((id) => [id, enabled(id)]));
    preferences = data.enabled || {};
    canManage = data.canManage === true;
    for (const plugin of plugins.values()) {
      if (before.get(plugin.id) === enabled(plugin.id)) continue;
      if (enabled(plugin.id)) plugin.cleanup = plugin.enable?.(host) || plugin.onEnable?.(host);
      else {
        clear(plugin.id);
        plugin.cleanup?.();
        plugin.cleanup = undefined;
        plugin.onDisable?.(host);
      }
      root.dispatchEvent(
        new root.CustomEvent('reverie:chat-plugin-change', {
          detail: { id: plugin.id, enabled: enabled(plugin.id) },
        })
      );
    }
    schedule();
    return data;
  }
  async function request(options) {
    const response = await root.fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', ...options });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Plugin settings unavailable');
    return apply(result.data);
  }
  async function refresh() {
    try {
      return await request();
    } catch (error) {
      apply({ enabled: {}, canManage: false });
      throw error;
    }
  }
  async function setEnabled(id, value) {
    if (!canManage) throw new Error('Owner sign-in required');
    if (!['latex', 'python', 'modelica'].includes(id) || !plugins.has(id)) throw new Error('Unknown plugin');
    if (saving) throw new Error('Plugin settings are saving');
    saving = true;
    try {
      return await request({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latex: preferences.latex === true,
          python: preferences.python === true,
          modelica: preferences.modelica === true,
          [id]: value === true,
        }),
      });
    } finally {
      saving = false;
    }
  }
  async function openSettings() {
    const data = await refresh();
    if (!canManage) throw new Error('Owner sign-in required');
    root.document.querySelector('.chat-plugins-settings')?.close();
    const dialog = root.document.createElement('dialog');
    dialog.className = 'chat-plugins-settings chat-plugin-dialog';
    const title = root.document.createElement('h2');
    title.textContent = 'Chat plugins';
    title.id = 'chat-plugins-title';
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.append(title);
    const note = root.document.createElement('p');
    note.textContent =
      'Shared server settings, off by default. Each change saves immediately for everyone. Enabling a plugin does not install or download tools.';
    dialog.append(note);
    const status = root.document.createElement('p');
    status.className = 'chat-plugin-status';
    status.setAttribute('role', 'status');
    const inputs = [];
    for (const plugin of plugins.values()) {
      const label = root.document.createElement('label');
      label.className = 'chat-plugin-choice';
      const input = root.document.createElement('input');
      inputs.push(input);
      input.type = 'checkbox';
      input.checked = preferences[plugin.id] === true;
      input.addEventListener('change', async () => {
        inputs.forEach((item) => (item.disabled = true));
        status.textContent = 'Saving…';
        try {
          await setEnabled(plugin.id, input.checked);
          status.textContent = 'Saved for everyone.';
        } catch (error) {
          status.textContent = error.message;
        } finally {
          input.checked = preferences[plugin.id] === true;
          inputs.forEach((item) => (item.disabled = false));
        }
      });
      const text = root.document.createElement('span');
      const unavailable =
        data.available?.[plugin.id] === false ? ' Local server is not included in this installation.' : '';
      text.textContent = `${plugin.label} — ${plugin.description}${unavailable}`;
      label.append(input, text);
      dialog.append(label);
    }
    dialog.append(status);
    const close = root.document.createElement('button');
    close.type = 'button';
    close.textContent = 'Done';
    close.addEventListener('click', () => dialog.close());
    dialog.append(close);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    root.document.body.append(dialog);
    dialog.showModal();
  }
  const host = (root.ReverieChatPlugins = {
    register(plugin) {
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(plugin.id) || plugins.has(plugin.id))
        throw new Error('Invalid or duplicate chat plugin');
      plugins.set(plugin.id, plugin);
      if (enabled(plugin.id)) plugin.cleanup = plugin.enable?.(host) || plugin.onEnable?.(host);
      schedule();
    },
    isEnabled: enabled,
    canManage: () => canManage,
    setEnabled,
    scan,
    openSettings,
    refresh,
  });
  new root.MutationObserver(schedule).observe(root.document.body, { childList: true, subtree: true });
  root.addEventListener('focus', () => refresh().catch(() => {}));
  root.document.addEventListener('visibilitychange', () => {
    if (!root.document.hidden) refresh().catch(() => {});
  });
  // Server state is authoritative. Old browser-local choices are deliberately ignored.
  refresh().catch(() => {});
  schedule();
})(window);
