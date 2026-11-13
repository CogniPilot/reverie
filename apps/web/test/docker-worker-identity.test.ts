import { describe, expect, it } from 'vitest';
import {
  DockerWorkerIdentityAuthentication,
  DOCKER_WORKER_IDENTITY_HEADER,
  type DockerWorkerIdentityBinding,
  type DockerWorkerIdentityRequest,
} from '../src/docker-worker-identity.js';

const instance = '11111111-1111-4111-8111-111111111111';
const binding: DockerWorkerIdentityBinding = {
  employeeId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  sessionGeneration: 4,
  owner: 'owner',
  containerId: 'a'.repeat(64),
  credentialId: '44444444-4444-4444-8444-444444444444',
};
function fixture() {
  let selected: DockerWorkerIdentityBinding | undefined = { ...binding },
    keyCurrent = true;
  const auth = new DockerWorkerIdentityAuthentication(instance, Buffer.alloc(32, 0x51), {
    binding: (employee) => (employee === binding.employeeId ? selected : undefined),
    keyCurrent: () => keyCurrent,
  });
  const token = auth.issue(binding, () => true);
  const request: DockerWorkerIdentityRequest = {
    headers: {
      [DOCKER_WORKER_IDENTITY_HEADER]: token,
      'x-reverie-parent-session': binding.sessionId,
    },
  };
  return {
    auth,
    token,
    request,
    select: (next: DockerWorkerIdentityBinding | undefined) => {
      selected = next;
    },
    revokeKey: () => {
      keyCurrent = false;
    },
    restoreKey: () => {
      keyCurrent = true;
    },
  };
}
describe('bound Docker callback identity', () => {
  it('authenticates possession with exact live EID/SID/generation/CID and selected credential', () => {
    const f = fixture(),
      identity = f.auth.capture(f.request)!;
    expect(identity.employeeId).toBe(binding.employeeId);
    expect(identity.sessionId).toBe(binding.sessionId);
    expect(identity.sessionGeneration).toBe(4);
    expect(identity.containerId).toBe(binding.containerId);
    expect(identity.owner).toBe('owner');
    expect(identity.current()).toBe(true);
    expect(() => identity.require()).not.toThrow();
  });
  it('does not convert shared Basic and a claimed SID into worker identity', () => {
    const f = fixture();
    expect(
      f.auth.capture({ headers: { authorization: 'Basic synthetic', 'x-reverie-parent-session': binding.sessionId } })
    ).toBeUndefined();
  });
  it.each(['authorization', 'x-reverie-service-token', 'x-reverie-recovery-assertion'])(
    'refuses mixed %s',
    (header) => {
      const f = fixture();
      f.request.headers[header] = 'synthetic';
      expect(f.auth.capture(f.request)).toBeUndefined();
    }
  );
  it.each(['reverie_owner', 'reverie_session'])('refuses mixed cookie %s', (name) => {
    const f = fixture();
    expect(f.auth.capture({ ...f.request, cookies: { [name]: 'synthetic' } })).toBeUndefined();
  });
  it.each(['employeeId', 'sessionId', 'sessionGeneration', 'owner', 'containerId', 'credentialId'] as const)(
    'revokes on changed selected %s without revival',
    (field) => {
      const f = fixture(),
        identity = f.auth.capture(f.request)!;
      const changed = {
        ...binding,
        [field]:
          field === 'sessionGeneration'
            ? 5
            : field === 'owner'
              ? 'another-owner'
              : field === 'containerId'
                ? 'b'.repeat(64)
                : '55555555-5555-4555-8555-555555555555',
      };
      f.select(changed);
      expect(identity.current()).toBe(false);
      f.select(binding);
      expect(identity.current()).toBe(false);
      expect(() => identity.require()).toThrow('identity changed');
    }
  );
  it('revokes when selected binding disappears and does not reconstruct a grant from token claims', () => {
    const f = fixture(),
      identity = f.auth.capture(f.request)!;
    f.select(undefined);
    expect(identity.current()).toBe(false);
    expect(f.auth.capture(f.request)).toBeUndefined();
  });
  it('requires the exact full SID, rejecting prefixes, arrays and duplicate header spellings', () => {
    const f = fixture();
    for (const parent of [binding.sessionId.slice(0, 8), ['wrong'], 'wrong']) {
      f.request.headers['x-reverie-parent-session'] = parent;
      expect(f.auth.capture(f.request)).toBeUndefined();
    }
    f.request.headers['x-reverie-parent-session'] = binding.sessionId;
    f.request.headers['X-Reverie-Parent-Session'] = binding.sessionId;
    expect(f.auth.capture(f.request)).toBeUndefined();
  });
  it('supports token-only requests and sticky request mutation revocation', () => {
    const f = fixture();
    delete f.request.headers['x-reverie-parent-session'];
    const identity = f.auth.capture(f.request)!;
    expect(identity.current()).toBe(true);
    f.request.headers['x-reverie-parent-session'] = binding.sessionId;
    expect(identity.current()).toBe(false);
  });
  it('rejects malformed, modified, foreign-instance, wrong-key and duplicate credentials', () => {
    const f = fixture();
    for (const token of ['', f.token + '.extra', 'x'.repeat(2049), f.token.slice(0, -1) + 'x']) {
      expect(f.auth.capture({ headers: { [DOCKER_WORKER_IDENTITY_HEADER]: token } })).toBeUndefined();
    }
    const other = new DockerWorkerIdentityAuthentication(
      '66666666-6666-4666-8666-666666666666',
      Buffer.alloc(32, 0x51),
      { binding: () => binding, keyCurrent: () => true }
    );
    expect(other.capture(f.request)).toBeUndefined();
    const wrongKey = new DockerWorkerIdentityAuthentication(instance, Buffer.alloc(32, 0x52), {
      binding: () => binding,
      keyCurrent: () => true,
    });
    expect(wrongKey.capture(f.request)).toBeUndefined();
    f.request.headers['X-Reverie-Worker-Identity'] = f.token;
    expect(f.auth.capture(f.request)).toBeUndefined();
  });
  it('binds every continued effect to the actual key epoch and poisons after revocation', () => {
    const f = fixture(),
      identity = f.auth.capture(f.request)!;
    f.revokeKey();
    expect(identity.current()).toBe(false);
    expect(f.auth.capture(f.request)).toBeUndefined();
    f.restoreKey();
    expect(identity.current()).toBe(false);
  });
  it('revokes issued identities on actual authentication-owner close', () => {
    const f = fixture(),
      identity = f.auth.capture(f.request)!;
    f.auth.close();
    expect(identity.current()).toBe(false);
    expect(f.auth.capture(f.request)).toBeUndefined();
    expect(() => f.auth.issue(binding, () => true)).toThrow('provisioning refused');
  });
  it('requires the original provisioning action before and after signing', () => {
    const f = fixture();
    let calls = 0;
    expect(() => f.auth.issue(binding, () => ++calls === 1)).toThrow('provisioning changed');
    expect(calls).toBe(2);
    expect(() => f.auth.issue(binding, () => false)).toThrow('provisioning refused');
    expect(() => f.auth.issue({ ...binding, containerId: 'short' }, () => true)).toThrow('provisioning refused');
  });
});
