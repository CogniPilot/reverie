/* Display-only company timezone. No timestamp, reset instant or job schedule is rewritten. */
(function () {
  let zone = 'UTC';
  const normalize = value => {
    if (typeof value !== 'string' || value.length > 100) return 'UTC';
    try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
    catch { return 'UTC'; }
  };
  const api = {
    get timeZone() { return zone; },
    setTimeZone(value) {
      const next = normalize(value);
      if (next === zone) return;
      zone = next;
      window.dispatchEvent(new CustomEvent('reverie-timezone-changed', { detail: { timeZone: zone } }));
    },
    format(at, options = {}) {
      const date = new Date(at);
      if (!Number.isFinite(date.getTime())) return '—';
      return new Intl.DateTimeFormat('en-US', {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        ...options, timeZone: zone, timeZoneName: 'short',
      }).format(date);
    },
    day(at) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    },
    async load() {
      try {
        const response = await fetch('/api/company', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
        if (!response.ok) return;
        const result = await response.json();
        if (result.success && result.data?.settings) api.setTimeZone(result.data.settings.timeZone);
      } catch { /* Explicit UTC label remains until authorized settings are available. */ }
    },
  };
  window.ReverieTime = api;
  window.addEventListener?.('reverie-timezone-changed', () => {
    const chat = window.reverieChat;
    if (chat?.built && chat.view === 'chat') chat.renderFeed({ keepScroll: true });
    else window.app?._chatRenderFeed?.({ keepScroll: true });
    if (window.app?._plansScreen && !window.app._plansScreen.hidden) void window.app._loadPlans();
    window.app?.restorePlanUsageChip?.();
  });
  document.addEventListener('DOMContentLoaded', () => void api.load(), { once: true });
})();
