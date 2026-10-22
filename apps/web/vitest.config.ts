// A bare `npx vitest run` only discovers a config at the package root. Without
// this file it ran every test file with default worker fan-out and skipped
// test/setup.ts (temp HOME, env strip, live-instance refusal). Use the CI gate.
export { default } from './config/vitest.ci.config';
