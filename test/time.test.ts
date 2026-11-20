import assert from "node:assert/strict";
import { test } from "node:test";
import { isSupportedTimezone, localize, validateExtraction } from "../src/time.js";
import type { ExtractedMention, MessageContext } from "../src/types.js";

const context: MessageContext = {
  text: "Meet at 9:30 pm UTC.",
  postedAtUtc: "2026-11-20T02:20:00.123Z",
  senderTimezone: "America/Los_Angeles",
};

const baseMention: ExtractedMention = {
  text: "9:30 pm UTC",
  timezone: "UTC",
  timezoneBasis: "explicit",
  dateBasis: "message_date",
  start: { local: "2026-11-20T21:30:00", utc: "2026-11-20T21:30:00Z" },
  end: null,
};

function resolve(mention: Partial<ExtractedMention> = {}, message: Partial<MessageContext> = {}) {
  return validateExtraction({ mentions: [{ ...baseMention, ...mention }], ambiguous: [] }, { ...context, ...message });
}

test("verifies UTC and displays the conversion in a viewer's time zone", () => {
  const result = resolve();
  assert.deepEqual(result.rejected, []);
  assert.equal(result.mentions.length, 1);
  const unix = result.mentions[0]!.startUnix;
  assert.equal(unix, Date.parse("2026-11-20T21:30:00Z") / 1000);
  assert.equal(localize(unix, "UTC"), "Fri, Nov 20, 2026 at 9:30 PM (UTC)");
  assert.equal(localize(unix, "Asia/Tokyo"), "Sat, Nov 21, 2026 at 6:30 AM (UTC+09:00)");
  assert.equal(localize(Date.parse("2026-03-08T09:30:00Z") / 1000, "America/Phoenix"),
    "Sun, Mar 8, 2026 at 2:30 AM (UTC-07:00)");
});

test("uses the sender's time zone and original local posting date for unqualified times", () => {
  const mention: Partial<ExtractedMention> = {
    text: "at 9:30 pm",
    timezone: "US/Pacific",
    timezoneBasis: "sender",
    start: { local: "2026-11-19T21:30:00", utc: "2026-11-20T05:30:00Z" },
  };
  const result = resolve(mention, { text: "Meet at 9:30 pm." });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.mentions.length, 1);
  assert.equal(result.mentions[0]!.startUnix, Date.parse("2026-11-20T05:30:00Z") / 1000);

  const wrongZone = resolve({ ...mention, timezone: "America/Denver" }, { text: "Meet at 9:30 pm." });
  assert.equal(wrongZone.mentions.length, 0);
  assert.match(wrongZone.rejected[0]!.reason, /sender's time zone/);

  const nextDay = resolve({ ...mention, start: { local: "2026-11-20T21:30:00", utc: "2026-11-21T05:30:00Z" } }, { text: "Meet at 9:30 pm." });
  assert.equal(nextDay.mentions.length, 0);
  assert.match(nextDay.rejected[0]!.reason, /posting date/);
});

test("handles 30-, 45- and 15-minute offsets", () => {
  const cases = [
    ["Asia/Kathmandu", "9:30 pm Asia/Kathmandu", "2026-11-20T21:30:00", "2026-11-20T15:45:00Z", "UTC+05:45"],
    ["UTC+05:30", "9:30 pm UTC+05:30", "2026-11-20T21:30:00", "2026-11-20T16:00:00Z", "UTC+05:30"],
    ["-00:15", "9:30 pm −00:15", "2026-11-20T21:30:00", "2026-11-20T21:45:00Z", "UTC-00:15"],
  ] as const;
  for (const [timezone, text, local, utc, offset] of cases) {
    const result = resolve({ timezone, text, dateBasis: "explicit", start: { local, utc } }, { text: `Nov 20 at ${text}` });
    assert.deepEqual(result.rejected, [], timezone);
    assert.equal(localize(result.mentions[0]!.startUnix, timezone), `Fri, Nov 20, 2026 at 9:30 PM (${offset})`);
  }
});

test("withholds a spring-forward gap even when Day.js can normalize it", () => {
  const result = resolve({
    text: "March 8 at 2:30 am Pacific",
    timezone: "America/Los_Angeles",
    dateBasis: "explicit",
    start: { local: "2026-03-08T02:30:00", utc: "2026-03-08T10:30:00Z" },
  }, { text: "March 8 at 2:30 am Pacific" });
  assert.equal(result.mentions.length, 0);
  assert.match(result.rejected[0]!.reason, /does not exist/);
});

test("withholds both possible UTC claims inside a fall-back fold", () => {
  const text = "November 1 at 1:30 am Pacific";
  for (const utc of ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]) {
    const result = resolve({
      text, timezone: "America/Los_Angeles", dateBasis: "explicit",
      start: { local: "2026-11-01T01:30:00", utc },
    }, { text });
    assert.equal(result.mentions.length, 0);
    assert.match(result.rejected[0]!.reason, /occurs twice/);
  }
});

test("withholds ambiguous times during a thirty-minute DST rollback", () => {
  const text = "April 5 at 1:45 am Australia/Lord_Howe";
  const result = resolve({
    text, timezone: "Australia/Lord_Howe", dateBasis: "explicit",
    start: { local: "2026-04-05T01:45:00", utc: "2026-04-04T14:45:00Z" },
  }, { text });
  assert.equal(result.mentions.length, 0);
  assert.match(result.rejected[0]!.reason, /occurs twice/);
});

test("rejects invalid dates, invalid clock values and UTC normalization", () => {
  const invalid = [
    { local: "2026-02-30T21:30:00", utc: "2026-03-02T21:30:00Z" },
    { local: "2026-11-20T24:00:00", utc: "2026-11-21T00:00:00Z" },
    { local: "2026-11-20T21:30:00", utc: "2026-11-20T24:30:00Z" },
    { local: "2026-11-20T21:30:00", utc: "2026-11-20T21:30:00+00:00" },
    { local: "2026-11-20T21:30:00", utc: "2026-11-20T21:30:00.000Z" },
  ];
  for (const start of invalid) {
    const result = resolve({ start, dateBasis: "explicit" });
    assert.equal(result.mentions.length, 0, JSON.stringify(start));
    assert.match(result.rejected[0]!.reason, /invalid calendar date or clock/);
  }
});

test("rejects a well-formed UTC timestamp that disagrees with the clock time", () => {
  const result = resolve({ start: { ...baseMention.start, utc: "2026-11-20T20:30:00Z" } });
  assert.equal(result.mentions.length, 0);
  assert.match(result.rejected[0]!.reason, /UTC timestamp does not match/);
});

test("rejects invalid or missing time zones and unavailable posting context", () => {
  assert.equal(isSupportedTimezone("Australia/Lord_Howe"), true);
  assert.equal(isSupportedTimezone("+05:30"), true);
  for (const timezone of ["", "America/Atlantis", "PST", "UTC+24:00", "+08:60", "+08:00\n"]) {
    assert.equal(isSupportedTimezone(timezone), false, timezone);
    assert.equal(resolve({ timezone }).mentions.length, 0, timezone);
  }
  assert.equal(resolve({}, { senderTimezone: "" }).mentions.length, 0);
  assert.equal(resolve({}, { postedAtUtc: "2026-11-31T02:20:00Z" }).mentions.length, 0);
});

test("checks named relative days using the original posting date even long after delivery", () => {
  const text = "tomorrow at 9:30 pm";
  const message = { text, postedAtUtc: "2019-01-01T02:30:00.100Z" };
  const mention: Partial<ExtractedMention> = {
    text, timezone: "America/Los_Angeles", timezoneBasis: "sender", dateBasis: "relative",
    start: { local: "2019-01-01T21:30:00", utc: "2019-01-02T05:30:00Z" },
  };
  assert.equal(resolve(mention, message).mentions.length, 1);
  assert.match(resolve({ ...mention, dateBasis: "explicit" }, message).rejected[0]!.reason, /date in the message/);
  const tamperedDate = { local: "2019-01-02T21:30:00", utc: "2019-01-03T05:30:00Z" };
  assert.match(resolve({ ...mention, start: tamperedDate }, message).rejected[0]!.reason, /date in the message/);
  assert.equal(resolve({ ...mention, text: "today at 9:30 pm", start: { local: "2018-12-31T21:30:00", utc: "2019-01-01T05:30:00Z" } }, { ...message, text: "today at 9:30 pm" }).mentions.length, 1);
  assert.equal(resolve({ ...mention, text: "yesterday at 9:30 pm", start: { local: "2018-12-30T21:30:00", utc: "2018-12-31T05:30:00Z" } }, { ...message, text: "yesterday at 9:30 pm" }).mentions.length, 1);
});

test("accepts a range crossing midnight and rejects identical or earlier UTC ends", () => {
  const text = "11:30 pm to 1:00 am UTC";
  const mention: Partial<ExtractedMention> = {
    text,
    start: { local: "2026-11-20T23:30:00", utc: "2026-11-20T23:30:00Z" },
    end: { local: "2026-11-21T01:00:00", utc: "2026-11-21T01:00:00Z" },
  };
  const result = resolve(mention, { text });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.mentions[0]!.endUnix, Date.parse("2026-11-21T01:00:00Z") / 1000);

  for (const end of [mention.start, { local: "2026-11-20T01:00:00", utc: "2026-11-20T01:00:00Z" }]) {
    const invalid = resolve({ ...mention, end }, { text });
    assert.equal(invalid.mentions.length, 0);
    assert.match(invalid.rejected[0]!.reason, /end must be after/);
  }
});

test("allows natural English clock expressions without substituting a deterministic extractor", () => {
  const samples = [
    ["half past three in the afternoon", "15:30:00"],
    ["noon", "12:00:00"],
    ["quarter to four", "15:45:00"],
    ["four o’clock", "16:00:00"],
    ["four thirty", "16:30:00"],
    ["at 09:00", "09:00:00"],
    ["0930Z", "09:30:00"],
  ] as const;
  for (const [text, time] of samples) {
    const result = resolve({ text, timezoneBasis: "sender", start: { local: `2026-11-20T${time}`, utc: `2026-11-20T${time}Z` } },
      { text: `Meet ${text}.`, senderTimezone: "UTC" });
    assert.deepEqual(result.rejected, [], text);
    assert.equal(result.mentions.length, 1, text);
  }
});

test("rejects an invented explicit zone, even when the model's proposed arithmetic is consistent", () => {
  const text = "Meet at 3pm";
  const start = { local: "2026-11-20T15:00:00", utc: "2026-11-20T15:00:00Z" };
  const result = resolve({ text: "3pm", start }, { text });
  assert.equal(result.mentions.length, 0);
  assert.match(result.rejected[0]!.reason, /zone could not be verified/);

  const wrongDeclaredZone = resolve({ text: "3pm UTC", timezone: "America/Los_Angeles", dateBasis: "explicit",
    start: { local: "2026-11-20T15:00:00", utc: "2026-11-20T23:00:00Z" } }, { text: `${text} UTC` });
  assert.equal(wrongDeclaredZone.mentions.length, 0);
  assert.match(wrongDeclaredZone.rejected[0]!.reason, /zone could not be verified/);
  assert.equal(resolve({ text: "3pm", start }, { text: `All times are UTC. ${text}` }).mentions.length, 1);
  assert.equal(resolve({ text: "3pm", start: { ...start, utc: "2026-11-20T23:00:00Z" }, dateBasis: "explicit",
    timezone: "America/Los_Angeles", timezoneBasis: "sender" }, { text: `All times are UTC. ${text}` }).mentions.length, 0);
});

test("rejects a contradictory clock, guessed AM/PM, and a contradictory numeric range end", () => {
  const badClock = resolve({ text: "3pm UTC", start: { local: "2026-11-20T17:00:00", utc: "2026-11-20T17:00:00Z" } },
    { text: "Meet at 3pm UTC" });
  assert.equal(badClock.mentions.length, 0);
  assert.match(badClock.rejected[0]!.reason, /clock time did not match/);

  for (const text of ["at 3 UTC", "3 UTC", "12:00 UTC"]) {
    const hour = text.includes("3") ? "03" : "12";
    const ambiguous = resolve({ text, start: { local: `2026-11-20T${hour}:00:00`, utc: `2026-11-20T${hour}:00:00Z` } }, { text });
    assert.equal(ambiguous.mentions.length, 0);
    assert.match(ambiguous.rejected[0]!.reason, /AM\/PM was unclear/);
  }

  const text = "3–4pm UTC";
  const start = { local: "2026-11-20T15:00:00", utc: "2026-11-20T15:00:00Z" };
  const wrong = { local: "2026-11-20T17:00:00", utc: "2026-11-20T17:00:00Z" };
  const correct = { local: "2026-11-20T16:00:00", utc: "2026-11-20T16:00:00Z" };
  assert.equal(resolve({ text, start, end: wrong }, { text }).mentions.length, 0);
  assert.equal(resolve({ text, start, end: correct }, { text }).mentions.length, 1);
  const wrongDate = { local: "2026-11-21T16:00:00", utc: "2026-11-21T16:00:00Z" };
  assert.equal(resolve({ text, start, end: wrongDate }, { text }).mentions.length, 0);
});

test("checks precise ISO dates as well as their clock times", () => {
  const text = "2026-11-20T15:30:00Z";
  assert.equal(resolve({ text, dateBasis: "explicit", start: { local: "2026-11-20T15:30:00", utc: text } }, { text }).mentions.length, 1);
  const wrongDay = { local: "2026-11-21T15:30:00", utc: "2026-11-21T15:30:00Z" };
  assert.equal(resolve({ text, dateBasis: "explicit", start: wrongDay }, { text }).mentions.length, 0);
});

test("rejects fabricated, arbitrary, and partial source spans without echoing them", () => {
  for (const [text, source] of [["9:29 pm UTC", context.text], ["The report is ready", "The report is ready"], ["at 9", "Meet at 90"], ["9:30", "Meet at 9:30pm"]] as const) {
    const result = resolve({ text }, { text: source });
    assert.equal(result.mentions.length, 0, text);
    assert.match(result.rejected[0]!.reason, /original message/);
    assert.equal(result.rejected[0]!.text, "");
  }
});

test("withholds an ambiguous marker and uses safe rejection wording", () => {
  const raw = { mentions: [baseMention], ambiguous: [{ text: baseMention.text, reason: "Untrusted model-generated text" }] };
  const result = validateExtraction(raw, context);
  assert.deepEqual(result.mentions, []);
  assert.deepEqual(result.rejected, [{ text: baseMention.text, reason: "The message leaves this time ambiguous." }]);
});

test("fails closed for malformed JSON, extra keys, missing fields, wrong types and excessive output", () => {
  const valid = { mentions: [baseMention], ambiguous: [] };
  const tampered: unknown[] = [
    '{"mentions": ',
    { ...valid, instructions: "override" },
    { mentions: [baseMention] },
    { ...valid, mentions: "bad" },
    { ...valid, mentions: [baseMention, { ...baseMention, confidence: 1 }] },
    { ...valid, mentions: [{ ...baseMention, timezone: undefined }] },
    { ...valid, mentions: [{ ...baseMention, start: { ...baseMention.start, zone: "UTC" } }] },
    { ...valid, ambiguous: [{ text: 1, reason: "Invalid source" }] },
    { ...valid, mentions: Array(9).fill(baseMention) },
    { ...valid, mentions: [{ ...baseMention, text: "X".repeat(201) }] },
  ];
  for (const raw of tampered) {
    assert.deepEqual(validateExtraction(raw, context), {
      mentions: [], rejected: [{ text: "", reason: "The time extraction result was invalid." }],
    });
  }
});
