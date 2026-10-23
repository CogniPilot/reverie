import { test } from "node:test";
import assert from "node:assert/strict";
import { chromiumLaunchOptions } from "../apps/web/scripts/voice-ci-launch.mjs";

test("voice CI requires explicit executable Chromium and keeps its sandbox enabled", () => {
  const options = chromiumLaunchOptions({ CHROMIUM_PATH: process.execPath });
  assert.equal(options.chromiumSandbox, true);
  assert.equal(options.executablePath, process.execPath);
  assert.equal(options.args, undefined);
  assert.throws(() => chromiumLaunchOptions({}), /CHROMIUM_PATH/);
  assert.throws(() =>
    chromiumLaunchOptions({ CHROMIUM_PATH: "/missing/voice-ci-chromium" }),
  );
});
