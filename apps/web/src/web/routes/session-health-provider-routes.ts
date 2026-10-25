import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerHealthMetadataProvider } from '../../session-health-provider.js';

/** Actual read-only provider route. Separate from the classifier's complete-evidence endpoint. */
export function registerHealthMetadataProviderRoutes(
  app: FastifyInstance,
  deps: {
    authorized(req: FastifyRequest, id: string): boolean;
    provider?: ServerHealthMetadataProvider;
    now?: () => number;
  }
) {
  const last = new Map<string, number>();
  const now = deps.now ?? Date.now;
  app.get('/api/session-health/:id/metadata', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const refuse = (status: number, code: string) => reply.code(status).send({ success: false, code });
    const id = (req.params as { id: string }).id;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id) ||
      Object.keys((req.query ?? {}) as object).length ||
      req.body !== undefined ||
      req.headers['transfer-encoding'] !== undefined ||
      (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
    )
      return refuse(400, 'HEALTH_REQUEST_INVALID');
    const authorized = () => {
      try {
        return deps.authorized(req, id) === true;
      } catch {
        return false;
      }
    };
    if (!authorized()) return refuse(403, 'HEALTH_READ_FORBIDDEN');
    if (!deps.provider) return refuse(503, 'HEALTH_ADAPTER_UNAVAILABLE');
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) return refuse(503, 'HEALTH_CLOCK_UNAVAILABLE');
    for (const [key, value] of last) if (at - value > 60000) last.delete(key);
    const previous = last.get(id);
    if (previous !== undefined && (at < previous || at - previous < 1000)) return refuse(429, 'HEALTH_READ_RATE');
    if (previous === undefined && last.size >= 128) return refuse(429, 'HEALTH_READ_BUSY');
    last.set(id, at);
    const entered = performance.now();
    try {
      // Fixed scalar projection + file metadata fences; no content read/clone, socket or process inspection.
      const data = deps.provider.read(id);
      if (performance.now() - entered >= 200 || now() < at || now() - at > 5000)
        return refuse(503, 'HEALTH_READ_UNAVAILABLE');
      if (!authorized()) return refuse(403, 'HEALTH_READ_FORBIDDEN');
      if (JSON.stringify(data).length > 2048) return refuse(503, 'HEALTH_READ_UNAVAILABLE');
      return { success: true, data };
    } catch {
      return refuse(503, 'HEALTH_READ_UNAVAILABLE');
    }
  });
}
