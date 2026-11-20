import assert from "node:assert/strict";
import { test } from "node:test";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoJobStore } from "../src/aws-store.js";
import { SqsTaskQueue } from "../src/aws-queue.js";
import type { DeliveryTask, ParsedJob, ParseTask } from "../src/contracts.js";

const parsed: ParsedJob = {
  mentions: [{
    text: "midnight UTC", timezone: "UTC", timezoneBasis: "explicit", dateBasis: "explicit",
    start: { local: "1970-01-01T00:00:00", utc: "1970-01-01T00:00:00Z" }, startUnix: 0,
    end: null, endUnix: null,
  }],
  recipients: ["U01", "W02"],
  permalink: "https://app.slack.com/archives/C02/p10000000",
};

test("message invalidation uses a consistent read and ignores expired DynamoDB items", async () => {
  let now = 10_000;
  let item: Record<string, unknown> | undefined;
  const store = new DynamoJobStore("jobs", {
    now: () => now,
    send: async (command) => {
      if (command instanceof PutCommand) {
        assert.equal(command.input.TableName, "jobs");
        item = command.input.Item;
      } else {
        assert.ok(command instanceof GetCommand);
        assert.deepEqual(command.input, {
          TableName: "jobs", ConsistentRead: true, Key: { id: "invalidate:C02:10.000000" },
        });
      }
      return { Item: item };
    },
  });

  assert.equal(await store.isInvalidated("C02", "10.000000"), false);
  await store.invalidate("C02", "10.000000");
  assert.deepEqual(item, {
    id: "invalidate:C02:10.000000", invalidatedAt: 10_000,
    sourceRevision: 10_000, deleted: false, expiresAt: 86_410,
  });
  now = 86_409_999;
  assert.equal(await store.isInvalidated("C02", "10.000000"), true);
  now++;
  assert.equal(await store.isInvalidated("C02", "10.000000"), false);
});

function invalidationFixture() {
  let now = 10_100;
  let item: Record<string, unknown> | undefined;
  const store = new DynamoJobStore("jobs", {
    now: () => now,
    send: async (command) => {
      if (command instanceof PutCommand) {
        const revision = command.input.ExpressionAttributeValues?.[":revision"];
        const deleting = command.input.Item?.deleted === true;
        assert.equal(command.input.ConditionExpression, deleting
          ? "attribute_not_exists(#sourceRevision) OR #sourceRevision <= :revision"
          : "attribute_not_exists(#sourceRevision) OR #sourceRevision < :revision");
        if (typeof item?.sourceRevision === "number"
          && (item.sourceRevision > revision || (item.sourceRevision === revision && !deleting))) {
          throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
        }
        item = command.input.Item;
      }
      return { Item: item };
    },
  });
  return { store, setNow: (value: number) => { now = value; } };
}

test("shortcuts without a known snapshot revision use the receipt time", async () => {
  const { store, setNow } = invalidationFixture();
  await store.invalidate("C02", "10.000000");
  setNow(10_300);
  const requestedAt = 10_200;
  assert.equal(await store.isInvalidated("C02", "10.000000", requestedAt), false);
  assert.equal(await store.isInvalidated("C02", "10.000000"), true);
  await store.invalidate("C02", "10.000000");
  assert.equal(await store.isInvalidated("C02", "10.000000", requestedAt), true);
  assert.equal(await store.isInvalidated("C02", "10.000000", 10_300), true);

  // An older write that finishes later cannot replace the newer invalidation.
  setNow(10_150);
  await store.invalidate("C02", "10.000000");
  assert.equal(await store.isInvalidated("C02", "10.000000", requestedAt), true);
});

test("an edited snapshot stays usable and a delayed shortcut on an older revision is blocked", async () => {
  const { store, setNow } = invalidationFixture();
  const source = ["C02", "10.000000"] as const;
  const firstEdit = 10_050.001;
  await store.invalidate(...source, firstEdit);
  const receivedAt = 10_200;
  assert.equal(await store.isInvalidated(...source, receivedAt, 10_000), true);
  assert.equal(await store.isInvalidated(...source, receivedAt, firstEdit), false);
  assert.equal(await store.isInvalidated(...source), true);

  setNow(10_300);
  await store.invalidate(...source, 10_205.002);
  assert.equal(await store.isInvalidated(...source, receivedAt, firstEdit), true);
});

test("a deletion blocks shortcuts and survives delayed edits and edits at the same revision", async () => {
  const { store, setNow } = invalidationFixture();
  const source = ["C02", "10.000000"] as const;
  const revision = 10_050.001;
  await store.invalidate(...source, revision);
  await store.invalidate(...source, revision, true);
  assert.equal(await store.isInvalidated(...source, 10_200, revision), true);

  setNow(10_300);
  await store.invalidate(...source, revision);
  await store.invalidate(...source, revision - 0.001);
  assert.equal(await store.isInvalidated(...source, 10_400, revision), true);
  assert.equal(await store.isInvalidated(...source, 10_400, revision + 1), true);
});

test("an active invalidation with a missing or invalid time still blocks shortcuts", async () => {
  for (const invalidatedAt of [undefined, "10000", -1, NaN]) {
    const store = new DynamoJobStore("jobs", {
      now: () => 20_000,
      send: async () => ({ Item: { expiresAt: 86_410, invalidatedAt } }),
    });
    assert.equal(await store.isInvalidated("C02", "10.000000", 15_000), true);
  }
});

test("revision-aware shortcuts fail closed for malformed invalidation metadata", async () => {
  for (const item of [
    { invalidatedAt: 10_000, deleted: false },
    { invalidatedAt: 10_000, deleted: false, sourceRevision: "10000" },
    { invalidatedAt: 10_000, sourceRevision: 10_000 },
  ]) {
    const store = new DynamoJobStore("jobs", {
      now: () => 20_000,
      send: async () => ({ Item: { expiresAt: 86_410, ...item } }),
    });
    assert.equal(await store.isInvalidated("C02", "10.000000", 15_000, 15_000), true);
  }
});

test("the parsed cache retains only the permitted fields and expires at the configured limit", async () => {
  let now = 10_000;
  let item: Record<string, unknown> | undefined;
  const store = new DynamoJobStore("jobs", {
    parsedTtlSeconds: 120,
    now: () => now,
    send: async (command) => {
      if (command instanceof PutCommand) {
        item = command.input.Item;
      } else {
        assert.ok(command instanceof GetCommand);
        assert.deepEqual(command.input, { TableName: "jobs", Key: { id: "parsed:task" }, ConsistentRead: true });
      }
      return { Item: item };
    },
  });
  const value = {
    ...parsed, source: { text: "Full message quoted here." },
    mentions: parsed.mentions.map((mention) => ({ ...mention, privateField: "unrelated source text" })),
  };

  await store.saveParsed("task", value);
  assert.deepEqual(item, { ...parsed, id: "parsed:task", expiresAt: 130 });
  assert.deepEqual(await store.getParsed("task"), parsed);
  now = 130_000;
  assert.equal(await store.getParsed("task"), undefined);
});

test("malformed parsed entries cannot reach rendering or delivery", async () => {
  for (const invalid of [
    { ...parsed, recipients: ["<@channel>"] },
    { ...parsed, permalink: "javascript:alert(1)" },
    { ...parsed, mentions: [{ ...parsed.mentions[0], startUnix: "0" }] },
    { ...parsed, mentions: [{ ...parsed.mentions[0], startUnix: 1 }] },
    { ...parsed, mentions: [{ ...parsed.mentions[0], endUnix: 0 }] },
    { ...parsed, mentions: [{ ...parsed.mentions[0], start: { local: "today", utc: "1970-01-01T00:00:00Z" } }] },
  ]) {
    const store = new DynamoJobStore("jobs", { now: () => 0, send: async () => ({
      Item: { ...invalid, expiresAt: 600 },
    }) });
    assert.equal(await store.getParsed("task"), undefined);
  }
});

test("delivery claims are conditional and only an explicit release removes a claim", async () => {
  const sent: Array<PutCommand | DeleteCommand> = [];
  let expiresAt: number | undefined;
  let now = 10_000;
  const store = new DynamoJobStore("jobs", {
    now: () => now,
    send: async (command) => {
      assert.ok(command instanceof PutCommand || command instanceof DeleteCommand);
      sent.push(command);
      if (command instanceof PutCommand) {
        if (expiresAt !== undefined && expiresAt > command.input.ExpressionAttributeValues?.[":now"]) {
          throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
        }
        expiresAt = command.input.Item?.expiresAt;
      } else {
        expiresAt = undefined;
      }
      return {};
    },
  });

  assert.deepEqual(await Promise.all([store.claimDelivery("task"), store.claimDelivery("task")]), [true, false]);
  assert.deepEqual(sent[0]?.input, {
    TableName: "jobs", Item: { id: "delivery:task", expiresAt: 86_410 },
    ConditionExpression: "attribute_not_exists(#id) OR #expiresAt <= :now",
    ExpressionAttributeNames: { "#id": "id", "#expiresAt": "expiresAt" },
    ExpressionAttributeValues: { ":now": 10 },
  });
  await store.releaseDelivery("task");
  assert.deepEqual(sent[2]?.input, { TableName: "jobs", Key: { id: "delivery:task" } });
  assert.equal(await store.claimDelivery("task"), true);
  now = 86_410_000;
  assert.equal(await store.claimDelivery("task"), true);
});

test("claim storage failures surface to the worker", async () => {
  const error = new Error("test transport unavailable");
  const store = new DynamoJobStore("jobs", { send: async () => { throw error; } });
  await assert.rejects(store.claimDelivery("task"), (cause: unknown) => cause === error);
});

test("an active workspace cooldown persists across workers and concurrent updates cannot shorten it", async () => {
  let now = 10_000;
  let item: Record<string, unknown> | undefined;
  const send: ConstructorParameters<typeof DynamoJobStore>[1] = {
    now: () => now,
    send: async (command) => {
      if (command instanceof PutCommand) {
        assert.equal(command.input.ConditionExpression, "attribute_not_exists(#id) OR #blockedUntil < :until");
        if (typeof item?.blockedUntil === "number" && item.blockedUntil >= command.input.ExpressionAttributeValues?.[":until"]) {
          throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
        }
        item = command.input.Item;
      } else {
        assert.ok(command instanceof GetCommand);
        assert.deepEqual(command.input, { TableName: "jobs", Key: { id: "rate:delivery" }, ConsistentRead: true });
      }
      return { Item: item };
    },
  };

  const firstWorker = new DynamoJobStore("jobs", send);
  const nextWorker = new DynamoJobStore("jobs", send);
  assert.equal(await firstWorker.getDeliveryCooldown(), 0);
  await firstWorker.setDeliveryCooldown(20_050);
  await nextWorker.setDeliveryCooldown(18_000);
  assert.deepEqual(item, { id: "rate:delivery", blockedUntil: 20_050, expiresAt: 21 });
  now = 20_049;
  assert.equal(await nextWorker.getDeliveryCooldown(), 20_050);
  now++;
  assert.equal(await nextWorker.getDeliveryCooldown(), 0);
  await nextWorker.setDeliveryCooldown(200_000_000);
  assert.equal(await firstWorker.getDeliveryCooldown(), now + 86_400_000);
});

test("tasks route to separate FIFO queues with stable, bounded deduplication IDs", async () => {
  const sent: SendMessageCommand[] = [];
  const queue = new SqsTaskQueue("https://example.test/parse.fifo", "https://example.test/deliver.fifo", {
    send: async (command) => sent.push(command),
  });
  const parse: ParseTask = {
    kind: "parse", id: "parse:" + "p".repeat(200), receivedAt: 10_000,
    source: { team: "T01", channel: "C02", ts: "10.000000", user: "U01", text: "At noon." },
  };
  const delivery: DeliveryTask = {
    ...parse, kind: "delivery", id: "original-for:W02", recipient: "W02", mentions: parsed.mentions,
  };

  await queue.parse(parse);
  await queue.parse(parse);
  await queue.deliver(delivery);
  await queue.deliver({ ...delivery, id: "original-for:U03", recipient: "U03" });

  const [first, repeated, toRecipient, toOtherRecipient] = sent.map((command) => command.input);
  assert.equal(first?.QueueUrl, "https://example.test/parse.fifo");
  assert.equal(first?.MessageBody, JSON.stringify(parse));
  assert.equal(toRecipient?.QueueUrl, "https://example.test/deliver.fifo");
  assert.equal(toRecipient?.MessageBody, JSON.stringify(delivery));
  for (const command of sent) {
    assert.equal(command.input.MessageGroupId, "workspace");
    assert.match(command.input.MessageDeduplicationId ?? "", /^[a-f0-9]{64}$/);
  }
  assert.equal(first?.MessageDeduplicationId, repeated?.MessageDeduplicationId);
  assert.notEqual(toRecipient?.MessageDeduplicationId, toOtherRecipient?.MessageDeduplicationId);
});
