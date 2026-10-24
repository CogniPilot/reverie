/** Opt-in math source/preview UI. Textareas remain the sole editable/sendable source. */
(function (root) {
  'use strict';
  const doc = root.document;
  const base = new URL('.', doc.currentScript?.src || doc.baseURI);
  let assets;
  function loadAssets() {
    if (assets) return assets;
    const script = (path) =>
      new Promise((resolve, reject) => {
        const node = doc.createElement('script');
        node.src = new URL(path, base).href;
        node.onload = resolve;
        node.onerror = () => {
          node.remove();
          reject(new Error('Math preview unavailable. Source is unchanged.'));
        };
        doc.head.append(node);
      });
    const css = doc.createElement('link');
    css.rel = 'stylesheet';
    css.href = new URL('vendor/katex-0.19.0/katex.min.css', base).href;
    doc.head.append(css);
    assets = (async () => {
      if (!root.katex) await script('vendor/katex-0.19.0/katex.min.js');
      if (!root.sanitizeChatMathHtml) await script('chat-math-sanitizer.js');
      if (!root.ReverieChatMath) await script('chat-math-renderer.js');
    })().catch((error) => {
      assets = null;
      css.remove();
      throw error;
    });
    return assets;
  }
  function element(tag, cls, text) {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, run) {
    const node = element('button', 'chat-math-button', text);
    node.type = 'button';
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      run();
    });
    return node;
  }
  function renderText(text, target) {
    const ranges = [];
    const lines = /^(?: {0,3})(`{3,}|~{3,})[^\n]*$/gm;
    let opening, match;
    while ((match = lines.exec(text))) {
      if (!opening) opening = { at: match.index, fence: match[1] };
      else if (match[1][0] === opening.fence[0] && match[1].length >= opening.fence.length) {
        ranges.push([opening.at, lines.lastIndex]);
        opening = null;
      }
    }
    if (opening) ranges.push([opening.at, text.length]);
    for (const part of root.ReverieChatMath.mathSegments(text, ranges)) {
      target.append(part.math === undefined ? doc.createTextNode(part.text) : root.ReverieChatMath.mathNode(part, doc));
    }
  }
  function enable() {
    let active = true,
      observer,
      queued = false;
    const messages = new Map(),
      editors = new Map();
    function enhanceEditor(input) {
      if (editors.has(input)) return;
      const bar = element('div', 'chat-math-toolbar');
      const preview = element('div', 'chat-math-preview chat-math-composer-preview');
      preview.hidden = true;
      let showing = false,
        last = '';
      const refresh = () => {
        if (showing && last !== input.value) {
          last = input.value;
          preview.replaceChildren();
          renderText(input.value, preview);
        }
      };
      const toggle = button('Preview math', () => {
        showing = !showing;
        input.hidden = showing;
        preview.hidden = !showing;
        toggle.textContent = showing ? 'Edit source' : 'Preview math';
        toggle.setAttribute('aria-pressed', String(showing));
        if (showing) {
          last = null;
          refresh();
        } else input.focus();
      });
      toggle.setAttribute('aria-pressed', 'false');
      const insert = (display) => {
        showing = false;
        input.hidden = false;
        preview.hidden = true;
        toggle.textContent = 'Preview math';
        toggle.setAttribute('aria-pressed', 'false');
        const start = input.selectionStart,
          end = input.selectionEnd;
        const selected = input.value.slice(start, end) || 'x';
        const delimiter = display ? '$$' : '$';
        const value = display ? '$$\n' + selected + '\n$$' : delimiter + selected + delimiter;
        input.setRangeText(value, start, end, 'select');
        input.dispatchEvent(new root.Event('input', { bubbles: true }));
        input.focus();
      };
      bar.append(
        toggle,
        button('Inline math', () => insert(false)),
        button('Display math', () => insert(true))
      );
      bar.setAttribute('aria-label', 'Math editing');
      input.before(bar);
      input.after(preview);
      input.addEventListener('input', refresh);
      editors.set(input, {
        refresh,
        toggleSource() {
          if (showing) toggle.click();
        },
        cleanup() {
          input.hidden = false;
          bar.remove();
          preview.remove();
          input.removeEventListener('input', refresh);
        },
      });
    }
    function enhanceMessage(message) {
      if (messages.has(message) || typeof message._reverieSource !== 'string') return;
      const raw = message._reverieSource;
      // Code spans/fences keep their normal copy behavior and are never interpreted as math.
      const walker = doc.createTreeWalker(message, root.NodeFilter.SHOW_TEXT);
      const runs = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement.closest('code, pre, a, button')) continue;
        if (root.ReverieChatMath.mathSegments(node.textContent).some((p) => p.math !== undefined)) runs.push(node);
      }
      if (!runs.length) return;
      const original = [...message.childNodes];
      const preview = element('div', 'chat-math-message-preview');
      preview.append(...original);
      const replacements = runs.map((node) => {
        const rendered = element('span', 'chat-math-run');
        renderText(node.textContent, rendered);
        node.replaceWith(rendered);
        return { node, rendered };
      });
      const source = element('pre', 'chat-math-message-source', raw);
      source.hidden = true;
      const bar = element('div', 'chat-math-toolbar');
      const toggle = button('Show source', () => {
        const showing = source.hidden;
        source.hidden = !showing;
        preview.hidden = showing;
        toggle.textContent = showing ? 'Show rendered' : 'Show source';
        toggle.setAttribute('aria-pressed', String(showing));
      });
      toggle.setAttribute('aria-pressed', 'false');
      const use = button('Use in composer', () => {
        const input = [...doc.querySelectorAll('textarea.chatroom-input')].find(
          (node) => node.isConnected && !node.parentElement.closest('[hidden]')
        );
        if (!input) return;
        // Append to an existing draft; discussing a received formula must not discard unsent work.
        input.value += (input.value ? '\n' : '') + raw;
        input.dispatchEvent(new root.Event('input', { bubbles: true }));
        const editor = editors.get(input);
        if (input.hidden) editor?.toggleSource?.();
        input.focus();
      });
      bar.append(toggle, use);
      message.append(bar, preview, source);
      messages.set(message, {
        cleanup() {
          for (const { node, rendered } of replacements) rendered.replaceWith(node);
          message.replaceChildren(...preview.childNodes);
        },
      });
    }
    function scan() {
      queued = false;
      if (!active) return;
      // Forget detached virtualized messages/editors; this observer never holds an unbounded transcript.
      for (const [node, state] of messages)
        if (!node.isConnected) {
          state.cleanup();
          messages.delete(node);
        }
      for (const [node, state] of editors)
        if (!node.isConnected) {
          state.cleanup();
          editors.delete(node);
        }
      for (const input of doc.querySelectorAll('textarea.chatroom-input, textarea.ca-edit-input')) enhanceEditor(input);
      for (const message of doc.querySelectorAll('.chatroom-msg-text')) enhanceMessage(message);
      for (const state of editors.values()) state.refresh();
    }
    loadAssets()
      .then(() => {
        if (!active) return;
        scan();
        observer = new root.MutationObserver((records) => {
          if (
            queued ||
            records.every(
              (record) =>
                record.target.nodeType === 1 &&
                record.target.closest(
                  '.chat-math-toolbar, .chat-math-preview, .chat-math-message-preview, .chat-math-message-source'
                )
            )
          )
            return;
          queued = true;
          root.queueMicrotask(scan);
        });
        observer.observe(doc.body, { childList: true, subtree: true });
      })
      .catch(() => {
        /* Exact source and ordinary chat remain available if local assets fail. */
      });
    return () => {
      active = false;
      observer?.disconnect();
      for (const state of messages.values()) state.cleanup();
      for (const state of editors.values()) state.cleanup();
      messages.clear();
      editors.clear();
    };
  }
  root.ReverieChatPlugins?.register({
    id: 'latex',
    label: 'LaTeX math',
    description: 'Local math preview with editable source. Use $…$ inline or $$…$$ for display math.',
    enable,
  });
})(globalThis);
