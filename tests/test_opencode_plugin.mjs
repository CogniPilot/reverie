// Run with node --test tests/test_opencode_plugin.mjs. No LLM or npm install needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Never read a live instance: a shell inside an agent container exports its memory paths.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEMAN_") || key.startsWith("FLEET_")) delete process.env[key];
}

test("OpenCode hooks restore context, persist complete turns once, and compose developer briefs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-plugin-"));
  const oldEnv = { ...process.env };
  try {
    const root = resolve(import.meta.dirname, "..");
    Object.assign(process.env, { FLEET_HOME: dir, FLEET_DATA_DIR: join(dir, "data"), FLEET_EMBED_URL: "" });
    await mkdir(join(dir, "data"));
    await writeFile(join(dir, ".fleet-instance"), JSON.stringify({ python: "python3", source: root }));
    const source = (await readFile(join(root, "cto/plugins/fleet.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}}), enum: () => ({})}});');
    const { CTOFleet } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const logs = [];
    const messages = [
      {info: {id: "user1", role: "user"}, parts: [{type: "text", text: "Check the fleet"}]},
      {info: {id: "a1", role: "assistant", parentID: "user1", time: {completed: 1}},
        parts: [{type: "reasoning", text: "SECRET REASONING"}, {type: "text", text: "I checked the plan."}]},
      {info: {id: "a2", role: "assistant", parentID: "user1", time: {}}, parts: [{type: "text", text: "unfinished"}]},
    ];
    const hooks = await CTOFleet({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async (entry) => logs.push(entry) }, session: { messages: async () => ({data: messages}) } } });
    await hooks["chat.message"]({sessionID: "ses_test"}, {parts: [{type: "text", text: "Check the fleet"}]});
    const output = {system: []};
    await hooks["experimental.chat.system.transform"]({sessionID: "ses_test"}, output);
    assert.match(output.system[0], /employee number one/);
    await hooks.event({event: {type: "session.idle", properties: {sessionID: "ses_test"}}});
    await hooks.event({event: {type: "session.idle", properties: {sessionID: "ses_test"}}});
    assert.deepEqual(logs, []);
    const recalled = JSON.parse(await hooks.tool.cto_memory.execute({action: "recall", text: "fleet"}));
    assert.equal(recalled.filter((m) => m.kind === "episode").length, 1);
    assert.match(recalled[0].text, /I checked the plan/);
    assert.doesNotMatch(JSON.stringify(recalled), /SECRET REASONING|unfinished/);
    await hooks.tool.cto_fleet.execute({action: "profile", data: JSON.stringify({name: "blake", revision: 0,
      profile: {role: "Compiler developer", long_term: "Modelica lookup rules", short_term: "CI pending"}})});
    const brief = JSON.parse(await hooks.tool.cto_fleet.execute({action: "brief",
      data: JSON.stringify({names: ["blake"], task: "Check the compiler"})}));
    assert.match(brief, /CI pending/);
    assert.doesNotMatch(brief, /Modelica lookup rules/);
    const compact = {context: []};
    await hooks["experimental.session.compacting"]({sessionID: "ses_test"}, compact);
    assert.match(compact.context[0], /employee number one/);
    await assert.rejects(hooks.tool.cto_fleet.execute({action: "plan", data: "[]"}));
    // Both product names use the work boundary; rebranding cannot expose private recall.
    for (const brand of ["Codeman", "Reverie"]) {
      await hooks["chat.message"]({sessionID: "ses_work"}, {parts: [{type: "text", text: `[${brand} chat "Fleet"] user: Review the task`}]});
      const work = {system: []};
      await hooks["experimental.chat.system.transform"]({sessionID: "ses_work"}, work);
      assert.match(work.system[0], /shared work channel/);
      assert.doesNotMatch(work.system[0], /Recent remembered exchanges|I checked the plan/);
    }
    // A new Python process can recover the exact turn without any plugin RAM.
    const db = execFileSync("python3", ["-c", "from cto.config import Config; from cto.memory import MemoryStore; s=MemoryStore(Config().db_path); print(s.count('episode')); s.close()"], {cwd: root, encoding: "utf8"});
    assert.equal(db.trim(), "1");
  } finally {
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Research cycles mark activity without registering a primary runtime, recording turns or maintaining memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reverie-research-plugin-"));
  const oldEnv = { ...process.env };
  const originalInterval = globalThis.setInterval;
  try {
    const root = resolve(import.meta.dirname, "..");
    const requests = join(dir, "requests.jsonl");
    const bridge = join(dir, "bridge");
    await writeFile(bridge, '#!/usr/bin/env node\n' +
      'const fs = require("node:fs"); let input = ""; process.stdin.on("data", part => input += part);\n' +
      'process.stdin.on("end", () => { fs.appendFileSync(process.env.REVERIE_TEST_REQUESTS, input + "\\n"); process.stdout.write("{}"); });\n', {mode: 0o700});
    Object.assign(process.env, { FLEET_RESEARCH_CYCLE_ID: "research-cycle", REVERIE_TEST_REQUESTS: requests });
    await writeFile(join(dir, ".fleet-instance"), JSON.stringify({ python: bridge, source: root }));
    const source = (await readFile(join(root, "cto/plugins/fleet.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}}), enum: () => ({})}});');
    const { CTOFleet } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    let maintenance;
    globalThis.setInterval = (callback) => { maintenance = callback; return {unref() {}}; };
    let messageReads = 0;
    const logs = [];
    const hooks = await CTOFleet({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async (entry) => logs.push(entry) }, session: { messages: async () => {
        messageReads++;
        throw new Error("Research must not read private conversation history");
      } } } });
    globalThis.setInterval = originalInterval;
    await maintenance();
    await hooks["chat.message"]({sessionID: "research-session"}, {parts: [{type: "text", text: "An unverified research idea"}]});
    await hooks.event({event: {type: "session.idle", properties: {sessionID: "research-session"}}});
    await maintenance();
    assert.equal(messageReads, 0);
    assert.deepEqual(logs, []);
    const recorded = (await readFile(requests, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(recorded, [{action: "activity", research_cycle_id: "research-cycle"}]);
  } finally {
    globalThis.setInterval = originalInterval;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
