import { execFile } from 'node:child_process';
import { tool } from '@opencode-ai/plugin';
import { createInteractionController } from './interaction.mjs';

export default async function InteractionModes({ client, directory }) {
  const controller = await createInteractionController({ client, directory });
  if (!controller) return {};
  const children = new Map(), blocked = new Set(), waiting = new Set();
  const isChild = async (id) => {
    if (!children.has(id)) {
      const result = await client.session.get({ path: { id } });
      if (result.error) throw new Error('Cannot establish native session scope');
      children.set(id, !!result.data?.parentID);
    }
    return children.get(id);
  };
  const safe = async (id, fn, fallback) => {
    try { return await fn(); } catch (error) {
      blocked.add(id);
      try { await client.app?.log?.({ body: { service: 'reverie-interaction', level: 'error', message: String(error.message) } }); } catch {}
      return fallback;
    }
  };
  return {
    'chat.message': async (input, output) => safe(input.sessionID, async () => {
      if (await isChild(input.sessionID)) return;
      const parts = output.parts.filter((p) => p.type === 'text');
      const text = parts.map((p) => p.text).join('\n');
      // A behavioural guard, not an authentication boundary: room transport owns sender authentication.
      const room = /^\[(?:Codeman|Reverie) chat [^\]]+\]\s*(.*)/s.exec(text);
      const ownerInput = room ? /^(?:USER|user)\s*->/.test(room[1]) : !text.startsWith('Shared-room voice turn:');
      await controller.onMessage(input.sessionID, text, parts.length > 0 && parts.every((p) => p.synthetic), ownerInput);
      blocked.delete(input.sessionID);
    }),
    'experimental.chat.system.transform': async (input, output) => {
      if (!input.sessionID) return;
      const mode = await safe(input.sessionID, async () => (await isChild(input.sessionID)) ? '' : await controller.system(input.sessionID),
        'Conversation mode. Interaction state is unavailable; answer conversationally and do not start coding.');
      output.system.splice(0, output.system.length, [...output.system, mode].join('\n\n'));
    },
    'tool.execute.before': async (input) => {
      if (await isChild(input.sessionID)) return;
      if (blocked.has(input.sessionID) && !['interaction_mode', 'cto_memory', 'cto_room', 'agent_profile'].includes(input.tool)) throw new Error('Interaction state unavailable: coding is blocked.');
      await controller.beforeTool(input.sessionID, input.tool);
    },
    event: async ({ event }) => {
      if (event.type === 'server.instance.disposed') { controller.close(); return; }
      const id = event.properties?.sessionID ?? event.properties?.info?.id;
      if (!id) return;
      await safe(id, async () => {
        if (await isChild(id)) return;
        if (event.type === 'session.status' && event.properties.status?.type !== 'idle') controller.onBusy(id);
        if (['permission.asked', 'permission.updated', 'question.asked'].includes(event.type)) { waiting.add(id); controller.onBusy(id); }
        if (event.type === 'session.idle' && !waiting.has(id)) await controller.onIdle(id);
        if (['permission.replied', 'question.replied'].includes(event.type)) {
          waiting.delete(id);
          const reply = event.properties.reply ?? event.properties.response;
          if (['reject', 'deny', 'rejected'].includes(reply)) await controller.onError(id);
        }
        if (['session.error', 'question.rejected'].includes(event.type)) { waiting.delete(id); await controller.onError(id); }
        if (event.type === 'session.deleted') { await controller.drop(id); children.delete(id); blocked.delete(id); waiting.delete(id); }
      });
    },
    tool: {
      agent_profile: tool({
        description: 'Change your own display name or icon without leaving conversation mode. This does not change your identity ID, role or permissions.',
        args: { name: tool.schema.string().max(100).optional(), icon: tool.schema.string().max(100).optional() },
        async execute(args, context) {
          if (await isChild(context.sessionID)) throw new Error('Only the primary conversation edits its profile.');
          if (!process.env.CODEMAN_SESSION_ID) throw new Error('An agent session identity is required.');
          if (args.name === undefined && args.icon === undefined) throw new Error('Give a name, an icon, or both.');
          const argv = ['agent', 'profile'];
          if (args.name !== undefined) argv.push('--name', args.name);
          if (args.icon !== undefined) argv.push('--icon', args.icon);
          return new Promise((resolve, reject) => {
            execFile('reverie', argv, { timeout: 30000, maxBuffer: 1024 * 1024 },
              (error, stdout, stderr) => error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout));
          });
        },
      }),
      interaction_mode: tool({
        description: 'Choose conversation or bounded coding yourself within the owner-authorized task. Identity, memory and permissions do not change. Return to chat when done or blocked.',
        args: { mode: tool.schema.enum(['chat', 'coding', 'status']), task: tool.schema.string().max(2000).optional() },
        async execute(args, context) {
          if (await isChild(context.sessionID)) return JSON.stringify({ mode: 'delegated', note: 'Interaction modes apply to the primary conversation, not its bounded child tasks.' });
          if (blocked.has(context.sessionID) && args.mode === 'coding') throw new Error('Interaction state unavailable: a fresh successful owner turn is required before coding.');
          return JSON.stringify(await controller.setMode(context.sessionID, args.mode, args.task));
        },
      }),
    },
  };
}
