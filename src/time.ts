import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";
import type { ExtractedMention, Extraction, MessageContext, TimeEndpoint, ValidationResult } from "./types.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const dateFormat = "YYYY-MM-DD";
const localFormat = "YYYY-MM-DD[T]HH:mm:ss";
const utcFormat = `${localFormat}[Z]`;
const fixedOffset = /^(?:UTC)?([+-])([01]\d|2[0-3]):([0-5]\d)$/;
const ianaName = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+$/;

type Zone =
  | { kind: "fixed"; id: string; seconds: number }
  | { kind: "iana"; id: string; formatter: Intl.DateTimeFormat };

function parseZone(input: string): Zone | null {
  if (typeof input !== "string" || input.trim() !== input) return null;

  const match = fixedOffset.exec(input);
  if (match) {
    const seconds = (Number(match[2]) * 60 + Number(match[3])) * 60;
    return seconds === 0
      ? { kind: "fixed", id: "UTC", seconds: 0 }
      : { kind: "fixed", id: `UTC${match[1]}${match[2]}:${match[3]}`, seconds: match[1] === "-" ? -seconds : seconds };
  }

  if (input === "UTC" || input === "GMT") return { kind: "fixed", id: "UTC", seconds: 0 };
  if (!ianaName.test(input)) return null;

  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: input, timeZoneName: "longOffset" });
    const id = formatter.resolvedOptions().timeZone;
    return id === "UTC" ? { kind: "fixed", id, seconds: 0 } : { kind: "iana", id, formatter };
  } catch {
    return null;
  }
}

export function isSupportedTimezone(zone: string): boolean {
  return parseZone(zone) !== null;
}

function offsetAt(instant: Dayjs, zone: Zone): number {
  if (zone.kind === "fixed") return zone.seconds;

  const name = zone.formatter.formatToParts(instant.toDate()).find((part) => part.type === "timeZoneName")?.value;
  if (name === "GMT") return 0;

  const parts = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name ?? "");
  if (!parts) throw new Error("The time zone offset could not be determined.");

  // The zone database includes historical offsets with second-level precision.
  const seconds = Number(parts[2]) * 3600 + Number(parts[3]) * 60 + Number(parts[4] ?? 0);
  return parts[1] === "-" ? -seconds : seconds;
}

function formatOffset(seconds: number): string {
  if (seconds === 0) return "UTC";

  const magnitude = Math.abs(seconds);
  const hours = String(Math.floor(magnitude / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((magnitude % 3600) / 60)).padStart(2, "0");
  const remainder = magnitude % 60;
  const subminute = remainder === 0 ? "" : `:${String(remainder).padStart(2, "0")}`;
  return `UTC${seconds < 0 ? "-" : "+"}${hours}:${minutes}${subminute}`;
}

export function localize(unixSeconds: number, timezone: string): string {
  const zone = parseZone(timezone);
  const instant = dayjs.utc(unixSeconds * 1000);
  if (!zone || !instant.isValid()) throw new RangeError("A valid timestamp and time zone are required.");

  const offset = offsetAt(instant, zone);
  const wall = instant.add(offset, "second");
  const zoned = zone.kind === "iana" ? instant.tz(zone.id) : wall;
  // Some wall times cannot be represented through the host's local-time parser.
  const display = zoned.format(localFormat) === wall.format(localFormat) ? zoned : wall;
  const clock = wall.second() === 0 ? "h:mm A" : "h:mm:ss A";
  return `${display.locale("en").format(`ddd, MMM D, YYYY [at] ${clock}`)} (${formatOffset(offset)})`;
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSpan(text: unknown): text is string {
  return typeof text === "string" && text.trim().length > 0 && text.length <= 200;
}

function isEndpoint(value: unknown): value is TimeEndpoint {
  return hasExactKeys(value, ["local", "utc"]) && typeof value.local === "string" && typeof value.utc === "string";
}

function isMention(value: unknown): value is ExtractedMention {
  return hasExactKeys(value, ["text", "timezone", "timezoneBasis", "dateBasis", "start", "end"])
    && isSpan(value.text) && typeof value.timezone === "string"
    && (value.timezoneBasis === "explicit" || value.timezoneBasis === "sender")
    && (value.dateBasis === "explicit" || value.dateBasis === "relative" || value.dateBasis === "message_date")
    && isEndpoint(value.start) && (value.end === null || isEndpoint(value.end));
}

function isExtraction(value: unknown): value is Extraction {
  return hasExactKeys(value, ["mentions", "ambiguous"])
    && Array.isArray(value.mentions) && Array.isArray(value.ambiguous)
    && value.mentions.length + value.ambiguous.length <= 8
    && [...value.mentions].every(isMention)
    && [...value.ambiguous].every((item: unknown) => hasExactKeys(item, ["text", "reason"])
      && isSpan(item.text) && typeof item.reason === "string" && item.reason.trim().length > 0);
}

function sourceHasSpan(source: string, span: string): boolean {
  for (let start = source.indexOf(span); start !== -1; start = source.indexOf(span, start + 1)) {
    const end = start + span.length;
    const cutsWordStart = /\w/.test(span[0] ?? "") && start > 0 && /\w/.test(source[start - 1] ?? "");
    const cutsWordEnd = /\w/.test(span.at(-1) ?? "") && /\w/.test(source[end] ?? "");
    if (!cutsWordStart && !cutsWordEnd) return true;
  }
  return false;
}

const hourWord = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
const hour = `(?:[01]?\\d|2[0-3]|${hourWord})`;
// Check for time evidence without interpreting the clock expression or its intent.
const clockPatterns = [
  /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?!\d)/i,
  /\b(?:noon|midday|midnight)\b/i,
  new RegExp(`\\b${hour}\\s*(?:[ap]\\.?m\\b|o[’']?clock\\b|hundred\\b|sharp\\b|(?:in the|this)\\s+(?:morning|afternoon|evening)\\b)`, "i"),
  new RegExp(`\\b(?:at|around|about|by|before|after|from|between)\\s+(?:(?:about|approximately)\\s+)?${hour}\\b`, "i"),
  new RegExp(`\\b${hour}\\s+(?:UTC|GMT|[ECMP][SD]?T|BST|CET|CEST|AEST|AEDT|JST|IST)\\b`, "i"),
  new RegExp(`\\b(?:half|(?:a )?quarter|(?:\\d{1,2}|${hourWord}) minutes?)\\s+(?:past|to|after|before)\\s+${hour}\\b`, "i"),
  new RegExp(`\\b(?:${hourWord})[- ](?:ten|eleven|twelve|twenty|thirty|forty|fifty)\\b`, "i"),
  /\b(?:[01]\d|2[0-3])[0-5]\d\s*(?:z|hours?|utc|gmt)\b/i,
  /\b(?:in\s+)?(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|half an?)\s+(?:seconds?|minutes?|hours?)\s+(?:from now|ago)\b/i,
  /\bin\s+(?:\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|half an?)\s+(?:seconds?|minutes?|hours?)\b/i,
];

const regionLabels = [
  [/\b(?:Pacific(?: time)?|PT|Los Angeles|Seattle|San Francisco)\b/i, "America/Los_Angeles"],
  [/\b(?:Eastern(?: time)?|ET|New York|Boston|Philadelphia)\b/i, "America/New_York"],
  [/\b(?:Mountain time|MT|Denver)\b/i, "America/Denver"],
  [/\b(?:Central time|CT|Chicago)\b/i, "America/Chicago"],
  [/\b(?:London(?: time)?|UK time|British local time)\b/i, "Europe/London"],
  [/\b(?:Tokyo(?: time)?|Japan(?: time)?|JST)\b/i, "Asia/Tokyo"],
  [/\b(?:Nepal(?: time)?|Kathmandu)\b/i, "Asia/Kathmandu"],
  [/\b(?:India time|Mumbai|Delhi|Kolkata|Bengaluru)\b/i, "Asia/Kolkata"],
] as const;

const standardAndDaylightLabels = [
  [/\b(?:PST|Pacific Standard Time)\b/i, "UTC-08:00"],
  [/\b(?:PDT|Pacific Daylight Time)\b/i, "UTC-07:00"],
  [/\b(?:EST|Eastern Standard Time)\b/i, "UTC-05:00"],
  [/\b(?:EDT|Eastern Daylight Time)\b/i, "UTC-04:00"],
] as const;

const offsetLabel = /\b(?:UTC|GMT)(?:[ \t]*([+−-])(\d{1,2})(?::(\d{2}))?)?\b(?![:\d]|[ \t]*[+−-]\d)/gi;
const standaloneOffset = /(?:^|[\s(]|T\d\d:\d\d(?::\d\d)?)([+−-]\d\d:[0-5]\d)\b/g;
const utcClock = /(?:\b[01]?\d:[0-5]\d(?::[0-5]\d)?|(?:T|\b)(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?|\b(?:[01]\d|2[0-3])[0-5]\d)Z\b/i;

function explicitZoneIds(text: string): Set<string> {
  const ids = new Set<string>();
  const withoutNames = text.replace(/\b[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)+\b/g, (name) => {
    const zone = parseZone(name);
    if (zone) ids.add(zone.id);
    return zone ? "" : name;
  });

  const withoutPrefixes = withoutNames.replace(offsetLabel, (_label, sign?: string, hour?: string, minute?: string) => {
    const name = sign && hour ? `${sign.replace("−", "-")}${hour.padStart(2, "0")}:${minute ?? "00"}` : "UTC";
    const zone = parseZone(name);
    if (zone) ids.add(zone.id);
    return "";
  });

  for (const match of withoutPrefixes.matchAll(standaloneOffset)) {
    const name = match[1];
    if (name) {
      const zone = parseZone(name.replace("−", "-"));
      if (zone) ids.add(zone.id);
    }
  }
  if (utcClock.test(withoutNames)) ids.add("UTC");

  let withoutFixedLabels = withoutPrefixes;
  for (const [pattern, name] of standardAndDaylightLabels) {
    if (pattern.test(withoutFixedLabels)) {
      ids.add(name);
      withoutFixedLabels = withoutFixedLabels.replace(pattern, "");
    }
  }
  for (const [pattern, name] of regionLabels) {
    if (pattern.test(withoutFixedLabels)) ids.add(parseZone(name)?.id ?? name);
  }
  return ids;
}

function sourceZoneMatches(mention: ExtractedMention, source: string, zone: Zone, sender: Zone): boolean {
  const spanIds = explicitZoneIds(mention.text);
  // Honor a message-wide zone only when it explicitly applies to all its times.
  const sharedZone = /\b(?:all|both)\s+(?:times|slots)\s+(?:are\s+(?:in\s+)?|in\s+)([^;.!?\n]+)/i.exec(source)?.[1];
  const evidence = spanIds.size > 0 || !sharedZone ? spanIds : explicitZoneIds(sharedZone);
  const literalMatches = evidence.size === 1 && evidence.has(zone.id);
  if (mention.timezoneBasis === "sender") return zone.id === sender.id && (evidence.size === 0 || literalMatches);
  if (evidence.size > 0) return literalMatches;

  if (zone.kind !== "iana") return false;
  const city = zone.id.split("/").at(-1)?.replaceAll("_", " ");
  return Boolean(city && sourceHasSpan(mention.text.toLowerCase(), city.toLowerCase()))
    || /\b(?:local time in\s+[A-Z][\p{L}]+|[A-Z][\p{L}]+\s+local time)\b/u.test(mention.text);
}

interface NumericClock {
  hours: number;
  minute: number;
  second: number;
  meridiem: "a" | "p" | undefined;
  twentyFourHour: boolean;
}

function numericClocks(text: string): NumericClock[] {
  const clocks: NumericClock[] = [];
  const withoutOffsets = text.replace(offsetLabel, " ").replace(standaloneOffset, (offset) => offset.slice(0, -6));
  const onlyBareHour = /^\s*\d{1,2}\s*$/.test(withoutOffsets);
  const pattern = /(?<![\d:])(\d{1,2})(?::([0-5]\d)(?::([0-5]\d))?)?(?:\s*([ap])\.?m\b\.?)?(?![\d:])/gi;
  for (const match of withoutOffsets.matchAll(pattern)) {
    const [token, hour, minute, second, meridiem] = match;
    const before = withoutOffsets.slice(0, match.index);
    const after = withoutOffsets.slice(match.index + token.length);
    const bareHourCue = onlyBareHour || /\b(?:at|around|about|by|from|between|to|until)\s*$/i.test(before)
      || /(?:[ap]\.?m\.?|:\d\d)\s*[-–—]\s*$/i.test(before)
      || /^\s+(?:GMT|UTC|[ECMP][SD]?T|BST|CET|CEST|AEST|AEDT|JST|IST)\b/i.test(after)
      || /^\s*(?:[-–—]|to\b)\s*\d{1,2}(?::\d{2}|\s*[ap]\.?m\b)/i.test(after);
    const spokenModifier = new RegExp(`\\b(?:half|quarter|minutes?|${hourWord})\\s+(?:past|to|after|before)\\s*$`, "i");
    if (spokenModifier.test(before) || (!minute && !meridiem && !bareHourCue)) continue;

    const hours = Number(hour);
    if (hours > 23) continue;
    const twentyFourHour = hours === 0 || hours > 12 || /^0\d$/.test(hour ?? "") || /^Z\b/i.test(after)
      || /\d{4}-\d{2}-\d{2}T$/i.test(before) || /\b24[ -]hour\b/i.test(withoutOffsets);
    clocks.push({ hours, minute: Number(minute ?? 0), second: Number(second ?? 0),
      meridiem: meridiem?.toLowerCase() as NumericClock["meridiem"], twentyFourHour });
  }

  if (clocks.length === 0) {
    for (const match of text.matchAll(/\b([01]\d|2[0-3])([0-5]\d)\s*(?:z|hours?|utc|gmt)\b/gi)) {
      clocks.push({ hours: Number(match[1]), minute: Number(match[2]), second: 0,
        twentyFourHour: true, meridiem: undefined });
    }
  }
  return clocks;
}

function clockTime(clock: NumericClock, inheritedMeridiem?: NumericClock["meridiem"]): string | null {
  const meridiem = clock.meridiem ?? (clock.twentyFourHour ? undefined : inheritedMeridiem);
  if (meridiem && (clock.hours < 1 || clock.hours > 12)) return null;
  if (!meridiem && !clock.twentyFourHour) return null;
  const hour = meridiem ? clock.hours % 12 + (meridiem === "p" ? 12 : 0) : clock.hours;
  return [hour, clock.minute, clock.second].map((part) => String(part).padStart(2, "0")).join(":");
}

function sourceClockMatches(mention: ExtractedMention): boolean {
  const clocks = numericClocks(mention.text);
  const [start, end] = clocks;
  if (!mention.end) return clocks.length === 0 || (clocks.length === 1 && start !== undefined
    && clockTime(start) === mention.start.local.slice(11));
  if (!start || !end) return true; // Mixed numeric and spoken ranges are interpreted by the extractor.
  if (clocks.length > 2) return false;

  const startClock = clockTime(start, end.meridiem);
  const endClock = clockTime(end, start.meridiem);
  return startClock === mention.start.local.slice(11) && endClock === mention.end.local.slice(11);
}

function strictDate(value: string, format: string): Dayjs | null {
  const parsed = dayjs.utc(value, format, true);
  return parsed.isValid() ? parsed : null;
}

function parsePostedAt(value: string): Dayjs | null {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!parts) return null;

  const posted = strictDate(`${parts[1]}Z`, utcFormat);
  return posted?.add(Number(parts[2]?.padEnd(3, "0") ?? 0), "millisecond") ?? null;
}

function resolveEndpoint(endpoint: TimeEndpoint, zone: Zone): number | string {
  const local = strictDate(endpoint.local, localFormat);
  const claimedUtc = strictDate(endpoint.utc, utcFormat);
  if (!local || !claimedUtc) return "The time has an invalid calendar date or clock value.";

  const offsets = new Set<number>();
  if (zone.kind === "fixed") {
    offsets.add(zone.seconds);
  } else {
    // Sample both sides of a potential transition, including changes across the date line.
    for (let hours = -36; hours <= 36; hours += 6) {
      offsets.add(offsetAt(local.add(hours, "hour"), zone));
    }
  }

  const candidates = [...offsets].map((offset) => local.subtract(offset, "second"))
    .filter((instant) => instant.add(offsetAt(instant, zone), "second").format(localFormat) === endpoint.local);

  if (candidates.length === 0) return "This clock time does not exist in its time zone.";
  if (candidates.length > 1) return "This clock time occurs twice in its time zone.";
  const resolved = candidates[0];
  if (resolved?.valueOf() !== claimedUtc.valueOf()) return "The UTC timestamp does not match the clock time and time zone.";
  return resolved.unix();
}

const relativeDays = { yesterday: -1, today: 0, tomorrow: 1 } as const;

function impliedEndDateMatches(mention: ExtractedMention, startDate: Dayjs): boolean {
  if (!mention.end) return true;
  const rollover = mention.end.local.slice(11) < mention.start.local.slice(11) ? 1 : 0;
  return mention.end.local.slice(0, 10) === startDate.add(rollover, "day").format(dateFormat);
}

function postingDateMatches(mention: ExtractedMention, posted: Dayjs, zone: Zone): boolean {
  const sourceIsoDates = mention.text.match(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g);
  if (sourceIsoDates && (mention.start.local.slice(0, 10) !== sourceIsoDates[0]
    || (sourceIsoDates[1] && mention.end && mention.end.local.slice(0, 10) !== sourceIsoDates[1]))) return false;

  const relative = mention.text.toLowerCase().match(/\b(?:today|tomorrow|yesterday)\b/g) as Array<keyof typeof relativeDays> | null;
  if (!relative && mention.dateBasis !== "message_date") return true;

  const postedWallDate = posted.add(offsetAt(posted, zone), "second").startOf("day");
  if (!relative) return mention.start.local.slice(0, 10) === postedWallDate.format(dateFormat) && impliedEndDateMatches(mention, postedWallDate);

  const startDay = relative[0];
  const endDay = relative[1];
  if (mention.dateBasis !== "relative" || startDay === undefined) return false;
  const startDate = postedWallDate.add(relativeDays[startDay], "day");
  if (mention.start.local.slice(0, 10) !== startDate.format(dateFormat)) return false;
  return endDay && mention.end
    ? mention.end.local.slice(0, 10) === postedWallDate.add(relativeDays[endDay], "day").format(dateFormat)
    : impliedEndDateMatches(mention, startDate);
}

export function validateExtraction(raw: unknown, context: MessageContext): ValidationResult {
  const result: ValidationResult = { mentions: [], rejected: [] };
  const reject = (text: string, reason: string) => result.rejected.push({ text, reason });

  if (!isExtraction(raw)) {
    reject("", "The time extraction result was invalid.");
    return result;
  }

  const senderZone = parseZone(context.senderTimezone);
  const posted = parsePostedAt(context.postedAtUtc);
  if (!senderZone || !posted) {
    reject("", "The original message's time or sender time zone was unavailable.");
    return result;
  }

  const ambiguous = new Set<string>();
  for (const item of raw.ambiguous) {
    if (sourceHasSpan(context.text, item.text)) {
      if (!ambiguous.has(item.text)) reject(item.text, "The message leaves this time ambiguous.");
      ambiguous.add(item.text);
    } else {
      reject("", "An ambiguous time did not match the original message.");
    }
  }

  for (const mention of raw.mentions) {
    if ([...ambiguous].some((span) => sourceHasSpan(mention.text, span) || sourceHasSpan(span, mention.text))) continue;
    if (!sourceHasSpan(context.text, mention.text) || !clockPatterns.some((pattern) => pattern.test(mention.text))) {
      reject("", "A clock time could not be verified in the original message.");
      continue;
    }

    const zone = parseZone(mention.timezone);
    if (!zone || !sourceZoneMatches(mention, context.text, zone, senderZone)) {
      reject(mention.text, "The time zone could not be verified from the message or the sender's time zone.");
      continue;
    }

    const start = resolveEndpoint(mention.start, zone);
    const end = mention.end && resolveEndpoint(mention.end, zone);
    if (typeof start === "string" || typeof end === "string") {
      reject(mention.text, typeof start === "string" ? start : String(end));
      continue;
    }

    if (end !== null && end <= start) {
      reject(mention.text, "The range end must be after its start.");
      continue;
    }

    if (!sourceClockMatches(mention)) {
      reject(mention.text, "The clock time did not match the message or its AM/PM was unclear.");
      continue;
    }

    if (!postingDateMatches(mention, posted, zone)) {
      reject(mention.text, "The date did not match the original posting date or the date in the message.");
      continue;
    }

    result.mentions.push({ ...mention, startUnix: start, endUnix: end });
  }

  return result;
}
