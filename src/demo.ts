import { validateExtraction } from "./time.js";
import { renderNotice } from "./render.js";

const context = { text: "Let's meet tomorrow at 10 am Pacific time", postedAtUtc: "2026-11-20T20:00:00Z", senderTimezone: "America/Los_Angeles" };
// This fixture exercises the real validator and renderer. It is not a live AI result.
const raw = { mentions: [{ text: "tomorrow at 10 am Pacific time", timezone: "America/Los_Angeles",
  timezoneBasis: "explicit", dateBasis: "relative", start: { local: "2026-11-21T10:00:00", utc: "2026-11-21T18:00:00Z" }, end: null }], ambiguous: [] };
const result = validateExtraction(raw, context);
if (!result.mentions.length) throw new Error("Demo fixture failed validation");
for (const tz of ["America/New_York", "Asia/Kolkata", "Asia/Kathmandu"]) {
  console.log(tz, renderNotice(result.mentions, { id: "DEMO", tz }, "profile").text);
}
console.log("\nSlack-native payload (same timestamp, viewer-local rendering):");
console.log(JSON.stringify(renderNotice(result.mentions, { id: "DEMO" }, "slack"), null, 2));
