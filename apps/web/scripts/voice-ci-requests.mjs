import assert from 'node:assert/strict';

// A fallback can finish while its earlier server prefetches are still running.
// Drain those requests before the next fixture, using each original deadline.
export async function settleVoiceRequests(
  timings,
  budgetFor,
  { now = () => performance.now(), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}
) {
  for (;;) {
    let remaining = Infinity;
    for (const item of timings) {
      const budget = budgetFor(item);
      assert.ok(Number.isFinite(budget) && budget > 0, 'Invalid request budget');
      assert.ok(Number.isFinite(item.startMs), 'Missing request start timestamp');
      assert.ok(!item.failure, `Request failed: ${item.failure}: ${item.url}`);
      if (Number.isFinite(item.endMs)) {
        assert.ok(item.endMs >= item.startMs, 'Invalid request completion timestamp');
        assert.ok(item.endMs - item.startMs <= budget, `Request exceeded ${budget}ms: ${item.url}`);
      } else {
        const left = item.startMs + budget - now();
        assert.ok(left > 0, `Request did not complete within ${budget}ms: ${item.url}`);
        remaining = Math.min(remaining, left);
      }
    }
    if (remaining === Infinity) return;
    await pause(Math.min(10, remaining));
  }
}
