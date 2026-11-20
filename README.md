# Func Timezones

See times from Slack messages in your local time zone. When someone writes “Tomorrow at 10 AM Pacific works for me,” Func Timezones checks the proposed conversion and can show each eligible person a private Slack notice. Choose **More actions → Convert time** on a message to request a conversion for yourself.

By default Slack displays the time in the viewer’s device time zone. Set `TIME_RENDER_MODE=profile` to use each viewer’s Slack profile time zone. Slack delivers these notices to active members of the conversation, and they disappear when the session ends. [Slack date formatting](https://docs.slack.dev/messaging/formatting-message-text/#date-formatting) · [Ephemeral delivery](https://docs.slack.dev/reference/methods/chat.postEphemeral/)

## Self-host on AWS

You need Node.js 22.14 or later, an AWS account with credentials authorized for SST to deploy its resources, permission to create and install a Slack app in your workspace, and an Anthropic API key or OpenAI API key. Use one Slack app and workspace per deployment. AWS and model usage are billed to your accounts. [SST AWS credentials](https://sst.dev/docs/aws-accounts/) · [Slack app settings](https://api.slack.com/apps)

```sh
git clone https://github.com/AIH-Software/func-timezones.git
cd func-timezones
npm ci
npm run setup
```

1. From [Your Apps](https://api.slack.com/apps), choose **Create New App → From a manifest**, select your workspace, and paste [slack-manifest.json](slack-manifest.json). Install the app in that workspace.
2. Follow the setup prompts. In the Slack app settings, find the **Bot User OAuth Token** under **OAuth & Permissions** and the **Signing Secret** under **Basic Information**. Enter at least one AI key and both Slack credentials. Each prompt hides the input. The script checks the bot token, saves credentials with SST, and deploys to AWS.
3. Open **App Manifest** for the same Slack app and replace it with `.setup/slack-manifest.production.json` from the deployment. Save and verify the Request URL when Slack prompts you. The generated manifest configures both Event Subscriptions and Interactivity with the deployed `/slack` endpoint. [Slack manifest reference](https://docs.slack.dev/reference/app-manifest/)
4. Invite **Func Timezones** to a test channel. With two active members, have one send “Tomorrow at 10 AM Pacific works for me.” Check for a private conversion as the second member, then try **More actions → Convert time**.

Use `npm run setup -- --stage demo` to deploy a different stage. If you use an AWS profile, set `AWS_PROFILE` in the environment and sign in to it first. For unattended deployment, supply `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` through your environment or CI secret store, then run `npm run setup -- --non-interactive --stage production`. Creating and updating the Slack app still takes place in Slack. The setup script passes credential values to SST through standard input. Rerun setup with the full desired credential set to rotate keys. [SST secret commands](https://sst.dev/docs/reference/cli/#secret)

## Provider behavior

| Configured keys | Model behavior |
| --- | --- |
| Anthropic only | Claude Haiku handles extraction. |
| OpenAI only | GPT-6 Luna handles extraction. |
| Both | Haiku is primary. Luna takes over on timeouts, connection failures, HTTP 429 or server errors. |

Authentication and model configuration failures require operator attention. The app validates proposed times and withholds ambiguous or unsupported conversions. When the message gives no time zone, the app uses the sender’s Slack profile time zone. When it assumes the date from the message timestamp, the notice identifies that assumption.

## Operation and data

The SST stack runs an HTTPS Slack endpoint, Lambda workers, FIFO parse and delivery queues, and a DynamoDB table. Automatic processing covers message events Slack sends to the bot and excludes the sender from notices by default. The shortcut submits the selected message when invoked. Use it in a conversation the bot has joined so it can post the private notice. Set `SLACK_ALLOWED_CHANNELS` to a comma-separated list of conversation IDs to limit both behaviors. [`.env.example`](.env.example) lists the optional deployment settings. Redeploy after changing them through `npm run deploy -- --stage production` or the command for your chosen stage.

Eligible message text, its posting time, and the sender’s time zone are sent to the configured AI provider for extraction. With both keys, a failed primary request can send the same data to the fallback. Parse jobs carry the full message text. Delivery jobs carry the extracted time snippets. Each queue, including each dead-letter queue, retains its messages for up to one day. DynamoDB keeps parsed time snippets and recipient IDs for up to 10 minutes of application reuse, and delivery and edit/delete markers for 24 hours. DynamoDB removes expired rows asynchronously. The app avoids logging raw Slack message text. Review your AI providers’ data controls before enabling this in sensitive channels.

When retiring a stage, disable the app’s subscriptions and interactivity or uninstall the Slack app, then remove the app resources with `npm run remove -- --stage production` using the correct stage. SST keeps its state and bootstrap resources. To clear the stage’s active SST secrets, run `npx sst secret remove ProviderKeys --stage production` and `npx sst secret remove SlackCredentials --stage production` for the retired stage. Revoke credentials issued solely for the retired app. [SST removal and secret commands](https://sst.dev/docs/reference/cli/#remove)

## Develop locally

`npm test` runs offline tests. `npm run demo` shows rendering for a fixed conversion without credentials. See [Contributing](CONTRIBUTING.md) for type checks, builds, and paid model evaluation.

## Limits and verification

The app converts a resolved instant once; Slack renders the date token locally on each recipient’s device. It still sends a separate private message per recipient. A private notice is temporary and is not a permanent annotation under the original message. The source link keeps the conversion associated with its message.

AI interpretation is not guaranteed. A schema-valid UTC proposal is checked against the source clock time, zone, date, and daylight-saving rules. Imprecise or ambiguous phrases are withheld. Spoken expressions and less common place names still depend on the model; evaluate representative messages before broad rollout. See `npm run evaluate -- --provider=both` in Contributing. The included evaluations use synthetic phrases and make paid API calls when run; no live-model accuracy result is claimed by the automated tests.

Automatic notices expire after 10 minutes, including time spent waiting in queues. Large channels can exhaust that window because private posts are paced at one per second. The shortcut is the on-demand alternative. A time without a date uses the original message’s source-local date and labels the assumption. A shortcut on an old message uses the sender’s current Slack profile timezone; historical travel is not reconstructed. Thread context is not fetched.

Edits and deletions cancel queued notices. Already-delivered ephemerals cannot be recalled or updated. Delivery claims avoid duplicate attempts after uncertain network outcomes, which can occasionally miss a notice if a worker stops just before posting. Definite rate-limit rejections are retried after Slack’s requested delay. Provider circuit breakers are local to each warm parsing worker; cold starts try the primary again.

`npm run build` compiles TypeScript and bundles the Lambda entry points and SST config without deploying. The GitHub workflow runs tests and builds; deployment, real Slack client placement, and live model interpretation still require a configured AWS/Slack test environment.

## License

[MIT](LICENSE).
