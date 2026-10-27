/* Owner controls only. Agent HTML always opens on a separate preview origin. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const names = new Map();
  const query = new URLSearchParams(location.search);
  const fragment = /^#previews\?(.*)$/.exec(location.hash);
  const hash = new URLSearchParams(fragment ? fragment[1] : '');
  let invalidLink = false;
  const suggestion = (name, valid) => {
    const value = query.has(name) ? query.get(name) : hash.get(name);
    if (value === null) return null;
    if (!valid(value)) { invalidLink = true; return null; }
    return value;
  };
  const suggestedSession = suggestion('sessionId', value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value));
  const suggestedPort = suggestion('port', value => /^[0-9]{4,5}$/.test(value) && Number(value) >= 1024 &&
    Number(value) <= 65535 && ![8092, 8093].includes(Number(value)));
  const suggestedPath = suggestion('path', value => value.length <= 4096 && value.startsWith('/') &&
    !value.startsWith('//') && !/[\\#\x00-\x1f\x7f]/.test(value));
  if (suggestedPort) $('expose').elements.port.value = suggestedPort;
  if (suggestedPath) $('expose').elements.path.value = suggestedPath;
  const status = text => {
    $('status').textContent = (invalidLink ? 'Some preview link fields were invalid; check the laptop, port and path. ' : '') + text;
  };
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
  async function loadRoster() {
    const company = await api('company');
    const employees = company.data?.employees || [];
    const selected = $('expose').elements.sessionId.value || suggestedSession;
    const options = [];
    names.clear();
    for (const employee of employees) {
      if (!employee.sessionId) continue;
      names.set(employee.sessionId, employee.name || employee.sessionId);
      const option = element('option', names.get(employee.sessionId));
      option.value = employee.sessionId;
      options.push(option);
    }
    $('expose').elements.sessionId.replaceChildren(...options);
    if (options.some(option => option.value === selected)) $('expose').elements.sessionId.value = selected;
    else if (selected || query.has('sessionId') || hash.has('sessionId')) {
      $('expose').elements.sessionId.value = '';
      invalidLink = true;
    }
  }
  async function refresh() {
    // A missing optional preview service must not hide the available laptops.
    const [roster, listing] = await Promise.allSettled([loadRoster(), api('previews')]);
    const errors = [];
    if (roster.status === 'rejected') {
      names.clear();
      $('expose').elements.sessionId.replaceChildren();
      errors.push('Could not load laptops. ' + roster.reason.message);
    }
    if (listing.status === 'rejected') {
      $('previews').replaceChildren();
      status(errors.concat(listing.reason.message).join(' '));
      return;
    }
    try {
      const data = listing.value;
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
            status(error.message);
          }
        };
        const remove = element('button', 'Stop sharing');
        remove.onclick = async () => {
          remove.disabled = true;
          try {
            await api('previews/' + preview.id, 'DELETE');
            await refresh();
          } catch (error) {
            status(error.message);
            remove.disabled = false;
          }
        };
        card.append(path, open, remove);
        $('previews').append(card);
      }
      status(errors.concat(data.previews.length
        ? 'Exposed ports are listed below.'
        : 'No laptop ports are exposed.').join(' '));
    } catch (error) {
      status(error.message);
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
      status(error.message);
    } finally {
      button.disabled = false;
    }
  };
  void refresh();
})();
