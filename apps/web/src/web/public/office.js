(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let self,
    selected,
    signature = '',
    polling = false;
  const api = async (path, options = {}) => {
    const response = await fetch('api/office/' + path, {
      credentials: 'same-origin',
      ...options,
      ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
    });
    if (response.status === 401) {
      location.href = 'owner/login?next=%2Foffice';
      throw new Error('Sign in again');
    }
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Request failed');
    return result.data;
  };
  const status = (text) => {
    $('status').textContent = text;
  };
  const update = async () => {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const data = await api('rooms');
      $('channels').replaceChildren();
      if (!data.rooms.some((r) => r.id === selected)) {
        selected = data.rooms[0]?.id;
        signature = '';
      }
      for (const room of data.rooms) {
        const b = document.createElement('button');
        b.textContent = '#' + room.name;
        b.setAttribute('aria-current', String(room.id === selected));
        b.addEventListener('click', () => {
          selected = room.id;
          signature = '';
          void update();
        });
        $('channels').append(b);
      }
      const composer = $('composer');
      composer.elements.text.disabled = !selected;
      composer.querySelector('button').disabled = !selected;
      if (!selected) {
        $('messages').replaceChildren();
        $('room-title').textContent = 'No channels assigned';
        $('people').textContent = '';
        status('Ask an owner to give you channel access.');
        return;
      }
      const current = selected,
        view = await api('rooms/' + encodeURIComponent(current));
      if (selected !== current) return;
      $('room-title').textContent = '#' + view.room.name;
      $('topic').textContent = view.room.topic;
      $('people').replaceChildren();
      for (const person of view.people) {
        const entry = document.createElement('span');
        entry.className = 'human-chip';
        if (
          typeof person.avatar === 'string' &&
          (/^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png$/.test(person.avatar) ||
            /^\/api\/owner-avatar\/[0-9a-f]{32}\?v=\d{1,16}$/.test(person.avatar))
        ) {
          const image = document.createElement('img');
          image.src = '.' + person.avatar;
          image.alt = '';
          image.width = image.height = 28;
          entry.append(image);
        }
        entry.append(
          document.createTextNode(
            person.name +
              (person.role === 'owner' ? ' · Owner' : ' · Limited') +
              (person.online ? ' · online' : ' · offline')
          )
        );
        $('people').append(entry);
      }
      for (const agent of view.agents) {
        const entry = document.createElement('span');
        entry.className = 'human-chip';
        entry.textContent = agent.name + ' · agent';
        $('people').append(entry);
      }
      const next = JSON.stringify(view.messages);
      if (next !== signature) {
        const list = $('messages'),
          atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
        list.replaceChildren();
        for (const message of view.messages) {
          const item = document.createElement('article'),
            name = document.createElement('h3'),
            text = document.createElement('p');
          item.className = message.from.humanId === self.id ? 'mine' : '';
          const primary = view.people.find((p) => p.id === 'owner');
          name.textContent =
            (message.from.kind === 'user' && !message.from.humanId
              ? primary?.name || message.from.name
              : message.from.name) +
            (message.from.kind === 'human' ? ' · Limited' : message.from.kind === 'user' ? ' · Owner' : '') +
            ' · ' +
            new Date(message.at).toLocaleTimeString();
          text.textContent = message.deleted ? 'Message removed' : message.text;
          item.append(name, text);
          list.append(item);
        }
        if (atBottom || !signature) list.scrollTop = list.scrollHeight;
        signature = next;
      }
      status('');
    } catch (err) {
      status(err.message);
    } finally {
      polling = false;
    }
  };
  $('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      room = selected,
      text = form.elements.text.value;
    if (!room || !text.trim()) return;
    form.querySelector('button').disabled = true;
    try {
      await api('rooms/' + encodeURIComponent(room) + '/messages', { method: 'POST', body: { text } });
      form.elements.text.value = '';
      await update();
    } catch (err) {
      status(err.message);
    } finally {
      form.querySelector('button').disabled = !selected;
    }
  });
  $('logout').addEventListener('click', async () => {
    const response = await fetch('api/owner/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (response.ok) location.href = 'owner/login';
    else status('Could not sign out. Try again.');
  });
  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('me', {
        method: 'PUT',
        body: { name: form.elements.name.value, avatar: form.elements.avatar.value || null },
      });
      self = (await api('me')).person;
      $('self-name').textContent = self.name;
      status('Profile saved.');
    } catch (err) {
      status(err.message);
    }
  });
  (async () => {
    try {
      self = (await api('me')).person;
      $('self-name').textContent = self.name;
      $('profile-form').elements.name.value = self.name;
      const catalog = await (await fetch('assets/avatars/pack-manifest.json', { cache: 'no-cache' })).json();
      for (const avatar of catalog.avatars)
        if (/^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png$/.test(avatar.src)) {
          const o = document.createElement('option');
          o.value = avatar.src;
          o.textContent = avatar.name;
          $('profile-form').elements.avatar.append(o);
        }
      if (self.avatar && !$('profile-form').elements.avatar.querySelector(`option[value="${self.avatar}"]`)) {
        const o = document.createElement('option');
        o.value = self.avatar;
        o.textContent = 'Current avatar';
        $('profile-form').elements.avatar.append(o);
      }
      $('profile-form').elements.avatar.value = self.avatar || '';
      const heartbeat = async () => {
        if (!document.hidden)
          try {
            await api('presence', { method: 'POST', body: {} });
          } catch (err) {
            status(err.message);
          }
      };
      await heartbeat();
      await update();
      setInterval(() => {
        void heartbeat();
      }, 20_000);
      setInterval(() => {
        void update();
      }, 5000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          void heartbeat();
          void update();
        }
      });
    } catch (err) {
      status(err.message);
    }
  })();
})();
