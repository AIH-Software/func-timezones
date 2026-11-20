import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHttpHandler } from "../src/http.js";

const secret = "test-signing-secret", now = 1795204801000;
function signed(body: unknown, form = false, base64 = false): APIGatewayProxyEventV2 {
  const raw = form ? new URLSearchParams({ payload: JSON.stringify(body) }).toString() : JSON.stringify(body);
  const timestamp = String(Math.floor(now / 1000));
  return { version: "2.0", routeKey: "$default", rawPath: "/slack", rawQueryString: "",
    headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}` },
    requestContext: { accountId: "test", apiId: "test", domainName: "example.test", domainPrefix: "example",
      http: { method: "POST", path: "/slack", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
      requestId: "test", routeKey: "$default", stage: "$default", time: "test", timeEpoch: now },
    body: base64 ? Buffer.from(raw).toString("base64") : raw, isBase64Encoded: base64 };
}

test("Slack challenge is verified; missing, forged, changed and expired signatures are rejected", async () => {
  let received = 0;
  const handler = createHttpHandler(secret, async () => { received++; }, () => now);
  const event = signed({ type: "url_verification", challenge: "challenge" });
  const result = await handler(event);
  assert.equal(result.statusCode, 200); assert.equal(JSON.parse(String(result.body)).challenge, "challenge");
  assert.equal(received, 0);
  assert.equal((await handler({ ...event, headers: {} })).statusCode, 401);
  assert.equal((await handler({ ...event, body: event.body + " " })).statusCode, 401);
  const old = createHttpHandler(secret, async () => {}, () => now + 301000);
  assert.equal((await old(event)).statusCode, 401);
});

test("signed form shortcuts and base64 bodies are parsed after verification", async () => {
  const values: unknown[] = [];
  const handler = createHttpHandler(secret, async body => { values.push(body); }, () => now);
  const payload = { type: "message_action", callback_id: "convert_time", text: "private" };
  assert.equal((await handler(signed(payload, true, true))).statusCode, 200);
  assert.deepEqual(values, [payload]);
});

test("HTTP success waits for durable enqueue, and persistence failure is not acknowledged", async () => {
  let complete!: () => void, returned = false;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const handler = createHttpHandler(secret, async () => { await gate; }, () => now);
  const result = handler(signed({ type: "event_callback" })).then(value => { returned = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false);
  complete(); assert.equal((await result).statusCode, 200);
  const failed = createHttpHandler(secret, async () => { throw new Error("private input must not leak"); }, () => now);
  const response = await failed(signed({ type: "event_callback" }));
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(String(response.body), /private input/);
});
