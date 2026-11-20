import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, SQSEvent, SQSBatchResponse } from "aws-lambda";
import { SQSClient, ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { RetryDelivery, TimezoneApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DynamoJobStore } from "./aws-store.js";
import { SqsTaskQueue } from "./aws-queue.js";
import { configuredExtractor, ProviderError, type TimeExtractor } from "./providers.js";
import { SlackApi, SlackError } from "./slack-api.js";
import { createHttpHandler } from "./http.js";
import type { DeliveryTask, ParseTask } from "./contracts.js";

const log = (event: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...details }));
let warmExtractor: TimeExtractor | undefined;

function services(role: "http" | "parse" | "delivery") {
  const config = loadConfig(process.env, role);
  const required = (key: string): string => {
    const value = process.env[key];
    if (!value) throw new Error(`Missing infrastructure binding: ${key}`);
    return value;
  };
  const store = new DynamoJobStore(required("STATE_TABLE"));
  const queue = new SqsTaskQueue(role === "http" ? required("PARSE_QUEUE_URL") : "",
    role === "http" ? "" : required("DELIVERY_QUEUE_URL"));
  const slack = new SlackApi(config.botToken);
  if (role === "parse") warmExtractor ??= configuredExtractor(config, reason => log("provider_fallback", { reason }));
  return { config, app: new TimezoneApp(config, store, queue, slack, role === "parse" ? warmExtractor : undefined, log) };
}

export async function http(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const { config, app } = services("http");
    return await createHttpHandler(config.signingSecret, body => app.ingest(body))(event);
  } catch {
    log("http_configuration_error");
    return { statusCode: 503, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Service not configured" }) };
  }
}

function queuedTask(raw: string, kind: "parse" | "delivery"): ParseTask | DeliveryTask | undefined {
  let value: ParseTask | DeliveryTask;
  try { value = JSON.parse(raw) as ParseTask | DeliveryTask; } catch { return undefined; }
  if (!value || value.kind !== kind || typeof value.id !== "string" || !Number.isFinite(value.receivedAt) ||
    !value.source || typeof value.source.channel !== "string" || typeof value.source.ts !== "string" ||
    typeof value.source.team !== "string" || typeof value.source.user !== "string" || typeof value.source.text !== "string" ||
    value.source.text.length > 8000) return undefined;
  if (value.kind === "delivery" && (!Array.isArray(value.mentions) || value.mentions.length > 8 || typeof value.recipient !== "string")) return undefined;
  return value;
}

export async function consume(event: SQSEvent, kind: "parse" | "delivery",
  run: (task: ParseTask | DeliveryTask) => Promise<void>,
  defer: (receipt: string, seconds: number) => Promise<void>,
  report: typeof log = log): Promise<SQSBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (let index = 0; index < event.Records.length; index++) {
    const message = event.Records[index]!;
    const task = queuedTask(message.body, kind);
    if (!task) { report("invalid_queue_task_discarded"); continue; }
    try { await run(task); }
    catch (error) {
      if (error instanceof ProviderError && !error.unavailable) {
        report("provider_configuration_or_output_error", { provider: error.provider, status: error.status, category: error.category });
        continue;
      }
      if (error instanceof SlackError && error.code !== "ratelimited"
        && error.code !== "connection_or_delivery_uncertain" && !/^http_5\d\d$/.test(error.code)) {
        report("slack_request_rejected", { code: error.code });
        continue;
      }
      if (error instanceof RetryDelivery || error instanceof SlackError && error.code === "ratelimited") {
        const seconds = Math.max(1, Math.min(43_200, Math.ceil(error.retryAfterSeconds ?? 60)));
        try { await defer(message.receiptHandle, seconds); }
        catch { report("queue_retry_delay_not_confirmed"); }
      }
      report("queue_task_retry", { kind: error instanceof Error ? error.name : "unknown" });
      for (const remaining of event.Records.slice(index)) batchItemFailures.push({ itemIdentifier: remaining.messageId });
      break;
    }
  }
  return { batchItemFailures };
}

function defer(queueUrl: string) {
  const client = new SQSClient({});
  return async (receipt: string, seconds: number): Promise<void> => {
    await client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt, VisibilityTimeout: seconds }));
  };
}

export async function parse(event: SQSEvent): Promise<SQSBatchResponse> {
  const { app, config } = services("parse");
  return consume(event, "parse", async task => {
    if (task.source.team === config.teamId) await app.parse(task as ParseTask);
  }, defer(process.env.PARSE_QUEUE_URL!));
}

export async function deliver(event: SQSEvent): Promise<SQSBatchResponse> {
  const { app, config } = services("delivery");
  return consume(event, "delivery", async task => {
    if (task.source.team === config.teamId) await app.deliver(task as DeliveryTask);
  }, defer(process.env.DELIVERY_QUEUE_URL!));
}
