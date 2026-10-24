/** Optional chat extensions. Preferences contain booleans only; snippets stay out of storage. */
(function (root) {
  'use strict';
  const key = 'reverie:chat-plugins:v1';
  const plugins = new Map();
  const mounted = new Map();
  let preferences = {};
  try {
    preferences = JSON.parse(root.localStorage.getItem(key) || '{}') || {};
  } catch {
    /* storage is optional */
  }
  const enabled = (id) => preferences[id] === true;
  let queued = false;
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
    const header = root.document.querySelector('.ca-head');
    if (header && !header.querySelector('.ca-plugins-open')) {
      const button = root.document.createElement('button');
      button.type = 'button';
      button.className = 'ca-icon-btn ca-plugins-open';
      button.textContent = 'Plugins';
      button.setAttribute('aria-label', 'Optional chat plugins');
      button.addEventListener('click', openSettings);
      header.append(button);
    }
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
        // Mark before the extension mutates the DOM; observer callbacks cannot mount twice.
        entries.set(plugin.id, null);
        mounted.set(code, entries);
        entries.set(plugin.id, plugin.enhanceBlock({ code, pre: code.parentElement, language, host }));
      }
    }
  }
  function setEnabled(id, value) {
    const plugin = plugins.get(id);
    if (!plugin || enabled(id) === Boolean(value)) return;
    preferences = { ...preferences, [id]: Boolean(value) };
    try {
      root.localStorage.setItem(
        key,
        JSON.stringify(Object.fromEntries([...plugins.keys()].map((name) => [name, enabled(name)])))
      );
    } catch {
      /* private mode */
    }
    if (enabled(id)) plugin.cleanup = plugin.enable?.(host) || plugin.onEnable?.(host);
    else {
      clear(id);
      plugin.cleanup?.();
      plugin.cleanup = undefined;
      plugin.onDisable?.(host);
    }
    root.dispatchEvent(new root.CustomEvent('reverie:chat-plugin-change', { detail: { id, enabled: enabled(id) } }));
    schedule();
  }
  function openSettings() {
    root.document.querySelector('.chat-plugins-settings')?.remove();
    const dialog = root.document.createElement('dialog');
    dialog.className = 'chat-plugins-settings chat-plugin-dialog';
    const title = root.document.createElement('h2');
    title.textContent = 'Optional chat plugins';
    dialog.append(title);
    const note = root.document.createElement('p');
    note.textContent =
      'Off by default. Choices apply to this browser. Language assistance sends only the snippet you explicitly check to a local server; it never runs your code.';
    dialog.append(note);
    for (const plugin of plugins.values()) {
      const label = root.document.createElement('label');
      label.className = 'chat-plugin-choice';
      const input = root.document.createElement('input');
      input.type = 'checkbox';
      input.checked = enabled(plugin.id);
      input.addEventListener('change', () => setEnabled(plugin.id, input.checked));
      const text = root.document.createElement('span');
      text.textContent = `${plugin.label} — ${plugin.description}`;
      label.append(input, text);
      dialog.append(label);
    }
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
    setEnabled,
    scan,
    openSettings,
  });
  new root.MutationObserver(schedule).observe(root.document.body, { childList: true, subtree: true });
  root.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    let next;
    try {
      next = JSON.parse(event.newValue || '{}') || {};
    } catch {
      return;
    }
    for (const id of plugins.keys()) setEnabled(id, next[id] === true);
  });
  schedule();
})(window);
