/**
 * @fileoverview "Reverie was updated" notice.
 *
 * The server sends a fingerprint of the frontend it serves as `buildId` in every
 * SSE `init` (frontend-build-id.ts). The first one this page sees is the code it
 * is running; a different one on a later `init` (SSE reconnects after a deploy)
 * means the page is stale, so a small notice offers a reload. Never reloads by
 * itself: the user may be mid-prompt.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (handleInit calls noteServerBuild)
 * @loadorder 12.15 (after chatroom-ui.js)
 */

Object.assign(CodemanApp.prototype, {
  /** Record or compare the server's build id; returns true only when this call put the notice up. */
  noteServerBuild(buildId) {
    if (!buildId || buildId === 'unknown') return false;
    if (!this._pageBuildId) {
      this._pageBuildId = buildId;
      return false;
    }
    if (buildId === this._pageBuildId || this._dismissedBuildIds?.has(buildId)) return false;
    return this._showUpdateNotice(buildId);
  },

  _showUpdateNotice(buildId) {
    if (document.getElementById('updateNotice')) return false;
    const notice = document.createElement('div');
    notice.id = 'updateNotice';
    notice.className = 'update-notice';
    notice.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = 'Reverie was updated.';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'update-notice-reload';
    reload.textContent = 'Reload';
    reload.onclick = () => location.reload();
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'update-notice-dismiss';
    dismiss.textContent = '×';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.onclick = () => {
      // Every dismissed build stays dismissed, so a rollback to one never nags again.
      (this._dismissedBuildIds ||= new Set()).add(buildId);
      notice.remove();
    };
    notice.append(text, reload, dismiss);
    document.body.append(notice);
    return true;
  },
});
