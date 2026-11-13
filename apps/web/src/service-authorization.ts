/** One composition owner for the existing service assertion/canonical/nonce
 * sources. Purpose consumers share this actual context; no second ledger.
 */
import type { CompanyService } from './company-service.js';
import type { GoalAuthentication } from './goal-access.js';
import { GoalNonceStore, type GoalNonceStoreOptions } from './goal-nonce-store.js';
import { serviceIssuers, serviceNonces, type LoadedServiceAuth } from './service-auth-config.js';
import { ServiceGrantAuthentication, canonicalServiceGrantSource } from './service-grant-auth.js';

export interface ServiceAuthorizationOptions {
  readonly company: Pick<CompanyService, 'store'>;
  readonly custody: Pick<GoalAuthentication, 'assertPrivateCustody'>;
  readonly nonce: GoalNonceStoreOptions;
  readonly now?: () => number;
}
const configuredAuthorities = new WeakMap<object, CompanyService['store']>();
export function createServiceAuthorization(loaded: LoadedServiceAuth, options: ServiceAuthorizationOptions) {
  const source = canonicalServiceGrantSource({ company: options.company, custody: options.custody });
  const issuer = serviceIssuers(loaded);
  const now = options.now ?? (() => Date.now());
  const reconcilePurpose = loaded.purposeFor('reverie.ops.employee.reconcile-owned');
  const closeViewerPurpose = loaded.purposeFor('reverie.ops.employee.close-viewer');
  const auth = new ServiceGrantAuthentication(
    { issuer, ...source, nonces: serviceNonces(new GoalNonceStore(options.nonce)), now },
    loaded.purposes,
    reconcilePurpose || closeViewerPurpose
      ? { reconcilePurpose, closeViewerPurpose, binding: source.retainedBinding }
      : undefined
  );
  const authority = Object.freeze({ loaded, source, issuer, auth, now });
  configuredAuthorities.set(authority, options.company.store);
  return authority;
}
export type ServiceAuthorization = ReturnType<typeof createServiceAuthorization>;

/** Read-only original-composition check; structural ports/leases cannot mint it. */
export function assertServiceAuthorization(authority: ServiceAuthorization, store?: CompanyService['store']): void {
  if (!configuredAuthorities.has(authority) || (store !== undefined && configuredAuthorities.get(authority) !== store))
    throw new Error('Configured service authorization is unavailable');
}
