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

const { settleVoiceRequests } =
  await import("../apps/web/scripts/voice-ci-requests.mjs");

test("fallback waits for outstanding prefetch and checks its original completion time", async () => {
  const request = { startMs: 0, url: "/api/voice/speak" };
  let clock = 12_600,
    pauses = 0;
  await settleVoiceRequests([request], () => 20_000, {
    now: () => clock,
    pause: async (ms) => {
      pauses++;
      clock += ms;
      if (clock >= 16_800) request.endMs = clock;
    },
  });
  assert.ok(pauses > 0);
  assert.equal(request.endMs, 16_800);
});

test("a lost prefetch is refused at its existing deadline without starting a new budget", async () => {
  const request = { startMs: 0, url: "/api/voice/speak" };
  let clock = 19_995;
  await assert.rejects(
    settleVoiceRequests([request], () => 20_000, {
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    }),
    /did not complete within 20000ms/,
  );
  assert.equal(clock, 20_000);
});

test("failed and over-budget completed requests cannot pass the drain", async () => {
  await assert.rejects(
    settleVoiceRequests(
      [
        {
          startMs: 0,
          endMs: 1,
          failure: "connection reset",
          url: "/api/voice/speak",
        },
      ],
      () => 20_000,
    ),
    /Request failed/,
  );
  await assert.rejects(
    settleVoiceRequests(
      [{ startMs: 0, endMs: 20_001, url: "/api/voice/speak" }],
      () => 20_000,
    ),
    /exceeded 20000ms/,
  );
});

test("a drain includes requests added while it waits and uses their own budgets", async () => {
  const requests = [{ startMs: 0, url: "/api/voice/speak" }];
  let clock = 0;
  await settleVoiceRequests(
    requests,
    (r) => (r.url.includes("/turn") ? 90 : 20),
    {
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
        if (clock === 10) {
          requests[0].endMs = clock;
          requests.push({ startMs: clock, url: "/api/voice/turn" });
        }
        if (clock === 30) requests[1].endMs = clock;
      },
    },
  );
  assert.equal(clock, 30);
});
