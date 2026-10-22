// Run with node --test tests/test_opencode_plugin.mjs. No LLM or npm install needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
const NODE_SHEBANG = '#!' + process.execPath + '\n';
process.env.PYTHONPATH = join(resolve(import.meta.dirname, ".."), "python");

// Never read a live instance: a shell inside an agent container exports its memory paths.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("REVERIE_")) delete process.env[key];
}

test("OpenCode hooks restore context, persist complete turns once, and compose developer briefs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-plugin-"));
  const oldEnv = { ...process.env };
  try {
    const root = resolve(import.meta.dirname, "..");
    Object.assign(process.env, { REVERIE_HOME: dir, REVERIE_DATA_DIR: join(dir, "data"), REVERIE_EMBED_URL: "" });
    await mkdir(join(dir, "data"));
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: "python3", source: join(root, "python") }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { ReveriePlugin } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    const logs = [];
    const messages = [
      {info: {id: "user1", role: "user"}, parts: [{type: "text", text: "Check the reverie"}]},
      {info: {id: "a1", role: "assistant", parentID: "user1", time: {completed: 1}},
        parts: [{type: "reasoning", text: "SECRET REASONING"}, {type: "text", text: "I checked the plan."}]},
      {info: {id: "a2", role: "assistant", parentID: "user1", time: {}}, parts: [{type: "text", text: "unfinished"}]},
    ];
    const hooks = await ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async (entry) => logs.push(entry) }, session: { messages: async () => ({data: messages}) } } });
    await hooks["chat.message"]({sessionID: "ses_test"}, {parts: [{type: "text", text: "Check the reverie"}]});
    const output = {system: []};
    await hooks["experimental.chat.system.transform"]({sessionID: "ses_test"}, output);
    assert.match(output.system[0], /persistent AI agent and expert/);
    assert.match(output.system[0], /Only explicit owner policy grants permissions/);
    assert.doesNotMatch(output.system[0], /You are the CTO|employee number one/);
    await hooks.event({event: {type: "session.idle", properties: {sessionID: "ses_test"}}});
    await hooks.event({event: {type: "session.idle", properties: {sessionID: "ses_test"}}});
    assert.deepEqual(logs, []);
    const recalled = JSON.parse(await hooks.tool.reverie_memory.execute({action: "recall", text: "reverie"}));
    assert.equal(recalled.filter((m) => m.kind === "episode").length, 1);
    assert.match(recalled[0].text, /I checked the plan/);
    assert.doesNotMatch(JSON.stringify(recalled), /SECRET REASONING|unfinished/);
    await hooks.tool.reverie_tools.execute({action: "profile", data: JSON.stringify({name: "reviewer-three", revision: 0,
      profile: {role: "Compiler developer", long_term: "Modelica lookup rules", short_term: "CI pending"}})});
    const brief = JSON.parse(await hooks.tool.reverie_tools.execute({action: "brief",
      data: JSON.stringify({names: ["reviewer-three"], task: "Check the compiler"})}));
    assert.match(brief, /CI pending/);
    assert.doesNotMatch(brief, /Modelica lookup rules/);
    const compact = {context: []};
    await hooks["experimental.session.compacting"]({sessionID: "ses_test"}, compact);
    assert.match(compact.context[0], /persistent AI agent and expert/);
    assert.match(compact.context[0], /Only explicit owner policy grants permissions/);
    assert.doesNotMatch(compact.context[0], /You are the CTO|employee number one/);
    await assert.rejects(hooks.tool.reverie_tools.execute({action: "plan", data: "[]"}));
    // Both product names use the work boundary; rebranding cannot expose private recall.
    for (const brand of ["Reverie"]) {
      await hooks["chat.message"]({sessionID: "ses_work"}, {parts: [{type: "text", text: `[${brand} chat "Reverie"] user: Review the task`}]});
      const work = {system: []};
      await hooks["experimental.chat.system.transform"]({sessionID: "ses_work"}, work);
      assert.match(work.system[0], /shared work channel/);
      assert.doesNotMatch(work.system[0], /Recent remembered exchanges|I checked the plan/);
    }
    // A synthetic continuation retains the last real user's shared scope after idle.
    const workText = '[Reverie chat "Project"] USER -> everyone: Check the requested fix';
    messages.push({info: {id: 'work_user', role: 'user'}, parts: [{type: 'text', text: workText}]});
    await hooks["chat.message"]({sessionID: "ses_work"}, {parts: [{type: "text", synthetic: true, text: "Continue"}]});
    const continued = {system: []};
    await hooks["experimental.chat.system.transform"]({sessionID: "ses_work"}, continued);
    assert.match(continued.system[0], /shared work channel/);
    const mixed = {messages: [...messages,
      {info: {id: 'continued_user', role: 'user'}, parts: [{type: 'text', synthetic: true, text: 'Continue'}]},
      {info: {id: 'continued_reply', role: 'assistant', parentID: 'continued_user'}, parts: [{type: 'text', text: 'A result'}]},
    ]};
    await hooks['experimental.chat.messages.transform']({}, mixed);
    assert.deepEqual(mixed.messages.map((m) => m.info.id), ['work_user', 'continued_user', 'continued_reply']);
    // A new Python process can recover the exact turn without any plugin RAM.
    const db = execFileSync("python3", ["-c", "from reverie.config import Config; from reverie.memory import MemoryStore; s=MemoryStore(Config().db_path); print(s.count('episode')); s.close()"], {cwd: root, encoding: "utf8"});
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
    await writeFile(bridge, NODE_SHEBANG +
      'const fs = require("node:fs"); let input = ""; process.stdin.on("data", part => input += part);\n' +
      'process.stdin.on("end", () => { fs.appendFileSync(process.env.REVERIE_TEST_REQUESTS, input + "\\n"); process.stdout.write("{}"); });\n', {mode: 0o700});
    Object.assign(process.env, { REVERIE_RESEARCH_CYCLE_ID: "research-cycle", REVERIE_TEST_REQUESTS: requests });
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: bridge, source: join(root, "python") }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { ReveriePlugin } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    let maintenance;
    globalThis.setInterval = (callback) => { maintenance = callback; return {unref() {}}; };
    let messageReads = 0;
    const logs = [];
    const hooks = await ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
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

test("A refused turn is logged and skipped, later turns still record, and each idle sends only new turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reverie-record-plugin-"));
  const oldEnv = { ...process.env };
  const originalInterval = globalThis.setInterval;
  try {
    const root = resolve(import.meta.dirname, "..");
    const requests = join(dir, "requests.jsonl");
    const bridge = join(dir, "bridge");
    await writeFile(bridge, NODE_SHEBANG +
      'const fs = require("node:fs"); let input = ""; process.stdin.on("data", part => input += part);\n' +
      'process.stdin.on("end", () => { const r = JSON.parse(input); fs.appendFileSync(process.env.REVERIE_TEST_REQUESTS, input + "\\n");\n' +
      '  if (r.action === "record" && r.reply.includes("REFUSE")) { process.stderr.write("reply crossed a hard floor"); process.exit(1); }\n' +
      '  if (r.action === "record" && r.reply.includes("FLAKY") && !process.env.REVERIE_TEST_FLAKY_OK) { process.stderr.write("database is locked"); process.exit(1); }\n' +
      '  process.stdout.write("{}"); });\n', {mode: 0o700});
    Object.assign(process.env, { REVERIE_TEST_REQUESTS: requests });
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: bridge, source: join(root, "python"), cycle_managed: true }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { ReveriePlugin } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    globalThis.setInterval = () => ({unref() {}});
    const turn = (id, reply) => [{info: {id, role: "user"}, parts: [{type: "text", text: "question " + id}]},
      {info: {id: id + "_a", role: "assistant", parentID: id, time: {completed: 1}}, parts: [{type: "text", text: reply}]}];
    const messages = [...turn("u1", "fine"), ...turn("u2", "REFUSE this"), ...turn("u3", "FLAKY once"), ...turn("u4", "also fine")];
    const logs = [];
    const hooks = await ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async (entry) => logs.push(entry.body.message) }, session: { messages: async () => ({data: messages}) } } });
    const records = async () => (await readFile(requests, "utf8")).trim().split("\n").map((l) => JSON.parse(l))
      .filter((r) => r.action === "record").map((r) => r.source_id.split(":").at(-1));
    const idle = () => hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}});

    await idle();
    assert.deepEqual(await records(), ["u1", "u2", "u3", "u4"]);              // u2 and u3 fail; u4 still records
    assert.equal(logs.length, 2);
    assert.match(logs[0], /hard floor/);
    process.env.REVERIE_TEST_FLAKY_OK = "1";
    messages.push(...turn("u5", "new turn"));
    await idle();
    assert.deepEqual((await records()).slice(4), ["u3", "u5"]);                 // only the retryable failure and the new turn
    await idle();
    assert.equal((await records()).length, 6);                                   // nothing left to send
  } finally {
    globalThis.setInterval = originalInterval;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("reverie_room targets the room a message came from, takes an explicit room, and never sends to one agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reverie-room-tool-"));
  const oldEnv = { ...process.env };
  const originalInterval = globalThis.setInterval;
  try {
    const root = resolve(import.meta.dirname, "..");
    const calls = join(dir, "calls.jsonl");
    const bin = join(dir, "bin"); await mkdir(bin);
    // A fake `reverie` CLI that records its arguments: the tool must pass --room, never run a shell.
    await writeFile(join(bin, "reverie"), NODE_SHEBANG +
      'require("node:fs").appendFileSync(process.env.REVERIE_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n"); process.stdout.write("ok");\n', {mode: 0o700});
    Object.assign(process.env, { PATH: bin + ":" + process.env.PATH, REVERIE_TEST_CALLS: calls, REVERIE_CYCLE_MANAGED: "1",
      REVERIE_HOME: dir, REVERIE_DATA_DIR: join(dir, "data"), REVERIE_EMBED_URL: "" });
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: "python3", source: join(root, "python") }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { ReveriePlugin } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    globalThis.setInterval = () => ({unref() {}});
    const hooks = await ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async () => {} }, session: { messages: async () => ({data: [
        {info: {role: "user"}, parts: [{type: "text", text: '[Reverie chat "lounge"] "Lead" -> everyone: "hi"'}]}]}) } } });
    const sent = async () => (await readFile(calls, "utf8")).trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    const deliver = (id, text, synthetic = false) => hooks["chat.message"]({sessionID: id}, {parts: [{type: "text", text, synthetic}]});
    const say = (id, args) => hooks.tool.reverie_room.execute({action: "say", text: "hello", ...args}, {sessionID: id});

    await deliver("s1", '[Reverie chat "lounge"] "Lead" -> everyone: "hi"');
    await say("s1", {});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--room", "lounge", "--", "hello"]);   // to everyone, that room
    await say("s1", {room: "ceo office"});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--room", "ceo office", "--", "hello"]);   // explicit wins
    await say("s1", {to: "user"});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--room", "lounge", "--", "hello"]);   // never a private post
    await say("s1", {to: "Lead"});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--room", "lounge", "--", "hello"]);
    await hooks.tool.reverie_room.execute({action: "read", text: ""}, {sessionID: "s1"});
    assert.deepEqual(await sent(), ["agent", "chat", "read", "--room", "lounge"]);
    await hooks.tool.reverie_room.execute({action: "status", text: "planning"}, {sessionID: "s1"});
    assert.deepEqual(await sent(), ["agent", "chat", "status", "--room", "lounge", "--progress", "planning"]);
    await deliver("s1", "continue", true);                                                              // a continuation keeps it
    await say("s1", {});
    assert.deepEqual((await sent()).slice(3, 5), ["--room", "lounge"]);
    await deliver("s1", '[Reverie chat "DM:00000002-0002-4000-8000-000000000002"] USER -> you: "hey"');
    await say("s1", {});
    assert.deepEqual((await sent()).slice(3, 5), ["--room", "00000002-0002-4000-8000-000000000002"]);   // a DM by its id
    await deliver("s1", '[Reverie chat "reverie platform", "lounge"] two rooms at once');
    await say("s1", {});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--", "hello"]);                           // ambiguous: CLI decides
    await deliver("s1", '[Reverie chat "a \\"quoted\\" room"] x');
    await say("s1", {});
    assert.deepEqual((await sent()).slice(3, 5), ["--room", 'a "quoted" room']);                       // JSON-quoted names decoded
    await deliver("s1", "a terminal turn, no room");
    await say("s1", {});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--", "hello"]);
    await deliver("s2", '[Reverie chat "other"] x');
    await say("s1", {});
    assert.deepEqual(await sent(), ["agent", "chat", "say", "--", "hello"]);                           // per session, not shared
  } finally {
    globalThis.setInterval = originalInterval;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Room guidance never tells an agent to address a single member", async () => {
  const root = resolve(import.meta.dirname, "..");
  for (const file of ["python/reverie/reverie.py", "python/reverie/skills/reverie/SKILL.md", "python/reverie/plugins/reverie.mjs"]) {
    assert.doesNotMatch(await readFile(join(root, file), "utf8"), /--to user|chat say --to/, file);
  }
});

test("The reply guard relays an unposted reply only to rooms the delivery named, once, marked automated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reverie-reply-guard-"));
  const oldEnv = { ...process.env };
  const originalInterval = globalThis.setInterval;
  const originalTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let elapsed = 0;
  // Await each timer's async relay, including its child process. Wall-clock
  // sleeps can observe the timer firing before that relay finishes on CI.
  const advance = async (ms) => {
    elapsed += ms;
    for (;;) {
      const due = [...timers].find(([, timer]) => timer.at <= elapsed);
      if (!due) return;
      timers.delete(due[0]);
      await due[1].run();
    }
  };
  try {
    const root = resolve(import.meta.dirname, "..");
    const calls = join(dir, "calls.jsonl");
    const bin = join(dir, "bin"); await mkdir(bin);
    await writeFile(join(bin, "reverie"), NODE_SHEBANG +
      'const args = process.argv.slice(2); require("node:fs").appendFileSync(process.env.REVERIE_TEST_CALLS, JSON.stringify(args) + "\\n");\n' +
      'if (args.includes("broken room")) { process.stderr.write("room unavailable"); process.exit(1); } process.stdout.write("ok");\n', {mode: 0o700});
    const bridge = join(dir, "bridge");
    await writeFile(bridge, NODE_SHEBANG + 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"));\n', {mode: 0o700});
    Object.assign(process.env, { PATH: bin + ":" + process.env.PATH, REVERIE_TEST_CALLS: calls });
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: bridge, source: join(root, "python"), cycle_managed: true, reply_guard: "post", reply_guard_grace_ms: 40, reply_guard_coding_ms: 400 }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { ReveriePlugin } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    globalThis.setInterval = () => ({unref() {}});
    globalThis.setTimeout = (callback, ms, ...args) => {
      const handle = { unref() {} };
      timers.set(handle, { at: elapsed + ms, run: () => callback(...args) });
      return handle;
    };
    globalThis.clearTimeout = (handle) => timers.delete(handle);
    const messages = [], logs = [];
    const hooks = await ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async (entry) => logs.push(entry.body.message) }, session: { messages: async () => ({data: messages}) } } });
    const posts = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const relays = async () => (await posts()).filter((a) => a.at(-1).startsWith("[automated - not the owner]"));
    const deliver = (text, synthetic = false) => {
      messages.push({info: {role: "user", time: {created: Date.now()}}, parts: [{type: "text", text, synthetic}]});
      return hooks["chat.message"]({sessionID: "s1"}, {parts: [{type: "text", text, synthetic}]});
    };
    const reply = (text, extra = {}) => messages.push({info: {role: "assistant", time: {created: Date.now()}, ...extra}, parts: [{type: "text", text}]});
    const say = (room, text = "posted") => hooks.tool.reverie_room.execute({action: "say", text, room}, {sessionID: "s1"});
    const idle = () => hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}});
    const busy = () => hooks.event({event: {type: "session.status", properties: {sessionID: "s1", status: {type: "busy"}}}});
    const settle = () => advance(120);

    // A two-room delivery answered in one room only: the other room gets the reply, marked automated.
    await deliver('[Reverie chat "lounge", "ceo office"] ["lounge"] USER -> everyone: "hi" | ["ceo office"] USER -> everyone: "new image"');
    await say("lounge");
    reply("Here is the full answer about the image.");
    await idle(); await settle();
    let out = await relays();
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].slice(0, 6), ["agent", "chat", "say", "--room", "ceo office", "--"]);
    assert.match(out[0].at(-1), /^\[automated - not the owner\] .*\nHere is the full answer about the image\.$/);
    await idle(); await settle();
    assert.equal((await relays()).length, 1);                                     // never twice

    // Rooms where only other agents spoke are never posted to on the agent's behalf.
    await deliver('[Reverie chat "lounge"] "Lead" -> everyone: "chatter" | "Peer" -> everyone: "more"');
    reply("No reply needed.");
    await idle(); await settle();
    await deliver('[Reverie chat "news", "rules"] ["news"] "Lead" -> everyone: "fyi" | ["rules"] USER -> everyone: "a question"');
    reply("The answer to the question.");
    await idle(); await settle();
    out = await relays();
    assert.equal(out.length, 2);
    assert.equal(out[1][4], "rules");
    messages.length = 0;

    // Answered in its room (any case): nothing is relayed. A terminal turn is never relayed.
    await deliver('[Reverie chat "Platform"] USER -> everyone: "status?"');
    await say("platform");
    reply("all green");
    await idle(); await settle();
    await deliver("a terminal question");
    reply("a terminal answer");
    await idle(); await settle();
    assert.equal((await relays()).length, 2);

    // A coding run: the first post does not cover the run; its end summary goes to the origin room only.
    await deliver('[Reverie chat "ceo office"] USER -> everyone: "update your image"');
    await say("ceo office", "switching to coding");
    reply("switching to coding");
    await idle();
    await busy();
    await deliver("[Reverie bounded coding continuation] Continue", true);
    reply("Profile image updated.");
    await idle(); await settle();
    out = await relays();
    assert.equal(out.length, 3);
    assert.equal(out[2][4], "ceo office");
    assert.match(out[2].at(-1), /\nProfile image updated\.$/);

    // A new real message inside the grace settles the previous turn first, with that turn's own text.
    await deliver('[Reverie chat "news"] USER -> everyone: "headline?"');
    reply("x".repeat(3000) + " the end");
    await idle();
    await deliver('[Reverie chat "lounge"] USER -> everyone: "next"');
    out = await relays();
    assert.equal(out.length, 4);
    assert.equal(out[3][4], "news");
    assert.ok(out[3].at(-1).length <= 1200 + 100);                                // capped
    assert.match(out[3].at(-1), /\n….* the end$/s);
    await say("lounge");

    // A coding run whose continuation starts long after the first idle still reports back (the grace race).
    const mode = (m) => hooks["tool.execute.after"]({tool: "interaction_mode", sessionID: "s1", callID: "c", args: {mode: m}}, {});
    const before = (await relays()).length;
    await deliver('[Reverie chat "ceo office"] USER -> everyone: "slow task"');
    await say("ceo office", "starting");
    await mode("coding");
    await idle(); await settle();                                                    // past the 40 ms grace: still open
    assert.equal((await relays()).length, before);
    await deliver("[Reverie bounded coding continuation] Continue", true);
    reply("Slow task finished.");
    await mode("chat");
    await idle(); await settle();
    out = await relays();
    assert.equal(out.length, before + 1);
    assert.equal(out.at(-1)[4], "ceo office");
    assert.match(out.at(-1).at(-1), /\nSlow task finished\.$/);
    // A coding run that never switches back still settles after the coding window.
    await deliver('[Reverie chat "ceo office"] USER -> everyone: "another"');
    await mode("coding");
    reply("Working on it.");
    await idle(); await settle();
    assert.equal((await relays()).length, before + 1);
    await advance(450);
    assert.equal((await relays()).length, before + 2);

    // A direct message the agent answered only in its pane is relayed back into that same DM.
    await deliver('[Reverie chat "DM:abc123"] USER -> you: "a private question"');
    reply("A private answer.");
    await idle(); await settle();
    out = await relays();
    assert.equal(out.length, before + 3);
    assert.equal(out.at(-1)[4], "abc123");

    // An errored turn relays nothing, and a failing post is logged, never thrown.
    await deliver('[Reverie chat "rules"] USER -> everyone: "q"');
    reply("partial", {error: {name: "MessageAbortedError"}});
    await idle(); await settle();
    assert.equal((await relays()).length, before + 3);
    await deliver('[Reverie chat "broken room"] USER -> everyone: "q"');
    reply("an answer");
    await idle(); await settle();
    await deliver("a terminal message");                                           // does not throw
    assert.ok(logs.some((l) => /room unavailable/.test(l)));
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Delivery-format contract, DM privacy, the turn clock and the web taint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reverie-dm-clock-"));
  const oldEnv = { ...process.env };
  const originalInterval = globalThis.setInterval;
  const RealDate = globalThis.Date;
  try {
    const root = resolve(import.meta.dirname, "..");
    const calls = join(dir, "calls.jsonl");
    const bin = join(dir, "bin"); await mkdir(bin);
    await writeFile(join(bin, "reverie"), NODE_SHEBANG +
      'require("node:fs").appendFileSync(process.env.REVERIE_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n"); process.stdout.write("ok");\n', {mode: 0o700});
    const bridge = join(dir, "bridge");
    await writeFile(bridge, NODE_SHEBANG + 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("\\"context\\""));\n', {mode: 0o700});
    Object.assign(process.env, { PATH: bin + ":" + process.env.PATH, REVERIE_TEST_CALLS: calls });
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: bridge, source: join(root, "python"), cycle_managed: true,
      reply_guard: "post", reply_guard_grace_ms: 40, reply_guard_coding_ms: 400, timezone: "America/New_York" }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});')
      + "\nexport { roomsOf, ownerRoomsOf, channelOf, clockLine };\n";   // test-only exports
    const plugin = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

    // 1) The fixture rendered by the console's real renderer parses as expected; in the container the two copies must match.
    const fixture = JSON.parse(await readFile(join(root, "tests/fixtures/delivery-lines.json"), "utf8"));
    assert.ok(fixture.length >= 5);
    for (const c of fixture) {
      assert.deepEqual(plugin.roomsOf(c.line), c.expect.rooms, c.case);
      assert.deepEqual(plugin.ownerRoomsOf(c.line), c.expect.ownerRooms, c.case);
      assert.equal(plugin.channelOf(c.line), c.expect.channel, c.case);
    }
    const consoleFixture = join(process.env.REVERIE_CONSOLE_DIR ?? "/opt/reverie/apps/web", "test/fixtures/delivery-lines.json");
    const installed = await readFile(consoleFixture, "utf8").catch(() => null);
    if (installed !== null) assert.deepEqual(JSON.parse(installed), fixture, "console and harness fixtures drifted apart");
    // A DM delivered under its label (older consoles) is private, never work.
    assert.equal(plugin.channelOf('[Reverie chat "Direct message"] USER: "hi"'), "private:dm");

    // 2) The clock is computed on every call, never cached.
    assert.match(plugin.clockLine(new RealDate("2026-10-17T14:31:00Z"), "America/New_York"), /Saturday, 10\/17\/2026, 10:31 EDT; Saturday, 10\/17\/2026, 14:31 UTC/);
    assert.match(plugin.clockLine(new RealDate("2026-10-17T14:31:00Z")), /^Current time: Saturday, 10\/17\/2026, 14:31 UTC\.$/);
    globalThis.setInterval = () => ({unref() {}});
    const messages = [];
    const hooks = await plugin.ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async () => {} }, session: { messages: async () => ({data: messages}) } } });
    const system = async () => { const out = {system: ["base"]}; await hooks["experimental.chat.system.transform"]({sessionID: "s1"}, out); return out.system[0]; };
    const first = await system();
    assert.match(first, /Current time: .*EDT; .*UTC\./);
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ["2027-01-04T09:00:00Z"])); } static now() { return new RealDate("2027-01-04T09:00:00Z").getTime(); } };
    assert.match(await system(), /Monday, 01\/04\/2027, 04:00 EST; Monday, 01\/04\/2027, 09:00 UTC/);   // fresh each turn
    globalThis.Date = RealDate;

    // 3) The guard arms on the real owner form ('USER: "..."') and relays a pane-only DM answer into that DM by id.
    const posts = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const relays = async () => (await posts()).filter((a) => /\[automated - not the owner\]/.test(a.at(-1)));
    const deliver = (text) => {
      messages.push({info: {role: "user", time: {created: Date.now()}}, parts: [{type: "text", text}]});
      return hooks["chat.message"]({sessionID: "s1"}, {parts: [{type: "text", text}]});
    };
    const reply = (text) => messages.push({info: {role: "assistant", time: {created: Date.now()}}, parts: [{type: "text", text}]});
    const idle = () => hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}});
    const settle = () => new Promise((done) => setTimeout(done, 120));
    // The relay runs a CLI process; under load it can take longer than one settle, so wait for the expected count.
    const relaysNow = async (n) => {
      for (let i = 0; i < 50 && (await relays()).length < n; i++) await settle();
      return relays();
    };
    const dmLine = fixture.find((c) => c.expect.channel.startsWith("private:")).line;
    const dmId = fixture.find((c) => c.expect.channel.startsWith("private:")).expect.rooms[0];
    await deliver(dmLine);
    reply("A private answer.");
    await idle();
    let out = await relaysNow(1);
    assert.equal(out.length, 1);
    assert.equal(out[0][4], dmId);
    await deliver(fixture.find((c) => c.case === "owner to the whole room").line);
    reply("The headline is X.");
    await idle();
    out = await relaysNow(2);
    assert.equal(out.length, 2);
    assert.equal(out[1][4], "news");

    // 4) Web taint: a turn that searched may not switch to coding; its posts and its relay carry [web]; the query is logged.
    await deliver('[Reverie chat "news"] USER: "find the release notes"');
    await hooks["tool.execute.after"]({tool: "websearch", sessionID: "s1", callID: "w", args: {query: "release notes"}}, {});
    await assert.rejects(hooks["tool.execute.before"]({tool: "interaction_mode", sessionID: "s1"}, {args: {mode: "coding"}}), /web results/);
    await hooks["tool.execute.before"]({tool: "interaction_mode", sessionID: "s1"}, {args: {mode: "chat"}});   // chat stays allowed
    for (const [tool, args] of [["bash", {command: "curl -s -X POST $API/api/cron/jobs -d @job.json"}],
        ["bash", {command: 'p=/api/cr; curl -X POST "$API${p}on/jobs"'}],   // split string: refused all the same
        ["bash", {command: "ls"}], ["routine_create", {}], ["task", {prompt: "x"}]])
      await assert.rejects(hooks["tool.execute.before"]({tool, sessionID: "s1"}, {args}), /shell, subagent and routine/);
    await hooks["tool.execute.before"]({tool: "read", sessionID: "s1"}, {args: {filePath: "notes.md"}});   // other tools still work
    await hooks.tool.reverie_room.execute({action: "say", text: "found it", room: "rules"}, {sessionID: "s1"});
    assert.equal((await posts()).at(-1).at(-1), "[web] found it");
    reply("Here are the notes.");
    await idle();
    assert.match((await relaysNow(3)).at(-1).at(-1), /\n\[web\] Here are the notes\.$/);
    const logged = (await readFile(join(dir, ".reverie-web-log.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(logged.map((e) => [e.tool, e.query, e.room]), [["websearch", "release notes", "news"]]);
    assert.equal((await stat(join(dir, ".reverie-web-log.jsonl"))).mode & 0o777, 0o600);
    await deliver('[Reverie chat "news"] USER: "now update the file"');                  // a new real message clears it
    await hooks["tool.execute.before"]({tool: "interaction_mode", sessionID: "s1"}, {args: {mode: "coding"}});
    await hooks["tool.execute.before"]({tool: "bash", sessionID: "s1"}, {args: {command: "curl $API/api/cron/jobs"}});
  } finally {
    globalThis.Date = RealDate;
    globalThis.setInterval = originalInterval;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("By default the reply guard logs an unposted final text instead of posting it, and a short DM id counts as the DM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reverie-reply-log-"));
  const oldEnv = { ...process.env };
  const originalInterval = globalThis.setInterval;
  try {
    const root = resolve(import.meta.dirname, "..");
    const calls = join(dir, "calls.jsonl");
    const bin = join(dir, "bin"); await mkdir(bin);
    await writeFile(join(bin, "reverie"), NODE_SHEBANG +
      'require("node:fs").appendFileSync(process.env.REVERIE_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n"); process.stdout.write("ok");\n', {mode: 0o700});
    const bridge = join(dir, "bridge");
    await writeFile(bridge, NODE_SHEBANG + 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}"));\n', {mode: 0o700});
    Object.assign(process.env, { PATH: bin + ":" + process.env.PATH, REVERIE_TEST_CALLS: calls });
    await writeFile(join(dir, ".reverie-instance"), JSON.stringify({ python: bridge, source: join(root, "python"), cycle_managed: true, reply_guard_grace_ms: 40, reply_guard_coding_ms: 400 }));
    const source = (await readFile(join(root, "python/reverie/plugins/reverie.mjs"), "utf8")).replace(
      'import { tool } from "@opencode-ai/plugin";',
      'const tool = Object.assign((definition) => definition, {schema: {string: () => ({describe() {return this}, optional() {return this}}), enum: () => ({})}});');
    const { ReveriePlugin } = await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    globalThis.setInterval = () => ({unref() {}});
    const messages = [];
    const hooks = await ReveriePlugin({ directory: dir, serverUrl: new URL("http://127.0.0.1:1234"),
      client: { app: { log: async () => {} }, session: { messages: async () => ({data: messages}) } } });
    const posts = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const relayed = async () => (await posts()).filter((a) => /\[automated - not the owner\]/.test(a.at(-1)));
    const logged = async () => (await readFile(join(dir, ".reverie-relay-log.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const deliver = (text) => {
      messages.push({info: {role: "user", time: {created: Date.now()}}, parts: [{type: "text", text}]});
      return hooks["chat.message"]({sessionID: "s1"}, {parts: [{type: "text", text}]});
    };
    const reply = (text) => messages.push({info: {role: "assistant", time: {created: Date.now()}}, parts: [{type: "text", text}]});
    const say = (room) => hooks.tool.reverie_room.execute({action: "say", text: "the reply", room}, {sessionID: "s1"});
    const idle = () => hooks.event({event: {type: "session.idle", properties: {sessionID: "s1"}}});
    const settle = () => new Promise((done) => setTimeout(done, 120));
    const dm = "000000ab-0003-4000-8000-000000000003";

    // A reply goes to the DM under its short id, then a note to self ends the turn. Nothing extra
    // is posted and nothing is logged, for the short id, DM:<id> and a differently cased id alike.
    for (const name of [dm.slice(0, 8), `DM:${dm}`, dm.toUpperCase()]) {
      await deliver(`[Reverie chat "DM:${dm}"] USER: "hey"`);
      await say(name);
      reply("I'm staying in chat mode with owner. Waiting for their next message.");
      await idle(); await settle();
    }
    assert.equal((await relayed()).length, 0);
    assert.equal((await logged()).length, 0);

    // A shorter prefix or another id's prefix does not count, and the unposted final text is logged, never posted.
    await deliver(`[Reverie chat "DM:${dm}"] USER: "still there?"`);
    await say(dm.slice(0, 4));
    reply("Note to self: no reply needed.");
    await idle(); await settle();
    await deliver('[Reverie chat "reverie"] USER: "a report about assistant"');
    reply("I'm staying in chat mode with owner.");
    await idle(); await settle();
    assert.equal((await relayed()).length, 0);
    const entries = await logged();
    assert.deepEqual(entries.map((e) => e.rooms), [[dm], ["reverie"]]);
    assert.equal(entries[1].text, "I'm staying in chat mode with owner.");
    assert.equal(entries[0].session, "s1");
    assert.equal(((await stat(join(dir, ".reverie-relay-log.jsonl"))).mode & 0o777), 0o600);
  } finally {
    globalThis.setInterval = originalInterval;
    process.env = oldEnv;
    await rm(dir, { recursive: true, force: true });
  }
});
