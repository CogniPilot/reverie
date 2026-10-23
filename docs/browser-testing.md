# Browser tests in the development container

The application image is built by `nix build .#dockerImage` from the same runtime
as the native package. Browser testing requires a separately prepared browser
runtime with its matching system libraries; Debian apt dependency lists do not
apply to this Nix image. `docker/playwright-system-packages.txt` records the earlier
Debian image setup as reference, and is not installed by the current image build.

For a Nix-pinned Chromium runtime, build `.#browserRuntime`; the optional
`.#workerBrowserImage` also bundles it for isolated laptops. See
[opt-in worker GPU/browser capability](worker-gpu.md) for explicit device grants,
the bounded hardware probe and pending container acceptance. WebKit still needs
its separately prepared runtime.

Inside the container, use a versioned, user-owned cache:

```sh
export PLAYWRIGHT_BROWSERS_PATH=/scratch/cache/playwright-1.60.0
export npm_config_cache=/scratch/cache/npm/playwright-tools-1.60.0
export TMPDIR=/scratch/tmp
npx --yes playwright@1.60.0 --version
npx --yes playwright@1.60.0 install chromium webkit
```

Use the same Playwright version in the screenshot helper's dependencies and browser
installation command. Pass `PLAYWRIGHT_BROWSERS_PATH` when running the helper;
it does not change browser discovery in other sessions. Store screenshots and
traces under `/scratch/build/<task>` or `/scratch/profiles/<task>`. Keep files local
unless the owner explicitly authorizes an upload.

Verify both engines against an isolated local HTML page before using the browser
runtime for acceptance testing. WebKit emulation is a smoke check, not proof of
behavior on a physical iPhone.

When updating Playwright, prepare matching browser libraries and verify both engines again. The dependency install measured on the
2026-10-16 slim runtime added 354 packages (about 757 MB installed, 219 MB download),
with no upgrades or removals. Package versions remain supplied by Debian's
configured repositories; the package list is tied to Playwright 1.60.0, not a
frozen Debian snapshot.
