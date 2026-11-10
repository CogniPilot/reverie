/** Fresh cookie-bound responses on the SAME original fleet Q, never an OS grant. */
import { isDeepStrictEqual } from 'node:util';
import { FleetMigrationChallenge, FleetPreviewChallenge } from './resource-fleet-native-data.js';
import {
  FLEET_MAINTENANCE_PURPOSE,
  ResourceOwnerAuthority,
  type FleetViewerContext,
  type FleetMigrationContext,
} from './resource-owner-authority.js';
function need(value: unknown): asserts value {
  if (!value) throw new Error('The original fleet owner authorization changed');
}
export function fleetPreviewRequest(authority: ResourceOwnerAuthority, context: FleetViewerContext) {
  authority.assertContext(context);
  need(context.purpose === FLEET_MAINTENANCE_PURPOSE && context.stage === 'fleet-viewer');
  return {
    kind: 'fleet-preview',
    purpose: context.purpose,
    version: 1,
    requestId: context.requestId,
    principal: context.principal,
  };
}
export function fleetMigrationRequest(authority: ResourceOwnerAuthority, context: FleetMigrationContext) {
  authority.assertContext(context);
  need(
    context.purpose === FLEET_MAINTENANCE_PURPOSE &&
      context.stage === 'fleet-migration' &&
      context.verb === 'migrate-pool' &&
      context.consent === true
  );
  return {
    kind: 'fleet-maintenance',
    purpose: context.purpose,
    version: 1,
    verb: context.verb,
    requestId: context.requestId,
    consent: true,
    approval: context.approval,
    principal: context.principal,
  };
}
export function answerFleetChallenge(
  authority: ResourceOwnerAuthority,
  context: FleetViewerContext | FleetMigrationContext,
  raw: unknown
) {
  authority.assertContext(context);
  need(context.purpose === FLEET_MAINTENANCE_PURPOSE);
  const migrating = context.stage === 'fleet-migration';
  const challenge = migrating ? FleetMigrationChallenge.parse(raw) : FleetPreviewChallenge.parse(raw);
  need(challenge.requestId === context.requestId && isDeepStrictEqual(challenge.principal, context.principal));
  if (migrating) need('approval' in challenge && isDeepStrictEqual(challenge.approval, context.approval));
  authority.assertContext(context);
  const expires = Math.min(context.expiresAtEpochMs, Date.now() + 10_000);
  need(expires > Date.now());
  return {
    kind: migrating ? 'fleet-maintenance-owner-current' : 'fleet-preview-owner-current',
    purpose: context.purpose,
    version: 1,
    requestId: context.requestId,
    nonce: challenge.nonce,
    principal: context.principal,
    ownerScopeDigest: context.ownerScopeDigest,
    expiresAtEpochMs: expires,
    ...(migrating ? { verb: 'migrate-pool', consent: true, approval: context.approval } : {}),
  };
}
