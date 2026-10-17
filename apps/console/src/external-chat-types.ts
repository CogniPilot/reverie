import { z } from 'zod';

export const ExternalProviderSchema = z.enum(['slack', 'discord']);
const id = z.string().min(1).max(100);
export const ExternalConnectSchema = z
  .object({
    provider: ExternalProviderSchema,
    agentSessionId: id,
    label: z.string().trim().min(1).max(80).optional(),
    token: z.string().trim().min(10).max(4096),
  })
  .strict();
export const ExternalLinkSchema = z.object({ roomId: id, channelId: id }).strict();
export const ExternalEnabledSchema = z.object({ enabled: z.boolean() }).strict();
export type ExternalProvider = z.infer<typeof ExternalProviderSchema>;
export type ExternalConnect = z.infer<typeof ExternalConnectSchema>;
export interface ExternalIdentity {
  id: string;
  name: string;
  workspaceId?: string;
  workspaceName?: string;
}
export interface ExternalConnection {
  id: string;
  owner?: string;
  provider: ExternalProvider;
  agentSessionId: string;
  label: string;
  token: string;
  identity: ExternalIdentity;
  enabled: boolean;
  verifiedAt: number;
  nextAt: number;
  lastError?: string;
}
export interface ExternalLink {
  id: string;
  connectionId: string;
  roomId: string;
  channelId: string;
  channelName: string;
  /** No historical import: watermark starts when the owner links a channel. */
  cursor: string;
  pageCursor?: string;
  highWater?: string;
}
export interface ExternalDelivery {
  id: string;
  connectionId: string;
  linkId: string;
  localMessageId: string;
  text: string;
  state: 'queued' | 'sending' | 'sent' | 'unknown' | 'failed';
  at: number;
  externalMessageId?: string;
  error?: string;
}
export interface ExternalChatState {
  version: 1;
  connections: ExternalConnection[];
  links: ExternalLink[];
  deliveries: ExternalDelivery[];
}
export interface ExternalIncoming {
  id: string;
  userId: string;
  name: string;
  text: string;
  bot: boolean;
}
export interface ExternalPage {
  messages: ExternalIncoming[];
  nextPage?: string;
}
export class ExternalChatError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' = 'INVALID_INPUT'
  ) {
    super(message);
  }
}
export class ExternalTransportError extends Error {
  constructor(
    readonly reason: string,
    readonly retryAfterMs?: number,
    readonly unknown = false
  ) {
    // Never include upstream error bodies, tokens, or URLs in errors/logs.
    super(`External chat: ${reason}`);
  }
}
