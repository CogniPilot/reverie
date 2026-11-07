/** Normal host package purpose. The guest image composes a separately compiled
 * fixed-purpose module at this import, rather than rewriting bundled JS. */
export function memoryOrigin(executable: string): boolean {
  return /^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/reverie-memory$/.test(executable);
}
