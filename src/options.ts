export function runtimeOptions(env: NodeJS.ProcessEnv) {
  const bounded = (name: string, fallback: number, min: number, max: number): string => {
    const value = env[name] === undefined || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}: expected ${min}–${max}`);
    return String(value);
  };
  const renderMode = env.TIME_RENDER_MODE || "slack";
  if (renderMode !== "slack" && renderMode !== "profile") throw new Error("Invalid TIME_RENDER_MODE");
  const includeSender = env.INCLUDE_SENDER || "false";
  if (includeSender !== "true" && includeSender !== "false") throw new Error("Invalid INCLUDE_SENDER");
  return {
    TIME_RENDER_MODE: renderMode,
    INCLUDE_SENDER: includeSender,
    SLACK_ALLOWED_CHANNELS: env.SLACK_ALLOWED_CHANNELS || "",
    ANTHROPIC_MODEL: env.ANTHROPIC_MODEL || "claude-haiku-5-5",
    OPENAI_MODEL: env.OPENAI_MODEL || "gpt-6-luna",
    AI_TIMEOUT_MS: bounded("AI_TIMEOUT_MS", 10_000, 100, 20_000),
    MAX_MESSAGE_AGE_SECONDS: bounded("MAX_MESSAGE_AGE_SECONDS", 600, 30, 600),
  } as const;
}
