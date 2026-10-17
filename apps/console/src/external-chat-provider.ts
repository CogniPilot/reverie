import { createHash } from 'node:crypto';
import {
  ExternalTransportError,
  type ExternalConnection,
  type ExternalIdentity,
  type ExternalLink,
  type ExternalPage,
  type ExternalProvider,
} from './external-chat-types.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const rows = (value: unknown): Json[] => (Array.isArray(value) ? value.map(record) : []);

/** Fixed production endpoints. Overrides exist only for injected local transport tests. */
export class ExternalChatProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoints = {
      slack: 'https://slack.com/api/',
      discord: 'https://discord.com/api/v10/',
    }
  ) {}

  private async request(provider: ExternalProvider, token: string, path: string, body?: Json): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.endpoints[provider]), {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: `${provider === 'slack' ? 'Bearer' : 'Bot'} ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new ExternalTransportError('network_failure', undefined, !!body);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ExternalTransportError('invalid_response', undefined, !!body);
    }
    const json = record(data);
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after') || json.retry_after || 60);
      throw new ExternalTransportError(
        'rate_limited',
        Number.isFinite(seconds) ? Math.max(1000, seconds * 1000) : 60000
      );
    }
    if (!response.ok)
      throw new ExternalTransportError(`http_${response.status}`, undefined, !!body && response.status >= 500);
    if (provider === 'slack' && json.ok !== true) {
      // Provider strings are not trusted: return only a fixed classification.
      const known = [
        'invalid_auth',
        'token_revoked',
        'missing_scope',
        'not_in_channel',
        'channel_not_found',
        'ratelimited',
      ];
      const reason = known.includes(str(json.error)) ? str(json.error) : 'provider_rejected';
      throw new ExternalTransportError(
        reason,
        reason === 'ratelimited' ? 60000 : undefined,
        !!body && ['internal_error', 'fatal_error', 'request_timeout'].includes(str(json.error))
      );
    }
    return data;
  }

  async verify(provider: ExternalProvider, token: string): Promise<ExternalIdentity> {
    if (provider === 'slack' && !token.startsWith('xoxb-')) throw new ExternalTransportError('bot_token_required');
    const data = record(
      await this.request(
        provider,
        token,
        provider === 'slack' ? 'auth.test' : 'users/@me',
        provider === 'slack' ? {} : undefined
      )
    );
    if (provider === 'slack') {
      if (!data.bot_id || !data.user_id || !data.team_id) throw new ExternalTransportError('bot_identity_required');
      return {
        id: str(data.user_id),
        name: str(data.user),
        workspaceId: str(data.team_id),
        workspaceName: str(data.team),
      };
    }
    if (data.bot !== true || !data.id) throw new ExternalTransportError('bot_identity_required');
    return { id: str(data.id), name: str(data.username) };
  }

  async channel(connection: ExternalConnection, channelId: string): Promise<{ id: string; name: string }> {
    if (!(connection.provider === 'slack' ? /^[CG][A-Z0-9]+$/ : /^\d{5,25}$/).test(channelId)) {
      throw new ExternalTransportError('invalid_channel_id');
    }
    const json = record(
      await this.request(
        connection.provider,
        connection.token,
        connection.provider === 'slack'
          ? `conversations.info?channel=${encodeURIComponent(channelId)}`
          : `channels/${channelId}`
      )
    );
    const channel = connection.provider === 'slack' ? record(json.channel) : json;
    if (
      connection.provider === 'slack'
        ? channel.is_member !== true || !!channel.is_im || !!channel.is_mpim || !!channel.is_archived
        : ![0, 5].includes(Number(channel.type))
    ) {
      throw new ExternalTransportError('join_a_text_channel_first');
    }
    if (str(channel.id) !== channelId) throw new ExternalTransportError('invalid_channel_response');
    return { id: channelId, name: str(channel.name) || channelId };
  }

  async read(connection: ExternalConnection, link: ExternalLink): Promise<ExternalPage> {
    const query = new URLSearchParams(
      connection.provider === 'slack'
        ? {
            channel: link.channelId,
            oldest: link.cursor,
            limit: '15',
            ...(link.pageCursor ? { cursor: link.pageCursor } : {}),
          }
        : { limit: '100', ...(link.pageCursor ? { before: link.pageCursor } : { after: link.cursor }) }
    );
    const data = await this.request(
      connection.provider,
      connection.token,
      connection.provider === 'slack'
        ? `conversations.history?${query}`
        : `channels/${link.channelId}/messages?${query}`
    );
    if (connection.provider === 'slack') {
      const json = record(data);
      const nextPage = str(record(json.response_metadata).next_cursor);
      if (json.has_more === true && !nextPage) throw new ExternalTransportError('missing_pagination_cursor');
      return {
        messages: rows(json.messages).map((m) => ({
          id: str(m.ts),
          userId: str(m.user),
          name: str(m.user),
          text: str(m.text),
          bot: !!m.bot_id || !!m.subtype,
        })),
        nextPage: nextPage || undefined,
      };
    }
    if (!Array.isArray(data)) throw new ExternalTransportError('invalid_message_response');
    const messages = rows(data).map((m) => {
      const author = record(m.author);
      return {
        id: str(m.id),
        userId: str(author.id),
        name: str(author.global_name) || str(author.username),
        text: str(m.content),
        bot: author.bot === true || !!m.webhook_id || (Number(m.type) !== 0 && Number(m.type) !== 19),
      };
    });
    // Walk backwards when a burst fills a page; the service retains the original
    // watermark until every page is consumed, including across restarts.
    return { messages, nextPage: messages.length === 100 ? messages.at(-1)?.id : undefined };
  }

  async send(connection: ExternalConnection, channelId: string, text: string, deliveryId: string): Promise<string> {
    const data = record(
      await this.request(
        connection.provider,
        connection.token,
        connection.provider === 'slack' ? 'chat.postMessage' : `channels/${channelId}/messages`,
        connection.provider === 'slack'
          ? {
              channel: channelId,
              text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
              mrkdwn: false,
              parse: 'none',
              unfurl_links: false,
              unfurl_media: false,
              client_msg_id: deliveryId,
            }
          : {
              content: text,
              allowed_mentions: { parse: [] },
              nonce: createHash('sha256').update(deliveryId).digest('hex').slice(0, 25),
              enforce_nonce: true,
            }
      )
    );
    const id = str(connection.provider === 'slack' ? data.ts : data.id);
    if (!id) throw new ExternalTransportError('missing_delivery_receipt', undefined, true);
    return id;
  }
}

export function initialExternalCursor(provider: ExternalProvider, now: number): string {
  return provider === 'slack' ? (now / 1000).toFixed(6) : ((BigInt(now) - 1420070400000n) << 22n).toString();
}
export function compareExternalIds(provider: ExternalProvider, a: string, b: string): number {
  const exact = (id: string): bigint => {
    if (provider === 'discord') return BigInt(id);
    const [seconds, fraction = ''] = id.split('.');
    return BigInt(seconds) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  };
  return exact(a) < exact(b) ? -1 : exact(a) > exact(b) ? 1 : 0;
}
