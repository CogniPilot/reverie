# Site testing and coverage

`cd apps/web && npm run test:coverage` runs the whole default suite and enforces
the checked-in line, branch, function and statement floors in
`config/coverage-policy.ts`. All `src/**/*.ts` files count, including unimported
files. The web-coverage workflow runs on every pull request and main push, using
the locked dependencies in a disposable runner. A failing test, missing report
or insufficient coverage fails the job. Reports are retained even on failure.

The initial floors are 82% lines, 75% branches, 80% functions and 80% statements.
The complete initial baseline measured 83.07%, 76.90%, 81.14% and 80.94%
respectively; that run also exposed failing tests, so those numbers alone are
not acceptance evidence. Selected lifecycle authorities have individual floors
so a global average cannot hide their regressions. Floors are reviewed changes;
there is no automatic baseline update or test-failure allowance.

This measures TypeScript executed by the Node test process. It does not measure
browser JavaScript, prove that every button works, or qualify a packaged native
worker. Browser acceptance must exercise real controls, assert API results and
persisted state, check refusal/recovery paths, and render desktop and phone
layouts. Native acceptance must run the actual built image in isolation. A
screenshot, discovered-control inventory or successful HTTP response alone is
not behavioral coverage. Unmapped controls remain explicit testing gaps.

The Nix console checks retain their own explicit file registration. The full
web-coverage job supplements those batches; it must not be replaced with a
selected passing subset. Browser, mobile and timing suites retain their separate
runners in `config/test-suites.ts`; exclusions are not coverage exemptions.
