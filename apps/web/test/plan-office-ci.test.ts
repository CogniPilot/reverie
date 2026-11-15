/** Closed hosted orchestration contracts only; these tests never call Docker or build images. */
import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  requireHostedPlanOffice,
  planOfficeCiNamespace,
  planOfficeCiImage,
  planOfficeCiContract,
  requirePlanOfficeCiAcceptance,
} from '../scripts/plan-office-ci.mjs';
const instance = 'a'.repeat(32),
  namespace = planOfficeCiNamespace(instance);
const sha = 'sha256:' + 'b'.repeat(64),
  employeeId = '11111111-1111-4111-8111-111111111111';
const env = { GITHUB_ACTIONS: 'true', REVERIE_CI_RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/private/runner' };
const metadata = {
  version: 1,
  purpose: 'reverie-ci-plan-office-inputs-v1',
  imageNamespace: namespace,
  sourcePath: '/nix/store/' + 'c'.repeat(32) + '-source',
  runtimePath: '/nix/store/' + 'd'.repeat(32) + '-runtime',
  platformClosure: '/nix/store/' + 'e'.repeat(32) + '-closure',
  clientManifestDigest: 'f'.repeat(64),
};
it('requires the explicit hosted-only command before any filesystem, build or Engine effect', () => {
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'x64')).not.toThrow();
  for (const args of [[], ['--ci', '--force'], ['--contract', '/private/office']])
    expect(() => requireHostedPlanOffice(args, env, 'linux', 'x64')).toThrow();
  for (const change of [
    { GITHUB_ACTIONS: 'false' },
    { REVERIE_CI_RUNNER_ENVIRONMENT: 'self-hosted' },
    { REVERIE_CI_RUNNER_ENVIRONMENT: undefined },
    { RUNNER_TEMP: 'relative' },
  ])
    expect(() => requireHostedPlanOffice(['--ci'], { ...env, ...change }, 'linux', 'x64')).toThrow();
  expect(() => requireHostedPlanOffice(['--ci'], env, 'darwin', 'x64')).toThrow();
  expect(() => requireHostedPlanOffice(['--ci'], env, 'linux', 'arm64')).toThrow();
});
it('selects only fresh namespaced actual Engine IDs and fixed immutable current-source inputs', () => {
  for (const invalid of ['production', '', '../office', 'A'.repeat(32), 'a'.repeat(31)])
    expect(() => planOfficeCiNamespace(invalid)).toThrow();
  const image = { Id: sha, Os: 'linux', Architecture: 'amd64', RepoTags: [namespace + '-source:latest'] };
  expect(planOfficeCiImage(image, namespace, 'source')).toBe(sha);
  for (const change of [
    { Id: 'source:latest' },
    { Architecture: 'arm64' },
    { Os: 'windows' },
    { RepoTags: ['production:latest'] },
    { RepoTags: [...image.RepoTags, 'production:latest'] },
  ])
    expect(() => planOfficeCiImage({ ...image, ...change }, namespace, 'source')).toThrow();
  const ids = { source: sha, worker: sha, helper: sha, control: sha };
  const c = planOfficeCiContract(metadata, instance, ids);
  expect(c.acceptance).toBe('ordinary-self');
  expect(c.bootstrap.employees[0]?.permissions).toEqual({ moveOwnPlan: true, managePlans: false });
  expect(c.sourceProviders[0]?.mode).toBe('ordinary');
  for (const change of [
    { imageNamespace: 'production' },
    { sourcePath: '/tmp/mutable' },
    { runtimePath: '/tmp/mutable' },
    { clientManifestDigest: 'invalid' },
  ])
    expect(() => planOfficeCiContract({ ...metadata, ...change }, instance, ids)).toThrow();
  expect(() => planOfficeCiContract(metadata, instance, { ...ids, worker: 'worker:latest' })).toThrow();
});
it('requires both the ordinary-self result and separate real HMAC/physical-completion sentinel', () => {
  const root = '/private/owned/office-' + instance;
  const result = {
    status: 0,
    baselineReady: true,
    planMovesAccepted: true,
    acceptedScenario: 'ordinary-self',
    evidence: root,
    forceAccepted: false,
    refreshReuseAccepted: false,
  };
  const proof = {
    id: '22222222-2222-4222-8222-222222222222',
    employeeId,
    fromAccount: 'ci-plan-a',
    toAccount: 'ci-plan-b',
    realCapsuleHmac: true,
    originalOnly: true,
  };
  expect(requirePlanOfficeCiAcceptance(result, proof, root, employeeId)).toMatchObject({
    ordinarySelfAccepted: true,
    forceAccepted: false,
    teamAccepted: false,
  });
  for (const change of [
    { status: 1 },
    { baselineReady: false },
    { planMovesAccepted: false },
    { acceptedScenario: 'baseline' },
    { evidence: '/foreign/office' },
    { forceAccepted: true },
  ])
    expect(() => requirePlanOfficeCiAcceptance({ ...result, ...change }, proof, root, employeeId)).toThrow();
  for (const change of [
    { id: 'latest' },
    { employeeId: 'foreign' },
    { fromAccount: 'ci-plan-b' },
    { toAccount: 'ci-plan-a' },
    { realCapsuleHmac: false },
    { originalOnly: false },
  ])
    expect(() => requirePlanOfficeCiAcceptance(result, { ...proof, ...change }, root, employeeId)).toThrow();
  expect(() => requirePlanOfficeCiAcceptance(result, undefined, root, employeeId)).toThrow();
});
it('the actual executable exits nonzero on an unqualified host without touching its proposed fixture directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-office-ci-refusal-'));
  try {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.resolve('scripts/plan-office-ci.mts'), '--ci'],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_ACTIONS: 'false',
          REVERIE_CI_RUNNER_ENVIRONMENT: 'github-hosted',
          RUNNER_TEMP: temp,
        },
        encoding: 'utf8',
        timeout: 10000,
      }
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(temp)).toEqual([]);
  } finally {
    fs.rmSync(temp, { recursive: true });
  }
});
