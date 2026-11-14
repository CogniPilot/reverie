/** Non-authorizing public correlation DATA from the current canonical binding. */
export function encodeDockerProviderPlacement(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const fields = [
    value.operationId,
    value.containerId,
    value.imageId,
    value.credentialId,
    value.sessionId,
    value.originalDigest,
    value.policyDigest,
  ];
  if (!fields.every((field): field is string => typeof field === 'string')) return undefined;
  const [operationId, containerId, imageId, credentialId, sessionId, originalDigest, policyDigest] = fields;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const digest = /^[0-9a-f]{64}$/;
  if (
    value.version !== 1 ||
    !uuid.test(operationId) ||
    !uuid.test(credentialId) ||
    !uuid.test(sessionId) ||
    !digest.test(containerId) ||
    !/^sha256:[0-9a-f]{64}$/.test(imageId) ||
    typeof value.sessionGeneration !== 'number' ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    value.sessionGeneration <= 0 ||
    !digest.test(originalDigest) ||
    !digest.test(policyDigest)
  )
    return undefined;
  return JSON.stringify([
    1,
    operationId,
    containerId,
    imageId,
    credentialId,
    sessionId,
    value.sessionGeneration,
    originalDigest,
    policyDigest,
  ]);
}
