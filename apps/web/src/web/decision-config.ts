/** Startup-only Board write policy. Missing or malformed settings preserve read-only fallback. */
export function decisionWritesEnabled(settings: unknown): boolean {
  return (
    typeof settings === 'object' &&
    settings !== null &&
    !Array.isArray(settings) &&
    (Object.getPrototypeOf(settings) === Object.prototype || Object.getPrototypeOf(settings) === null) &&
    Object.prototype.hasOwnProperty.call(settings, 'structuredDecisionWrites') &&
    (settings as Record<string, unknown>).structuredDecisionWrites === true
  );
}
