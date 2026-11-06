import { type Pipeline, type Segment, tokenizeAll } from "./command.ts";

/**
 * Best-effort shell deny for the Claude Code worktree hook entrypoints
 * (`wardens worktree create|remove --tool claude`, issue #51). It is a speed
 * bump, not the protection: text parsing cannot close this class (ANSI-C
 * quoting, `$(cat file)`, `xargs`, `node -e`, `python -c` and script files all
 * get through). Safety comes from the entrypoints granting an agent nothing:
 * the primary checkout and the Charter come from the running bundle, scope can
 * only narrow, and `remove` touches only clean, pushed subagent worktrees.
 *
 * One generic rule, applied only to a segment whose executable resolves to the
 * Wardens entrypoint (`wardens`, or a path ending in `wardens.mjs` or `cli.ts`, after the
 * wrappers `env`, `exec`, `node`, `tsx`, `pnpm exec`, `pnpm --filter ... exec`,
 * `npx`, `sh -c` and `eval`): deny a dynamic construct in the arguments, any
 * `--tool` flag, and the subcommands `worktree create` and `worktree remove`.
 * `wardens worktree list`, `wardens doctor` and the other plain forms pass. A
 * segment whose executable word is itself dynamic (`$bundle`, `{node,x}`) is
 * denied when it names the entrypoint. Words inside text commands (commit
 * messages, PR bodies, `rg` patterns, `sed` and `awk` scripts) never match.
 *
 * Alias definitions that name the entrypoint (`git -c alias.x=!...`,
 * `git config alias.x ...`, `gh alias set`, `alias w=...`) are denied too.
 */

const PASS_THROUGH = new Set([
  "env",
  "exec",
  "command",
  "builtin",
  "nohup",
  "time",
  "nice",
  "sudo",
  "doas",
  "timeout",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const RUNNERS = new Set(["node", "tsx", "bun", "deno", "ts-node"]);
const PACKAGE_EXEC = new Set(["npx", "pnpx", "bunx"]);
const RUNNER_VALUE_FLAGS = new Set([
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
  "--env-file",
]);
const MAX_DEPTH = 4;
const NAMES_ENTRYPOINT = /wardens|cli\.ts/;

function base(word: string): string {
  return word.split("/").pop() ?? "";
}

function isEntrypointWord(word: string): boolean {
  const name = base(word);
  return name === "wardens" || name === "wardens.mjs" || name === "cli.ts";
}

type Resolved =
  | { kind: "entry"; at: number }
  | { kind: "dynamic" }
  | { kind: "nested"; strings: string[] }
  | { kind: "other" };

const OTHER: Resolved = { kind: "other" };

/** Follows wrappers from `argv[from]` to the executable the shell would finally run. */
function resolve(
  argv: readonly string[],
  expand: ReadonlySet<number>,
  from: number,
): Resolved {
  let i = from;
  while (i < argv.length) {
    const word = argv[i] ?? "";
    if (expand.has(i) && word !== "[" && word !== "[[") {
      return { kind: "dynamic" };
    }
    const name = base(word);
    if (PASS_THROUGH.has(name)) {
      i += 1;
      while (
        i < argv.length &&
        ((argv[i] ?? "").startsWith("-") ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i] ?? "") ||
          /^[0-9.]+[smhd]?$/.test(argv[i] ?? ""))
      ) {
        i += 1;
      }
      continue;
    }
    if (name === "eval") {
      return { kind: "nested", strings: [argv.slice(i + 1).join(" ")] };
    }
    if (isEntrypointWord(word)) {
      return { kind: "entry", at: i };
    }
    if (RUNNERS.has(name)) {
      i += 1;
      while (i < argv.length && (argv[i] ?? "").startsWith("-")) {
        i += RUNNER_VALUE_FLAGS.has(argv[i] ?? "") ? 2 : 1;
      }
      if (expand.has(i)) {
        return { kind: "dynamic" };
      }
      return isEntrypointWord(argv[i] ?? "") ? { kind: "entry", at: i } : OTHER;
    }
    if (name === "pnpm" || name === "yarn") {
      const exec = argv.findIndex(
        (w, k) => k > i && (w === "exec" || w === "dlx"),
      );
      if (exec === -1) {
        return OTHER;
      }
      i = exec + 1;
      continue;
    }
    if (PACKAGE_EXEC.has(name)) {
      i += 1;
      while (i < argv.length && (argv[i] ?? "").startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (SHELLS.has(name)) {
      const c = argv.findIndex((w, k) => k > i && /^-[a-z]*c[a-z]*$/.test(w));
      const text = c === -1 ? undefined : argv[c + 1];
      return text === undefined ? OTHER : { kind: "nested", strings: [text] };
    }
    return OTHER;
  }
  return OTHER;
}

function dynamicWord(word: string): boolean {
  return word.includes("`") || word.includes("$(") || word.includes("${");
}

/** Reads `at` as the entrypoint word and judges its arguments. */
function entryArgsDenied(
  segment: Segment,
  at: number,
  expand: ReadonlySet<number>,
): boolean {
  const args = segment.argv.slice(at + 1);
  if (args.some(dynamicWord) || [...expand].some((k) => k > at)) {
    return true;
  }
  if (args.some((w) => w === "--tool" || w.startsWith("--tool="))) {
    return true;
  }
  const worktree = args.indexOf("worktree");
  return (
    worktree !== -1 &&
    args.slice(worktree + 1).some((w) => w === "create" || w === "remove")
  );
}

function aliasNamesEntrypoint(argv: readonly string[]): boolean {
  const name = base(argv[0] ?? "");
  const names = argv.some((w) => NAMES_ENTRYPOINT.test(w));
  if (!names) {
    return false;
  }
  if (name === "git") {
    return argv.some((w) => /alias\./.test(w));
  }
  if (name === "gh") {
    return argv[1] === "alias";
  }
  return name === "alias";
}

function segmentDenied(segment: Segment, depth: number): boolean {
  const expand = new Set(segment.expand);
  if (aliasNamesEntrypoint(segment.argv)) {
    return true;
  }
  const res = resolve(segment.argv, expand, 0);
  switch (res.kind) {
    case "entry":
      return entryArgsDenied(segment, res.at, expand);
    case "dynamic":
      return segment.argv.some(
        (w) => NAMES_ENTRYPOINT.test(w) || w === "worktree" || w === "--tool",
      );
    case "nested":
      return res.strings.some((text) => textDenied(text, depth + 1));
    default:
      return false;
  }
}

function pipelinesDenied(
  pipelines: readonly Pipeline[],
  depth: number,
): boolean {
  return pipelines.some(
    (pipeline) =>
      pipeline.ok &&
      pipeline.segments.some((segment) => segmentDenied(segment, depth)),
  );
}

function textDenied(text: string, depth: number): boolean {
  if (depth > MAX_DEPTH) {
    return NAMES_ENTRYPOINT.test(text);
  }
  const pipelines = tokenizeAll(text);
  if (pipelines.some((p) => !p.ok)) {
    return NAMES_ENTRYPOINT.test(text);
  }
  return pipelinesDenied(pipelines, depth);
}

/** True when the parsed command would reach a worktree hook entrypoint (best effort). */
export function invokesWorktreeHook(pipelines: readonly Pipeline[]): boolean {
  return pipelinesDenied(pipelines, 0);
}
