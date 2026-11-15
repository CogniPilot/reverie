import { describe, expect, it } from 'vitest';
import {
  DockerPlanInitialReceipt,
  DockerPlanLiveReceipt,
  dockerPlanDestinationEnvironment,
  dockerPlanGeneration,
} from '../src/docker-plan-install-data.js';
const operationId = '11111111-1111-4111-8111-111111111111',
  containerId = 'a'.repeat(64),
  projectionDigest = 'b'.repeat(64);
const selected = { operationId, containerId, projectionDigest, provider: 'anthropic' as const };
function receipt() {
  return {
    version: 1,
    purpose: 'reverie-plan-installed-v1',
    operationId,
    sessionId: '22222222-2222-4222-8222-222222222222',
    containerId,
    projectionDigest,
    accountId: 'account-b',
    provider: 'anthropic',
    contextInputDigest: 'c'.repeat(64),
    readMode: 'initial',
    installedAuthDigest: 'd'.repeat(64),
    observedAuthDigest: 'd'.repeat(64),
    tokenDigest: 'e'.repeat(64),
    contextDigest: 'f'.repeat(64),
    observedContextDigest: 'f'.repeat(64),
    homeDev: '1',
    homeIno: '2',
    configDev: '1',
    configIno: '3',
  };
}
describe('fixed plan generation contract', () => {
  it('derives only operation/material/provider/CID paths and rejects arbitrary selectors', () => {
    const paths = dockerPlanGeneration(selected),
      root = '/home/agent/.reverie/plan-moves/' + operationId + '/generation-' + projectionDigest;
    expect(paths).toEqual({
      generation: root,
      configDir: root + '/claude',
      identityFile: root + '/worker-identity-' + containerId,
    });
    expect(dockerPlanGeneration({ ...selected, provider: 'openai' }).configDir).toBe(root + '/codex');
    for (const changed of [
      { ...selected, operationId: '../elsewhere' },
      { ...selected, containerId: 'not-a-cid' },
      { ...selected, projectionDigest: '../payload' },
      { ...selected, provider: 'custom' },
      { ...selected, path: '/secrets' },
    ])
      expect(() => dockerPlanGeneration(changed as typeof selected)).toThrow();
  });
  it('retains tool/workspace environment while replacing source account credentials and callback identity', () => {
    const source = Object.freeze([
      'HOME=/home/agent',
      'PATH=/bin',
      'WORKSPACE_TOOL=keep',
      'ANTHROPIC_API_KEY=synthetic-old-key',
      'OPENAI_BASE_URL=https://old.invalid',
      'CLAUDE_CONFIG_DIR=/old-account',
      'CODEX_HOME=/old-codex',
      'REVERIE_WORKER_IDENTITY_FILE=/old-token',
      'REVERIE_SESSION_ID=old',
      'REVERIE_HOOK_GENERATION=old',
      'REVERIE_WORKER_SOCKET=/old-broker',
    ]);
    const { containerId: _cid, ...selector } = selected;
    const expected = [
      'HOME=/home/agent',
      'PATH=/bin',
      'WORKSPACE_TOOL=keep',
      'CLAUDE_CONFIG_DIR=' + dockerPlanGeneration(selected).configDir,
    ];
    expect(dockerPlanDestinationEnvironment(source, selector)).toEqual(expected);
    expect(source).toContain('CLAUDE_CONFIG_DIR=/old-account');
    expect(dockerPlanDestinationEnvironment(source, { ...selector, provider: 'openai' }).at(-1)).toBe(
      'CODEX_HOME=' + dockerPlanGeneration({ ...selected, provider: 'openai' }).configDir
    );
  });
  it('refuses duplicate/invalid inherited environment before constructing a target', () => {
    const { containerId: _cid, ...selector } = selected;
    for (const source of [['A=x', 'A=y'], ['bad;name=value'], ['missing-equals'], ['A=bad\0value']])
      expect(() => dockerPlanDestinationEnvironment(source, selector)).toThrow();
  });
  it('keeps input context separate from physical inode observations and prevents live receipts from becoming install ACKs', () => {
    const initial = receipt();
    expect(DockerPlanInitialReceipt.parse(initial).contextInputDigest).not.toBe(initial.contextDigest);
    expect(() => DockerPlanInitialReceipt.parse({ ...initial, accountId: undefined })).toThrow();
    expect(() => DockerPlanInitialReceipt.parse({ ...initial, observedAuthDigest: '9'.repeat(64) })).toThrow();
    expect(() => DockerPlanInitialReceipt.parse({ ...initial, observedContextDigest: '8'.repeat(64) })).toThrow();
    const live = {
      ...initial,
      purpose: 'reverie-plan-live-observation-v1',
      readMode: 'live',
      observedAuthDigest: '9'.repeat(64),
      observedContextDigest: '8'.repeat(64),
    };
    expect(DockerPlanLiveReceipt.parse(live).installedAuthDigest).toBe(initial.installedAuthDigest);
    expect(() => DockerPlanInitialReceipt.parse(live)).toThrow();
    expect(() => DockerPlanLiveReceipt.parse(initial)).toThrow();
    expect(() => DockerPlanInitialReceipt.parse({ ...initial, secret: 'never accepted' })).toThrow();
  });
});
