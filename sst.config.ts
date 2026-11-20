/// <reference path="./.sst/platform/config.d.ts" />
import { runtimeOptions } from "./src/options.js";

export default $config({
  app() {
    return { name: "func-timezones", home: "aws", removal: "remove", providers: { aws: { region: process.env.AWS_REGION || "us-east-1" } } };
  },
  async run() {
    const providerKeys = new sst.Secret("ProviderKeys", "{}");
    const slackCredentials = new sst.Secret("SlackCredentials", "{}");
    const state = new sst.aws.Dynamo("State", {
      fields: { id: "string" }, primaryIndex: { hashKey: "id" }, ttl: "expiresAt",
      transform: { table: { pointInTimeRecovery: { enabled: false } } },
    });
    const queueSettings = { fifo: true, transform: { queue: { sqsManagedSseEnabled: true, messageRetentionSeconds: 86_400 } } };
    const parseDeadLetters = new sst.aws.Queue("ParseDeadLetters", queueSettings);
    const deliveryDeadLetters = new sst.aws.Queue("DeliveryDeadLetters", queueSettings);
    const parseQueue = new sst.aws.Queue("ParseQueue", { ...queueSettings,
      visibilityTimeout: "360 seconds", dlq: { queue: parseDeadLetters.arn, retry: 5 } });
    const deliveryQueue = new sst.aws.Queue("DeliveryQueue", { ...queueSettings,
      visibilityTimeout: "270 seconds", dlq: { queue: deliveryDeadLetters.arn, retry: 5 } });
    const options = runtimeOptions(process.env);
    const signingCredentials = slackCredentials.value.apply(raw => {
      const value = JSON.parse(raw); return JSON.stringify({ signingSecret: value.signingSecret, teamId: value.teamId });
    });
    const botCredentials = slackCredentials.value.apply(raw => {
      const value = JSON.parse(raw); return JSON.stringify({ botToken: value.botToken, teamId: value.teamId });
    });
    const environment = { ...options, STATE_TABLE: state.name };
    const common = { runtime: "nodejs22.x" as const, memory: "512 MB" as const,
      logging: { retention: "1 week" as const } };
    const statePermissions = (actions: string[]) => ({ actions: actions.map(action => `dynamodb:${action}`), resources: [state.arn] });
    const receiver = new sst.aws.Function("SlackEndpoint", {
      ...common, handler: "src/functions.http", timeout: "10 seconds", url: { cors: false },
      environment: { ...environment, SLACK_CREDENTIALS: signingCredentials, PARSE_QUEUE_URL: parseQueue.url },
      permissions: [statePermissions(["PutItem"]), { actions: ["sqs:SendMessage"], resources: [parseQueue.arn] }],
    });
    parseQueue.subscribe({
      ...common, handler: "src/functions.parse", timeout: "60 seconds",
      environment: { ...environment, SLACK_CREDENTIALS: botCredentials, PROVIDER_KEYS: providerKeys.value,
        PARSE_QUEUE_URL: parseQueue.url, DELIVERY_QUEUE_URL: deliveryQueue.url },
      permissions: [statePermissions(["GetItem", "PutItem"]), { actions: ["sqs:SendMessage"], resources: [deliveryQueue.arn] }],
    }, { batch: { size: 1, partialResponses: true } });
    deliveryQueue.subscribe({
      ...common, handler: "src/functions.deliver", timeout: "45 seconds",
      environment: { ...environment, SLACK_CREDENTIALS: botCredentials, DELIVERY_QUEUE_URL: deliveryQueue.url },
      permissions: [statePermissions(["GetItem", "PutItem", "DeleteItem"])],
    }, { batch: { size: 1, partialResponses: true } });
    return { slackEndpoint: receiver.url.apply(url => new URL("slack", url).toString()) };
  },
});
