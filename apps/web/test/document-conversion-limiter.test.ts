import { describe, it, expect } from 'vitest';
import { runWithConversionLimit, getActiveConversionCount } from '../src/document-conversion-limiter.js';

describe('document-conversion-limiter', () => {
  it('never runs more converters than the cap (default 3) concurrently', async () => {
    let running = 0;
    let maxObserved = 0;

    const task = () => async () => {
      running++;
      maxObserved = Math.max(maxObserved, running);
      // The module's own accounting must also stay within the cap.
      expect(getActiveConversionCount()).toBeLessThanOrEqual(3);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    };

    await Promise.all(Array.from({ length: 12 }, () => runWithConversionLimit(task())));

    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1); // proves it genuinely parallelizes, not serializes
    expect(getActiveConversionCount()).toBe(0); // every slot released
  });

  it('processes every queued task even when far more are submitted than the cap', async () => {
    let completed = 0;
    await Promise.all(
      Array.from({ length: 25 }, () =>
        runWithConversionLimit(async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          completed++;
        })
      )
    );
    expect(completed).toBe(25);
    expect(getActiveConversionCount()).toBe(0);
  });

  it('releases the slot when a task throws', async () => {
    await expect(
      runWithConversionLimit(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(getActiveConversionCount()).toBe(0);
  });
});
