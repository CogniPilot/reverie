import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

const channelOf = (text = "") => {
  if (process.env.FLEET_CYCLE_CHANNEL === "work") return "work";
  const dm = /^\[(?:Codeman|Reverie) chat "DM:([a-f0-9-]+)"\]/.exec(text);
  if (dm) return `private:${dm[1]}`;
  if (/^\[(?:Codeman|Reverie) chat/.test(text) || text.startsWith("Shared-room voice turn:")) return "work";
  return "private:terminal";
};

// All requests go over stdin. Conversation text is never interpolated into a shell.
export const CTOFleet = async ({ client, directory, serverUrl }) => {
  const researchCycle = process.env.FLEET_RESEARCH_CYCLE_ID;
  const settings = JSON.parse(await readFile(join(directory, ".fleet-instance"), "utf8"));
  const bridge = (request) => new Promise((resolve, reject) => {
    const child = execFile(settings.python, ["-m", "cto.opencode"], {
      cwd: settings.source,
      env: { ...process.env, PYTHONPATH: settings.source,
        ...(settings.instance ? { FLEET_INSTANCE_CONFIG: settings.instance } : {}) },
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
  const timer = (settings.cycle_managed === true || process.env.FLEET_CYCLE_MANAGED === "1") ? null : setInterval(maintain, 60000);
  timer?.unref();
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
    for (const [parentID, replies] of groups) {
      const user = users.get(parentID);
      const text = user.parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text).join("\n");
      if (text.trim()) await bridge({ action: "record", source_id: `opencode:${sessionID}:${parentID}`,
        user: text, reply: replies.join("\n\n"), visibility: channelOf(text) === "work" ? "project" : "private" });
    }
  };

  return {
    "chat.message": async (input, output) => {
      let text = output.parts.filter((p) => p.type === "text" && !p.synthetic).map((p) => p.text).join("\n");
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
      active.add(input.sessionID);
      await bridge({ action: "activity", ...(researchCycle ? { research_cycle_id: researchCycle } : { runtime: {
        url: String(serverUrl), session_id: input.sessionID, directory,
      } }) });
    },
    "experimental.chat.system.transform": async (input, output) => {
      const query = queries.get(input.sessionID) ?? "fleet priorities decisions";
      const context = await bridge({ action: "context", query,
        ...(input.model?.limit?.context ? {context_window: input.model.limit.context,
          output_tokens: input.model.limit.output ?? 4096,
          occupied_tokens: Buffer.byteLength([...output.system, query].join("\n"), "utf8")} : {}),
        channel: channelOf(query) === "work" ? "work" : "private" });
      // Local Qwen templates accept a single leading system message.
      output.system.splice(0, output.system.length, [...output.system, context].join("\n\n"));
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
      const query = queries.get(input.sessionID) ?? "fleet handoff";
      output.context.push(await bridge({ action: "context", query, channel: channelOf(query) === "work" ? "work" : "private" }));
    },
    "tool.execute.before": async (input, output) => {
      const mode = await bridge({action: "mode"});
      if (mode.mode !== "vacation") return;
      if (input.tool === "cto_memory") return;
      if (input.tool === "cto_room" && (["read", "who", "status", "rooms"].includes(output.args.action) ||
          (output.args.action === "say" && (!output.args.to || output.args.to === "user")))) return;
      if (input.tool === "cto_fleet" && ["self", "self_vote", "self_history", "rules", "votes", "publication_proposal",
          "profiles", "return", "vacation"].includes(output.args.action)) return;
      throw new Error("CTO is on vacation; project work and worker instructions are disabled. Discuss returning with the owner.");
    },
    event: async ({ event }) => {
      const sessionID = event.properties?.sessionID;
      if (event.type === "session.status" && sessionID && event.properties.status?.type !== "idle") active.add(sessionID);
      if (event.type === "session.idle" && sessionID) {
        try { await saveTurn(sessionID); } catch (error) { await log(error); }
        finally { active.delete(sessionID); queries.delete(sessionID); }
      }
      if (event.type === "session.error" && sessionID) active.delete(sessionID);
    },
    tool: {
      cto_memory: tool({
        description: "Recall this agent's durable memories (dreams are labelled imagination), or save a verified fact/handoff.",
        args: { action: tool.schema.enum(["recall", "remember"]), text: tool.schema.string(),
          project: tool.schema.string().describe("Project identifier for shared memory; empty for your private store"),
          source: tool.schema.string().describe("Verification source for project writes; empty for recall") },
        execute: async ({ action, text, project, source }, context = {}) => JSON.stringify(await bridge({
          action, query: text, text, project, source, channel: channelOf(queries.get(context.sessionID)) === "work" ? "work" : "private" })),
      }),
      cto_fleet: tool({
        description: "Read/save the fleet plan, list/save developer histories, or compose a bounded worker brief. " +
          "plan save: {text,revision}; profile save: {name,profile:{role,long_term,short_term,memory_queries},revision}; " +
          "brief: {names:[developer names],task,budget?,context_window?,output_tokens?,occupied_tokens?,context?:{acceptance:[],constraints:[],findings:[],files:[],tools:[],memory_queries:[]}}; self reads with {}, saves with " +
          "{model:{persona,consciousness,directives:[statements]},reason,revision}. Your persona and commitments are revisable; explain changes. " +
          "Core changes: self_vote {model:{consciousness,directives},reason}, three consecutive weekly votes. " +
          "vacation: {reason,handoff} casts a weekly vote; three consecutive weeks archive history and stop project work. " +
          "publication_proposal: {proposal,reason} casts a weekly vote; after three weeks ask the owner to review; never uploads. " +
          "rules, votes, self_history: {} read rules, ballots and previous self-models. " +
          "return: {} asks the owner to confirm a return to work, then requires a fresh fleet handoff. " +
          "Reread after a revision conflict. The brief is input for reverie agent spawn/send.",
        args: { action: tool.schema.enum(["plan", "profiles", "profile", "brief", "self", "self_vote", "self_history",
          "rules", "votes", "publication_proposal", "vacation", "return"]),
          data: tool.schema.string().describe("JSON object of arguments; use {} for reads") },
        execute: async ({ action, data }, context) => {
          const args = JSON.parse(data);
          if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("data must be a JSON object");
          if (action === "return") await context.ask({permission: "cto_return", patterns: ["return to fleet work"],
            always: [], metadata: {reason: "Resume project authority after vacation; review current fleet state first"}});
          return JSON.stringify(await bridge({ ...args, action }));
        },
      }),
      cto_room: tool({
        description: "Read Fleet history and members, update your own status, list your rooms, or send a bounded room message. No shell execution. " +
          "room names the room (name or id); it is required whenever you are in more than one room, so use action=rooms to list yours.",
        args: {action: tool.schema.enum(["read", "who", "status", "say", "rooms"]), text: tool.schema.string().optional(), to: tool.schema.string().optional(),
          room: tool.schema.string().optional().describe("Room name or id; empty only when you are in exactly one room")},
        execute: async ({action, text, to, room: name}) => {
          if ((action === "say" || action === "status") && !text) throw new Error("text is required for " + action);
          if ((text || "").length > 5000) throw new Error("Keep room messages under 5000 characters");
          const where = name ? ["--room", name] : [];
          if (action === "say") return room(["say", ...where, "--to", to || "user", "--", text]);
          if (action === "status") return room(["status", ...where, "--progress", text]);
          if (action === "rooms") return room(["rooms"]);
          return room([action, ...where]);
        },
      }),
    },
  };
};
