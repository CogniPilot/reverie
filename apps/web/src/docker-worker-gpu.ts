import { z } from 'zod';

export const workerGpuLabel = 'reverie.boxed.gpu';
const storePath = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]{1,178}$/;

// Corresponds to the deployment-owned profile compiled by the Rust image tool.
export const DockerWorkerGpu = z
  .object({
    device: z.string().regex(/^nvidia\.com\/gpu=GPU-[\da-fA-F]{8}-(?:[\da-fA-F]{4}-){3}[\da-fA-F]{12}$/),
    driverStorePaths: z
      .array(z.string().regex(storePath))
      .max(96)
      .refine((paths) => new Set(paths).size === paths.length),
  })
  .strict();
export type DockerWorkerGpu = z.infer<typeof DockerWorkerGpu>;

export function gpuDriverMount(mount: { Type: string; Source: string; Destination: string; RW: boolean }): boolean {
  return mount.Type === 'bind' && !mount.RW && mount.Source === mount.Destination && storePath.test(mount.Source);
}

export function gpuHostConfig(gpu: DockerWorkerGpu) {
  return {
    DeviceRequests: [{ Driver: 'cdi', Count: 0, DeviceIDs: [gpu.device], Capabilities: null, Options: null }],
    Mounts: gpu.driverStorePaths.map((path) => ({
      Type: 'bind',
      Source: path,
      Target: path,
      ReadOnly: true,
      BindOptions: { Propagation: 'rprivate' },
    })),
  };
}

export function gpuWorkerEnvironment(environment: string[], gpu: DockerWorkerGpu): string[] {
  if (!gpu.driverStorePaths.length) return environment;
  const key = 'LD_LIBRARY_PATH=';
  const previous =
    environment
      .find((value) => value.startsWith(key))
      ?.slice(key.length)
      .split(':') ?? [];
  const libraryPaths = [...new Set(['/run/opengl-driver/lib', ...previous])].join(':');
  return [
    ...environment.filter((value) => !value.startsWith(key) && !value.startsWith('VK_DRIVER_FILES=')),
    key + libraryPaths,
    'VK_DRIVER_FILES=/etc/vulkan/icd.d/nvidia_icd.json',
  ];
}
