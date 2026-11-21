import dayjs from "dayjs";
import { createHash } from "node:crypto";
import type { AppConfig, DeliveryTask, JobStore, ParseTask, TaskQueue } from "./contracts.js";
import type { SourceMessage } from "./types.js";
import type { TimeExtractor } from "./providers.js";
import type { SlackGateway } from "./slack-api.js";
import { SlackError } from "./slack-api.js";
import { isSupportedTimezone, validateExtraction } from "./time.js";
import { renderNotice } from "./render.js";

export type Log = (event: string, details?: Record<string, unknown>) => void;
export class RetryDelivery extends Error {
  constructor(public readonly retryAfterSeconds = 5) { super("Delivery deferred"); this.name = "RetryDelivery"; }
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class TimezoneApp {
  constructor(private readonly config: AppConfig, private readonly store: JobStore, private readonly queue: TaskQueue,
    private readonly slack: SlackGateway, private readonly extractor?: TimeExtractor,
    private readonly log: Log = () => {}, private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  private allowed(channel: string): boolean { return this.config.allowedChannels.size === 0 || this.config.allowedChannels.has(channel); }
  private expired(task: ParseTask | DeliveryTask): boolean {
    const reference = task.source.requestedBy ? task.receivedAt : Number(task.source.ts) * 1000;
    return !Number.isFinite(reference) || this.clock() - reference > this.config.maxMessageAgeSeconds * 1000 || reference > this.clock() + 60_000;
  }
  private async current(task: ParseTask | DeliveryTask): Promise<boolean> {
    return this.allowed(task.source.channel) && !this.expired(task) && !(await this.store.isInvalidated(task.source.channel, task.source.ts,
      task.source.requestedBy ? task.receivedAt : undefined, task.source.requestedBy ? task.source.revision : undefined));
  }

  async ingest(raw: unknown): Promise<void> {
    const body = record(raw);
    let source: SourceMessage | undefined;
    let id: string | undefined;
    if (body.type === "event_callback" && body.team_id === this.config.teamId) {
      const event = record(body.event);
      if (event.type !== "message" || typeof event.channel !== "string" || !this.allowed(event.channel)) return;
      if (event.subtype === "message_changed" || event.subtype === "message_deleted") {
        const changed = record(event.message), previous = record(event.previous_message);
        if (event.subtype === "message_changed" && typeof changed.text === "string" && previous.text === changed.text) return;
        const ts = event.deleted_ts ?? changed.ts;
        const edited = record(changed.edited);
        const revision = typeof edited.ts === "string" ? Number(edited.ts) * 1000
          : typeof event.event_ts === "string" ? Number(event.event_ts) * 1000 : this.clock();
        if (typeof ts === "string") await this.store.invalidate(event.channel, ts, revision, event.subtype === "message_deleted");
        return;
      }
      if (event.subtype && event.subtype !== "file_share" && event.subtype !== "me_message") return;
      if (event.bot_id || typeof event.user !== "string" || typeof event.text !== "string" || !event.text.trim() ||
        event.text.length > 8000 || typeof event.ts !== "string" || !/^\d{10,}\.\d+$/.test(event.ts)) return;
      source = { team: this.config.teamId, channel: event.channel, user: event.user, ts: event.ts, text: event.text,
        ...(typeof event.thread_ts === "string" ? { threadTs: event.thread_ts } : {}) };
      id = `message:${source.channel}:${source.ts}`;
    } else if (body.type === "message_action" && body.callback_id === "convert_time" && record(body.team).id === this.config.teamId) {
      const message = record(body.message), channel = record(body.channel), user = record(body.user);
      if (typeof channel.id !== "string" || !this.allowed(channel.id) || typeof user.id !== "string" ||
        typeof message.user !== "string" || typeof message.text !== "string" || !message.text.trim() || message.text.length > 8000 ||
        typeof message.ts !== "string" || !/^\d{10,}\.\d+$/.test(message.ts) || typeof body.trigger_id !== "string") return;
      source = { team: this.config.teamId, channel: channel.id, user: message.user, ts: message.ts, text: message.text,
        requestedBy: user.id, revision: Number(typeof record(message.edited).ts === "string" ? record(message.edited).ts : message.ts) * 1000,
        ...(typeof message.thread_ts === "string" ? { threadTs: message.thread_ts } : {}) };
      id = `shortcut:${createHash("sha256").update(body.trigger_id).digest("hex")}`;
    }
    if (!source || !id) return;
    const task: ParseTask = { kind: "parse", id, source, receivedAt: this.clock() };
    if (!this.expired(task)) await this.queue.parse(task);
  }

  async parse(task: ParseTask): Promise<void> {
    if (!(await this.current(task))) return;
    let cached = await this.store.getParsed(task.id);
    if (!cached) {
      const sender = await this.slack.user(task.source.user);
      if (sender.is_bot || sender.is_app_user || sender.deleted) return;
      let mentions: ReturnType<typeof validateExtraction>["mentions"] = [];
      if (sender.tz && isSupportedTimezone(sender.tz)) {
        if (!(await this.current(task))) return;
        const context = { text: task.source.text, postedAtUtc: dayjs.utc(Number(task.source.ts) * 1000).toISOString(), senderTimezone: sender.tz };
        if (!this.extractor) throw new Error("AI extraction is not configured on this worker");
        const extracted = await this.extractor.extract(context);
        const validated = validateExtraction(extracted.raw, context);
        mentions = validated.mentions;
        this.log("extraction_finished", { provider: extracted.provider, resolved: mentions.length, withheld: validated.rejected.length });
      }
      const recipients = task.source.requestedBy ? [task.source.requestedBy] : mentions.length
        ? (await this.slack.members(task.source.channel)).filter(id => this.config.includeSender || id !== task.source.user) : [];
      const permalink = mentions.length ? await this.slack.permalink(task.source.channel, task.source.ts) : undefined;
      cached = { mentions, recipients, ...(permalink ? { permalink } : {}) };
      await this.store.saveParsed(task.id, cached);
    }
    for (const recipient of cached.recipients) {
      if (!(await this.current(task))) return;
      await this.queue.deliver({ kind: "delivery", id: `${task.id}:${recipient}`,
        source: { ...task.source, text: "" }, recipient, mentions: cached.mentions,
        receivedAt: task.receivedAt, ...(cached.permalink ? { permalink: cached.permalink } : {}) });
    }
  }

  async deliver(task: DeliveryTask & { permalink?: string }): Promise<void> {
    if (!(await this.current(task))) return;
    const cooldown = await this.store.getDeliveryCooldown();
    if (cooldown > this.clock()) throw new RetryDelivery(Math.ceil((cooldown - this.clock()) / 1000));
    // One FIFO message group + an awaited gate also pace cold/replacement workers.
    await this.sleep(1000);
    if (!(await this.current(task))) return;
    const user = await this.slack.user(task.recipient);
    if (user.is_bot || user.is_app_user || user.deleted || user.id === "USLACKBOT") return;
    if (this.config.renderMode === "profile" && (!user.tz || !isSupportedTimezone(user.tz))) {
      this.log("recipient_timezone_unavailable"); return;
    }
    const text = "I couldn’t resolve a precise, unambiguous time in this message. Check the stated time and the sender’s timezone.";
    const content = task.mentions.length ? renderNotice(task.mentions, user, this.config.renderMode, task.permalink)
      : { text, blocks: [{ type: "section", text: { type: "plain_text", text } }] };
    if (!(await this.current(task)) || !(await this.store.claimDelivery(task.id))) return;
    try {
      if (!(await this.current(task))) return;
    } catch (error) { await this.store.releaseDelivery(task.id); throw error; }
    try {
      await this.slack.postEphemeral({ ...content, channel: task.source.channel, user: task.recipient,
        ...(task.source.threadTs ? { thread_ts: task.source.threadTs } : {}) });
    } catch (error) {
      if (error instanceof SlackError && error.code === "ratelimited") {
        await this.store.setDeliveryCooldown(this.clock() + (error.retryAfterSeconds ?? 60) * 1000);
        await this.store.releaseDelivery(task.id);
        throw new RetryDelivery(error.retryAfterSeconds ?? 60);
      }
      this.log("notice_not_confirmed", { kind: error instanceof Error ? error.name : "unknown" });
    }
  }
}
