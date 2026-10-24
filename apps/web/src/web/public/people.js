(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = async (path, options = {}) => {
    const response = await fetch('api/office/' + path, {
      credentials: 'same-origin',
      ...options,
      ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || 'Request failed');
    return result.data;
  };
  $('back-to-chat').addEventListener('click', (event) => {
    if (window.parent !== window) {
      event.preventDefault();
      window.parent.postMessage({ type: 'office-back-to-chat' }, location.origin);
    }
  });
  let snapshot, editing;
  const error = (value) => {
    $('status').textContent = value;
  };
  const button = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', action);
    return b;
  };
  const rooms = (container, selected = []) => {
    container.replaceChildren();
    const legend = document.createElement('legend');
    legend.textContent = 'Allowed channels';
    container.append(legend);
    for (const room of snapshot.rooms) {
      const label = document.createElement('label'),
        input = document.createElement('input');
      label.className = 'check';
      input.type = 'checkbox';
      input.name = 'rooms';
      input.value = room.id;
      input.checked = selected.includes(room.id);
      label.append(input, document.createTextNode('#' + room.name));
      container.append(label);
    }
    if (!snapshot.rooms.length)
      container.append(document.createTextNode('Create a channel first, or leave channel access empty.'));
  };
  const roleFields = (form) => {
    const fieldset = form.querySelector('fieldset');
    fieldset.disabled = form.elements.role.value === 'owner';
    fieldset.hidden = fieldset.disabled;
  };
  const password = (value) => {
    $('one-time-password').value = value;
    $('one-time-password').type = 'password';
    $('reveal-password').checked = false;
    $('password-result').hidden = false;
    $('password-result').scrollIntoView({ block: 'nearest' });
  };
  const refresh = async () => {
    snapshot = await api('accounts');
    $('accounts').replaceChildren();
    rooms($('create-rooms'));
    roleFields($('create-form'));
    const primary = document.createElement('article');
    primary.textContent = 'Original owner · protected recovery account';
    $('accounts').append(primary);
    for (const person of snapshot.people) {
      const card = document.createElement('article'),
        title = document.createElement('h3'),
        detail = document.createElement('p');
      title.textContent = person.name;
      detail.textContent =
        person.username +
        ' · ' +
        (person.disabled ? 'Disabled' : person.role === 'owner' ? 'Owner' : 'Limited') +
        (person.role === 'limited' ? ` · ${person.rooms.length} channels` : '');
      card.append(
        title,
        detail,
        button('Edit access', () => {
          editing = person;
          const form = $('edit-form');
          form.elements.name.value = person.name;
          form.elements.role.value = person.role;
          form.elements.disabled.checked = person.disabled;
          rooms($('edit-rooms'), person.rooms);
          roleFields(form);
          $('edit-error').textContent = '';
          $('edit-person').showModal();
        }),
        button('Reset password', async () => {
          if (!confirm(`Reset ${person.name}’s password and end their sessions?`)) return;
          try {
            password(
              (await api('accounts/' + encodeURIComponent(person.id) + '/reset-password', { method: 'POST', body: {} }))
                .oneTimePassword
            );
          } catch (err) {
            error(err.message);
          }
        })
      );
      $('accounts').append(card);
    }
  };
  $('create-form').addEventListener('change', () => roleFields($('create-form')));
  $('edit-form').addEventListener('change', () => roleFields($('edit-form')));
  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      fields = new FormData(form),
      role = fields.get('role');
    if (role === 'owner' && !confirm('Give this person full owner access to the office, agents, files and settings?'))
      return;
    const submit = form.querySelector('button');
    submit.disabled = true;
    error('');
    try {
      const result = await api('accounts', {
        method: 'POST',
        body: { username: fields.get('username'), name: fields.get('name'), role, rooms: fields.getAll('rooms') },
      });
      form.reset();
      await refresh();
      password(result.oneTimePassword);
    } catch (err) {
      error(err.message);
    } finally {
      submit.disabled = false;
    }
  });
  $('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget,
      fields = new FormData(form),
      role = fields.get('role');
    if (
      role === 'owner' &&
      editing.role !== 'owner' &&
      !confirm('Give this person full owner access to the office, agents, files and settings?')
    )
      return;
    const submit = form.querySelector('button');
    submit.disabled = true;
    try {
      await api('accounts/' + encodeURIComponent(editing.id), {
        method: 'PUT',
        body: { name: fields.get('name'), role, rooms: fields.getAll('rooms'), disabled: fields.has('disabled') },
      });
      $('edit-person').close();
      await refresh();
    } catch (err) {
      $('edit-error').textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
  $('cancel-edit').addEventListener('click', () => $('edit-person').close());
  $('copy-password').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('one-time-password').value);
      error('Password copied. Share it privately.');
    } catch {
      error('Select the password field to copy it.');
    }
  });
  $('reveal-password').addEventListener('change', () => {
    $('one-time-password').type = $('reveal-password').checked ? 'text' : 'password';
  });
  $('dismiss-password').addEventListener('click', () => {
    $('one-time-password').value = '';
    $('password-result').hidden = true;
  });
  const preview = () => {
    const value = $('profile-form').elements.avatar.value;
    $('profile-preview').hidden = !value;
    if (value) $('profile-preview').src = '.' + value;
  };
  $('profile-form').elements.avatar.addEventListener('change', preview);
  $('profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api('me', {
        method: 'PUT',
        body: { name: form.elements.name.value, avatar: form.elements.avatar.value || null },
      });
      error('Profile saved.');
    } catch (err) {
      error(err.message);
    }
  });
  (async () => {
    try {
      await refresh();
      if (!snapshot.self.primary) {
        const form = $('profile-form');
        form.elements.name.value = snapshot.self.name;
        const manifest = await (await fetch('assets/avatars/pack-manifest.json', { cache: 'no-cache' })).json();
        const avatars = manifest.avatars.filter((a) =>
          /^\/assets\/avatars\/pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png$/.test(a.src)
        );
        if (snapshot.self.avatar && !avatars.some((a) => a.src === snapshot.self.avatar))
          avatars.push({ name: 'Current avatar', src: snapshot.self.avatar });
        for (const avatar of avatars) {
          const option = document.createElement('option');
          option.value = avatar.src;
          option.textContent = avatar.name;
          form.elements.avatar.append(option);
        }
        form.elements.avatar.value = snapshot.self.avatar || '';
        preview();
        $('my-profile').hidden = false;
      }
    } catch (err) {
      error(err.message);
    }
  })();
})();
