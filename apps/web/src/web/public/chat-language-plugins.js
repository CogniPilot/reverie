/** Explicit snippet assistance; no execution, workspace paths, CDN assets or background requests. */
(function (root) {
  'use strict';
  const host = root.ReverieChatPlugins;
  const MAX_SOURCE = 50000;
  const node = (tag, text, className) => {
    const el = root.document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  for (const definition of [
    { id: 'python', label: 'Python', languages: ['python', 'py'], server: 'Pyright' },
    { id: 'modelica', label: 'Modelica', languages: ['modelica', 'mo'], server: 'Rumoca LSP' },
  ]) {
    const dialogs = new Set();
    host.register({
      ...definition,
      description: `Edit a scratch copy and request local ${definition.server} diagnostics, completion or hover.`,
      enable: () => () => {
        for (const dialog of dialogs) dialog.close();
      },
      enhanceBlock({ code, pre }) {
        if (code.textContent.length > MAX_SOURCE) return;
        const actions = node('div', '', 'chat-plugin-actions');
        const button = node('button', `${definition.label} assistance`);
        button.type = 'button';
        actions.append(button);
        pre.after(actions);
        button.addEventListener('click', () => openEditor(code.textContent, definition, dialogs));
        return () => actions.remove();
      },
    });
  }
  function openEditor(source, definition, dialogs) {
    const dialog = node('dialog', '', 'chat-language-editor chat-plugin-dialog');
    dialogs.add(dialog);
    dialog.append(
      node('h2', `${definition.label} scratch editor`),
      node(
        'p',
        'Changes stay in this scratch copy. Select Check, Complete or Hover to send this snippet to the local language server. Code is never executed.'
      )
    );
    const editor = node('textarea');
    editor.value = source;
    editor.maxLength = MAX_SOURCE;
    editor.spellcheck = false;
    editor.setAttribute('aria-label', `${definition.label} source`);
    dialog.append(editor);
    const controls = node('div', '', 'chat-plugin-actions');
    const output = node('pre', 'Ready. No language server has started.', 'chat-plugin-output');
    output.setAttribute('aria-live', 'polite');
    let request;
    let generation = 0;
    const buttons = [];
    for (const [label, action] of [
      ['Check', 'diagnostics'],
      ['Complete', 'completion'],
      ['Hover', 'hover'],
    ]) {
      const button = node('button', label);
      button.type = 'button';
      buttons.push(button);
      controls.append(button);
      button.addEventListener('click', async () => {
        request?.abort();
        const controller = (request = new root.AbortController());
        const current = ++generation;
        buttons.forEach((item) => (item.disabled = true));
        output.textContent = `Asking ${definition.server}…`;
        const before = editor.value.slice(0, editor.selectionStart).split('\n');
        try {
          const response = await root.fetch(`${root.__REVERIE_BASE__ || ''}/api/chat-plugins/lsp`, {
            method: 'POST',
            credentials: 'same-origin',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enabled: true,
              language: definition.id,
              source: editor.value,
              action,
              position: { line: before.length - 1, character: before.at(-1).length },
            }),
          });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(result.error || 'Language assistance unavailable');
          if (current !== generation || !dialog.isConnected) return;
          // Server strings are text only. Markdown, links and snippets are never inserted or executed.
          output.textContent = formatResult(result.data, action);
        } catch (error) {
          if (current === generation && dialog.isConnected)
            output.textContent = error.name === 'AbortError' ? 'Cancelled.' : error.message;
        } finally {
          if (current === generation) buttons.forEach((item) => (item.disabled = false));
        }
      });
    }
    const cancel = node('button', 'Cancel request');
    cancel.type = 'button';
    cancel.addEventListener('click', () => request?.abort());
    controls.append(cancel);
    const close = node('button', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    controls.append(close);
    dialog.append(controls, output);
    dialog.addEventListener(
      'close',
      () => {
        generation++;
        request?.abort();
        editor.value = '';
        dialogs.delete(dialog);
        dialog.remove();
      },
      { once: true }
    );
    root.document.body.append(dialog);
    dialog.showModal();
    editor.focus();
  }
  function formatResult(data, action) {
    const diagnostics = (data.diagnostics || []).map(
      (item) => `${item.line + 1}:${item.character + 1} ${item.message}`
    );
    if (action === 'completion')
      return (
        (data.completions || []).map((item) => `${item.label}${item.detail ? ` — ${item.detail}` : ''}`).join('\n') ||
        'No completions at the cursor.'
      );
    if (action === 'hover') return data.hover || 'No hover information at the cursor.';
    return (
      diagnostics.join('\n') ||
      (data.diagnosticsReceived
        ? 'No diagnostics for this snippet.'
        : 'The server did not publish diagnostics before the deadline. Try Check again.')
    );
  }
})(window);
