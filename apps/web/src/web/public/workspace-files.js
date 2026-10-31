/* Owner workspace UI. All filenames and text are DOM text; previews never execute. */
(() => {
  const $ = (id) => document.getElementById(id);
  document.documentElement.classList.toggle('embedded', parent !== window);
  $('back').addEventListener('click', (event) => {
    if (parent !== window) {
      event.preventDefault();
      parent.postMessage({ type: 'workspace-back-to-chat' }, location.origin);
    }
  });
  let path = '',
    epoch = 0,
    previewEpoch = 0,
    imageUrl = null,
    pdfPreview = null,
    previewController = null,
    uploading = false,
    loading = true,
    uploadAllowed = false,
    entries = [],
    limited = false,
    selectedPath = null,
    sortKey = 'name',
    sortDirection = 1;
  const compareNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const paths = {
    folder: 'M3 5h6l2 2h10v13H3z',
    file: 'M14 2H5v20h14V7z M14 2v6h5 M8 13h8 M8 17h6',
    up: 'M12 20V4 M5 11l7-7 7 7',
    refresh: 'M20 11a8 8 0 1 0-2 6 M20 4v7h-7',
    upload: 'M12 16V3 M7 8l5-5 5 5 M4 15v6h16v-6',
    download: 'M12 3v13 M7 11l5 5 5-5 M4 17v4h16v-4',
    close: 'M6 6l12 12 M6 18 18 6',
    chevron: 'm9 5 7 7-7 7',
    search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    }))
      svg.setAttribute(key, value);
    const shape = document.createElementNS(svg.namespaceURI, 'path');
    shape.setAttribute('d', paths[name]);
    svg.append(shape);
    return svg;
  }
  $('up').replaceChildren(icon('up'));
  $('refresh').replaceChildren(icon('refresh'));
  $('upload').closest('label').prepend(icon('upload'));
  document.querySelector('.search > span').replaceWith(icon('search'));
  const size = (n) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`;
  const date = (value) =>
    new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const status = (text, error = false) => {
    $('status').textContent = text;
    $('status').classList.toggle('error', error);
  };
  const url = (route, params) => `${route}?${new URLSearchParams(params)}`;
  function updateUpload() {
    const disabled = uploading || loading || !uploadAllowed;
    $('upload').disabled = disabled;
    $('upload').closest('label').setAttribute('aria-disabled', String(disabled));
    $('upload').closest('label').title = loading
      ? 'Checking upload availability…'
      : uploadAllowed
        ? 'Upload to Workspace root'
        : path
          ? 'Open Workspace to upload files'
          : 'Uploads are unavailable here';
    $('uploadHint').textContent = path ? 'Open Workspace to upload' : 'Uploads up to 32 MiB';
  }
  async function responseError(res) {
    try {
      return (await res.json()).error || `HTTP ${res.status}`;
    } catch {
      return `HTTP ${res.status}`;
    }
  }
  async function previewBytes(response, limit, signal) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Preview unavailable. Use Download.');
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('Preview cancelled.');
        if (done) break;
        if ((size += value.length) > limit) throw new Error('Preview is too large. Use Download.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* preserve refusal */
      }
    }
  }
  function staticDocument(text) {
    const template = document.createElement('template');
    template.innerHTML = window.sanitizeMarkdownHtml(text);
    for (const img of template.content.querySelectorAll('img'))
      img.replaceWith(document.createTextNode(img.alt || '[image]'));
    for (const a of template.content.querySelectorAll('a')) a.replaceWith(...a.childNodes);
    for (const el of template.content.querySelectorAll('*'))
      for (const attr of [...el.attributes]) {
        if (/^(?:on|src|href|action|formaction|ping|style)/i.test(attr.name)) el.removeAttribute(attr.name);
      }
    return template;
  }
  function clearPreview() {
    previewEpoch++;
    previewController?.abort();
    previewController = null;
    pdfPreview?.destroy();
    pdfPreview = null;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    selectedPath = null;
    $('preview').hidden = true;
    $('preview').replaceChildren();
    $('layout').classList.remove('preview-open');
    for (const button of $('files').querySelectorAll('.selected')) {
      button.classList.remove('selected');
      button.setAttribute('aria-pressed', 'false');
    }
  }
  function breadcrumbs() {
    const nav = $('breadcrumbs');
    nav.replaceChildren();
    const button = (name, target) => {
      const b = node('button', name);
      b.type = 'button';
      if (target === path) b.setAttribute('aria-current', 'location');
      b.onclick = () => void load(target, true);
      nav.append(b);
    };
    button('Workspace', '');
    path
      .split('/')
      .filter(Boolean)
      .forEach((part, i, segments) => {
        nav.append(icon('chevron'));
        button(part, segments.slice(0, i + 1).join('/'));
      });
    $('up').disabled = loading || !path;
    // Keep the current folder in view even for a long path on a phone.
    nav.lastElementChild?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  function renderFiles() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const visible = entries
      .filter((entry) => entry.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => {
        if (sortKey === 'name' && a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        const value =
          sortKey === 'name'
            ? compareNames.compare(a.name, b.name)
            : sortKey === 'modified'
              ? new Date(a.modified).getTime() - new Date(b.modified).getTime()
              : (a.kind === 'directory' ? 0 : a.size) - (b.kind === 'directory' ? 0 : b.size);
        return (value || compareNames.compare(a.name, b.name)) * sortDirection;
      });
    for (const heading of document.querySelectorAll('[data-sort]')) {
      const active = heading.dataset.sort === sortKey;
      heading.setAttribute('aria-pressed', String(active));
      const label = { name: 'Name', modified: 'Modified', size: 'Size' }[heading.dataset.sort];
      heading.textContent = `${label}${active ? (sortDirection === 1 ? ' ↑' : ' ↓') : ''}`;
    }
    $('sort').value = `${sortKey}:${sortDirection}`;
    $('files').replaceChildren();
    for (const entry of visible) {
      const li = node('li'),
        b = node('button');
      li.className = 'file-row';
      b.type = 'button';
      b.className = 'file';
      b.dataset.path = entry.path;
      const name = node('span', undefined, 'file-name');
      const symbol = icon(entry.kind === 'directory' ? 'folder' : 'file');
      if (entry.kind === 'directory') symbol.classList.add('folder-icon');
      name.append(symbol, node('span', entry.name));
      b.title = entry.name;
      const modified = node('span', date(entry.modified), 'file-date');
      modified.title = new Date(entry.modified).toLocaleString();
      b.append(name, modified, node('span', entry.kind === 'directory' ? '—' : size(entry.size), 'file-size'));
      b.setAttribute('aria-label', `${entry.name}${entry.kind === 'directory' ? ' Folder' : ''}`);
      if (entry.kind !== 'directory') b.setAttribute('aria-pressed', String(entry.path === selectedPath));
      b.classList.toggle('selected', entry.path === selectedPath);
      b.onclick = () => (entry.kind === 'directory' ? void load(entry.path, true) : void preview(entry, b));
      li.append(b);
      if (entry.kind !== 'directory') {
        const download = node('a', undefined, 'row-download');
        download.setAttribute('aria-label', `Download ${entry.name}`);
        download.title = `Download ${entry.name}`;
        download.href = url('api/workspace/file', {
          path: entry.path,
          ...(entry.binding ? { binding: entry.binding } : {}),
        });
        download.download = entry.name;
        download.append(icon('download'));
        li.append(download);
      }
      $('files').append(li);
    }
    $('empty-state').hidden = visible.length > 0;
    if (!visible.length) {
      $('empty-state').replaceChildren(
        node('p', query ? 'No matching files' : 'This folder has no visible files.'),
        node(
          'small',
          query
            ? limited
              ? 'Try another name. Only the loaded files are searched.'
              : 'Try another name or clear the search.'
            : 'Files added to this folder will appear here.'
        )
      );
    }
    status(
      query
        ? `${visible.length} of ${entries.length}${limited ? '+ loaded' : ''} items`
        : limited
          ? `${entries.length}+ items · folder view is limited`
          : `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
    );
  }
  async function load(target, push = false) {
    const turn = ++epoch;
    clearPreview();
    loading = true;
    uploadAllowed = false;
    updateUpload();
    $('up').disabled = true;
    $('search').disabled = true;
    status('Loading workspace…');
    $('files').replaceChildren();
    $('empty-state').hidden = false;
    $('empty-state').replaceChildren(node('p', 'Loading files…'));
    try {
      const res = await fetch(url('api/workspace/files', { path: target }), { cache: 'no-store' });
      if (!res.ok) throw new Error(await responseError(res));
      const { data } = await res.json();
      if (turn !== epoch) return;
      uploadAllowed = !!data.upload?.enabled;
      $('uploadReason').textContent =
        data.upload?.reason || (uploadAllowed ? 'Uploads are available in Workspace.' : 'Uploads are unavailable.');
      if (path !== target) $('search').value = '';
      path = target;
      entries = data.entries;
      limited = !!data.limited;
      if (push) history.pushState({}, '', `?${new URLSearchParams({ path })}`);
      renderFiles();
    } catch (error) {
      if (turn === epoch) {
        entries = [];
        uploadAllowed = false;
        status(error.message, true);
        $('empty-state').replaceChildren(
          node('p', 'Could not load this folder'),
          node('small', 'Try refreshing or return to Workspace.')
        );
      }
    } finally {
      if (turn === epoch) {
        loading = false;
        $('search').disabled = false;
        breadcrumbs();
        updateUpload();
      }
    }
  }
  async function preview(entry, button) {
    // The owner console supplies the shared viewer. A standalone Workspace
    // keeps its safe local preview; it does not invent a session or parent.
    if (parent !== window && typeof entry.absolutePath === 'string') {
      try {
        if (parent.location.origin === location.origin && typeof parent.app?.openWorkspaceFilePreview === 'function') {
          await parent.app.openWorkspaceFilePreview(entry.absolutePath, button);
          return;
        }
      } catch {
        /* unavailable/cross-origin parent: retain standalone behavior */
      }
    }
    clearPreview();
    selectedPath = entry.path;
    button.classList.add('selected');
    button.setAttribute('aria-pressed', 'true');
    const turn = previewEpoch,
      pane = $('preview');
    const controller = new AbortController();
    previewController = controller;
    const timer = setTimeout(() => controller.abort(), 12000);
    const heading = node('div', undefined, 'preview-heading');
    const close = node('button', undefined, 'icon-button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close preview');
    close.append(icon('close'));
    close.onclick = () => {
      clearPreview();
      (
        [...$('files').querySelectorAll('button')].find((row) => row.dataset.path === entry.path) || $('search')
      ).focus();
    };
    heading.append(node('h2', entry.name), close);
    const info = node(
      'p',
      `${size(entry.size)} · Modified ${new Date(entry.modified).toLocaleString()}`,
      'preview-meta'
    );
    const download = node('a');
    download.append(icon('download'), node('span', 'Download file'));
    download.href = url('api/workspace/file', {
      path: entry.path,
      ...(entry.binding ? { binding: entry.binding } : {}),
    });
    download.download = entry.name;
    const note = node('p', 'Loading preview…', 'preview-note');
    pane.replaceChildren(heading, info, download, note);
    pane.hidden = false;
    $('layout').classList.add('preview-open');
    try {
      const res = await fetch(
        url('api/workspace/file', {
          path: entry.path,
          preview: '1',
          ...(entry.binding ? { binding: entry.binding } : {}),
        }),
        { cache: 'no-store', signal: controller.signal, redirect: 'error' }
      );
      if (!res.ok || res.redirected || res.status === 206) throw new Error(await responseError(res));
      if (entry.binding && res.headers.get('X-Reverie-File-Binding') !== entry.binding)
        throw new Error('Workspace file changed. Refresh and reopen.');
      const type = res.headers.get('content-type') || '';
      if (type.startsWith('image/')) {
        const blob = new Blob([await previewBytes(res, 5 * 1024 * 1024, controller.signal)], { type });
        if (turn !== previewEpoch) return;
        imageUrl = URL.createObjectURL(blob);
        const img = node('img');
        img.alt = entry.name;
        img.src = imageUrl;
        note.replaceWith(img);
      } else if (type === 'application/pdf') {
        const bytes = await previewBytes(res, 16 * 1024 * 1024, controller.signal);
        if (turn !== previewEpoch) return;
        const module =
          await import('./file-preview-pdf.mjs?v=f7183e3bd5ad84a4a921b0c9932c982f884f2a5f3619ff44ceb5f030edf9fc53');
        if (turn !== previewEpoch) return;
        const container = node('div');
        note.replaceWith(container);
        pdfPreview = await module.mountReadOnlyPdf({ bytes, container, signal: controller.signal });
      } else {
        const bytes = await previewBytes(res, 256 * 1024, controller.signal);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (turn !== previewEpoch) return;
        if (/\.svg$/i.test(entry.name)) {
          // Drawn by an <img> from a data: URL, as in the console viewers: an image runs none of the file's script, and a
          // data: URL (unlike a same-origin blob:) cannot be opened as a page on this origin. The server sends it as text.
          let binary = '';
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const img = node('img');
          img.alt = entry.name;
          img.src = `data:image/svg+xml;base64,${btoa(binary)}`;
          note.replaceWith(img);
        } else if (/\.md(?:own)?$|\.markdown$/i.test(entry.name) && window.marked?.parse && window.sanitizeMarkdownHtml) {
          const template = staticDocument(window.marked.parse(text, { async: false }));
          const article = node('article', undefined, 'workspace-markdown');
          article.append(template.content);
          note.replaceWith(article);
        } else if (/\.html?$/i.test(entry.name) && window.sanitizeMarkdownHtml) {
          const frame = node('iframe');
          frame.title = entry.name + ' (static preview)';
          frame.setAttribute('sandbox', '');
          frame.referrerPolicy = 'no-referrer';
          frame.srcdoc =
            '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"><style>body{font:16px system-ui;margin:20px;overflow-wrap:anywhere}pre{white-space:pre-wrap}</style>' +
            staticDocument(text).innerHTML;
          note.replaceWith(frame);
        } else note.replaceWith(node('pre', text));
      }
    } catch (error) {
      if (turn === previewEpoch) {
        note.textContent = controller.signal.aborted ? 'Preview cancelled or timed out.' : error.message;
        if (!note.isConnected) pane.append(note);
      }
    } finally {
      clearTimeout(timer);
    }
    if (turn === previewEpoch && matchMedia('(max-width: 650px)').matches) {
      const top = pane.getBoundingClientRect().top;
      if (top < 0 || top > innerHeight - 120) pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
  $('search').oninput = () => {
    if (!loading) renderFiles();
  };
  for (const heading of document.querySelectorAll('[data-sort]'))
    heading.onclick = () => {
      const key = heading.dataset.sort;
      sortDirection = sortKey === key ? -sortDirection : key === 'name' ? 1 : -1;
      sortKey = key;
      if (!loading) renderFiles();
    };
  $('sort').onchange = () => {
    const [key, direction] = $('sort').value.split(':');
    sortKey = key;
    sortDirection = Number(direction);
    if (!loading) renderFiles();
  };
  $('search').onkeydown = (event) => {
    if (event.key === 'Escape' && $('search').value) {
      $('search').value = '';
      renderFiles();
    }
  };
  $('up').onclick = () => void load(path.split('/').slice(0, -1).join('/'), true);
  $('refresh').onclick = () => void load(path);
  $('upload').onchange = async () => {
    const file = $('upload').files[0];
    if (!file || uploading || loading || !uploadAllowed) {
      $('upload').value = '';
      return;
    }
    if (file.size > 32 * 1048576) {
      status('Uploads are limited to 32 MiB.', true);
      $('upload').value = '';
      return;
    }
    uploading = true;
    updateUpload();
    const destination = ''; // Root-only publication.
    status(`Uploading ${file.name}…`);
    try {
      const res = await fetch(url('api/workspace/files', { path: destination, name: file.name }), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Reverie-Workspace-Upload': '1' },
        body: file,
      });
      if (!res.ok) throw new Error(await responseError(res));
      if (path === destination) await load(path);
      status(`Uploaded ${file.name}.`);
    } catch (error) {
      status(`Upload failed: ${error.message}`, true);
    } finally {
      uploading = false;
      updateUpload();
      $('upload').value = '';
    }
  };
  addEventListener('popstate', () => void load(new URLSearchParams(location.search).get('path') || ''));
  addEventListener('pagehide', () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  });
  void load(new URLSearchParams(location.search).get('path') || '');
})();
