import { test } from "node:test";
import assert from "node:assert/strict";
import type { SQSEvent } from "aws-lambda";
import { loadConfig } from "../src/config.js";
import { configuredExtractor } from "../src/providers.js";
import { consume, http, deliver } from "../src/functions.js";
import { RetryDelivery } from "../src/app.js";
import { SlackError } from "../src/slack-api.js";

const context = { text: "tomorrow at noon", postedAtUtc: "2026-11-20T20:00:00Z", senderTimezone: "America/Los_Angeles" };
const slack = JSON.stringify({ botToken: "test", teamId: "T1", signingSecret: "test" });
const empty = { mentions: [], ambiguous: [] };

for (const mode of ["anthropic", "openai", "both"] as const) {
  test(`runtime supports ${mode} credentials without requiring the other provider`, async t => {
    const keys = mode === "both" ? { anthropic: "test-a", openai: "test-o" } : { [mode]: "test" };
    const config = loadConfig({ SLACK_CREDENTIALS: slack, PROVIDER_KEYS: JSON.stringify(keys) });
    const urls: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string | URL) => {
      urls.push(String(url));
      return String(url).includes("anthropic")
        ? Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(empty) }] })
        : Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(empty) }] }] });
    });
    const result = await configuredExtractor(config).extract(context);
    assert.equal(result.provider, mode === "openai" ? "luna" : "haiku");
    assert.equal(urls.length, 1);
  });
}

test("both-provider runtime switches to Luna only for unavailable Haiku", async t => {
  const config = loadConfig({ SLACK_CREDENTIALS: slack, PROVIDER_KEYS: JSON.stringify({ anthropic: "test", openai: "test" }) });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL) => {
    urls.push(String(url));
    return String(url).includes("anthropic") ? new Response("{}", { status: 503 })
      : Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(empty) }] }] });
  });
  assert.equal((await configuredExtractor(config).extract(context)).provider, "luna");
  assert.equal(urls.length, 2);
});

test("runtime roles accept only the credentials their infrastructure supplies", () => {
  const config = loadConfig({ SLACK_CREDENTIALS: JSON.stringify({ signingSecret: "test", teamId: "T1" }) }, "http");
  assert.equal(config.botToken, ""); assert.equal(config.anthropicKey, undefined);
  const delivery = loadConfig({ SLACK_CREDENTIALS: JSON.stringify({ botToken: "test", teamId: "T1" }) }, "delivery");
  assert.equal(delivery.signingSecret, "");
  assert.throws(() => loadConfig({ SLACK_CREDENTIALS: slack }), /at least one AI/);
});

test("deployed HTTP and delivery entry points do not need AI keys or unused queue bindings", async t => {
  const names = ["SLACK_CREDENTIALS", "PROVIDER_KEYS", "STATE_TABLE", "PARSE_QUEUE_URL", "DELIVERY_QUEUE_URL"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    delete process.env.PROVIDER_KEYS; delete process.env.DELIVERY_QUEUE_URL;
    process.env.SLACK_CREDENTIALS = JSON.stringify({ teamId: "T1", signingSecret: "test" });
    process.env.STATE_TABLE = "test-table"; process.env.PARSE_QUEUE_URL = "https://sqs.example/parse.fifo";
    const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No outgoing requests allowed"); });
    const result = await http({ rawPath: "/slack", requestContext: { http: { method: "POST" } }, headers: {}, body: "{}" } as Parameters<typeof http>[0]);
    assert.equal(result.statusCode, 401);
    process.env.SLACK_CREDENTIALS = JSON.stringify({ teamId: "T1", botToken: "test" });
    delete process.env.PARSE_QUEUE_URL; process.env.DELIVERY_QUEUE_URL = "https://sqs.example/delivery.fifo";
    assert.deepEqual(await deliver({ Records: [] }), { batchItemFailures: [] });
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});

const task = { kind: "delivery", id: "task1", receivedAt: 1, source: { team: "T1", channel: "C1", user: "U1", ts: "1795204800.000001", text: "" }, recipient: "U2", mentions: [] };
const event = (bodies: string[]): SQSEvent => ({ Records: bodies.map((body, index) => ({ body, messageId: `m${index}`, receiptHandle: `r${index}` })) } as SQSEvent);

test("malformed queue JSON is discarded with no source text in logs", async () => {
  const reports: string[] = [];
  const result = await consume(event(["PRIVATE SECRET invalid JSON"]), "delivery", async () => { throw new Error("must not run"); }, async () => {}, name => { reports.push(name); });
  assert.deepEqual(result.batchItemFailures, []);
  assert.deepEqual(reports, ["invalid_queue_task_discarded"]);
});

test("short rate limits defer by the requested duration and preserve FIFO order", async () => {
  const delays: Array<[string, number]> = [];
  let calls = 0;
  const result = await consume(event([JSON.stringify(task), JSON.stringify({ ...task, id: "task2" })]), "delivery", async () => {
    calls++; throw new RetryDelivery(2);
  }, async (receipt, seconds) => { delays.push([receipt, seconds]); }, () => {});
  assert.equal(calls, 1);
  assert.deepEqual(delays, [["r0", 2]]);
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "m0" }, { itemIdentifier: "m1" }]);
});

test("permanent Slack rejection does not poison the delivery FIFO group", async () => {
  const result = await consume(event([JSON.stringify(task)]), "delivery", async () => { throw new SlackError("user_not_in_channel"); }, async () => {}, () => {});
  assert.deepEqual(result.batchItemFailures, []);
});
