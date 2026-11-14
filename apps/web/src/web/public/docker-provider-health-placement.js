/** Non-authorizing correlation DATA; identical codec in server and browser. */
export function encodeDockerProviderPlacement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (
    ['operationId', 'credentialId', 'sessionId', 'containerId', 'imageId', 'originalDigest', 'policyDigest'].some(
      (key) => typeof value[key] !== 'string'
    )
  )
    return undefined;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
  const digest = /^[0-9a-f]{64}$/;
  if (
    value.version !== 1 ||
    !uuid.test(value.operationId) ||
    !uuid.test(value.credentialId) ||
    !uuid.test(value.sessionId) ||
    !digest.test(value.containerId) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.imageId) ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    value.sessionGeneration <= 0 ||
    !digest.test(value.originalDigest) ||
    !digest.test(value.policyDigest)
  )
    return undefined;
  return JSON.stringify([
    1,
    value.operationId,
    value.containerId,
    value.imageId,
    value.credentialId,
    value.sessionId,
    value.sessionGeneration,
    value.originalDigest,
    value.policyDigest,
  ]);
}
globalThis.ReverieDockerProviderPlacement = Object.freeze({ encode: encodeDockerProviderPlacement });
