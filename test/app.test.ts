import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig, DeliveryTask, JobStore, ParseTask, ParsedJob, TaskQueue } from "../src/contracts.js";
import type { EphemeralNotice, SlackUser } from "../src/types.js";
import type { SlackGateway } from "../src/slack-api.js";
import { SlackError } from "../src/slack-api.js";
import { RetryDelivery, TimezoneApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const now = Date.parse("2026-11-20T20:00:01Z");
const source = { team: "T1", channel: "C1", user: "U1", ts: "1795204800.000001", text: "Tomorrow at 10 am" };
const fixture: ParseTask = { kind: "parse", id: "message:C1:1795204800.000001", source, receivedAt: now };
const raw = { mentions: [{ text: source.text, timezone: "America/Los_Angeles", timezoneBasis: "sender", dateBasis: "relative",
  start: { local: "2026-11-21T10:00:00", utc: "2026-11-21T18:00:00Z" }, end: null }], ambiguous: [] };
const config = loadConfig({ PROVIDER_KEYS: JSON.stringify({ anthropic: "test" }),
  SLACK_CREDENTIALS: JSON.stringify({ teamId: "T1", botToken: "test", signingSecret: "test" }) });

class MemoryStore implements JobStore {
  parsed = new Map<string, ParsedJob>(); claims = new Set<string>(); invalid = false; cooldown = 0;
  async invalidate() { this.invalid = true; }
  async isInvalidated() { return this.invalid; }
  async getParsed(id: string) { return this.parsed.get(id); }
  async saveParsed(id: string, value: ParsedJob) { this.parsed.set(id, value); }
  async claimDelivery(id: string) { if (this.claims.has(id)) return false; this.claims.add(id); return true; }
  async releaseDelivery(id: string) { this.claims.delete(id); }
  async getDeliveryCooldown() { return this.cooldown; }
  async setDeliveryCooldown(until: number) { this.cooldown = Math.max(this.cooldown, until); }
}
class MemoryQueue implements TaskQueue {
  parses: ParseTask[] = []; deliveries: DeliveryTask[] = [];
  async parse(task: ParseTask) { this.parses.push(task); }
  async deliver(task: DeliveryTask) { this.deliveries.push(task); }
}
class SlackMock implements SlackGateway {
  posts: EphemeralNotice[] = [];
  async user(id: string): Promise<SlackUser> { return { id, tz: id === "U1" ? "America/Los_Angeles" : "Asia/Kolkata", is_bot: id === "UBOT" }; }
  async members() { return ["U1", "U2", "U3", "UBOT"]; }
  async permalink() { return "https://example.slack.com/archives/C1/p1795204800000001"; }
  async postEphemeral(notice: EphemeralNotice) { this.posts.push(notice); }
}
function setup(options: { config?: AppConfig; store?: MemoryStore; queue?: MemoryQueue; slack?: SlackMock } = {}) {
  const store = options.store ?? new MemoryStore(), queue = options.queue ?? new MemoryQueue(), slack = options.slack ?? new SlackMock();
  let calls = 0, clock = now;
  const app = new TimezoneApp(options.config ?? config, store, queue, slack,
    { async extract() { calls++; return { provider: "haiku", raw }; } }, () => {}, () => clock, async () => {});
  return { app, store, queue, slack, calls: () => calls, setNow: (value: number) => { clock = value; } };
}

test("ingestion bounds workspace/channel/source and skips bot/system messages", async () => {
  const { app, queue } = setup({ config: { ...config, allowedChannels: new Set(["C1"]) } });
  const event = { type: "message", ...source };
  for (const body of [{ type: "event_callback", team_id: "OTHER", event },
    { type: "event_callback", team_id: "T1", event: { ...event, channel: "C2" } },
    { type: "event_callback", team_id: "T1", event: { ...event, bot_id: "B1" } },
    { type: "event_callback", team_id: "T1", event: { ...event, subtype: "thread_broadcast" } }]) await app.ingest(body);
  assert.equal(queue.parses.length, 0);
  await app.ingest({ type: "event_callback", team_id: "T1", event });
  assert.equal(queue.parses.length, 1);
  assert.equal(queue.parses[0]?.source.text, source.text);
});

test("one extraction is cached across fanout retries; duplicate delivery tasks send at most once", async () => {
  const { app, queue, slack, calls } = setup();
  await app.parse(fixture); await app.parse(fixture);
  assert.equal(calls(), 1);
  assert.equal(queue.deliveries.length, 6);
  assert.equal(queue.deliveries[0]?.source.text, "");
  for (const task of queue.deliveries) await app.deliver(task);
  assert.deepEqual(slack.posts.map(post => post.user), ["U2", "U3"]);
  assert.equal(slack.posts[0]?.text, slack.posts[1]?.text);
  assert.match(JSON.stringify(slack.posts[0]?.blocks), /Original message/);
});

test("edits and expired sources prevent extraction and fanout", async () => {
  const { app, store, calls, queue } = setup();
  store.invalid = true;
  await app.parse(fixture);
  store.invalid = false;
  await app.parse({ ...fixture, source: { ...source, ts: "1600000000.000001" } });
  assert.equal(calls(), 0); assert.equal(queue.deliveries.length, 0);
});

test("bad model UTC proposals are withheld; shortcuts get a private explanation", async () => {
  const store = new MemoryStore(), queue = new MemoryQueue(), slack = new SlackMock();
  const app = new TimezoneApp(config, store, queue, slack, { async extract() {
    return { provider: "haiku", raw: { ...raw, mentions: [{ ...raw.mentions[0], start: { local: "2026-11-21T10:00:00", utc: "2026-11-21T19:00:00Z" } }] } };
  } }, () => {}, () => now, async () => {});
  await app.parse({ ...fixture, id: "shortcut", source: { ...source, requestedBy: "U2" } });
  assert.equal(queue.deliveries[0]?.mentions.length, 0);
  await app.deliver(queue.deliveries[0]!);
  assert.equal(slack.posts.length, 1);
  assert.match(slack.posts[0]!.text, /couldn’t resolve/);
});

test("a profile-mode recipient without a timezone is skipped rather than poisoning the queue", async () => {
  const slack = new SlackMock(); slack.user = async id => ({ id, ...(id === "U1" ? { tz: "America/Los_Angeles" } : {}) });
  const { app, queue } = setup({ config: { ...config, renderMode: "profile" }, slack });
  await app.parse(fixture);
  await app.deliver(queue.deliveries[0]!);
  assert.equal(slack.posts.length, 0);
});

test("confirmed Slack 429 releases the claim and retains a cross-invocation cooldown", async () => {
  const { app, queue, slack, store, setNow } = setup();
  await app.parse(fixture);
  let posts = 0;
  slack.postEphemeral = async () => { posts++; if (posts === 1) throw new SlackError("ratelimited", 2); };
  const task = queue.deliveries[0]!;
  await assert.rejects(app.deliver(task), RetryDelivery);
  assert.equal(store.claims.has(task.id), false);
  assert.equal(store.cooldown, now + 2000);
  await assert.rejects(app.deliver(task), RetryDelivery);
  assert.equal(posts, 1);
  setNow(now + 2001);
  await app.deliver(task);
  assert.equal(posts, 2);
});

test("an uncertain post is not repeated, while a failed read before posting can retry", async () => {
  const { app, queue, slack, store } = setup();
  await app.parse(fixture);
  const task = queue.deliveries[0]!;
  let attempts = 0;
  slack.postEphemeral = async () => { attempts++; throw new SlackError("connection_or_delivery_uncertain"); };
  await app.deliver(task); await app.deliver(task);
  assert.equal(attempts, 1);
  const second = queue.deliveries[1]!;
  let checks = 0;
  store.isInvalidated = async () => { checks++; if (checks === 4) throw new Error("read unavailable"); return false; };
  await assert.rejects(app.deliver(second), /read unavailable/);
  assert.equal(store.claims.has(second.id), false);
});

test("shortcut carries the source revision; metadata-only edits do not invalidate", async () => {
  const { app, queue, store } = setup();
  await app.ingest({ type: "message_action", callback_id: "convert_time", trigger_id: "trigger",
    team: { id: "T1" }, channel: { id: "C1" }, user: { id: "U2" },
    message: { ...source, edited: { ts: "1795204800.123456" } } });
  assert.equal(queue.parses[0]?.source.revision, Number("1795204800.123456") * 1000);
  await app.ingest({ type: "event_callback", team_id: "T1", event: { type: "message", subtype: "message_changed", channel: "C1",
    message: { ...source }, previous_message: { ...source } } });
  assert.equal(store.invalid, false);
});
