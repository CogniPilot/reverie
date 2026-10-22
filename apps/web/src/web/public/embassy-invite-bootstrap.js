/**
 * @fileoverview Synchronously scrub an embassy fragment before application scripts.
 * No network, storage, parsing/redemption or automatic navigation. Page scripts
 * share this origin's privilege; this is URL/history hygiene, not script isolation.
 */
(() => {
  let pending = null;
  const collect = () => {
    const hash = window.location.hash;
    if (!/^#embassy(?:=|&)/.test(hash)) return;
    try {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
      pending = hash.length <= 2048 ? { hash, scrubbed: true } : { invalid: true };
    } catch {
      pending = { invalid: true };
    }
  };
  collect();
  window.addEventListener('hashchange', collect);
  window.addEventListener('pagehide', () => { pending = null; });
  Object.defineProperty(window, 'ReverieEmbassyInvite', {
    value: Object.freeze({ take() { const value = pending; pending = null; return value; } }),
    writable: false, configurable: false,
  });
})();
