/** Installable phone app and device-specific background notification setup. */
(() => {
  'use strict';
  let installPrompt;
  let dialog;
  const key = 'reverie-mobile-notifications';
  const prefs = () => {
    try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
  };
  const installed = () => window.matchMedia('(display-mode: standalone)').matches;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    refresh();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; refresh(); });

  function status(text) {
    if (dialog) dialog.querySelector('[data-status]').textContent = text;
  }
  function refresh() {
    if (!dialog) return;
    dialog.querySelector('[data-install]').textContent = installed() ? 'Installed on this device' : 'Install Reverie';
    dialog.querySelector('[data-install]').disabled = installed();
    const permission = window.Notification?.permission;
    const subscribed = !!window.app?._pushSubscription;
    dialog.querySelector('[data-enable]').textContent = subscribed ? 'Update notifications' : 'Enable notifications';
    dialog.querySelector('[data-test]').disabled = !subscribed;
    dialog.querySelector('[data-disable]').hidden = !subscribed;
    if (!window.isSecureContext) status('Open Reverie through its HTTPS address to install and enable notifications.');
    else if (permission === 'denied') status('Notifications are blocked. In Chrome, open site settings → Notifications → Allow, then try again.');
    else status(subscribed ? 'Notifications are enabled for this device.' : 'Install the app, then enable notifications when you are ready.');
  }
  async function run(button, action) {
    button.disabled = true;
    try { await action(); } catch (error) { status(error.message || 'Please try again.'); }
    finally { button.disabled = false; }
  }
  function remember() {
    const value = { all: dialog.querySelector('[data-all]').checked, preview: dialog.querySelector('[data-preview]').checked };
    localStorage.setItem(key, JSON.stringify(value));
    return value;
  }
  function open() {
    if (dialog?.open) return;
    dialog?.remove();
    dialog = document.createElement('dialog');
    dialog.className = 'reverie-mobile-setup';
    dialog.setAttribute('aria-labelledby', 'reverie-mobile-title');
    dialog.innerHTML = `
      <div class="rm-head"><span class="rm-logo" aria-hidden="true">R</span><button type="button" data-close aria-label="Close phone setup">×</button></div>
      <h2 id="reverie-mobile-title">Your agents. In your pocket.</h2>
      <p>Install Reverie on your phone. Keep your channels, conversations and agents together.</p>
      <section><span class="rm-step">1</span><div><h3>Add to your home screen</h3><p>Opens as its own app, straight into chat.</p><button type="button" class="rm-primary" data-install>Install Reverie</button><p class="rm-help" data-install-help hidden>In Chrome, tap ⋮ → Add to home screen → Install. If Install is unavailable, choose Create shortcut.</p></div></section>
      <section><span class="rm-step">2</span><div><h3>Choose what reaches you</h3><p>Direct messages and messages addressed to you are on by default.</p><label><input type="checkbox" data-all> Also notify for all channel messages</label><label><input type="checkbox" data-preview> Show message previews on the lock screen</label><button type="button" class="rm-primary" data-enable>Enable notifications</button></div></section>
      <div class="rm-actions"><button type="button" data-test disabled>Send a test notification</button><button type="button" data-disable hidden>Turn off on this device</button></div>
      <p class="rm-status" role="status" aria-live="polite" data-status></p>
      <p class="rm-help">Keep Tailscale connected to open Reverie. Notifications use your browser’s push service and can arrive with the app closed; opening a message needs a connection to this server.</p>`;
    document.body.append(dialog);
    const stored = prefs();
    dialog.querySelector('[data-all]').checked = stored.all === true;
    dialog.querySelector('[data-preview]').checked = stored.preview === true;
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelector('[data-install]').onclick = (event) => run(event.currentTarget, async () => {
      if (!installPrompt) { dialog.querySelector('[data-install-help]').hidden = false; return; }
      const prompt = installPrompt;
      installPrompt = null;
      await prompt.prompt();
      await prompt.userChoice;
      refresh();
    });
    dialog.querySelector('[data-enable]').onclick = (event) => run(event.currentTarget, async () => {
      if (!window.isSecureContext || !('PushManager' in window) || !('Notification' in window)) throw new Error('Use Chrome and the HTTPS Reverie address for background notifications.');
      // Permission is requested only from this explicit tap, before network work.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { refresh(); return; }
      remember();
      await window.app.registerServiceWorker();
      if (!await window.app.subscribeToPush()) throw new Error('Could not enable notifications. Check your connection and try again.');
      refresh();
    });
    dialog.querySelector('[data-test]').onclick = (event) => run(event.currentTarget, async () => {
      const id = window.app._pushSubscriptionId || localStorage.getItem('reverie-push-subscription-id');
      if (!id) throw new Error('Enable notifications again to register this device.');
      const result = await window.app._apiJson('/api/push/subscribe/' + encodeURIComponent(id) + '/test', { method: 'POST', body: {} });
      if (!result?.accepted) throw new Error('The push service did not accept the test. Enable notifications again and retry.');
      status('Test accepted by the push service. Look for a Reverie notification on your phone.');
    });
    dialog.querySelector('[data-disable]').onclick = (event) => run(event.currentTarget, async () => {
      await window.app.unsubscribeFromPush();
      refresh();
    });
    refresh();
    dialog.showModal();
  }
  window.ReverieMobile = { open };
})();
