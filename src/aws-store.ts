import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { JobStore, ParsedJob } from "./contracts.js";
import type { ResolvedMention, TimeEndpoint } from "./types.js";

const oneDaySeconds = 24 * 60 * 60;
const maxParsedTtlSeconds = 10 * 60;
const deliveryCooldownKey = "rate:delivery";

type StoreCommand = GetCommand | PutCommand | DeleteCommand;

interface DynamoJobStoreOptions {
  client?: DynamoDBDocumentClient;
  send?: (command: StoreCommand) => Promise<unknown>;
  now?: () => number;
  parsedTtlSeconds?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRevision(value: unknown): value is number {
  // Slack timestamps can include fractions of a millisecond.
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return isRecord(error) && error.name === "ConditionalCheckFailedException";
}

function isEndpoint(value: unknown): value is TimeEndpoint {
  return isRecord(value) && typeof value.local === "string" && typeof value.utc === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value.local)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.utc);
}

function isResolvedMention(value: unknown): value is ResolvedMention {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 200
    || typeof value.timezone !== "string" || !value.timezone
    || (value.timezoneBasis !== "explicit" && value.timezoneBasis !== "sender")
    || (value.dateBasis !== "explicit" && value.dateBasis !== "relative" && value.dateBasis !== "message_date")
    || !isEndpoint(value.start) || !isInteger(value.startUnix)
    || Date.parse(value.start.utc) / 1000 !== value.startUnix) return false;

  if (value.end === null) return value.endUnix === null;
  return isEndpoint(value.end) && isInteger(value.endUnix) && value.endUnix > value.startUnix
    && Date.parse(value.end.utc) / 1000 === value.endUnix;
}

function parsedJob(value: Record<string, unknown>): ParsedJob | undefined {
  const { mentions, recipients, permalink } = value;
  if (!Array.isArray(mentions) || mentions.length > 8 || !mentions.every(isResolvedMention)
    || !Array.isArray(recipients) || !recipients.every((id: unknown) => typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id))
    || (permalink !== undefined && (typeof permalink !== "string" || !/^https:\/\/[^\s<>|]+$/.test(permalink)))) {
    return undefined;
  }

  return {
    mentions: mentions.map(({ text, timezone, timezoneBasis, dateBasis, start, end, startUnix, endUnix }) => ({
      text, timezone, timezoneBasis, dateBasis,
      start: { local: start.local, utc: start.utc },
      end: end === null ? null : { local: end.local, utc: end.utc },
      startUnix, endUnix,
    })),
    recipients: [...recipients],
    ...(permalink === undefined ? {} : { permalink }),
  };
}

function createSender(client = DynamoDBDocumentClient.from(new DynamoDBClient({}))) {
  return (command: StoreCommand) => {
    if (command instanceof GetCommand) return client.send(command);
    if (command instanceof PutCommand) return client.send(command);
    return client.send(command);
  };
}

export class DynamoJobStore implements JobStore {
  private readonly send: (command: StoreCommand) => Promise<unknown>;
  private readonly now: () => number;
  private readonly parsedTtlSeconds: number;

  constructor(private readonly tableName: string, options: DynamoJobStoreOptions = {}) {
    this.send = options.send ?? createSender(options.client);
    this.now = options.now ?? Date.now;
    this.parsedTtlSeconds = Math.min(maxParsedTtlSeconds, options.parsedTtlSeconds ?? maxParsedTtlSeconds);
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private async read(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.send(new GetCommand({
      TableName: this.tableName, Key: { id }, ConsistentRead: true,
    }));
    return isRecord(result) && isRecord(result.Item) ? result.Item : undefined;
  }

  async invalidate(channel: string, ts: string, revision?: number, deleted = false): Promise<void> {
    const invalidatedAt = this.now();
    const sourceRevision = isRevision(revision) ? revision : invalidatedAt;
    const comparison = deleted ? "<=" : "<";
    try {
      await this.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          id: `invalidate:${channel}:${ts}`, invalidatedAt, sourceRevision, deleted,
          expiresAt: Math.ceil(invalidatedAt / 1000) + oneDaySeconds,
        },
        ConditionExpression: `attribute_not_exists(#sourceRevision) OR #sourceRevision ${comparison} :revision`,
        ExpressionAttributeNames: { "#sourceRevision": "sourceRevision" },
        ExpressionAttributeValues: { ":revision": sourceRevision },
      }));
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
  }

  async isInvalidated(channel: string, ts: string, since?: number, revision?: number): Promise<boolean> {
    const item = await this.read(`invalidate:${channel}:${ts}`);
    if (!item) return false;
    if (!isInteger(item.expiresAt)) return true;
    if (item.expiresAt <= this.nowSeconds()) return false;
    if (!isInteger(since) || !isInteger(item.invalidatedAt) || item.invalidatedAt < 0 || item.deleted === true) return true;
    if (revision === undefined) return item.invalidatedAt >= since;
    return !isRevision(revision) || !isRevision(item.sourceRevision) || item.deleted !== false || item.sourceRevision > revision;
  }

  async getParsed(id: string): Promise<ParsedJob | undefined> {
    const item = await this.read(`parsed:${id}`);
    return item && isInteger(item.expiresAt) && item.expiresAt > this.nowSeconds() ? parsedJob(item) : undefined;
  }

  async saveParsed(id: string, value: ParsedJob): Promise<void> {
    const job = parsedJob({ ...value });
    if (!job) throw new Error("Invalid parsed job.");
    await this.send(new PutCommand({
      TableName: this.tableName,
      Item: { ...job, id: `parsed:${id}`, expiresAt: this.nowSeconds() + this.parsedTtlSeconds },
    }));
  }

  async claimDelivery(id: string): Promise<boolean> {
    const now = this.nowSeconds();
    try {
      await this.send(new PutCommand({
        TableName: this.tableName,
        Item: { id: `delivery:${id}`, expiresAt: now + oneDaySeconds },
        ConditionExpression: "attribute_not_exists(#id) OR #expiresAt <= :now",
        ExpressionAttributeNames: { "#id": "id", "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: { ":now": now },
      }));
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }

  async releaseDelivery(id: string): Promise<void> {
    // The worker calls this for a confirmed rejection while it still owns the FIFO message.
    await this.send(new DeleteCommand({ TableName: this.tableName, Key: { id: `delivery:${id}` } }));
  }

  async getDeliveryCooldown(): Promise<number> {
    const item = await this.read(deliveryCooldownKey);
    if (!item) return 0;
    if (!isInteger(item.expiresAt) || !isInteger(item.blockedUntil)) throw new Error("Invalid delivery cooldown.");
    const now = this.now();
    return item.expiresAt > Math.floor(now / 1000) && item.blockedUntil > now ? item.blockedUntil : 0;
  }

  async setDeliveryCooldown(until: number): Promise<void> {
    if (!isInteger(until)) throw new Error("Invalid delivery cooldown.");
    const now = this.now();
    const blockedUntil = Math.min(until, now + oneDaySeconds * 1000);
    if (blockedUntil <= now) return;

    try {
      await this.send(new PutCommand({
        TableName: this.tableName,
        Item: { id: deliveryCooldownKey, blockedUntil, expiresAt: Math.ceil(blockedUntil / 1000) },
        ConditionExpression: "attribute_not_exists(#id) OR #blockedUntil < :until",
        ExpressionAttributeNames: { "#id": "id", "#blockedUntil": "blockedUntil" },
        ExpressionAttributeValues: { ":until": blockedUntil },
      }));
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
  }
}
