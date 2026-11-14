import { describe, expect, it } from 'vitest';
import { boundedDockerResourceVisits } from '../src/docker-resource-convergence.js';
describe('bounded resource convergence scheduling creates no authority', () => {
  it.each([Array.from({ length: 65 }, (_, i) => String(i)), ['same', 'same']].map((ids) => ({ ids })))(
    'refuses excessive/ambiguous membership before invoking any visit',
    async ({ ids }) => {
      const visits: string[] = [];
      await expect(
        boundedDockerResourceVisits(ids, async (id) => {
          visits.push(id);
        })
      ).rejects.toThrow('CAPACITY');
      expect(visits).toEqual([]);
    }
  );
  it('snapshots eligible IDs, runs at most two, and joins every visit despite an early failure', async () => {
    const ids = ['first', 'second', 'third', 'fourth'],
      selected: string[] = [],
      releases: Array<() => void> = [];
    let active = 0,
      maximum = 0;
    const pending = boundedDockerResourceVisits(ids, async (id) => {
      selected.push(id);
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      if (id === 'first') throw Error('closed failed observation');
      return id;
    });
    expect(selected).toEqual(['first', 'second']);
    ids.push('unadmitted-later'); // no membership widening after an await
    releases.shift()!();
    releases.shift()!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(selected).toEqual(['first', 'second', 'third', 'fourth']);
    expect(active).toBe(2);
    releases.shift()!();
    releases.shift()!();
    const results = await pending;
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(results).toHaveLength(4);
    expect(results[0]?.status).toBe('rejected');
    expect(results.slice(1).map((value) => value.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  });
});
