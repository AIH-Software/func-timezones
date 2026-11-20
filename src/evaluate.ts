import { writeFile } from "node:fs/promises";
import { createHaiku, createLuna } from "./providers.js";
import { evaluationCases } from "./evaluation-cases.js";
import { validateExtraction } from "./time.js";

const selection = process.argv.find(arg => arg.startsWith("--provider="))?.split("=")[1] ?? "both";
if (!["both", "haiku", "luna"].includes(selection)) throw new Error("Use --provider=both, haiku, or luna");
const selected = selection === "both" ? ["haiku", "luna"] : [selection];
for (const name of selected) {
  const variable = name === "haiku" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  if (!process.env[variable] || process.env[variable] === "replace-me") throw new Error(`Set ${variable} before running paid evaluation calls`);
}
const results: Array<Record<string, unknown>> = [];
for (const name of selected) {
  const provider = name === "haiku"
    ? createHaiku({ apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", timeoutMs: 20_000 })
    : createLuna({ apiKey: process.env.OPENAI_API_KEY!, model: process.env.OPENAI_MODEL || "gpt-6-luna", timeoutMs: 20_000 });
  for (const fixture of evaluationCases) {
    const started = performance.now();
    try {
      const raw = await provider.extract(fixture);
      const validated = validateExtraction(raw, fixture);
      const actual = validated.mentions.map(mention => mention.start.utc).sort();
      const ends = validated.mentions.map(mention => mention.end?.utc).filter(Boolean).sort();
      const pass = JSON.stringify(actual) === JSON.stringify([...fixture.expectedUtc].sort())
        && JSON.stringify(ends) === JSON.stringify([...(fixture.expectedEndUtc ?? [])].sort());
      results.push({ provider: name, case: fixture.id, pass, expected: fixture.expectedUtc, actual, ends,
        falseConversion: actual.some(instant => !fixture.expectedUtc.includes(instant)),
        missedConversion: fixture.expectedUtc.some(instant => !actual.includes(instant)),
        milliseconds: Math.round(performance.now() - started), withheld: validated.rejected.length });
      console.log(`${name}: ${fixture.id}: ${pass ? "PASS" : "FAIL"}`);
    } catch (error) {
      results.push({ provider: name, case: fixture.id, pass: false, error: error instanceof Error ? error.name : "unknown" });
      console.log(`${name}: ${fixture.id}: ERROR`);
    }
  }
}
await writeFile("evaluation-results.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(`${results.filter(result => result.pass).length}/${results.length} passed; see evaluation-results.json`);
if (results.some(result => !result.pass)) process.exitCode = 1;
