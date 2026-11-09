/** Global human-consent cookie proof and wire DATA only. No B connection,
 * native offer, route, installation or host administration is created here.
 */
import {
  POOL_INSTALLATION_CONSENT_PURPOSE,
  ResourceOwnerAuthority,
  type PoolInstallationConsentContext,
  type PoolInstallationOfferContext,
} from './resource-owner-authority.js';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
function need(value: unknown): asserts value {
  if (!value) throw new Error('Current pool installation consent is unavailable or changed');
}
function current(authority: ResourceOwnerAuthority, context: PoolInstallationConsentContext): void {
  authority.assertContext(context);
  need(
    context.purpose === POOL_INSTALLATION_CONSENT_PURPOSE && context.stage === 'consent' && context.consent === true
  );
}
/** Returned fields are correlation DATA. The native side must still compare
 * its SAME retained OS offer, nominated principal and actual attested B peer.
 */
export function poolInstallationConsentRequest(
  authority: ResourceOwnerAuthority,
  context: PoolInstallationConsentContext
) {
  current(authority, context);
  return Object.freeze({
    kind: 'pool-installation-consent' as const,
    purpose: POOL_INSTALLATION_CONSENT_PURPOSE,
    version: 1 as const,
    requestId: context.requestId,
    offerNonce: context.offerNonce,
    requestDigest: context.requestDigest,
    principal: context.principal,
    consent: true as const,
  });
}
/** Answers only an exact original consent request on its private current
 * context. A view, JSON reconstruction or another issuer cannot answer.
 */
export function answerPoolInstallationChallenge(
  authority: ResourceOwnerAuthority,
  context: PoolInstallationConsentContext,
  challenge: unknown
) {
  current(authority, context);
  need(challenge && typeof challenge === 'object' && !Array.isArray(challenge));
  need(
    Object.keys(challenge).sort().join(',') ===
      'kind,nonce,offerNonce,principal,purpose,requestDigest,requestId,version'
  );
  const value = challenge as Record<string, unknown>;
  need(
    value.kind === 'pool-installation-owner-check' &&
      value.purpose === POOL_INSTALLATION_CONSENT_PURPOSE &&
      value.version === 1 &&
      value.requestId === context.requestId &&
      value.offerNonce === context.offerNonce &&
      value.requestDigest === context.requestDigest &&
      typeof value.nonce === 'string' &&
      UUID.test(value.nonce) &&
      value.nonce !== NIL_UUID
  );
  need(value.principal && typeof value.principal === 'object' && !Array.isArray(value.principal));
  need(Object.keys(value.principal).sort().join(',') === 'accountId,personId,sessionEpoch');
  const principal = value.principal as Record<string, unknown>;
  need(
    principal.accountId === context.principal.accountId &&
      principal.personId === context.principal.personId &&
      principal.sessionEpoch === context.principal.sessionEpoch
  );
  // Re-read actual current ROOT/Office registration, cookie and role after
  // matching the whole challenge. This does not renew the original expiry.
  current(authority, context);
  return Object.freeze({
    kind: 'pool-installation-owner-current' as const,
    purpose: POOL_INSTALLATION_CONSENT_PURPOSE,
    version: 1 as const,
    requestId: context.requestId,
    nonce: value.nonce,
    offerNonce: context.offerNonce,
    requestDigest: context.requestDigest,
    principal: context.principal,
    consent: true as const,
    ownerScopeDigest: context.ownerScopeDigest,
    expiresAtEpochMs: context.expiresAtEpochMs,
  });
}

/** Separate view proof: deliberately contains no consent field. */
export function answerPoolInstallationViewChallenge(
  authority: ResourceOwnerAuthority,
  context: PoolInstallationOfferContext,
  challenge: unknown
) {
  authority.assertContext(context);
  need(context.purpose === POOL_INSTALLATION_CONSENT_PURPOSE && context.stage === 'offer');
  need(challenge && typeof challenge === 'object' && !Array.isArray(challenge));
  need(
    Object.keys(challenge).sort().join(',') ===
      'kind,nonce,offerNonce,principal,purpose,requestDigest,requestId,version'
  );
  const value = challenge as Record<string, unknown>;
  need(
    value.kind === 'pool-installation-view-check' &&
      value.purpose === context.purpose &&
      value.version === 1 &&
      value.requestId === context.requestId &&
      value.offerNonce === context.offerNonce &&
      value.requestDigest === context.requestDigest &&
      typeof value.nonce === 'string' &&
      UUID.test(value.nonce) &&
      value.nonce !== NIL_UUID
  );
  need(value.principal && typeof value.principal === 'object' && !Array.isArray(value.principal));
  need(Object.keys(value.principal).sort().join(',') === 'accountId,personId,sessionEpoch');
  const principal = value.principal as Record<string, unknown>;
  need(
    principal.accountId === context.principal.accountId &&
      principal.personId === context.principal.personId &&
      principal.sessionEpoch === context.principal.sessionEpoch
  );
  authority.assertContext(context);
  return Object.freeze({
    kind: 'pool-installation-view-current' as const,
    purpose: context.purpose,
    version: 1 as const,
    requestId: context.requestId,
    nonce: value.nonce,
    offerNonce: context.offerNonce,
    requestDigest: context.requestDigest,
    principal: context.principal,
    ownerScopeDigest: context.ownerScopeDigest,
    expiresAtEpochMs: context.expiresAtEpochMs,
  });
}
