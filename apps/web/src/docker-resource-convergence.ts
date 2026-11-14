/** Bounded scheduling only; this pure utility creates no resource or launch authority. */
import { DockerEmployeeContinuationError } from './docker-employee-continuation.js';
export async function boundedDockerResourceVisits<T>(
  ids: readonly string[],
  visit: (id: string) => Promise<T>
): Promise<PromiseSettledResult<T>[]> {
  const selected = [...ids];
  if (selected.length > 64 || new Set(selected).size !== selected.length)
    throw new DockerEmployeeContinuationError('DOCKER_RESOURCE_REVISION_CAPACITY');
  const results: PromiseSettledResult<T>[] = [];
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++,
        id = selected[index]!;
      try {
        results[index] = { status: 'fulfilled', value: await visit(id) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  // Every owned visit joins, including the other worker after a rejection.
  await Promise.all([worker(), worker()]);
  return results;
}
