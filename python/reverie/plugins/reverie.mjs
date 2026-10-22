import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
// Runtime settings use REVERIE_* environment variables.
const envName = (suffix) => process.env[`REVERIE_${suffix}`];

// Every room a delivery names: `[Reverie chat "<room>", ...]` (names are JSON-quoted); a DM is its id.
const roomsOf = (text = "") => {
  const header = /^\[Reverie chat ((?:"(?:[^"\\]|\\.)*"(?:, )?)+)\]/.exec(text);
  if (!header) return [];
  let names;
  try { names = [...header[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)); } catch { return []; }
  return names.map((name) => /^DM:([a-f0-9-]+)$/.exec(name)?.[1] ?? name);
};
// The rooms in which the owner spoke in this delivery; only these may receive an automatic relay, so a room
// where the agent chose to stay silent among other agents is never posted to on its behalf.
const ownerRoomsOf = (text = "") => {
  const rooms = roomsOf(text);
  // An owner line is unquoted `USER: "..."` (to everyone) or `USER -> who: "..."` (addressed): both count.
  if (rooms.length === 1) return /(?:^\[Reverie chat "(?:[^"\\]|\\.)*"\]| \|) USER(?: -> |: )/.test(text) ? rooms : [];
  let spoken;
  try {
    spoken = [...text.matchAll(/(?:\] |\| )\["((?:[^"\\]|\\.)*)"\] USER(?: -> |: )/g)]
      .map((m) => JSON.parse(`"${m[1]}"`)).map((name) => /^DM:([a-f0-9-]+)$/.exec(name)?.[1] ?? name);
  } catch { return []; }
  return rooms.filter((name) => spoken.includes(name));
};
// The one room a delivery came from. A delivery that names several rooms gives no single room, so the agent must name one.
const roomOf = (text = "") => {
  const names = roomsOf(text);
  return names.length === 1 ? names[0] : null;
};

const channelOf = (text = "") => {
  if (envName("CYCLE_CHANNEL") === "work") return "work";
  const dm = /^\[Reverie chat "DM:([a-f0-9-]+)"\]/.exec(text);
  if (dm) return `private:${dm[1]}`;
  // A direct message delivered under its label (consoles before the DM:<id> header) is still private, never work.
  if (/^\[Reverie chat "(?:Direct|Group) message"\]/.test(text)) return "private:dm";
  if (/^\[Reverie chat/.test(text) || text.startsWith("Shared-room voice turn:")) return "work";
  return "private:terminal";
};

// The current time, computed on every call (never cached at session start): a local model gets no clock otherwise.
// Not exported: OpenCode treats every export of a plugin file as a plugin initializer.
const clockLine = (now = new Date(), timeZone) => {
  const fmt = (zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).format(now);
  let local = "";
  if (timeZone) { try { local = fmt(timeZone) + "; "; } catch { local = ""; } }
  return `Current time: ${local}${fmt("UTC")}.`;
};

// All requests go over stdin. Conversation text is never interpolated into a shell.
export const ReveriePlugin = async ({ client, directory, serverUrl }) => {
  const researchCycle = envName("RESEARCH_CYCLE_ID");
  const settings = JSON.parse(await readFile(join(directory, ".reverie-instance"), "utf8"));
  const bridge = (request) => new Promise((resolve, reject) => {
    const child = execFile(settings.python, ["-m", "reverie.opencode"], {
      cwd: settings.source,
      env: { ...process.env, PYTHONPATH: settings.source,
        ...(settings.instance ? { REVERIE_INSTANCE_CONFIG: settings.instance } : {}) },
      timeout: request.action === "maintenance" ? 120000 : 60000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message));
      try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request));
  });
  const log = async (message) => {
    await client.app.log({ body: { service: "reverie", level: "error", message: String(message) } });
  };
  const queries = new Map();
  const active = new Set();
  let maintaining = false;
  const maintain = async () => {
    if (researchCycle || maintaining || active.size) return;
    maintaining = true;
    try { await bridge({ action: "maintenance" }); } catch (error) { await log(error); }
    finally { maintaining = false; }
  };
  const timer = (settings.cycle_managed === true || envName("CYCLE_MANAGED") === "1") ? null : setInterval(maintain, 60000);
  timer?.unref();
  const lastRoom = new Map();
  const settled = new Map(); // session -> turn ids already recorded or refused; a restart re-sends, and records are idempotent
  // Reply guard. A room the delivery named that got no post from the turn has the turn's final text recorded in
  // .reverie-relay-log.jsonl once the session has stayed idle past any coding continuation; a coding run reports again
  // to its origin rooms. Final text is often a note to self, not a reply, so it is only POSTED (marked automated) when
  // the instance sets reply_guard: "post". It only ever concerns rooms the delivery named; failures are logged, never thrown.
  const AUTOMATED = "[automated - not the owner] Relayed reply (the agent did not post it to this room):";
  const relayLog = join(directory, ".reverie-relay-log.jsonl");
  // A post counts for a delivered room under any name the room tool accepts: the same name, DM:<id>, or an id
  // prefix of at least 8 characters (an agent often shortens 000000ab-0003-... to 000000ab).
  const roomKey = (name) => String(name).trim().toLowerCase().replace(/^dm:/, "");
  const sameRoom = (delivered, posted) => {
    const a = roomKey(delivered), b = roomKey(posted);
    return a === b || (/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(a) && /^[0-9a-f-]{8,}$/.test(b) && a.startsWith(b));
  };
  const RELAY_CHARS = 1200;
  const graceMs = Number.isFinite(settings.reply_guard_grace_ms) ? settings.reply_guard_grace_ms : 75000;
  // While a coding run is open its continuations may start long after an idle; wait out the whole coding
  // window (at most 15 minutes) before settling, so a slow run still reports back to its origin rooms.
  const codingMs = Number.isFinite(settings.reply_guard_coding_ms) ? settings.reply_guard_coding_ms : 960000;
  const guards = new Map(), guardTimers = new Map();
  // Web taint: a turn that used web results may not switch to coding mode, and its room posts carry a marker. A new
  // real message clears it; continuations keep it. Searches and fetches are logged (time, tool, query or url, room).
  const WEB_TOOLS = new Set(["websearch", "webfetch"]);
  const WEB_MARK = "[web] ";
  const tainted = new Set();
  // While tainted: no shell at all (a page can build a command from parts, so matching its text is not enough), no
  // subagent (its own session would not carry the taint), and no tool whose name says cron or routine.
  const ROUTINE = /cron|routine|chat-bots/i;
  const taintRefused = (name) => name === "bash" || name === "task" || ROUTINE.test(name);
  const webLog = join(directory, ".reverie-web-log.jsonl");
  const cancelGuard = (id) => { clearTimeout(guardTimers.get(id)); guardTimers.delete(id); };
  const flushGuard = async (id) => {
    cancelGuard(id);
    const guard = guards.get(id);
    guards.delete(id);
    if (!guard || settings.reply_guard === false) return;
    try {
      const missing = guard.rooms.filter((name) => ![...guard.posted].some((posted) => sameRoom(name, posted)));
      if (!missing.length) return;
      const result = await client.session.messages({ path: { id } });
      if (result.error) throw new Error(JSON.stringify(result.error));
      const text = (result.data ?? []).filter((m) => m.info.role === "assistant" && !m.info.error && !m.info.summary &&
          (m.info.time?.created ?? 0) >= guard.since)
        .flatMap((m) => m.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text))
        .join("\n").trim();
      if (!text) return;
      const body = (guard.web ? WEB_MARK : "") + (text.length > RELAY_CHARS ? "…" + text.slice(-RELAY_CHARS) : text);
      if (settings.reply_guard !== "post") {
        await appendFile(relayLog, JSON.stringify({ at: new Date().toISOString(), session: id, rooms: missing, text: body }) + "\n",
          { mode: 0o600 });
        return;
      }
      for (const name of missing) await room(["say", "--room", name, "--", `${AUTOMATED}\n${body}`]);
    } catch (error) { await log(error).catch(() => {}); }
  };
  const room = (args) => new Promise((resolve, reject) => {
    execFile("reverie", ["agent", "chat", ...args], {timeout: 30000, maxBuffer: 1024 * 1024},
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout));
  });

  const saveTurn = async (sessionID) => {
    if (researchCycle) return; // Research is curated separately from private conversation history.
    // Read durable SDK messages, including after a restart. Never store reasoning/tool text.
    const result = await client.session.messages({ path: { id: sessionID } });
    if (result.error) throw new Error(JSON.stringify(result.error));
    const messages = result.data ?? [];
    const users = new Map(messages.filter((m) => m.info.role === "user").map((m) => [m.info.id, m]));
    const groups = new Map();
    for (const message of messages) {
      const info = message.info;
      if (info.role !== "assistant" || !info.time?.completed || info.error || info.summary) continue;
      const user = users.get(info.parentID);
      if (!user) continue;
      const text = message.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text).join("\n").trim();
      if (text) groups.set(info.parentID, [...(groups.get(info.parentID) ?? []), text]);
    }
    const done = settled.get(sessionID) ?? new Set();
    settled.set(sessionID, done);
    for (const [parentID, replies] of groups) {
      if (done.has(parentID)) continue;
      const user = users.get(parentID);
      const text = user.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text).join("\n");
      if (!text.trim()) { done.add(parentID); continue; }
      try {
        await bridge({ action: "record", source_id: `opencode:${sessionID}:${parentID}`,
          user: text, reply: replies.join("\n\n"), visibility: channelOf(text) === "work" ? "project" : "private" });
        done.add(parentID);
      } catch (error) {
        // One refused turn must not block the turns after it. A floor refusal is final; anything else retries next idle.
        if (/hard floor|requires input and reply/.test(error.message)) done.add(parentID);
        await log(error);
      }
    }
  };

  return {
    "chat.message": async (input, output) => {
      let text = output.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
      const continuation = !text && output.parts.some((p) => p.synthetic);
      if (!text && output.parts.some((p) => p.synthetic)) {
        // A continuation keeps its real user's scope, including after an idle hook cleared RAM.
        const result = await client.session.messages({ path: { id: input.sessionID } });
        if (result.error) throw new Error("Cannot establish continuation context scope");
        const previous = (result.data ?? []).filter((m) => m.info.role === "user" &&
          m.parts.some((p) => p.type === "text" && !p.synthetic)).at(-1);
        if (!previous) throw new Error("Continuation requires a real user context");
        text = previous.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
      }
      queries.set(input.sessionID, text);
      // Remember the room of the latest real delivery (a continuation reuses that real message's text above);
      // a terminal turn or a multi-room delivery clears it, so the agent must name a room.
      const deliveredRoom = roomOf(text);
      if (deliveredRoom) lastRoom.set(input.sessionID, deliveredRoom); else lastRoom.delete(input.sessionID);
      try {
        cancelGuard(input.sessionID);
        const guard = guards.get(input.sessionID);
        if (continuation) {
          if (guard) guards.set(input.sessionID, { ...guard, posted: new Set(), since: Date.now() });
        } else {
          tainted.delete(input.sessionID);
          await flushGuard(input.sessionID); // a new real message first settles the previous turn
          const rooms = ownerRoomsOf(text);
          if (rooms.length) guards.set(input.sessionID, { rooms, posted: new Set(), since: Date.now() });
        }
      } catch (error) { await log(error).catch(() => {}); }
      active.add(input.sessionID);
      await bridge({ action: "activity", ...(researchCycle ? { research_cycle_id: researchCycle } : { runtime: {
        url: String(serverUrl), session_id: input.sessionID, directory,
      } }) });
    },
    "experimental.chat.system.transform": async (input, output) => {
      const query = queries.get(input.sessionID) ?? "reverie priorities decisions";
      const context = await bridge({ action: "context", query,
        ...(input.model?.limit?.context ? {context_window: input.model.limit.context,
          output_tokens: input.model.limit.output ?? 4096,
          occupied_tokens: Buffer.byteLength([...output.system, query].join("\n"), "utf8")} : {}),
        channel: channelOf(query) === "work" ? "work" : "private" });
      // Local Qwen templates accept a single leading system message.
      output.system.splice(0, output.system.length, [...output.system, context, clockLine(new Date(), settings.timezone)].join("\n\n"));
    },
    "experimental.chat.messages.transform": async (_, output) => {
      const users = output.messages.filter((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && !p.synthetic));
      const latest = users.at(-1);
      if (!latest) return;
      const textOf = (m) => m.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
      const channel = channelOf(textOf(latest));
      let inherited = "private:terminal";
      const allowed = new Set();
      for (const message of output.messages) {
        if (message.info.role !== "user") continue;
        const real = message.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
        if (real) inherited = channelOf(real);
        if (inherited === channel) allowed.add(message.info.id);
      }
      output.messages = output.messages.filter((m) => !m.info.summary &&
        (m.info.role === "user" ? allowed.has(m.info.id) : allowed.has(m.info.parentID)));
    },
    "experimental.session.compacting": async (input, output) => {
      const query = queries.get(input.sessionID) ?? "reverie handoff";
      output.context.push(await bridge({ action: "context", query, channel: channelOf(query) === "work" ? "work" : "private" }));
    },
    "tool.execute.after": async (input) => {
      if (WEB_TOOLS.has(input.tool)) {
        tainted.add(input.sessionID);
        const guard = guards.get(input.sessionID);
        if (guard) guard.web = true;
        const entry = { at: new Date().toISOString(), tool: input.tool, query: String(input.args?.query ?? input.args?.url ?? "").slice(0, 300),
          room: lastRoom.get(input.sessionID) ?? null };
        await appendFile(webLog, JSON.stringify(entry) + "\n", { mode: 0o600 }).catch(async (error) => { await log(error).catch(() => {}); });
      }
      // A successful mode switch: a coding run keeps the reply guard open until it switches back to chat.
      const guard = input.tool === "interaction_mode" && guards.get(input.sessionID);
      if (guard && ["coding", "chat"].includes(input.args?.mode)) guard.coding = input.args.mode === "coding";
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool === "interaction_mode" && output.args?.mode === "coding" && tainted.has(input.sessionID))
        throw new Error("This turn used web results; switching to coding mode is refused until the next message.");
      if (tainted.has(input.sessionID) && taintRefused(input.tool))
        throw new Error("This turn used web results; shell, subagent and routine/cron tools are refused until the next message.");
      const mode = await bridge({action: "mode"});
      if (mode.mode !== "vacation") return;
      if (input.tool === "reverie_memory") return;
      if (input.tool === "reverie_room" && (["read", "who", "status", "rooms"].includes(output.args.action) ||
          output.args.action === "say")) return;
      if (input.tool === "reverie_tools" && ["self", "self_vote", "self_history", "rules", "votes", "publication_proposal",
          "profiles", "return", "vacation"].includes(output.args.action)) return;
      throw new Error("This agent is on vacation; project work and worker instructions are disabled. Discuss returning with the owner.");
    },
    event: async ({ event }) => {
      const sessionID = event.properties?.sessionID;
      if (event.type === "session.status" && sessionID && event.properties.status?.type !== "idle") {
        active.add(sessionID);
        cancelGuard(sessionID);
      }
      if (event.type === "session.idle" && sessionID && guards.has(sessionID)) {
        cancelGuard(sessionID);
        const timer = setTimeout(() => flushGuard(sessionID), guards.get(sessionID).coding ? codingMs : graceMs);
        timer.unref?.();
        guardTimers.set(sessionID, timer);
      }
      if (event.type === "session.idle" && sessionID) {
        try { await saveTurn(sessionID); } catch (error) { await log(error); }
        finally { active.delete(sessionID); queries.delete(sessionID); }
      }
      if (event.type === "session.error" && sessionID) active.delete(sessionID);
    },
    tool: {
      reverie_memory: tool({
        description: "Recall this agent's durable memories (dreams are labelled imagination), or save a verified fact/handoff.",
        args: { action: tool.schema.enum(["recall", "remember"]), text: tool.schema.string(),
          project: tool.schema.string().describe("Project identifier for shared memory; empty for your private store"),
          source: tool.schema.string().describe("Verification source for project writes; empty for recall") },
        execute: async ({ action, text, project, source }, context = {}) => JSON.stringify(await bridge({
          action, query: text, text, project, source, channel: channelOf(queries.get(context.sessionID)) === "work" ? "work" : "private" })),
      }),
      reverie_tools: tool({
        description: "Read/save the reverie plan, list/save developer histories, or compose a bounded worker brief. " +
          "plan save: {text,revision}; profile save: {name,profile:{role,long_term,short_term,memory_queries},revision}; " +
          "brief: {names:[developer names],task,budget?,context_window?,output_tokens?,occupied_tokens?,context?:{acceptance:[],constraints:[],findings:[],files:[],tools:[],memory_queries:[]}}; self reads with {}, saves with " +
          "{model:{persona,consciousness,directives:[statements]},reason,revision}. Your persona and commitments are revisable; explain changes. " +
          "Core changes: self_vote {model:{consciousness,directives},reason}, three consecutive weekly votes. " +
          "vacation: {reason,handoff} casts a weekly vote; three consecutive weeks archive history and stop project work. " +
          "publication_proposal: {proposal,reason} casts a weekly vote; after three weeks ask the owner to review; never uploads. " +
          "rules, votes, self_history: {} read rules, ballots and previous self-models. " +
          "return: {} asks the owner to confirm a return to work, then requires a fresh reverie handoff. " +
          "Reread after a revision conflict. The brief is input for reverie agent spawn/send.",
        args: { action: tool.schema.enum(["plan", "profiles", "profile", "brief", "self", "self_vote", "self_history",
          "rules", "votes", "publication_proposal", "vacation", "return"]),
          data: tool.schema.string().describe("JSON object of arguments; use {} for reads") },
        execute: async ({ action, data }, context) => {
          const args = JSON.parse(data);
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("data must be a JSON object");
          if (action === "return") await context.ask({permission: "reverie_return", patterns: ["return to reverie work"],
            always: [], metadata: {reason: "Resume project authority after vacation; review current reverie state first"}});
          return JSON.stringify(await bridge({ ...args, action }));
        },
      }),
      reverie_room: tool({
        description: "Read a room's history and members, update your own status, list your rooms, or post a message to everyone in a room. " +
          "room: the room's name (as in the [Reverie chat \"...\"] header); defaults to the room the latest message came from. " +
          "Every post goes to everyone in the room; @mention the member you need, including the owner. No shell execution.",
        args: {action: tool.schema.enum(["read", "who", "status", "say", "rooms"]), text: tool.schema.string().optional(),
          room: tool.schema.string().optional()},
        // No addressee: a post to one member hides it from the others' panes. Older turns may still pass `to`; it is ignored.
        execute: async ({action, text = "", room: named}, context = {}) => {
          if ((action === "say" || action === "status") && !text) throw new Error("text is required for " + action);
          if (text.length > 5000) throw new Error("Keep room messages under 5000 characters");
          const target = (typeof named === "string" && named.trim()) || lastRoom.get(context.sessionID);
          const where = target ? ["--room", target] : [];
          if (action === "say") {
            const posted = await room(["say", ...where, "--", (tainted.has(context.sessionID) ? WEB_MARK : "") + text]);
            if (target) guards.get(context.sessionID)?.posted.add(target.toLowerCase());
            return posted;
          }
          if (action === "status") return room(["status", ...where, "--progress", text]);
          if (action === "rooms") return room(["rooms"]);
          return room([action, ...where]);
        },
      }),
    },
  };
};
