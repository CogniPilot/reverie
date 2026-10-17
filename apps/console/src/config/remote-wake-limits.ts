/**
 * @fileoverview Limits shared between Wake-on-LAN parsing and its request schema.
 *
 * Its own module because `src/remote-wake.ts` is import-fenced: only
 * `web/routes/session-routes.ts` and `web/server.ts` may import it, so that no
 * watcher or boot-recovery path can WAKE a host (pinned by the wiring guard in
 * `test/remote-wake.test.ts`). `web/schemas.ts` needs the same MAC-count limit and
 * must not become a third importer, and it would drag `dgram`/`net`/`child_process`
 * into every module that validates a request body. A plain constant satisfies both.
 */

/**
 * How many comma-separated MACs one `wakeMac` may carry.
 *
 * ⚠ Single source for `parseMacList()` and `RemoteHostSchema.wakeMac`. The two used
 * to disagree: the schema's 128-character cap admits seven MACs while the parser
 * rejected more than four all-or-nothing, so a five-MAC value validated, persisted to
 * `remote-hosts.json`, and then resolved to NO wake target. The host read as
 * unconfigured and the banner offered "Configure WoL" for a host the user had just
 * configured, which is the worst shape a validation gap can take: accepted, stored,
 * silently inert.
 */
export const MAX_WAKE_MACS = 4;
