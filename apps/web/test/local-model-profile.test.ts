import { describe, it, expect } from 'vitest';
import { resolveLocalModelProfile } from '../src/local-model-profile.js';
import type { CustomModelHost } from '../src/custom-model-hosts.js';

const endpoint: CustomModelHost = {
  id: 'local-owner-endpoint',
  label: 'Local server',
  baseUrl: 'http://127.0.0.1:8080',
  apiKey: 'PRIVATE_TEST_SENTINEL',
  models: ['model-small', 'model-large'],
  defaultModelId: 'model-large',
};

describe('owner-selected local model profiles', () => {
  it('uses a saved requested model or configured default without selecting a harness', () => {
    expect(resolveLocalModelProfile([endpoint], endpoint.id, 'model-small')).toEqual({
      customModel: { endpointId: endpoint.id, modelId: 'model-small' },
      label: 'Local server',
    });
    expect(resolveLocalModelProfile([endpoint], endpoint.id).customModel.modelId).toBe('model-large');
    expect(
      resolveLocalModelProfile([{ ...endpoint, defaultModelId: undefined }], endpoint.id).customModel.modelId
    ).toBe('model-small');
  });
  it('returns only saved references and leaves owner data and credentials untouched', () => {
    const before = JSON.stringify(endpoint);
    const result = resolveLocalModelProfile([endpoint], endpoint.id);
    expect(Object.keys(result).sort()).toEqual(['customModel', 'label']);
    expect(JSON.stringify(result)).not.toContain(endpoint.apiKey);
    expect(JSON.stringify(result)).not.toContain(endpoint.baseUrl);
    expect(JSON.stringify(endpoint)).toBe(before);
  });
  it('rejects missing endpoints, models not saved on the endpoint and stale defaults', () => {
    expect(() => resolveLocalModelProfile([endpoint], '')).toThrow('Select a local model endpoint');
    expect(() => resolveLocalModelProfile([endpoint], 'missing')).toThrow('not found');
    for (const model of ['', 'unknown', ' model-small ']) {
      expect(() => resolveLocalModelProfile([endpoint], endpoint.id, model)).toThrow('Select a model saved');
    }
    expect(() => resolveLocalModelProfile([{ ...endpoint, models: [] }], endpoint.id)).toThrow('Select a model saved');
    expect(() => resolveLocalModelProfile([{ ...endpoint, defaultModelId: 'removed' }], endpoint.id)).toThrow(
      'Select a model saved'
    );
  });
});
