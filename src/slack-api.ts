import type { EphemeralNotice, SlackUser } from "./types.js";

export class SlackError extends Error {
  constructor(public readonly code: string, public readonly retryAfterSeconds?: number) { super(`Slack: ${code}`); this.name = "SlackError"; }
}

interface ApiResult { ok: boolean; error?: string; [key: string]: unknown }

export interface SlackGateway {
  user(id: string): Promise<SlackUser>;
  members(channel: string): Promise<string[]>;
  permalink(channel: string, ts: string): Promise<string | undefined>;
  postEphemeral(notice: EphemeralNotice): Promise<void>;
}

export class SlackApi implements SlackGateway {
  private users = new Map<string, SlackUser>();
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  private async call(method: string, payload: object): Promise<ApiResult> {
    const post = method === "chat.postEphemeral";
    const url = new URL(`https://slack.com/api/${method}`);
    if (!post) for (const [key, value] of Object.entries(payload)) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.fetcher(url, { method: post ? "POST" : "GET",
        headers: { authorization: `Bearer ${this.token}`, ...(post ? { "content-type": "application/json" } : {}) },
        ...(post ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(8000) });
    } catch { throw new SlackError("connection_or_delivery_uncertain"); }
    if (response.status === 429) {
      const retry = Number(response.headers.get("retry-after") || "60");
      throw new SlackError("ratelimited", Number.isFinite(retry) ? Math.max(1, Math.min(86_400, retry)) : 60);
    }
    if (!response.ok) throw new SlackError(`http_${response.status}`);
    let result: ApiResult;
    try { result = await response.json() as ApiResult; }
    catch { throw new SlackError("invalid_response"); }
    if (!result.ok) throw new SlackError(typeof result.error === "string" ? result.error : "unknown_error");
    return result;
  }

  async user(id: string): Promise<SlackUser> {
    const cached = this.users.get(id);
    if (cached) return cached;
    const result = await this.call("users.info", { user: id });
    const user = result.user as SlackUser | undefined;
    if (!user || user.id !== id) throw new SlackError("invalid_user");
    this.users.set(id, user);
    return user;
  }

  async members(channel: string): Promise<string[]> {
    const members: string[] = [];
    const cursors = new Set<string>();
    let cursor = "";
    do {
      if (cursors.has(cursor)) throw new SlackError("invalid_pagination");
      cursors.add(cursor);
      const result = await this.call("conversations.members", { channel, limit: 200, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.members) || result.members.some(id => typeof id !== "string")) throw new SlackError("invalid_members");
      members.push(...result.members as string[]);
      cursor = (result.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || "";
    } while (cursor);
    return [...new Set(members)];
  }

  async permalink(channel: string, ts: string): Promise<string | undefined> {
    const result = await this.call("chat.getPermalink", { channel, message_ts: ts });
    return typeof result.permalink === "string" ? result.permalink : undefined;
  }

  async postEphemeral(notice: EphemeralNotice): Promise<void> { await this.call("chat.postEphemeral", notice); }
}
