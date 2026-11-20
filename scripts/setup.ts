import { spawn } from "node:child_process";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { runSetup, SetupError } from "./setup-lib.js";

async function promptSecret(prompt: string) {
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const terminal = createInterface({ input: stdin, output: muted, terminal: true, historySize: 0 });
  const abort = new AbortController();
  terminal.once("SIGINT", () => abort.abort());
  terminal.once("close", () => abort.abort());
  stdout.write(`${prompt}: `);
  try {
    return await terminal.question("", { signal: abort.signal });
  } catch {
    throw new SetupError("Setup cancelled.");
  } finally {
    terminal.close();
    stdout.write("\n");
  }
}

function runSst(args: string[], env: NodeJS.ProcessEnv, secret?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const executable = join(process.cwd(), "node_modules", "sst", "bin", "sst.mjs");
    const child = spawn(process.execPath, [executable, ...args], {
      env, stdio: secret === undefined ? ["ignore", "inherit", "inherit"] : ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => reject(new SetupError("Could not start SST. Run npm ci and try again.")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new SetupError(secret === undefined ? "SST deployment failed. See the SST output above." :
        `SST could not save ${args[2]}. Check AWS credentials and permissions, then rerun setup.`));
    });
    // A child that exits before reading its stdin reports its failure through close.
    child.stdin?.on("error", () => {});
    if (secret !== undefined) child.stdin?.end(secret);
  });
}

try {
  await runSetup(process.argv.slice(2), {
    cwd: process.cwd(), env: process.env, log: message => console.log(message),
    prompt: stdin.isTTY && stdout.isTTY ? promptSecret : undefined, runSst,
  });
} catch (error) {
  console.error(error instanceof SetupError ? error.message : "Could not finish setup. Check the project directory and rerun setup.");
  process.exitCode = 1;
}
