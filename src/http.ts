import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createHmac, timingSafeEqual } from "node:crypto";

export function validSlackSignature(raw: string, headers: Record<string, string | undefined>, secret: string,
  now: number = Date.now()): boolean {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const timestamp = normalized["x-slack-request-timestamp"], signature = normalized["x-slack-signature"];
  if (!timestamp || !/^\d{10,12}$/.test(timestamp) || !signature || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex")}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createHttpHandler(secret: string, receive: (body: unknown) => Promise<void>, clock: () => number = Date.now) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const respond = (statusCode: number, value: object): APIGatewayProxyStructuredResultV2 => ({
      statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value),
    });
    if (event.requestContext.http.method !== "POST") return respond(405, { error: "Method not allowed" });
    if (event.rawPath !== "/slack" && event.rawPath !== "/slack/") return respond(404, { error: "Not found" });
    if (!event.body || event.body.length > 180_000) return respond(400, { error: "Invalid request" });
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    if (!validSlackSignature(raw, event.headers, secret, clock())) return respond(401, { error: "Invalid signature" });
    let body: unknown;
    try {
      const contentType = Object.entries(event.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "";
      body = JSON.parse(contentType.includes("application/x-www-form-urlencoded")
        ? new URLSearchParams(raw).get("payload") || "" : raw);
    } catch { return respond(400, { error: "Invalid payload" }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return respond(400, { error: "Invalid payload" });
    const item = body as Record<string, unknown>;
    if (item.type === "url_verification" && typeof item.challenge === "string" && item.challenge.length <= 200) {
      return respond(200, { challenge: item.challenge });
    }
    try { await receive(body); }
    catch { return respond(503, { error: "Temporarily unavailable" }); }
    return respond(200, { ok: true });
  };
}
