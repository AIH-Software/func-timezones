import type { ResolvedMention, SlackUser } from "./types.js";
import { isSupportedTimezone, localize } from "./time.js";

export function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function clockText(unix: number, user: SlackUser, mode: "slack" | "profile"): string {
  if (mode === "profile") {
    if (!user.tz || !isSupportedTimezone(user.tz)) throw new Error("recipient_timezone_unavailable");
    return escapeSlack(localize(unix, user.tz));
  }
  // Slack localizes this timestamp on the viewer's device, including their 12/24h preference.
  const fallback = localize(unix, "UTC");
  return `<!date^${unix}^{date_short} at {time}|${escapeSlack(fallback)}>`;
}

export function renderNotice(mentions: ResolvedMention[], user: SlackUser, mode: "slack" | "profile",
  permalink?: string): { text: string; blocks: Array<Record<string, unknown>> } {
  const conversions = mentions.map(mention => {
    const local = clockText(mention.startUnix, user, mode);
    const range = mention.endUnix === null ? local : `${local} – ${clockText(mention.endUnix, user, mode)}`;
    const assumption = mention.dateBasis === "message_date" ? ` (date assumed: ${mention.start.local.slice(0, 10)})` : "";
    return { phrase: mention.text, text: `${range} for you${assumption}.` };
  });
  const text = conversions.map(line => `“${escapeSlack(line.phrase)}” is ${line.text}`).join("\n").slice(0, 3900);
  const blocks: Array<Record<string, unknown>> = conversions.flatMap(line => [
    { type: "section", text: { type: "plain_text", text: `“${line.phrase}” is`, emoji: false } },
    { type: "section", text: { type: "mrkdwn", text: line.text, verbatim: true } },
  ]);
  if (permalink && /^https:\/\/[^\s<>|]+$/.test(permalink)) blocks.push({
    type: "context", elements: [{ type: "mrkdwn", text: `<${permalink}|Original message>` }],
  });
  return { text, blocks };
}
