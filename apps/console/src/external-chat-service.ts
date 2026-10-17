import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatRoom } from './chatroom-store.js';
import type { ChatroomService } from './chatroom-service.js';
import { ExternalChatProvider, compareExternalIds, initialExternalCursor } from './external-chat-provider.js';
import { loadExternalChat, saveExternalChat } from './external-chat-store.js';
import {
  ExternalChatError,
  ExternalTransportError,
  type ExternalChatState,
  type ExternalConnect,
  type ExternalConnection,
  type ExternalDelivery,
  type ExternalLink,
} from './external-chat-types.js';

export interface ExternalChatDeps {
  file: string;
  chatrooms: ChatroomService;
  getSession(id: string): { owner?: string } | undefined;
  provider?: ExternalChatProvider;
  now?: () => number;
}

/** Owner-authorized bot connections. Only an explicitly bound agent's public
 * room messages leave the machine. No owner messages, DMs, history, or relays. */
export class ExternalChatService {
  private state: ExternalChatState = { version: 1, connections: [], links: [], deliveries: [] };
  private chain: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private verifiedThisRun = new Set<string>();
  private readonly provider: ExternalChatProvider;
  constructor(private readonly deps: ExternalChatDeps) {
    this.provider = deps.provider ?? new ExternalChatProvider();
  }
  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }
  private save(): Promise<void> {
    return saveExternalChat(this.deps.file, this.state);
  }
  async init(): Promise<void> {
    this.state = await loadExternalChat(this.deps.file);
    // Re-verify saved tokens before network work. Prior identity remains visible
    // with its verification timestamp, never upgraded to a live assertion.
    await this.save();
    this.unsubscribe = this.deps.chatrooms.onMessage((room, message) => {
      void this.relay(room, message).catch(() => {
        for (const c of this.state.connections)
          if (c.owner === room.owner) c.lastError = 'Cannot persist outbound message; delivery not queued';
      });
    });
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll().catch(() => {});
    }, 5000);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.chain;
  }
  snapshot(owner: string | undefined): unknown {
    const connections = this.state.connections.filter((c) => c.owner === owner);
    const ids = new Set(connections.map((c) => c.id));
    return {
      connections: connections.map(({ token: _secret, ...connection }) => connection),
      links: this.state.links.filter((l) => ids.has(l.connectionId)),
      deliveries: this.state.deliveries.filter((d) => ids.has(d.connectionId)).map(({ text: _text, ...d }) => d),
    };
  }
  private connection(owner: string | undefined, id: string): ExternalConnection {
    const c = this.state.connections.find((c) => c.id === id && c.owner === owner);
    if (!c) throw new ExternalChatError('Connection not found', 'NOT_FOUND');
    return c;
  }
  private validateBinding(c: ExternalConnection, roomId?: string): void {
    const session = this.deps.getSession(c.agentSessionId);
    if (!session || session.owner !== c.owner)
      throw new ExternalChatError('Bound agent is unavailable or belongs to another owner', 'CONFLICT');
    if (roomId) {
      const room = this.deps.chatrooms.room(roomId);
      if (!room || room.owner !== c.owner) throw new ExternalChatError('Room not found', 'NOT_FOUND');
      if (room.kind === 'dm' || room.archivedAt || !room.members.some((m) => m.sessionId === c.agentSessionId)) {
        throw new ExternalChatError('Choose an active ordinary room containing the bound agent', 'CONFLICT');
      }
    }
  }
  connect(owner: string | undefined, input: ExternalConnect): Promise<unknown> {
    return this.run(async () => {
      if (this.state.connections.filter((c) => c.owner === owner).length >= 20)
        throw new ExternalChatError('At most 20 external connections per owner', 'CONFLICT');
      const c: ExternalConnection = {
        id: randomUUID(),
        owner,
        provider: input.provider,
        token: input.token,
        agentSessionId: input.agentSessionId,
        label: input.label || input.provider,
        enabled: false,
        identity: { id: '', name: '' },
        verifiedAt: this.now(),
        nextAt: 0,
      };
      this.validateBinding(c);
      c.identity = await this.provider.verify(c.provider, c.token);
      this.verifiedThisRun.add(c.id);
      this.state.connections.push(c);
      await this.save();
      return this.snapshot(owner);
    });
  }
  setEnabled(owner: string | undefined, id: string, enabled: boolean): Promise<unknown> {
    return this.run(async () => {
      const c = this.connection(owner, id);
      if (enabled) {
        this.validateBinding(c);
        const identity = await this.provider.verify(c.provider, c.token);
        if (identity.id !== c.identity.id || identity.workspaceId !== c.identity.workspaceId)
          throw new ExternalChatError('Bot identity changed; reconnect explicitly', 'CONFLICT');
        c.verifiedAt = this.now();
        this.verifiedThisRun.add(c.id);
      }
      c.enabled = enabled;
      c.lastError = undefined;
      await this.save();
      return this.snapshot(owner);
    });
  }
  remove(owner: string | undefined, id: string): Promise<unknown> {
    return this.run(async () => {
      this.connection(owner, id);
      this.state.connections = this.state.connections.filter((c) => c.id !== id);
      this.state.links = this.state.links.filter((l) => l.connectionId !== id);
      this.state.deliveries = this.state.deliveries.filter((d) => d.connectionId !== id);
      await this.save();
      return this.snapshot(owner);
    });
  }
  channel(owner: string | undefined, id: string, channelId: string): Promise<unknown> {
    return this.run(() => this.provider.channel(this.connection(owner, id), channelId));
  }
  link(owner: string | undefined, id: string, input: { roomId: string; channelId: string }): Promise<unknown> {
    return this.run(async () => {
      const c = this.connection(owner, id);
      this.validateBinding(c, input.roomId);
      if (
        this.state.links.some(
          (l) => l.connectionId === id && (l.channelId === input.channelId || l.roomId === input.roomId)
        )
      ) {
        throw new ExternalChatError('This room or channel is already linked for this bot', 'CONFLICT');
      }
      if (this.state.links.filter((l) => l.connectionId === id).length >= 20)
        throw new ExternalChatError('At most 20 channels per connection', 'CONFLICT');
      const channel = await this.provider.channel(c, input.channelId);
      this.state.links.push({
        id: randomUUID(),
        connectionId: id,
        roomId: input.roomId,
        channelId: channel.id,
        channelName: channel.name,
        cursor: initialExternalCursor(c.provider, this.now()),
      });
      await this.save();
      return this.snapshot(owner);
    });
  }
  unlink(owner: string | undefined, linkId: string): Promise<unknown> {
    return this.run(async () => {
      const link = this.state.links.find((l) => l.id === linkId);
      if (!link) throw new ExternalChatError('Link not found', 'NOT_FOUND');
      this.connection(owner, link.connectionId);
      this.state.links = this.state.links.filter((l) => l !== link);
      for (const d of this.state.deliveries)
        if (d.linkId === linkId && d.state === 'queued') {
          d.state = 'failed';
          d.error = 'Channel unlinked';
        }
      await this.save();
      return this.snapshot(owner);
    });
  }
  relay(room: ChatRoom, message: ChatMessage): Promise<void> {
    return this.run(async () => {
      if (message.from.kind !== 'agent' || message.to !== 'all' || room.kind === 'dm' || room.archivedAt) return;
      for (const link of this.state.links.filter((l) => l.roomId === room.id)) {
        const c = this.state.connections.find((c) => c.id === link.connectionId);
        if (!c?.enabled || c.owner !== room.owner || c.agentSessionId !== message.from.sessionId) continue;
        this.validateBinding(c, room.id);
        if (this.state.deliveries.some((d) => d.linkId === link.id && d.localMessageId === message.id)) continue;
        const max = c.provider === 'discord' ? 2000 : 4000;
        const delivery: ExternalDelivery = {
          id: randomUUID(),
          connectionId: c.id,
          linkId: link.id,
          localMessageId: message.id,
          text: message.text,
          at: this.now(),
          state: message.text.length <= max ? 'queued' : 'failed',
        };
        if (delivery.state === 'failed')
          delivery.error = `External message exceeds ${max} characters; shorten and post again`;
        if (this.state.deliveries.filter((d) => ['queued', 'sending', 'unknown'].includes(d.state)).length >= 200) {
          delivery.state = 'failed';
          delivery.error = 'External queue full';
        }
        this.state.deliveries.push(delivery);
      }
      // Keep pending and uncertain outcomes until explicitly disconnected; bound
      // completed history prevents uncontrolled runtime-state growth.
      const completed = this.state.deliveries.filter((d) => d.state === 'sent' || d.state === 'failed');
      const remove = new Set(completed.slice(0, Math.max(0, completed.length - 1000)));
      this.state.deliveries = this.state.deliveries.filter((d) => !remove.has(d));
      await this.save();
    });
  }
  poll(): Promise<void> {
    return this.run(async () => {
      for (const c of [...this.state.connections]) {
        if (!c.enabled || c.nextAt > this.now()) continue;
        this.state.connections = [...this.state.connections.filter((peer) => peer !== c), c];
        try {
          this.validateBinding(c);
          // Re-verification is actual network evidence, never a simulated login.
          if (!this.verifiedThisRun.has(c.id) || this.now() - c.verifiedAt > 3600000) {
            const identity = await this.provider.verify(c.provider, c.token);
            if (identity.id !== c.identity.id || identity.workspaceId !== c.identity.workspaceId)
              throw new ExternalChatError('Bot identity changed', 'CONFLICT');
            c.verifiedAt = this.now();
            this.verifiedThisRun.add(c.id);
          }
          const outgoing = this.state.deliveries.find((d) => d.connectionId === c.id && d.state === 'queued');
          if (outgoing) await this.send(c, outgoing);
          else {
            const links = this.state.links.filter((l) => l.connectionId === c.id);
            // Rotate fairly across explicitly selected channels; one request per tick.
            const link = links.shift();
            if (link) {
              this.state.links = [...this.state.links.filter((l) => l !== link), link];
              this.validateBinding(c, link.roomId);
              await this.receive(c, link);
            }
          }
          c.lastError = undefined;
          c.nextAt = this.now() + (c.provider === 'slack' ? 65000 : 5000);
          // Multiple agent bindings may use the same installed bot. Share the
          // conservative transport window so they do not multiply its rate.
          for (const peer of this.state.connections)
            if (
              peer.provider === c.provider &&
              peer.identity.id === c.identity.id &&
              peer.identity.workspaceId === c.identity.workspaceId
            ) {
              peer.nextAt = Math.max(peer.nextAt, c.nextAt);
            }
        } catch (error) {
          const transport = error instanceof ExternalTransportError ? error : undefined;
          c.lastError = transport?.message ?? 'External binding or persistence failed; check the linked room and agent';
          c.nextAt = this.now() + (transport?.retryAfterMs ?? 65000);
          if (transport?.retryAfterMs)
            for (const peer of this.state.connections)
              if (peer.provider === c.provider) {
                peer.nextAt = Math.max(peer.nextAt, c.nextAt);
              }
          if (
            transport &&
            ['invalid_auth', 'token_revoked', 'http_401', 'http_403', 'bot_identity_required'].includes(
              transport.reason
            )
          )
            c.enabled = false;
        }
        await this.save();
      }
    });
  }
  private async send(c: ExternalConnection, d: ExternalDelivery): Promise<void> {
    const link = this.state.links.find((l) => l.id === d.linkId);
    if (!link) {
      d.state = 'failed';
      d.error = 'Channel unlinked';
      return;
    }
    this.validateBinding(c, link.roomId);
    d.state = 'sending';
    await this.save();
    try {
      d.externalMessageId = await this.provider.send(c, link.channelId, d.text, d.id);
      d.state = 'sent';
    } catch (error) {
      const transport = error instanceof ExternalTransportError ? error : undefined;
      d.state = transport?.retryAfterMs ? 'queued' : transport?.unknown ? 'unknown' : 'failed';
      d.error = transport?.unknown
        ? 'Delivery may have succeeded; check the external channel before reposting'
        : (transport?.message ?? 'Delivery failed');
      throw error;
    }
  }
  private async receive(c: ExternalConnection, link: ExternalLink): Promise<void> {
    const page = await this.provider.read(c, link);
    let crossedWatermark = false;
    for (const m of page.messages.sort((a, b) => compareExternalIds(c.provider, a.id, b.id))) {
      if (compareExternalIds(c.provider, m.id, link.cursor) <= 0) {
        crossedWatermark = true;
        continue;
      }
      if (!link.highWater || compareExternalIds(c.provider, m.id, link.highWater) > 0) link.highWater = m.id;
      if (m.bot || !m.text.trim() || !m.userId || m.userId === c.identity.id) continue;
      await this.deps.chatrooms.externalMessage(
        link.roomId,
        {
          kind: 'external',
          provider: c.provider,
          connectionId: c.id,
          channelId: link.channelId,
          userId: m.userId,
          messageId: m.id,
          name: `${c.provider}: ${m.name || m.userId}`,
        },
        m.text,
        c.agentSessionId
      );
    }
    link.pageCursor = crossedWatermark ? undefined : page.nextPage;
    if (!link.pageCursor && link.highWater) {
      link.cursor = link.highWater;
      link.highWater = undefined;
    }
  }
}
