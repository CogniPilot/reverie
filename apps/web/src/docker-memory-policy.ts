/** Memory policy for ordinary Docker case laptops, never host-action scopes. */
import type { DockerResourceLimits } from './types.js';

const MIB = 1024n ** 2n;
const GIB = 1024n ** 3n;
const MAX_BYTES = 1024n * GIB;
const DEFAULT_SWAP_BYTES = 16n * GIB;

function bytes(value: string): bigint {
  const match = typeof value === 'string' && /^(\d{1,16})([bkmg]?)$/i.exec(value);
  if (!match) throw new Error('Memory sizes require a positive integer and an optional b/k/m/g suffix');
  const scale = { '': 1n, b: 1n, k: 1024n, m: MIB, g: GIB }[match[2].toLowerCase()];
  const result = BigInt(match[1]) * scale!;
  if (result === 0n) throw new Error('Memory sizes must be positive');
  if (result > MAX_BYTES) throw new Error('Memory size exceeds the supported 1 TiB bound');
  return result;
}

/** Shared by API validation and the create builder, including persisted profiles. */
export function validateDockerMemory(resources: DockerResourceLimits): void {
  const { memory, memoryReservation, memorySwap } = resources;
  if (memory === undefined) {
    if (memoryReservation !== undefined || memorySwap !== undefined) {
      throw new Error('A memory ceiling is required with a reservation or swap limit');
    }
    return;
  }
  const maximum = bytes(memory);
  if (maximum < 6n * MIB) throw new Error('The memory ceiling must be at least 6 MiB');
  if (memoryReservation !== undefined) {
    const reservation = bytes(memoryReservation);
    if (reservation < 6n * MIB) throw new Error('The memory reservation must be at least 6 MiB');
    if (reservation >= maximum) throw new Error('The memory reservation must be below the memory ceiling');
  }
  if (memorySwap !== undefined && bytes(memorySwap) < maximum) {
    throw new Error('The memory-plus-swap limit must be at least the memory ceiling');
  }
  if (memoryReservation !== undefined && memorySwap === undefined && maximum + DEFAULT_SWAP_BYTES > MAX_BYTES) {
    throw new Error('The default swap allowance exceeds the supported memory-plus-swap bound');
  }
}

/**
 * A reservation opts in to borrowing up to the separately selected RAM ceiling.
 * On accounting-capable hosts its default backup is 16 GiB of swap. The Docker
 * swap flag is TOTAL RAM+swap, whereas cgroup-v2 memory.swap.max is swap only.
 * Absent new fields preserve the previous fixed-RAM/no-swap create arguments.
 */
export function dockerMemoryFlags(resources: DockerResourceLimits, disableSwapLimit = false): string[] {
  validateDockerMemory(resources);
  if (resources.memory === undefined) return [];
  if (disableSwapLimit && resources.memorySwap !== undefined) {
    throw new Error('An explicit swap limit cannot be enforced while swap-limit compatibility mode is enabled');
  }
  const result = ['--memory', resources.memory];
  if (resources.memoryReservation !== undefined) {
    result.push('--memory-reservation', resources.memoryReservation);
  }
  if (!disableSwapLimit) {
    const total =
      resources.memorySwap ??
      (resources.memoryReservation === undefined
        ? resources.memory
        : String(bytes(resources.memory) + DEFAULT_SWAP_BYTES));
    result.push('--memory-swap', total);
  }
  return result;
}

/** Declared engine readback for the opt-in policy, not proof of kernel/ancestor limits. */
export function dockerMemoryReadback(
  resources?: DockerResourceLimits,
  disableSwapLimit = false
):
  | {
      format: string;
      expected: string;
    }
  | undefined {
  if (!resources || (resources.memoryReservation === undefined && resources.memorySwap === undefined)) return undefined;
  const flags = dockerMemoryFlags(resources, disableSwapLimit);
  const fields = ['Memory', 'MemoryReservation'];
  const values = [
    String(bytes(resources.memory!)),
    String(resources.memoryReservation === undefined ? 0n : bytes(resources.memoryReservation)),
  ];
  if (!disableSwapLimit) {
    fields.push('MemorySwap');
    values.push(String(bytes(flags[flags.indexOf('--memory-swap') + 1])));
  }
  return { format: fields.map((field) => `{{.HostConfig.${field}}}`).join(':'), expected: values.join(':') };
}
