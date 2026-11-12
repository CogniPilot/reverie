import { expect, it } from 'vitest';
import { ExecutionIndex, executionSchema } from './helpers/browser-coverage-execution.js';

const origin = 'http://127.0.0.1:1234',
  url = origin + '/selected.js',
  sha = 'a'.repeat(64);
function fixture() {
  const index = new ExecutionIndex(origin);
  index.frame('main', undefined, origin, true);
  index.frame('child', 'main', origin + '/frame');
  index.context(1, 'main', 'main-context');
  index.context(2, 'child', 'child-context');
  return index;
}

it('binds an executed script to its actual context even when an iframe fetches the same URL', () => {
  const index = fixture();
  // Merely having a child frame never assigns a script to it.
  const main = index.script('7', url, 1);
  index.source(main, sha);
  expect(index.proof('7', url, sha)).toMatchObject({ state: 'attributed', kind: 'main', frameId: 'main' });
  const child = index.script('8', url, 2);
  index.source(child, sha);
  expect(index.proof('8', url, sha)).toMatchObject({
    state: 'attributed',
    kind: 'iframe',
    frameId: 'child',
    ancestry: ['child', 'main'],
  });
});

it('refuses a missing context, a different source hash and unrelated source URL', () => {
  const index = fixture(),
    unknown = index.script('1', url, 99);
  index.source(unknown, sha);
  expect(index.proof('1', url, sha)).toMatchObject({ state: 'unattributed' });
  const main = index.script('2', url, 1);
  index.source(main, sha);
  expect(index.proof('2', url, 'b'.repeat(64))).toMatchObject({ state: 'unattributed' });
  expect(index.proof('2', origin + '/other.js', sha)).toMatchObject({ state: 'unattributed' });
  expect(index.proof('unseen', url, sha)).toMatchObject({ state: 'unattributed' });
});

it('retains ambiguity across context generations instead of guessing from reused script IDs', () => {
  const index = fixture(),
    first = index.script('1', url, 1);
  index.source(first, sha);
  index.cleared();
  index.context(1, 'child', 'new-context');
  const second = index.script('1', url, 1);
  index.source(second, sha);
  expect(index.proof('1', url, sha)).toEqual({ state: 'unattributed', reason: 'ambiguous-script-identity' });
});

it('refuses unknown parentage, conflicting context identity and changing script source', () => {
  const index = fixture();
  index.context(3, 'missing');
  const unknown = index.script('1', url, 3);
  index.source(unknown, sha);
  expect(index.proof('1', url, sha)).toMatchObject({ state: 'unattributed' });
  index.context(1, 'child', 'conflicting-context');
  const reused = index.script('2', url, 1);
  index.source(reused, sha);
  expect(index.proof('2', url, sha)).toMatchObject({ state: 'unattributed' });
  const changing = index.script('3', url, 2);
  index.source(changing, sha);
  index.source(changing, 'c'.repeat(64));
  expect(index.proof('3', url, 'c'.repeat(64))).toEqual({ state: 'unattributed', reason: 'script-source-changed' });
});

it('records out-of-process gaps and validates ancestry before accepting proof data', () => {
  const index = fixture();
  index.swapped('child');
  expect(index.collectionGaps()).toEqual(['out-of-process-frame-swap:/frame']);
  expect(() =>
    executionSchema.parse({
      state: 'attributed',
      kind: 'iframe',
      scriptId: '1',
      sourceSha256: sha,
      contextId: 1,
      generation: 0,
      frameId: 'main',
      mainFrameId: 'main',
      ancestry: ['main'],
    })
  ).toThrow();
});

it('refuses new contexts after conflicting frame parentage while preserving historical proof', () => {
  const index = fixture(),
    historical = index.script('old', url, 2);
  index.source(historical, sha);
  index.frame('other', 'main', origin + '/other');
  index.frame('child', 'other', origin + '/frame');
  index.context(3, 'child', 'after-conflict');
  const current = index.script('new', url, 3);
  index.source(current, sha);
  expect(index.proof('new', url, sha)).toEqual({ state: 'unattributed', reason: 'frame-parentage-unavailable' });
  expect(index.proof('old', url, sha)).toMatchObject({ state: 'attributed', kind: 'iframe' });
  expect(index.collectionGaps()).toContain('conflicting-frame-parentage');
});
