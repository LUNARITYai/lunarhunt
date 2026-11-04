import { Command, CommanderError } from "commander";
import { loadCharterAt } from "./charter.ts";
import { gitToplevel } from "./git.ts";
import { CHARTER_INVALID_MESSAGE } from "./messages.ts";
import {
  allowVerdict,
  checkExitCode,
  type Decision,
  type Verdict,
} from "./verdict.ts";

function writeVerdict(verdict: Verdict): void {
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

function engineDeny(message: string): Verdict {
  return {
    rule: "engine",
    decision: "deny",
    message,
    replacement: null,
    rendered: "deny",
  };
}

function runCharterValidate(): Decision {
  const toplevel = gitToplevel(process.cwd());
  if (!toplevel) {
    writeVerdict(engineDeny(CHARTER_INVALID_MESSAGE));
    return "deny";
  }
  const result = loadCharterAt(toplevel);
  if (!result.ok) {
    writeVerdict(engineDeny(CHARTER_INVALID_MESSAGE));
    return "deny";
  }
  writeVerdict(allowVerdict());
  return "allow";
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
    .action((rule: string) => {
      if (rule !== "charter-validate") {
        writeVerdict(
          engineDeny(
            `Blocked by Warden engine: unknown rule ${rule}. Label the issue needs:human.`,
          ),
        );
        process.exitCode = 2;
        return;
      }
      process.exitCode = checkExitCode(runCharterValidate());
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
    process.stderr.write(`${CHARTER_INVALID_MESSAGE}\n`);
    process.exitCode = 2;
  }
}
