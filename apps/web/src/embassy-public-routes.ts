/** These routes authenticate Embassy capabilities themselves, independently of console accounts. */
export function isEmbassyProtocolRoute(method: string, route?: string): boolean {
  return (
    (method === 'POST' &&
      [
        '/api/embassy/pair-request',
        '/api/embassy/pair-status',
        '/api/embassy/pair-claim',
        '/api/embassy/pair-cancel',
      ].includes(route ?? '')) ||
    ((method === 'GET' || method === 'POST') && route === '/embassy/rooms/:roomId/posts')
  );
}
