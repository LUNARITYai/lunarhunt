import { Command, CommanderError } from "commander";
import { type Charter, loadCharterAt } from "./charter.ts";
import { type RunResult, runCheck, runHook } from "./engine.ts";
import { resolveRole } from "./engines.ts";
import { gitToplevel } from "./git.ts";
import { engineMessage } from "./messages.ts";
import { runAgentTrailer } from "./trailer.ts";

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

function isRoleName(
  charter: Charter,
  name: string,
): name is keyof Charter["roles"] {
  return Object.hasOwn(charter.roles, name);
}

function printResolvedRole(name: string | undefined): 0 | 2 {
  if (!name) {
    process.stderr.write("usage: wardens check role <name>\n");
    return 2;
  }
  const toplevel = gitToplevel(process.cwd());
  if (!toplevel) {
    process.stderr.write(
      `${engineMessage("git toplevel could not be resolved")}\n`,
    );
    return 2;
  }
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    process.stderr.write(`${loaded.errors.join("\n")}\n`);
    return 2;
  }
  if (!isRoleName(loaded.charter, name)) {
    process.stderr.write(`unknown role ${name}\n`);
    return 2;
  }
  const resolved = resolveRole(loaded.charter.roles[name]);
  process.stdout.write(`${JSON.stringify(resolved)}\n`);
  return 0;
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
    .argument("<rule>", "rule id, or role")
    .argument("[name]", "role name, or message file for agent-trailer")
    .action(async (rule: string, name?: string) => {
      if (rule === "role") {
        process.exitCode = printResolvedRole(name);
        return;
      }
      if (rule === "agent-trailer") {
        const result = runAgentTrailer(name);
        if (result.stderr.length > 0) {
          process.stderr.write(result.stderr);
        }
        process.exitCode = result.exitCode;
        return;
      }
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
