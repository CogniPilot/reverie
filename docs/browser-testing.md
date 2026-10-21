# Browser tests in the development container

The Debian 12 runtime image includes Chromium and WebKit's OS dependencies from
Playwright **1.60.0**. `docker/playwright-system-packages.txt` is the union of that
version's Debian 12 `tools`, `chromium`, and `webkit` dependency lists. The final
Containerfile stage installs it without recommended packages. Browser executables
are downloaded separately by the agent user; they are not installed globally or
included in the image.

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

For an older image, the host operator can install only the OS dependencies as
container root, using the existing pinned Playwright installation:

```sh
node /path/to/playwright/cli.js install-deps chromium webkit
```

Then run `install-deps --dry-run chromium webkit` as the agent user. It should
report that all system dependencies are installed. Verify both engines with an
isolated, local HTML page and a headless screenshot as the agent user. This does
not require a public listener, a container restart, or reading personal chat data.
WebKit emulation is a smoke check, not proof of behavior on a physical iPhone.

An install in a running container is lost when recreating from an older image.
Until a reviewed image includes this Containerfile change, reapply the OS package
list before browser tests after recreation. Preserve the current console/runtime
changes when building that image; do not replace them with an older source tree.

When updating Playwright, regenerate the package list for the image's Debian
release and verify both engines again. The dependency install measured on the
2026-10-16 slim runtime added 354 packages (about 757 MB installed, 219 MB download),
with no upgrades or removals. Package versions remain supplied by Debian's
configured repositories; the package list is tied to Playwright 1.60.0, not a
frozen Debian snapshot.
