import { createHash } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { DeliveryTask, ParseTask, TaskQueue } from "./contracts.js";

interface SqsTaskQueueOptions {
  client?: SQSClient;
  send?: (command: SendMessageCommand) => Promise<unknown>;
}

function createSender(client = new SQSClient({})) {
  return (command: SendMessageCommand) => client.send(command);
}

export class SqsTaskQueue implements TaskQueue {
  private readonly send: (command: SendMessageCommand) => Promise<unknown>;

  constructor(
    private readonly parseQueueUrl: string,
    private readonly deliveryQueueUrl: string,
    options: SqsTaskQueueOptions = {},
  ) {
    this.send = options.send ?? createSender(options.client);
  }

  async parse(task: ParseTask): Promise<void> {
    await this.enqueue(this.parseQueueUrl, task);
  }

  async deliver(task: DeliveryTask): Promise<void> {
    await this.enqueue(this.deliveryQueueUrl, task);
  }

  private async enqueue(url: string, task: ParseTask | DeliveryTask): Promise<void> {
    await this.send(new SendMessageCommand({
      QueueUrl: url,
      MessageGroupId: "workspace",
      MessageDeduplicationId: createHash("sha256").update(task.id).digest("hex"),
      MessageBody: JSON.stringify(task),
    }));
  }
}
