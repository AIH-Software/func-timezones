import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runtimeOptions } from "../src/options.js";

const credentialNames = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET",
] as const;

type CredentialName = typeof credentialNames[number];

const prompts: Record<CredentialName, string> = {
  ANTHROPIC_API_KEY: "Anthropic API key (Enter to skip)",
  OPENAI_API_KEY: "OpenAI API key (Enter to skip)",
  SLACK_BOT_TOKEN: "Slack Bot User OAuth Token (xoxb-…)",
  SLACK_SIGNING_SECRET: "Slack Signing Secret",
};

export const setupHelp = `Usage: npm run setup -- [--stage NAME] [--non-interactive]

The default stage is production (or SST_STAGE when set).
Set ANTHROPIC_API_KEY and/or OPENAI_API_KEY, SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET
in your environment for unattended setup. An AWS credential source is required.`;

export class SetupError extends Error {}

export function setupOptions(args: string[], env: NodeJS.ProcessEnv) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: {
      stage: { type: "string" }, "non-interactive": { type: "boolean" }, help: { type: "boolean", short: "h" },
    } }));
  } catch {
    throw new SetupError(setupHelp);
  }
  const stage = values.stage ?? env.SST_STAGE ?? "production";
  if (!values.help && !/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(stage)) {
    throw new SetupError("Stage must have 1–32 lowercase letters, numbers or hyphens, start with a letter, and end with a letter or number.");
  }
  return { stage, nonInteractive: values["non-interactive"] === true, help: values.help === true };
}

export function callbackUrl(outputs: unknown): string {
  const value = (outputs as { slackEndpoint?: unknown } | null)?.slackEndpoint;
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (!url || url.protocol !== "https:" || url.pathname !== "/slack" ||
      url.username || url.password || url.search || url.hash) {
    throw new SetupError("SST did not report a valid HTTPS /slack endpoint in .sst/outputs.json.");
  }
  return url.href;
}

type BootstrapManifest = {
  display_information: Record<string, unknown>;
  features: Record<string, unknown>;
  oauth_config: { scopes: { bot: string[] } };
  settings: Record<string, unknown>;
};

export function slackManifest(bootstrap: BootstrapManifest, endpoint: string) {
  return {
    ...bootstrap,
    features: {
      ...bootstrap.features,
      shortcuts: [{
        name: "Convert time", type: "message", callback_id: "convert_time",
        description: "Show times from this message in your local time zone.",
      }],
    },
    settings: {
      ...bootstrap.settings,
      interactivity: { is_enabled: true, request_url: endpoint },
      event_subscriptions: {
        request_url: endpoint,
        bot_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
      },
    },
  };
}

async function workspaceId(botToken: string, fetcher: typeof fetch) {
  let response: Response;
  let identity: { ok?: unknown; team_id?: unknown; is_enterprise_install?: unknown } | null;
  try {
    response = await fetcher("https://slack.com/api/auth.test", {
      method: "POST", headers: { authorization: `Bearer ${botToken}` }, redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    identity = await response.json() as typeof identity;
  } catch {
    throw new SetupError("Could not reach Slack to check the bot token. Check your connection and try again.");
  }
  const teamId = identity?.team_id;
  if (!response.ok || identity?.ok !== true || identity.is_enterprise_install === true ||
      typeof teamId !== "string" || !/^T[A-Z0-9]+$/.test(teamId)) {
    throw new SetupError("Slack could not verify a workspace for this token. Use the Bot User OAuth Token from a workspace installation.");
  }
  return teamId;
}

interface SetupDriver {
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
  prompt?: (prompt: string) => Promise<string>;
  fetcher?: typeof fetch;
  runSst: (args: string[], env: NodeJS.ProcessEnv, secret?: string) => Promise<void>;
}

export async function runSetup(args: string[], driver: SetupDriver) {
  const { cwd, env, log, prompt, runSst } = driver;
  const { stage, nonInteractive, help } = setupOptions(args, env);
  if (help) {
    log(setupHelp);
    return;
  }
  try {
    runtimeOptions(env);
  } catch (error) {
    throw new SetupError(error instanceof Error ? error.message : "Invalid deployment settings.");
  }
  if (!nonInteractive && !prompt) {
    throw new SetupError("Use an interactive terminal, or pass --non-interactive and supply credentials in your environment.");
  }

  log(`Preparing SST stage ${stage}. Have your AWS credentials ready.`);
  log("For a new installation, open https://api.slack.com/apps and choose Create New App → From a manifest.");
  log("Paste slack-manifest.json, install the app to your workspace, then copy the bot token from OAuth & Permissions and the signing secret from Basic Information.");

  const ask = nonInteractive ? undefined : prompt;
  const readCredential = async (name: CredentialName) => {
    const value = env[name]?.trim() || (await ask?.(prompts[name]))?.trim() || "";
    if (/\s/.test(value)) throw new SetupError(`${name} must be a single value without spaces.`);
    return value;
  };
  const anthropic = await readCredential("ANTHROPIC_API_KEY");
  const openai = await readCredential("OPENAI_API_KEY");
  if (!anthropic && !openai) throw new SetupError("Supply at least one AI API key (Anthropic or OpenAI).");
  const botToken = await readCredential("SLACK_BOT_TOKEN");
  if (!botToken.startsWith("xoxb-")) throw new SetupError("Supply a Slack Bot User OAuth Token beginning with xoxb-.");
  const signingSecret = await readCredential("SLACK_SIGNING_SECRET");
  if (!signingSecret) throw new SetupError("Supply the Slack Signing Secret from Basic Information.");

  const teamId = await workspaceId(botToken, driver.fetcher ?? fetch);
  const providerKeys = { anthropic: anthropic || undefined, openai: openai || undefined };
  const slackCredentials = { botToken, signingSecret, teamId };
  const sstEnv = { ...env };
  for (const name of credentialNames) delete sstEnv[name];

  log("Slack token verified. Saving credentials to SST.");
  await runSst(["secret", "set", "ProviderKeys", "--stage", stage], sstEnv, JSON.stringify(providerKeys));
  await runSst(["secret", "set", "SlackCredentials", "--stage", stage], sstEnv, JSON.stringify(slackCredentials));
  log("Deploying AWS resources with SST.");
  await runSst(["deploy", "--stage", stage], sstEnv);

  let outputs: unknown;
  try {
    outputs = JSON.parse(await readFile(join(cwd, ".sst", "outputs.json"), "utf8"));
  } catch {
    throw new SetupError("SST deployed but .sst/outputs.json could not be read.");
  }
  const endpoint = callbackUrl(outputs);
  const bootstrap: BootstrapManifest = JSON.parse(await readFile(join(cwd, "slack-manifest.json"), "utf8"));
  const manifest = `.setup/slack-manifest.${stage}.json`;
  await mkdir(join(cwd, ".setup"), { recursive: true });
  await writeFile(join(cwd, manifest), `${JSON.stringify(slackManifest(bootstrap, endpoint), null, 2)}\n`);

  log(`In the same Slack app, paste ${manifest} into App Manifest and save.`);
  log(`Verify ${endpoint} as the Request URL under Event Subscriptions in Slack.`);
  log("Invite FuckTimezones to a test channel. Use a message's More actions → Convert time to try it.");
  return { manifest, endpoint };
}
