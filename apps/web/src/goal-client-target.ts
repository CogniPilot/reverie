/** Preserve already validated canonical Goal ID bytes, including colon and dot-only IDs.
 * This is serialization, not authentication or an expansion of the broker grammar.
 * Other routes and noncanonical/encoded targets retain the generic URL transport.
 */
export function goalClientTarget(options: {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
}): string | undefined {
  const id = '[A-Za-z0-9_.:-]{1,100}';
  const exact = (pattern: string, value: string) => new RegExp('^(?:' + pattern + ')$').exec(value)?.[0] === value;
  const metadata = options.method === 'GET' && exact('/api/goal-metadata/' + id, options.path);
  const goal =
    (options.method === 'GET' && exact('/api/goals(?:/' + id + ')?', options.path)) ||
    (options.method === 'POST' && exact('/api/goals(?:/' + id + '/transitions)?', options.path));
  if (!metadata && !goal) return;
  const query = Object.entries(options.query ?? {}).filter(([, value]) => value !== undefined);
  if (!query.length) return options.path;
  if (
    metadata &&
    query.length === 1 &&
    query[0][0] === 'grantId' &&
    typeof query[0][1] === 'string' &&
    exact(id, query[0][1])
  )
    return options.path + '?grantId=' + query[0][1];
  return;
}
