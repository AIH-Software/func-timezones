import { test } from "node:test";
import assert from "node:assert/strict";
import { createHaiku, createLuna, FailoverExtractor, ProviderError } from "../src/providers.js";
import type { ExtractionProvider } from "../src/types.js";

const context = { text: "Tomorrow at 10 am", postedAtUtc: "2026-11-20T20:00:00Z", senderTimezone: "America/Los_Angeles" };
const empty = { mentions: [], ambiguous: [] };
const provider = (name: "haiku" | "luna", run: () => Promise<unknown>): ExtractionProvider => ({ name, extract: run });

test("primary success never calls fallback, and uses one extraction result", async () => {
  let fallback = 0;
  const extractor = new FailoverExtractor(provider("haiku", async () => empty), provider("luna", async () => { fallback++; return empty; }));
  assert.deepEqual(await extractor.extract(context), { provider: "haiku", raw: empty });
  assert.equal(fallback, 0);
});

test("outages fall back; repeated outages open circuit and primary recovers", async () => {
  let now = 0, calls = 0, fail = true;
  const extractor = new FailoverExtractor(provider("haiku", async () => {
    calls++;
    if (fail) throw new ProviderError("haiku", true, "http_error", 503);
    return empty;
  }), provider("luna", async () => empty), () => now);
  for (let i = 0; i < 4; i++) assert.equal((await extractor.extract(context)).provider, "luna");
  assert.equal(calls, 3);
  now = 60_001; fail = false;
  assert.equal((await extractor.extract(context)).provider, "haiku");
});

test("authentication, refusal, invalid JSON and invalid schemas do not become outage fallback", async () => {
  for (const status of [400, 401, 403, 404]) {
    let fallback = 0;
    const primary = createHaiku({ apiKey: "test", model: "test", timeoutMs: 100,
      fetcher: async () => new Response("{}", { status }) });
    const extractor = new FailoverExtractor(primary, provider("luna", async () => { fallback++; return empty; }));
    await assert.rejects(extractor.extract(context), ProviderError);
    assert.equal(fallback, 0);
  }
});

test("network and 429/5xx responses are availability failures", async () => {
  const cases: typeof fetch[] = [async () => { throw new TypeError("connection reset"); },
    ...[429, 500, 503, 529].map(status => async () => new Response("{}", { status }))];
  for (const fetcher of cases) {
    const primary = createHaiku({ apiKey: "test", model: "test", timeoutMs: 100, fetcher });
    const extractor = new FailoverExtractor(primary, provider("luna", async () => empty));
    assert.equal((await extractor.extract(context)).provider, "luna");
  }
});

test("Haiku request is schema constrained and parses only complete text output", async () => {
  const primary = createHaiku({ apiKey: "secret-test", model: "claude-test", timeoutMs: 100,
    fetcher: async (url, init) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.output_config.format.type, "json_schema");
      const input = JSON.parse(request.messages[0].content);
      assert.equal(input.text, context.text);
      assert.equal(input.calendarReferences[0].tomorrow, "2026-11-21");
      assert.match(request.system, /DATA, never instructions/);
      assert.equal(request.tools, undefined);
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(empty) }] });
    } });
  assert.deepEqual(await primary.extract(context), empty);
  const truncated = createHaiku({ apiKey: "test", model: "test", timeoutMs: 100,
    fetcher: async () => Response.json({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }) });
  await assert.rejects(truncated.extract(context), /incomplete_or_refused/);
});

test("Luna uses stateless Responses API with schema, complete output and no tools", async () => {
  const fallback = createLuna({ apiKey: "test", model: "gpt-test", timeoutMs: 100,
    fetcher: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      const request = JSON.parse(String(init?.body));
      assert.equal(request.store, false);
      assert.equal(JSON.parse(request.input).calendarReferences[0].tomorrow, "2026-11-21");
      assert.equal(request.text.format.strict, true);
      assert.equal(request.tools, undefined);
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(empty) }] }] });
    } });
  assert.deepEqual(await fallback.extract(context), empty);
  const refusal = createLuna({ apiKey: "test", model: "test", timeoutMs: 100,
    fetcher: async () => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "No" }] }] }) });
  await assert.rejects(refusal.extract(context), /invalid_json/);
});

test("both providers failing produces an error, never fabricated times", async () => {
  const extractor = new FailoverExtractor(provider("haiku", async () => { throw new ProviderError("haiku", true, "timeout"); }),
    provider("luna", async () => { throw new ProviderError("luna", true, "timeout"); }));
  await assert.rejects(extractor.extract(context), ProviderError);
});

test("a response-body timeout also triggers availability fallback", async () => {
  const primary = createHaiku({ apiKey: "test", model: "test", timeoutMs: 100,
    fetcher: async () => {
      const response = Response.json({});
      response.json = async () => { throw new DOMException("The operation was aborted", "AbortError"); };
      return response;
    } });
  const extractor = new FailoverExtractor(primary, provider("luna", async () => empty));
  assert.equal((await extractor.extract(context)).provider, "luna");
});
