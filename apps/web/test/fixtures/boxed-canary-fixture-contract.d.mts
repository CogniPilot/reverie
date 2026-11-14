export type CanaryFixture = Readonly<{
  version: 1;
  purpose: string;
  employeeId: string;
  sessionId: string;
  generation: number;
  providerThread: string;
  operationId: string;
  sourceCid: string;
  imageId: string;
  workdir: string;
  sourceTask: string;
  sourceFixtureId: string;
  home: Readonly<{ path: string; dev: string; ino: string; uid: number; gid: number; mode: '0700' }>;
}>;
export const LEGACY: CanaryFixture;
export function validateCanaryFixture(value: unknown): CanaryFixture;
export function decodeCanaryFixture(raw: string): CanaryFixture;
export function loadCanaryFixtureContract(file?: string): CanaryFixture;
