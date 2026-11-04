import { Command, CommanderError } from "commander";
import { type RunResult, runCheck, runHook } from "./engine.ts";
import { engineMessage } from "./messages.ts";

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return Promise.resolve("");
  }
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", reject);
  });
}

function emit(result: RunResult): 0 | 2 {
  try {
    if (result.stdout.length > 0) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.length > 0) {
      process.stderr.write(result.stderr);
    }
    return result.exitCode;
  } catch {
    process.stderr.write(
      `${engineMessage("the hook response could not be written")}\n`,
    );
    return 2;
  }
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("wardens")
    .description("PANOPTICON Wardens")
    .exitOverride((err) => {
      throw err;
    });

  program
    .command("check")
    .argument("<rule>", "rule id")
    .action(async (rule: string) => {
      const stdin = rule === "charter-validate" ? "" : await readStdin();
      process.exitCode = emit(runCheck(rule, stdin));
    });

  program
    .command("hook")
    .requiredOption("--tool <tool>", "claude or cursor")
    .requiredOption("--event <event>", "hook event name")
    .action(async (opts: { tool: string; event: string }) => {
      const stdin = await readStdin();
      process.exitCode = emit(runHook(opts.tool, opts.event, stdin));
    });

  await program.parseAsync(process.argv);
}

try {
  await main();
} catch (err) {
  if (err instanceof CommanderError) {
    const helpOrVersion =
      err.code === "commander.helpDisplayed" ||
      err.code === "commander.version" ||
      err.code === "commander.help";
    process.exitCode = helpOrVersion || err.exitCode === 0 ? 0 : 2;
  } else {
    process.stderr.write(`${engineMessage("the engine failed")}\n`);
    process.exitCode = 2;
  }
}
