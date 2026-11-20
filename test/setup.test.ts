import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { callbackUrl, runSetup, setupOptions } from "../scripts/setup-lib.js";

const slackEnv = { SLACK_BOT_TOKEN: "xoxb-fixture", SLACK_SIGNING_SECRET: "fixture-signing-secret" };
const anthropic = "fixture-anthropic-key";
const openai = "fixture-openai-key";
const endpoint = "https://example.execute-api.us-east-1.amazonaws.com/slack";

async function fixture(t: TestContext, env: NodeJS.ProcessEnv) {
  const cwd = await mkdtemp(join(tmpdir(), "timezones-setup-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bootstrap = await readFile(new URL("../slack-manifest.json", import.meta.url), "utf8");
  await writeFile(join(cwd, "slack-manifest.json"), bootstrap);
  const lines: string[] = [];
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; secret?: string }> = [];
  const checked: string[] = [];
  const driver: Parameters<typeof runSetup>[1] = {
    cwd, env, log: line => lines.push(line),
    fetcher: async (url, request) => {
      assert.equal(url, "https://slack.com/api/auth.test");
      assert.equal(request?.method, "POST");
      assert.equal(new Headers(request?.headers).get("Authorization"), `Bearer ${slackEnv.SLACK_BOT_TOKEN}`);
      assert.equal(calls.length, 0, "verify Slack before saving secrets");
      checked.push("checked");
      return Response.json({ ok: true, team_id: "T012345678", bot_id: "B012345678" });
    },
    runSst: async (args, commandEnv, secret) => {
      calls.push({ args, env: commandEnv, secret });
      if (args[0] === "deploy") {
        await mkdir(join(cwd, ".sst"));
        await writeFile(join(cwd, ".sst", "outputs.json"), JSON.stringify({ slackEndpoint: endpoint }));
      }
    },
  };
  return { cwd, bootstrap: JSON.parse(bootstrap), calls, checked, driver, lines };
}

test("validates stages, including explicit overrides and malformed arguments", () => {
  assert.equal(setupOptions([], {}).stage, "production");
  assert.equal(setupOptions([], { SST_STAGE: "demo" }).stage, "demo");
  assert.deepEqual(setupOptions(["--stage", "demo-1", "--non-interactive"], { SST_STAGE: "ignored" }), {
    stage: "demo-1", nonInteractive: true, help: false,
  });
  for (const stage of ["", "../outside", "not/valid", "--file", "UPPER", "123", "trailing-", "x".repeat(33)]) {
    assert.throws(() => setupOptions([`--stage=${stage}`], {}), /Stage must/);
  }
  assert.throws(() => setupOptions(["--extra"], {}), /Usage:/);
});

for (const [description, aiEnv, stores] of [
  ["Anthropic only", { ANTHROPIC_API_KEY: anthropic }, { anthropic }],
  ["OpenAI only", { OPENAI_API_KEY: openai }, { openai }],
  ["both providers", { ANTHROPIC_API_KEY: anthropic, OPENAI_API_KEY: openai }, { anthropic, openai }],
] as const) {
  test(`unattended setup with ${description} deploys once and keeps credentials out of argv, output and files`, async t => {
    const { cwd, driver, calls, checked, bootstrap, lines } = await fixture(t, {
      ...aiEnv, ...slackEnv, AWS_PROFILE: "deployment", TIME_RENDER_MODE: "profile",
    });
    const result = await runSetup(["--non-interactive", "--stage", "demo"], driver);
    assert.deepEqual(result, { manifest: ".setup/slack-manifest.demo.json", endpoint });
    assert.deepEqual(checked, ["checked"]);
    assert.deepEqual(calls.map(call => call.args), [
      ["secret", "set", "ProviderKeys", "--stage", "demo"],
      ["secret", "set", "SlackCredentials", "--stage", "demo"],
      ["deploy", "--stage", "demo"],
    ]);
    assert.deepEqual(JSON.parse(calls[0]!.secret!), stores);
    assert.deepEqual(JSON.parse(calls[1]!.secret!), {
      botToken: slackEnv.SLACK_BOT_TOKEN, signingSecret: slackEnv.SLACK_SIGNING_SECRET, teamId: "T012345678",
    });
    assert.equal(calls[2]!.secret, undefined);
    for (const call of calls) assert.deepEqual(call.env, { AWS_PROFILE: "deployment", TIME_RENDER_MODE: "profile" });

    const files = await readdir(cwd, { recursive: true, withFileTypes: true });
    const fileContents = await Promise.all(files.filter(file => file.isFile())
      .map(file => readFile(join(file.parentPath, file.name), "utf8")));
    const visible = JSON.stringify([calls.map(({ args, env }) => ({ args, env })), lines, ...fileContents]);
    for (const credential of [anthropic, openai, ...Object.values(slackEnv)]) assert.ok(!visible.includes(credential));

    const manifest = JSON.parse(await readFile(join(cwd, result!.manifest), "utf8"));
    assert.equal(bootstrap.settings.event_subscriptions, undefined);
    assert.equal(bootstrap.settings.interactivity, undefined);
    assert.equal(bootstrap.features.shortcuts, undefined);
    assert.deepEqual(manifest.oauth_config, bootstrap.oauth_config);
    assert.equal(manifest.settings.socket_mode_enabled, false);
    assert.deepEqual(manifest.settings.interactivity, { is_enabled: true, request_url: endpoint });
    assert.deepEqual(manifest.settings.event_subscriptions, {
      request_url: endpoint, bot_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
    });
    assert.equal(manifest.features.shortcuts[0].type, "message");
    assert.equal(manifest.features.shortcuts[0].callback_id, "convert_time");
  });
}

test("interactive setup accepts a skipped provider using the hidden prompt driver", async t => {
  const { driver, calls, lines } = await fixture(t, {});
  const answers = ["", openai, slackEnv.SLACK_BOT_TOKEN, slackEnv.SLACK_SIGNING_SECRET];
  const prompted: string[] = [];
  driver.prompt = async message => { prompted.push(message); return answers.shift()!; };
  await runSetup([], driver);
  assert.deepEqual(JSON.parse(calls[0]!.secret!), { openai });
  assert.equal(prompted.length, 4);
  assert.ok(lines.some(line => line.includes("slack-manifest.json")));
});

test("no provider keys stops before Slack validation, SST or manifest generation", async t => {
  const { cwd, driver, calls, checked } = await fixture(t, slackEnv);
  await assert.rejects(runSetup(["--non-interactive"], driver), /at least one AI API key/);
  assert.deepEqual([calls, checked, await readdir(cwd)], [[], [], ["slack-manifest.json"]]);
});

test("invalid deployment settings stop before Slack validation, SST or manifest generation", async t => {
  const { cwd, driver, calls, checked } = await fixture(t, {
    ...slackEnv, OPENAI_API_KEY: openai, MAX_MESSAGE_AGE_SECONDS: "900",
  });
  await assert.rejects(runSetup(["--non-interactive"], driver), /MAX_MESSAGE_AGE_SECONDS/);
  assert.deepEqual([calls, checked, await readdir(cwd)], [[], [], ["slack-manifest.json"]]);
});

test("invalid Slack token stops before secrets or deploy without logging Slack error content", async t => {
  const { driver, calls, lines } = await fixture(t, { ...slackEnv, OPENAI_API_KEY: openai });
  driver.fetcher = async () => Response.json({ ok: false, error: slackEnv.SLACK_BOT_TOKEN });
  await assert.rejects(runSetup(["--non-interactive"], driver), {
    message: "Slack could not verify a workspace for this token. Use the Bot User OAuth Token from a workspace installation.",
  });
  assert.deepEqual(calls, []);
  assert.ok(!lines.join("\n").includes(slackEnv.SLACK_BOT_TOKEN));
});

test("checks that SST provides the full HTTPS callback URL", () => {
  assert.equal(callbackUrl({ slackEndpoint: endpoint }), endpoint);
  for (const slackEndpoint of [undefined, "http://example.com/slack", "https://example.com", "https://example.com/slack?secret=x",
    "https://user:pass@example.com/slack", "https://example.com/slack#wrong", "https://example.com/slack/wrong"]) {
    assert.throws(() => callbackUrl({ slackEndpoint }), /valid HTTPS \/slack endpoint/);
  }
});
