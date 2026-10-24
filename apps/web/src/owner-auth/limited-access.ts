/** Matched-route allowlist. A limited human never enters an implicit owner/agent handler. */
export const LIMITED_ROUTES = new Set([
  'GET /api/owner-avatar/:key',
  'GET /api/office/presence',
  'GET /api/office/me',
  'PUT /api/office/me',
  'POST /api/office/presence',
  'GET /api/office/rooms',
  'GET /api/office/rooms/:id',
  'POST /api/office/rooms/:id/messages',
  'GET /api/owner/status',
  'POST /api/owner/password',
  'POST /api/owner/logout',
  'POST /api/owner/logout-everywhere',
  'POST /api/owner/2fa/start',
  'POST /api/owner/2fa/confirm',
  'POST /api/owner/2fa/disable',
  'POST /api/owner/recovery-codes',
  'GET /api/owner/devices',
  'DELETE /api/owner/devices/:id',
]);
export function limitedAsset(method: string, path: string): boolean {
  return (
    method === 'GET' &&
    (['/office', '/office.js', '/office.css', '/owner/account', '/owner/owner.js', '/owner/login'].includes(path) ||
      /^\/assets\/avatars\/(?:pack-manifest\.json|pack-(?:0[1-9]|[1-9][0-9]|1[0-4][0-9]|15[01])\.png)$/.test(path))
  );
}
