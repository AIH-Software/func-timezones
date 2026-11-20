import type { AppConfig } from "./contracts.js";
import { runtimeOptions } from "./options.js";

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}

function jsonObject(raw: string | undefined, name: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new ConfigurationError(`Invalid ${name} secret`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, role: "http" | "parse" | "delivery" = "parse"): AppConfig {
  const providers = jsonObject(env.PROVIDER_KEYS, "ProviderKeys");
  const slack = jsonObject(env.SLACK_CREDENTIALS, "SlackCredentials");
  const key = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const anthropicKey = key(providers.anthropic), openaiKey = key(providers.openai);
  if (role === "parse" && !anthropicKey && !openaiKey) throw new ConfigurationError("Configure at least one AI provider key using npm run setup");
  const botToken = key(slack.botToken), signingSecret = key(slack.signingSecret), teamId = key(slack.teamId);
  if (!teamId || (role === "http" ? !signingSecret : !botToken)) throw new ConfigurationError("Configure Slack using npm run setup");
  const options = runtimeOptions(env);
  return {
    botToken: botToken || "", signingSecret: signingSecret || "", teamId, anthropicKey, openaiKey,
    anthropicModel: options.ANTHROPIC_MODEL, openaiModel: options.OPENAI_MODEL,
    timeoutMs: Number(options.AI_TIMEOUT_MS), maxMessageAgeSeconds: Number(options.MAX_MESSAGE_AGE_SECONDS),
    renderMode: options.TIME_RENDER_MODE, includeSender: options.INCLUDE_SENDER === "true",
    allowedChannels: new Set(options.SLACK_ALLOWED_CHANNELS.split(",").map(value => value.trim()).filter(Boolean)),
  };
}
