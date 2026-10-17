/* Optional external bot connections. Tokens go only to the server, never browser storage.
 * Integration: ExternalChatUI.open(app), or mount(element, { app }). */
/* global document, window */
(() => {
  'use strict';
  let fieldId = 0;
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const option = (select, value, label) => {
    const item = element('option', label);
    item.value = value;
    select.append(item);
  };
  const field = (form, title, control) => {
    const label = element('label');
    label.style.cssText = 'display:block;margin:10px 0';
    const caption = element('span', title + ' ');
    caption.id = `external-chat-field-${++fieldId}`;
    control.setAttribute('aria-labelledby', caption.id);
    label.append(caption, control);
    form.append(label);
    return control;
  };
  const input = (placeholder, type = 'text') => {
    const node = element('input');
    node.type = type;
    node.placeholder = placeholder;
    node.required = true;
    return node;
  };
  const button = (text, action) => {
    const node = element('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };

  function mount(container, { app }) {
    let disposed = false;
    let busy = false;
    let rooms = [];
    container.replaceChildren();
    container.append(element('h2', 'External chat bots (optional)'));
    container.append(
      element(
        'p',
        'Connect an installed Slack or Discord bot to one agent. Connections start disabled. Only future messages from that agent to everyone in explicitly linked rooms are sent outside Reverie. Owner messages, DMs, and directed messages stay local. External speakers keep their external identity and cannot act as the owner.'
      )
    );
    container.append(
      element(
        'p',
        'Slack: install your app with chat:write, channels:read, channels:history (and groups:read / groups:history for private channels), then invite its bot to the selected channel. Discord: install a bot with View Channel, Read Message History, Send Messages and Message Content intent enabled. Each agent may use a separate bot token.'
      )
    );
    const docs = element('p');
    for (const [label, href] of [
      ['Slack bot setup', 'https://docs.slack.dev/authentication/tokens/'],
      ['Discord bot setup', 'https://docs.discord.com/developers/quick-start/getting-started'],
    ]) {
      const link = element('a', label);
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      docs.append(link, document.createTextNode(' '));
    }
    container.append(docs);
    const status = element('p');
    status.setAttribute('role', 'status');
    container.append(status);
    const form = element('form');
    const provider = field(form, 'Provider', element('select'));
    option(provider, 'slack', 'Slack bot');
    option(provider, 'discord', 'Discord bot');
    const agent = field(form, 'Agent', element('select'));
    agent.required = true;
    option(agent, '', 'Choose agent');
    for (const session of app.sessions?.values() || []) {
      if (session.mode !== 'shell') option(agent, session.id, session.name || session.id);
    }
    const label = field(form, 'Connection name', input('Agent Slack bot'));
    label.maxLength = 80;
    const token = field(form, 'Bot token', input('Stored only on the server', 'password'));
    token.autocomplete = 'off';
    token.spellcheck = false;
    token.maxLength = 4096;
    const submit = element('button', 'Verify bot and save disabled');
    submit.type = 'submit';
    form.append(submit);
    container.append(form);
    const list = element('div');
    container.append(
      button('Refresh status', () => action(refresh)),
      list
    );

    async function request(path, method = 'GET', body) {
      const response = await app._api('/api/external-chat' + path, { method, body });
      if (!response) throw new Error('Cannot reach Reverie. Check connection status before retrying.');
      let json;
      try {
        json = await response.json();
      } catch {
        throw new Error('Unexpected server response');
      }
      if (!response.ok || !json.success) throw new Error(json.error || 'External chat request failed');
      return json.data;
    }
    async function action(fn) {
      if (busy || disposed) return;
      busy = true;
      submit.disabled = true;
      status.textContent = 'Working…';
      try {
        await fn();
        status.textContent = 'Status refreshed';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        busy = false;
        submit.disabled = false;
      }
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy) return;
      const body = { provider: provider.value, agentSessionId: agent.value, label: label.value, token: token.value };
      token.value = '';
      void action(async () => {
        try {
          await request('/connections', 'POST', body);
        } finally {
          body.token = '';
        }
        await refresh();
      });
    });
    async function refresh() {
      const state = await request('');
      const roomData = await app._apiJson('/api/chatrooms');
      rooms = roomData?.rooms || [];
      if (disposed) return;
      list.replaceChildren();
      if (!state.connections.length)
        list.append(element('p', 'No external connections. Local chat works independently.'));
      for (const connection of state.connections) {
        const card = element('section');
        card.style.cssText = 'border:1px solid currentColor;border-radius:8px;padding:12px;margin:12px 0';
        card.append(
          element('h3', `${connection.label} · ${connection.provider} · ${connection.enabled ? 'Enabled' : 'Disabled'}`)
        );
        const who = connection.identity;
        card.append(
          element(
            'p',
            `Verified bot: ${who.name} (${who.id})${who.workspaceName ? ' · ' + who.workspaceName : ''}. Verified ${new Date(connection.verifiedAt).toLocaleString()}. Bound agent: ${app.sessions?.get(connection.agentSessionId)?.name || connection.agentSessionId}.`
          )
        );
        if (connection.lastError) card.append(element('p', connection.lastError));
        card.append(
          button(connection.enabled ? 'Disable' : 'Enable selected links', () =>
            action(async () => {
              await request(`/connections/${encodeURIComponent(connection.id)}`, 'PUT', {
                enabled: !connection.enabled,
              });
              await refresh();
            })
          )
        );
        card.append(
          button('Disconnect and erase stored token', () =>
            action(async () => {
              await request(`/connections/${encodeURIComponent(connection.id)}`, 'DELETE');
              await refresh();
            })
          )
        );
        const links = state.links.filter((link) => link.connectionId === connection.id);
        for (const link of links) {
          const line = element(
            'p',
            `#${link.channelName} ↔ ${rooms.find((room) => room.id === link.roomId)?.name || link.roomId} `
          );
          line.append(
            button('Unlink', () =>
              action(async () => {
                await request(`/links/${encodeURIComponent(link.id)}`, 'DELETE');
                await refresh();
              })
            )
          );
          card.append(line);
        }
        const linkForm = element('form');
        const room = field(linkForm, 'Local room', element('select'));
        room.required = true;
        option(room, '', 'Choose room');
        for (const candidate of rooms.filter((r) => r.members.some((m) => m.sessionId === connection.agentSessionId))) {
          option(room, candidate.id, candidate.name || 'Direct message (not linkable)');
        }
        const channel = field(
          linkForm,
          'External channel ID',
          input(connection.provider === 'slack' ? 'C0123456789' : '123456789012345678')
        );
        const preview = element('p');
        let checkedId;
        const linkSubmit = element('button', 'Link this channel and room');
        linkSubmit.type = 'submit';
        linkSubmit.disabled = true;
        channel.addEventListener('input', () => {
          checkedId = undefined;
          linkSubmit.disabled = true;
          preview.textContent = '';
        });
        linkForm.append(
          button('Look up channel', () =>
            action(async () => {
              const selectedId = channel.value.trim();
              const verified = await request(
                `/connections/${encodeURIComponent(connection.id)}/channel?channelId=${encodeURIComponent(selectedId)}`
              );
              if (channel.value.trim() !== selectedId) return;
              checkedId = selectedId;
              preview.textContent = `Selected #${verified.name} (${verified.id}). Linking shares this agent’s future room-wide messages with everyone in that channel; incoming human messages go to the bound agent. No historical messages are imported.`;
              linkSubmit.disabled = false;
            })
          ),
          preview,
          linkSubmit
        );
        linkForm.addEventListener('submit', (event) => {
          event.preventDefault();
          if (checkedId !== channel.value.trim()) return;
          void action(async () => {
            await request(`/connections/${encodeURIComponent(connection.id)}/links`, 'POST', {
              channelId: checkedId,
              roomId: room.value,
            });
            await refresh();
          });
        });
        card.append(linkForm);
        const deliveries = state.deliveries.filter((d) => d.connectionId === connection.id).slice(-10);
        for (const delivery of deliveries)
          card.append(
            element(
              'p',
              `Delivery ${delivery.localMessageId.slice(0, 8)}: ${delivery.state}${delivery.error ? ' · ' + delivery.error : ''}`
            )
          );
        card.append(
          element(
            'small',
            'Slack polling may take over a minute per linked channel. Unknown delivery outcomes are never automatically retried; check the channel before posting again. Empty Discord content may require Message Content intent.'
          )
        );
        list.append(card);
      }
    }
    void action(refresh);
    return () => {
      disposed = true;
      token.value = '';
      container.replaceChildren();
    };
  }
  function open(app) {
    const dialog = element('dialog');
    dialog.className = 'fleet-external-chat-dialog';
    dialog.style.cssText =
      'overflow:auto;color:inherit;background:var(--bg-primary,#171923);border:1px solid #777;border-radius:12px;padding:20px';
    const body = element('div');
    let dispose = () => {};
    dialog.append(
      button('Close', () => dialog.close()),
      body
    );
    dialog.addEventListener('close', () => {
      dispose();
      dialog.remove();
    });
    document.body.append(dialog);
    dispose = mount(body, { app });
    dialog.showModal();
  }
  window.ExternalChatUI = { mount, open };
})();
