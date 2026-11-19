import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CONTINUATION = '[Reverie bounded coding continuation] Continue only the authorized task. If it is complete or blocked, call interaction_mode with mode chat and report the result. Do not invent more work.';

/** Behavioral modes are separate from permissions, identity and lifecycle state. */
export async function createInteractionController({ client, directory, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  const folder = join(directory, '.opencode');
  let policy;
  try { policy = JSON.parse(await readFile(join(folder, 'interaction-policy.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (policy.enabled !== true) return null;
  const bounded = (value, fallback, lo, hi) => Number.isFinite(Number(value)) ? Math.floor(Math.max(lo, Math.min(hi, Number(value)))) : fallback;
  const maxContinues = bounded(policy.max_continuations ?? 0, 0, 0, 3);
  const windowMs = bounded(policy.coding_window_ms ?? 600000, 600000, 1000, 900000);
  const delayMs = bounded(policy.cooldown_ms ?? 10000, 10000, 1000, 60000);
  // Optional: run coding continuations as this OpenCode agent, so a lean conversation agent need not carry
  // the coding tools. Unset keeps every turn on the session's own agent.
  const agentName = (value) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : null;
  const codingAgent = agentName(policy.coding_agent);
  // With a coding agent, every conversation-mode message runs as this agent: the TUI keeps the last agent used
  // (and restores it on relaunch), so without this a turn after a coding continuation would carry coding tools.
  const conversationAgent = codingAgent ? agentName(policy.conversation_agent) ?? 'chat' : null;
  const boot = randomUUID();
  const fileFor = (id) => join(folder, 'interaction-state', validId(id) + '.json');
  const timers = new Map(), busy = new Set(), injected = new Set(), continuing = new Set();
  let writes = Promise.resolve();
  const chat = (generation = 0, eligible = false) => ({ mode: 'chat', generation, remaining: 0, expiresAt: 0, task: '', eligible, boot });
  const validId = (id) => { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error('A native session id is required'); return id; };
  async function read(id) {
    try { const value = JSON.parse(await readFile(fileFor(id), 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
  }
  const normalized = (value) => {
    if (value?.boot !== boot) return chat();
    if (value.mode === 'chat') return chat(value.generation || 0, value.eligible === true);
    return value?.mode === 'coding' && Number.isFinite(value.expiresAt) && value.expiresAt > now() && Number.isInteger(value.generation) && Number.isInteger(value.remaining) && value.remaining >= 0 && value.remaining <= maxContinues && typeof value.task === 'string' ? value : chat(value?.generation || 0);
  };
  async function status(id) { validId(id); await writes; return normalized(await read(id)); }
  function mutate(id, change) {
    validId(id);
    const result = writes.then(async () => {
      const file = fileFor(id), data = change(normalized(await read(id)));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      await rename(temporary, file); return data;
    });
    writes = result.catch(() => {}); return result;
  }
  function clear(id) { if (timers.has(id)) cancel(timers.get(id)); timers.delete(id); }
  async function setMode(id, mode, task = '') {
    if (!['chat', 'coding', 'status'].includes(mode)) throw new Error('Mode must be chat, coding or status');
    if (mode === 'status') return status(id);
    if (mode === 'coding' && (typeof task !== 'string' || !task.trim() || task.length > 2000)) throw new Error('Coding mode requires the bounded task already authorized by the owner');
    clear(id);
    return mutate(id, (s) => {
      if (mode === 'chat') return chat(s.generation + 1);
      if (s.mode === 'coding' || !s.eligible) throw new Error('Coding budget requires a new real user turn; it cannot be renewed by a continuation or by switching back and forth.');
      return { mode, task: task.trim(), generation: s.generation + 1, remaining: maxContinues, expiresAt: now() + windowMs, eligible: false, boot };
    });
  }
  async function onMessage(id, text, synthetic = false, ownerInput = true) {
    if (synthetic && text === CONTINUATION && injected.delete(id)) return;
    clear(id); injected.delete(id); busy.add(id);
    await mutate(id, (s) => chat(s.generation + 1, !synthetic && ownerInput));
  }
  async function onIdle(id) {
    busy.delete(id); clear(id);
    const s = await status(id);
    if (s.mode !== 'coding' || continuing.has(id)) return;
    if (s.remaining === 0) { await setMode(id, 'chat'); return; }
    const timer = schedule(async () => {
      timers.delete(id);
      if (continuing.has(id)) return;
      continuing.add(id);
      try {
        const current = await status(id);
        if (busy.has(id) || current.mode !== 'coding' || current.generation !== s.generation || current.remaining === 0) return;
        // Spend before submitting: a failed request never earns an unbounded retry.
        let consumed = false;
        const spent = await mutate(id, (v) => {
          if (v.mode !== 'coding' || v.generation !== s.generation || busy.has(id) || v.remaining === 0) return v;
          consumed = true; return { ...v, remaining: v.remaining - 1 };
        });
        const latest = await status(id);
        if (!consumed || spent.mode !== 'coding' || latest.mode !== 'coding' || latest.generation !== s.generation || busy.has(id)) return;
        injected.add(id);
        const result = await client.session.promptAsync({ path: { id }, body: { ...(codingAgent ? { agent: codingAgent } : {}), parts: [{ type: 'text', text: CONTINUATION, synthetic: true }] } });
        if (result?.error) throw new Error('Continuation was refused');
      } catch {
        injected.delete(id);
        if ((await status(id).catch(() => null))?.generation === s.generation) await setMode(id, 'chat').catch(() => {});
      } finally { continuing.delete(id); }
    }, delayMs);
    timer?.unref?.(); timers.set(id, timer);
  }
  function onBusy(id) { busy.add(id); clear(id); }
  async function onError(id) { busy.delete(id); injected.delete(id); await setMode(id, 'chat'); }
  async function system(id) {
    const s = await status(id);
    const role = typeof policy.role === 'string' ? policy.role : 'assistant';
    return `Owner-configured interaction role: ${role}. Active mode: ${s.mode}. Generic infrastructure charters do not replace this conversational role. Identity, memory, lifecycle safeguards and permissions stay unchanged.\n` +
      (s.mode === 'chat'
        ? 'Be present in conversation. Do not pursue the coding backlog. You may call interaction_mode(mode="coding", task="...") yourself when coding directly serves an owner-authorized request; announce substantial work briefly. Use chat mode again after the task or when the owner wants to talk.' +
          (codingAgent ? ` Coding tools are not loaded in conversation: after selecting coding, end this turn; the task continues by itself in a coding turn with the full toolset about ${Math.round(delayMs / 1000)} seconds later.` : '')
        : `Work only on this authorized task: ${s.task}\nPause for owner messages. Call interaction_mode(mode="chat") when complete or blocked. At most ${maxContinues} automatic continuation turns and ${Math.round(windowMs / 60000)} minutes are available; these are limits, not a reason to keep working.`);
  }
  /** The agent a new primary-session message must run as, or null to keep the agent it arrived with. */
  async function messageAgent(id) { return conversationAgent && (await status(id)).mode === 'chat' ? conversationAgent : null; }
  async function beforeTool(id, tool) {
    const allowed = ['interaction_mode', 'reverie_memory', 'reverie_room', 'agent_profile'];
    if ((await status(id)).mode === 'chat' && !allowed.includes(tool)) throw new Error('Conversation mode: stay with the conversation, or select coding mode for a bounded owner-authorized task first.');
  }
  async function drop(id) { clear(id); busy.delete(id); injected.delete(id); await writes; await unlink(fileFor(id)).catch((e) => { if (e.code !== 'ENOENT') throw e; }); }
  return { status, setMode, onMessage, onIdle, onBusy, onError, system, beforeTool, drop, messageAgent, codingAgent, conversationAgent, continuationDelayMs: delayMs, close: () => { for (const id of timers.keys()) clear(id); } };
}
