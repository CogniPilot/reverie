// Run with node --test tests/test_opencode_plugin_room.mjs. No LLM, npm install or console needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEMAN_") || key.startsWith("FLEET_")) delete process.env[key];
}

// An agent in several rooms cannot post unless the tool can name the room: the chat CLI only defaults it for a one-room session.
test("cto_room passes the room to the chat CLI, and lists the agent's rooms", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-room-"));
  const oldEnv = { ...process.env };
  try {
    const root = resolve(import.meta.dirname, "..");
    await mkdir(join(dir, "bin"));
    const log = join(dir, "calls.log");
    await writeFile(join(dir, "bin", "reverie"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    await chmod(join(dir, "bin", "reverie"), 0o755);
    Object.assign(process.env, { PATH: join(dir, "bin") + ":" + process.env.PATH, FLEET_HOME: dir, FLEET_DATA_DIR: join(dir, "data"), FLEET_EMBED_URL: "" });
    await mkdir(join(dir, "data"));
    await writeFile(join(dir, ".fleet-instance"), JSON.stringify({ python: "python3", source: root }));
    const source = (await readFile(join(root, "cto/plugins/fleet.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { CTOFleet } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const hooks = await CTOFleet({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async () => {} }, session: { messages: async () => ({data: []}) } } });
    const room = hooks.tool.cto_room.execute;
    await room({action: "say", text: "hello", room: "reverie"});
    await room({action: "say", text: "no room given"});
    await room({action: "read", room: "boardroom"});
    await room({action: "status", text: "working", room: "games"});
    await room({action: "rooms"});
    // Optional in the schema, so say and status must refuse an empty text instead of passing undefined into argv.
    await assert.rejects(room({action: "say", room: "reverie"}), /text is required for say/);
    await assert.rejects(room({action: "status", text: "", room: "reverie"}), /text is required for status/);
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(calls, [
      "agent chat say --room reverie --to user -- hello",
      "agent chat say --to user -- no room given",
      "agent chat read --room boardroom",
      "agent chat status --room games --progress working",
      "agent chat rooms",
    ]);
  } finally {
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
