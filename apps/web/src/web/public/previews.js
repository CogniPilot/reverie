/* Owner controls only. Agent HTML always opens on a separate preview origin. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const names = new Map();
  const suggested = new URLSearchParams(location.search);
  if (/^[0-9]+$/.test(suggested.get('port') || '')) $('expose').elements.port.value = suggested.get('port');
  const suggestedPath = suggested.get('path');
  if (suggestedPath && suggestedPath.startsWith('/') && !suggestedPath.startsWith('//'))
    $('expose').elements.path.value = suggestedPath;
  const element = (tag, text) => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  async function api(path, method = 'GET', body) {
    const response = await fetch(new URL('./api/' + path, location.href), {
      method,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Preview request failed.');
    return data;
  }
  function navigate(url, tab) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.origin === location.origin) throw new Error('Invalid preview address.');
    if (!tab) throw new Error('Allow this site to open a preview tab, then try again.');
    tab.opener = null;
    tab.location.replace(url);
  }
  async function refresh() {
    try {
      const [company, data] = await Promise.all([api('company'), api('previews')]);
      const employees = company.data?.employees || [];
      const selected = $('expose').elements.sessionId.value || suggested.get('sessionId');
      const options = [];
      for (const employee of employees) {
        if (!employee.sessionId) continue;
        names.set(employee.sessionId, employee.name || employee.sessionId);
        const option = element('option', names.get(employee.sessionId));
        option.value = employee.sessionId;
        options.push(option);
      }
      $('expose').elements.sessionId.replaceChildren(...options);
      if (options.some((option) => option.value === selected)) $('expose').elements.sessionId.value = selected;
      $('previews').replaceChildren();
      for (const preview of data.previews) {
        const card = element('article', '');
        card.className = 'card';
        card.append(element('h2', (names.get(preview.sessionId) || 'Laptop') + ' · port ' + preview.port));
        card.append(element('p', 'Expires in ' + Math.ceil(preview.expiresIn / 60) + ' minutes'));
        const path = element('input', '');
        path.value = '/';
        path.setAttribute('aria-label', 'Page path');
        const open = element('button', 'Open preview');
        open.onclick = async () => {
          const tab = window.open('about:blank', '_blank');
          if (tab) tab.opener = null;
          try {
            navigate((await api('previews/' + preview.id + '/open', 'POST', { path: path.value })).url, tab);
          } catch (error) {
            if (tab) tab.close();
            $('status').textContent = error.message;
          }
        };
        const remove = element('button', 'Stop sharing');
        remove.onclick = async () => {
          remove.disabled = true;
          try {
            await api('previews/' + preview.id, 'DELETE');
            await refresh();
          } catch (error) {
            $('status').textContent = error.message;
            remove.disabled = false;
          }
        };
        card.append(path, open, remove);
        $('previews').append(card);
      }
      $('status').textContent = data.previews.length
        ? 'Exposed ports are listed below.'
        : 'No laptop ports are exposed.';
    } catch (error) {
      $('status').textContent = error.message;
    }
  }
  $('refresh').onclick = refresh;
  $('expose').onsubmit = async (event) => {
    event.preventDefault();
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    const form = event.currentTarget;
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    try {
      const data = await api('previews', 'POST', {
        sessionId: form.elements.sessionId.value,
        port: Number(form.elements.port.value),
        path: form.elements.path.value,
      });
      navigate(data.url, tab);
      await refresh();
    } catch (error) {
      if (tab) tab.close();
      $('status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
  void refresh();
})();
