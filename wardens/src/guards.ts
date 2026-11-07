import { homedir } from "node:os";
import { join } from "node:path";
import picomatch from "picomatch";
import type { Charter } from "./charter.ts";
import {
  directoryChange,
  expandsDdOperand,
  firstDeny,
  rewriteCommand,
  type Segment,
  secretCandidates,
  shellWriteTargets,
  tokenizeAll,
  valueTargets,
} from "./command.ts";
import { externalAllows } from "./external.ts";
import { EngineFailure } from "./failures.ts";
import { anyGlob, basename, denyListMatches } from "./globs.ts";
import { wardenMessage } from "./messages.ts";
import { resolveAbsolutePath, resolveRepoPath } from "./paths.ts";
import type { Objection, RuleContext } from "./rules.ts";
import type { TaskState } from "./task.ts";

function block(
  rule: string,
  decision: Objection["decision"],
  what: string,
  next: string,
  replacement: string | null = null,
): Objection {
  return {
    rule,
    decision,
    message: wardenMessage(rule, what, next),
    replacement,
  };
}

export function pathInScope(
  path: string,
  charter: Charter,
  task: TaskState,
): boolean {
  if (!anyGlob(charter.paths.allowed_paths, path)) {
    return false;
  }
  if (task.kind === "missing") {
    return true;
  }
  if (task.kind === "invalid") {
    return false;
  }
  return anyGlob(task.allowed_paths, path);
}

function isMutation(action: string): boolean {
  return action === "edit" || action === "write" || action === "delete";
}

export function scopeGuard(ctx: RuleContext): Objection | null {
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  if (ctx.event.path === null) {
    return block(
      "scope-guard",
      "deny",
      "path is missing",
      "Ask for needs:human",
    );
  }
  if (ctx.task.kind === "invalid") {
    return block(
      "scope-guard",
      "deny",
      ".panopticon/task.json is invalid for this task",
      "Ask for needs:human",
    );
  }
  if (!pathInScope(ctx.event.path, ctx.charter, ctx.task)) {
    return block(
      "scope-guard",
      "deny",
      `path ${ctx.event.path} not in allowed_paths for this task`,
      "Ask for needs:human",
    );
  }
  return null;
}

/** The deny side of `protected-paths`. The post-edit audit uses it alone, because a human may have approved an ask path. */
export function protectedDeny(ctx: RuleContext): Objection | null {
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  if (ctx.event.path === null) {
    return block(
      "protected-paths",
      "deny",
      "path is missing",
      "Ask for needs:human",
    );
  }
  if (denyListMatches(ctx.charter.paths.protected.deny, ctx.event.path)) {
    return block(
      "protected-paths",
      "deny",
      `${ctx.event.path} is deny for agents`,
      "A human must change it in a reviewed PR",
    );
  }
  return null;
}

export function generatedFilesGuard(ctx: RuleContext): Objection | null {
  if (ctx.event.action === "shell") {
    return shellEditVerdict(ctx, generatedFilesGuard);
  }
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  if (ctx.event.path === null) {
    return block(
      "generated-files-guard",
      "deny",
      "path is missing",
      "Ask for needs:human",
    );
  }
  if (anyGlob(ctx.charter.paths.generated, ctx.event.path)) {
    return block(
      "generated-files-guard",
      "deny",
      `${ctx.event.path} is generated`,
      "Run uv run export-openapi to regenerate it",
    );
  }
  return null;
}

/** True when a path is named `.git` or lies under a `.git` directory. Case-insensitive: the default macOS volume is. */
function isGitMetadataPath(path: string): boolean {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => part.toLowerCase() === ".git");
}

function gitMetadataBlock(): Objection {
  return block(
    "protected-paths",
    "deny",
    "git metadata is not editable by agents",
    "Label the issue needs:human",
  );
}

/** The launcher anchor directory (`~/.config/panopticon`) in a path or in shell text. */
const ANCHOR_DIR = /\.config\/+panopticon/i;
const ANCHOR_FILE = /panopticon\/+primaries/i;

function anchorBlock(): Objection {
  return block(
    "protected-paths",
    "deny",
    "the Wardens launcher configuration is not editable by agents",
    "Label the issue needs:human",
  );
}

function expansionBlock(): Objection {
  return block(
    "command-guard",
    "deny",
    "the command could not be parsed safely",
    "Retry with literal paths",
  );
}

/**
 * The one verdict for a command the tokenizer rejects: a subshell, group,
 * process substitution, reserved word in command position, brace expansion,
 * command substitution, a `-c` command string, or a `#` the two readings
 * disagree on. Returned by `command-guard` and, as defence in depth, by
 * `expansionDeny` (so `protected-paths` and `secret-read-guard` never skip a
 * pipeline they cannot read).
 */
function unparseableBlock(): Objection {
  return block(
    "command-guard",
    "deny",
    "the command could not be parsed safely",
    "Retry without subshells, groups or shell comments",
  );
}

/**
 * A word the shell rewrites (a variable, an unquoted glob or brace, `~user`)
 * names a path we cannot read from the text. It is provably inside the
 * worktree only when it has no variable, brace or `~user`, no glob segment can
 * match `.git`, and its literal reading resolves inside the repository.
 */
function provablyInside(
  ctx: RuleContext,
  path: string,
  cwd: string,
  home: string,
): boolean {
  if (/[${}]/.test(path) || /^~/.test(path.replace(/^~\//, "x/"))) {
    return false;
  }
  const expanded = expandHome(path, home);
  for (const part of expanded.split("/")) {
    if (/[*?[]/.test(part) && picomatch.isMatch(".git", part, { dot: false })) {
      return false;
    }
  }
  return resolveRepoPath(expanded, cwd, ctx.root).ok;
}

type ShellTarget = {
  path: string;
  cwd: string;
  expanding: boolean;
  /** A file the command writes, or a directory it changes into. */
  kind: "write" | "cd";
};

/** One command word list with the directory the shell is in when it runs. */
type Step = {
  segment: Segment;
  cwd: string;
  /** The directory change this segment makes, if it is a `cd`, `pushd` or `popd`. */
  change: { path: string | null; expanding: boolean } | null;
};

/**
 * Walks the command line in order and tracks the directory literal `cd`
 * commands move to, so later relative words resolve from where the shell is.
 * A directory change the tracker cannot follow is reported through `change`
 * and denied by `expansionDeny`.
 */
function trackedSteps(ctx: RuleContext, command: string): Step[] {
  const out: Step[] = [];
  const home = ctx.home ?? homedir();
  for (const pipeline of tokenizeAll(command)) {
    if (!pipeline.ok) {
      continue;
    }
    let cwd = ctx.event.cwd;
    for (const segment of pipeline.segments) {
      const dir = directoryChange(segment);
      const change =
        dir === null
          ? null
          : {
              path: dir.path,
              expanding:
                dir.path !== null &&
                dir.path.length > 0 &&
                segment.expand.some((i) => {
                  const word = segment.argv[i] ?? "";
                  return word === dir.path || word.endsWith(dir.path ?? "");
                }),
            };
      out.push({ segment, cwd, change });
      if (change?.path && !change.expanding && change.path !== "-") {
        const next = resolveAbsolutePath(expandHome(change.path, home), cwd);
        if (next !== null) {
          cwd = next;
        }
      }
    }
  }
  return out;
}

/** Write targets and `cd` arguments of a command line, in order, each with the directory it resolves from. */
function shellTargets(ctx: RuleContext, command: string): ShellTarget[] {
  const out: ShellTarget[] = [];
  for (const { segment, cwd, change } of trackedSteps(ctx, command)) {
    const expandingWords = segment.expand.map((i) => segment.argv[i] ?? "");
    const isExpanding = (path: string) =>
      path.length > 0 &&
      expandingWords.some((word) => word === path || word.endsWith(path));
    for (const path of shellWriteTargets(segment)) {
      out.push({ path, cwd, expanding: isExpanding(path), kind: "write" });
    }
    if (change?.path) {
      out.push({
        path: change.path,
        cwd,
        expanding: change.expanding,
        kind: "cd",
      });
    }
  }
  return out;
}

/**
 * Fail closed on shell words the shell expands after we read them, when they
 * name a write target or a directory change and cannot be shown to stay inside
 * the worktree, and on directory changes the tracker cannot follow (`cd` with
 * no argument, `cd ""`, `cd -`, `pushd`, `popd`) or that leave the worktree:
 * later relative words are resolved from the tracked directory, so it must be
 * known and inside. Called by `secretReadGuard` and `gitMetadataDeny`.
 */
export function expansionDeny(ctx: RuleContext): Objection | null {
  if (ctx.event.action !== "shell" || ctx.event.command === null) {
    return null;
  }
  if (tokenizeAll(ctx.event.command).some((pipeline) => !pipeline.ok)) {
    return unparseableBlock();
  }
  const home = ctx.home ?? homedir();
  for (const step of trackedSteps(ctx, ctx.event.command)) {
    const path = step.change?.path;
    if (
      step.change &&
      (path === null || path === undefined || path === "-" || path === "")
    ) {
      return expansionBlock();
    }
    if (step.change && path && !step.change.expanding) {
      if (!resolveRepoPath(expandHome(path, home), step.cwd, ctx.root).ok) {
        return expansionBlock();
      }
    }
  }
  for (const target of shellTargets(ctx, ctx.event.command)) {
    if (
      target.expanding &&
      !provablyInside(ctx, target.path, target.cwd, home)
    ) {
      return expansionBlock();
    }
  }
  // `out=$HOME/x`, `--sink=x$X`, `of=~root/x` (#75): a key=value value the
  // shell may rewrite must be provably inside, whatever the key. So must any
  // operand of `dd` that the shell fills in: it may be `of=`.
  for (const { segment, cwd } of trackedSteps(ctx, ctx.event.command)) {
    if (expandsDdOperand(segment)) {
      return expansionBlock();
    }
    for (const value of valueTargets(segment)) {
      if (value.expanding && !provablyInside(ctx, value.path, cwd, home)) {
        return expansionBlock();
      }
    }
  }
  return null;
}

/**
 * Every path a shell command writes, as repo-relative paths: its own write
 * targets plus `key=value` and `--opt=value` values. Paths that resolve outside
 * the worktree are left to the escape check in `secretReadGuard`.
 */
function shellEditPaths(ctx: RuleContext, command: string): string[] {
  const home = ctx.home ?? homedir();
  const out: string[] = [];
  for (const { segment, cwd } of trackedSteps(ctx, command)) {
    for (const target of [
      ...shellWriteTargets(segment),
      ...valueTargets(segment)
        .filter((value) => !value.pattern)
        .map((value) => value.path),
    ]) {
      const resolved = resolveRepoPath(expandHome(target, home), cwd, ctx.root);
      // A secret is already denied as a candidate by `secret-read-guard`, which
      // keeps its own verdict (a `--config=.env` may be a read).
      if (
        resolved.ok &&
        !denyListMatches(ctx.charter.paths.secrets_deny_read, resolved.path)
      ) {
        out.push(resolved.path);
      }
    }
  }
  return out;
}

/**
 * Applies an edit-tool rule to each path a shell command writes (#75), as if
 * an Edit tool call had named it. The strongest objection wins; a deny ends
 * the walk.
 */
function shellEditVerdict(
  ctx: RuleContext,
  rule: (edit: RuleContext) => Objection | null,
): Objection | null {
  if (ctx.event.action !== "shell" || ctx.event.command === null) {
    return null;
  }
  let found: Objection | null = null;
  for (const path of shellEditPaths(ctx, ctx.event.command)) {
    const objection = rule({
      ...ctx,
      event: { ...ctx.event, action: "write", path, command: null },
    });
    if (objection?.decision === "deny") {
      return objection;
    }
    found ??= objection;
  }
  return found;
}

/**
 * Built-in (not Charter) deny: agents never write a `.git` file or directory
 * in any worktree, nor the launcher configuration directory, through the edit
 * tools or through shell write targets. Shell targets are checked as written
 * and as resolved. Ring 0 is a guard rail, not a sandbox.
 */
export function gitMetadataDeny(ctx: RuleContext): Objection | null {
  if (isMutation(ctx.event.action)) {
    const path = ctx.event.path;
    if (path === null) {
      return null;
    }
    if (isGitMetadataPath(path)) {
      return gitMetadataBlock();
    }
    return ANCHOR_DIR.test(path.replaceAll("\\", "/")) ? anchorBlock() : null;
  }
  if (ctx.event.action !== "shell" || ctx.event.command === null) {
    return null;
  }
  const command = ctx.event.command;
  const words = tokenizeAll(command).flatMap((pipeline) =>
    pipeline.ok ? pipeline.segments.flatMap((segment) => segment.argv) : [],
  );
  if (
    [command, ...words].some(
      (text) => ANCHOR_DIR.test(text) || ANCHOR_FILE.test(text),
    )
  ) {
    return anchorBlock();
  }
  const unexpandable = expansionDeny(ctx);
  if (unexpandable) {
    return unexpandable;
  }
  const home = ctx.home ?? homedir();
  for (const target of shellTargets(ctx, command)) {
    if (target.kind !== "write") {
      continue;
    }
    const path = expandHome(target.path, home);
    const absolute = resolveAbsolutePath(path, target.cwd);
    if (
      isGitMetadataPath(path) ||
      (absolute !== null && isGitMetadataPath(absolute))
    ) {
      return gitMetadataBlock();
    }
  }
  // `foo out=.git/x`, `foo --sink=.git` (#75): the value of any key=value word.
  for (const { segment, cwd } of trackedSteps(ctx, command)) {
    for (const value of valueTargets(segment)) {
      const path = expandHome(value.path, home);
      const absolute = resolveAbsolutePath(path, cwd);
      if (value.pattern || value.gitGlobal) {
        continue;
      }
      if (
        isGitMetadataPath(path) ||
        (absolute !== null && isGitMetadataPath(absolute))
      ) {
        return gitMetadataBlock();
      }
      if (absolute !== null && ANCHOR_DIR.test(absolute)) {
        return anchorBlock();
      }
    }
  }
  return null;
}

export function protectedPaths(ctx: RuleContext): Objection | null {
  const gitMetadata = gitMetadataDeny(ctx);
  if (gitMetadata) {
    return gitMetadata;
  }
  // `ask` guards edits only: agents must read the Covenant files (#46).
  if (ctx.event.action === "shell") {
    return shellEditVerdict(ctx, protectedEdit);
  }
  if (!isMutation(ctx.event.action)) {
    return null;
  }
  return protectedEdit(ctx);
}

/** The deny and ask verdicts for an edit of `ctx.event.path`, without the git-metadata check. */
function protectedEdit(ctx: RuleContext): Objection | null {
  const denied = protectedDeny(ctx);
  if (denied || ctx.event.path === null) {
    return denied;
  }
  const path = ctx.event.path;
  if (!pathInScope(path, ctx.charter, ctx.task)) {
    return null;
  }
  if (!anyGlob(ctx.charter.paths.protected.ask, path)) {
    return null;
  }
  if (!ctx.event.interactive) {
    return block(
      "protected-paths",
      "deny",
      `${path} requires ask and this session is non-interactive`,
      "Label the issue needs:human",
    );
  }
  return block(
    "protected-paths",
    "ask",
    `${path} requires approval`,
    "Ask Krzysztof to approve this edit in the session",
  );
}

function commandDeny(pattern: string): Objection {
  if (
    pattern.includes("no-verify") ||
    pattern === "git commit -n*" ||
    pattern.startsWith("LEFTHOOK=") ||
    pattern.includes("hooksPath")
  ) {
    return block(
      "command-guard",
      "deny",
      "git commit --no-verify is denied",
      "Remove --no-verify and retry",
    );
  }
  if (pattern.includes(" | ")) {
    return block(
      "command-guard",
      "deny",
      "piping a download into a shell is denied",
      "Do not pipe a download into a shell",
    );
  }
  if (pattern.startsWith("git push")) {
    return block(
      "command-guard",
      "deny",
      "git push --force is denied",
      "Push without rewriting history",
    );
  }
  return block(
    "command-guard",
    "deny",
    `${pattern} is denied`,
    "Choose a command The Charter allows",
  );
}

/** `git` subcommands that only read. Global options that redirect git are allowed with these alone. */
const READ_ONLY_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "cat-file",
  "blame",
  "grep",
  "describe",
  "shortlog",
  "for-each-ref",
  "merge-base",
  "name-rev",
  "show-ref",
  "diff-tree",
  "diff-files",
  "diff-index",
  "check-ignore",
  "count-objects",
  "version",
  "help",
  "whatchanged",
  "ls-remote",
  "show-branch",
  "verify-commit",
]);
/** Keys `git -c` may set for a read-only subcommand: presentation only. */
const HARMLESS_GIT_CONFIG =
  /^(color\.|log\.|core\.quotepath$|core\.abbrev$|diff\.(renames|context|algorithm)$)/i;
/** `git config` forms that only read. */
const GIT_CONFIG_READ = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
]);
const GIT_CONFIG_READ_EXTRAS = new Set([
  "--show-origin",
  "--show-scope",
  "--local",
  "--global",
  "--system",
  "--worktree",
  "--name-only",
  "--includes",
  "--no-includes",
  "-z",
  "--null",
]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "--namespace", "--super-prefix"]);

function gitMetadataCommandBlock(what: string): Objection {
  return block(
    "command-guard",
    "deny",
    what,
    "Use the dedicated wardens command or ask for needs:human",
  );
}

/**
 * Built-in (not Charter) deny for `git` invocations that rewrite repository
 * metadata or redirect git to other metadata: `init --separate-git-dir`,
 * worktree changes, `config` writes, and the global options `-c`,
 * `--git-dir` and `--work-tree` in front of a subcommand that writes.
 */
function gitRewriteDeny(segment: Segment): Objection | null {
  const argv = segment.argv;
  if ((argv[0] ?? "").split("/").pop() !== "git") {
    return null;
  }
  const configs: string[] = [];
  let redirected = false;
  let execPath = false;
  let index = 1;
  for (; index < argv.length; index += 1) {
    const word = argv[index] ?? "";
    const hasValue = word.includes("=");
    if (word === "-c" || longOption(word, "--config-env", 6)) {
      configs.push(
        hasValue ? word.slice(word.indexOf("=") + 1) : (argv[index + 1] ?? ""),
      );
      index += hasValue ? 0 : 1;
    } else if (
      longOption(word, "--git-dir", 6) ||
      longOption(word, "--work-tree", 6)
    ) {
      redirected = true;
      index += hasValue ? 0 : 1;
    } else if (hasValue && longOption(word, "--exec-path", 6)) {
      execPath = true;
    } else if (GIT_GLOBAL_WITH_VALUE.has(word)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      break;
    }
  }
  const sub = argv[index] ?? null;
  const args = argv.slice(index + 1);
  const reads = sub !== null && READ_ONLY_GIT.has(sub);
  if (execPath) {
    return gitMetadataCommandBlock("git --exec-path=<dir> is denied");
  }
  // git's option parser takes any unambiguous prefix: `--se` is enough for `init`.
  if (
    (sub === "init" || sub === "clone") &&
    args.some((a) => longOption(a, "--separate-git-dir", 4))
  ) {
    return gitMetadataCommandBlock("git --separate-git-dir is denied");
  }
  if (sub === "worktree" && args[0] !== "list") {
    return gitMetadataCommandBlock(
      "git worktree changes are denied; only git worktree list is allowed",
    );
  }
  if (sub === "config") {
    const flags = args.filter((a) => a.startsWith("-"));
    const readsOnly =
      flags.some((a) => GIT_CONFIG_READ.has(a)) &&
      flags.every(
        (a) => GIT_CONFIG_READ.has(a) || GIT_CONFIG_READ_EXTRAS.has(a),
      );
    if (!readsOnly) {
      return gitMetadataCommandBlock(
        "git config writes are denied; only --get, --get-all, --get-regexp and --list are allowed",
      );
    }
  }
  if (redirected && !reads) {
    return gitMetadataCommandBlock(
      "git --git-dir and --work-tree are denied in front of a command that writes",
    );
  }
  if (
    configs.length > 0 &&
    !(
      reads &&
      configs.every((c) => HARMLESS_GIT_CONFIG.test(c.split("=")[0] ?? ""))
    )
  ) {
    return gitMetadataCommandBlock(
      "git -c is denied except for presentation settings of a read-only command",
    );
  }
  return null;
}

/** Variables that redirect the shell or git: the directory a `cd` lands in, the home, startup files, git's own metadata. */
const REDIRECTING_ENV = /^(CDPATH|HOME|PWD|OLDPWD|BASH_ENV|ENV|GIT_.*)$/;
/** Allowed as a command prefix only (never standalone, exported or after `env`). */
const PREFIX_ENV_OK =
  /^GIT_(EDITOR|SEQUENCE_EDITOR|TERMINAL_PROMPT|AUTHOR_.+|COMMITTER_.+)$/;
const DECLARATIONS = new Set([
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
]);
const ENV_WRAPPERS = new Set(["command", "nohup", "time", "nice", "builtin"]);

function envBlock(name: string): Objection {
  return block(
    "command-guard",
    "deny",
    `setting ${name || "a variable"} is denied`,
    "Remove the assignment from the command",
  );
}

/** `--name` or an unambiguous prefix of it of at least `min` characters, with or without `=value`. */
function longOption(word: string, full: string, min: number): boolean {
  const name = word.split("=")[0] ?? "";
  return name.startsWith("--") && name.length >= min && full.startsWith(name);
}

/**
 * Built-in deny for assignments of variables that redirect the shell or git,
 * in every spelling: a command prefix, a standalone statement, a declaration
 * builtin and the `env` wrapper. A few git variables are fine as a prefix.
 */
function environmentDeny(segment: Segment): Objection | null {
  const prefix = segment.argv.length > 0;
  for (const [name, value] of Object.entries(segment.env)) {
    if (!REDIRECTING_ENV.test(name)) {
      continue;
    }
    const fine =
      prefix &&
      (PREFIX_ENV_OK.test(name) || (name === "GIT_PAGER" && value === "cat"));
    if (!fine) {
      return envBlock(name);
    }
  }
  const head = (segment.argv[0] ?? "").split("/").pop() ?? "";
  if (DECLARATIONS.has(head)) {
    for (const word of segment.argv.slice(1)) {
      if (word.startsWith("-")) {
        continue;
      }
      const name = word.split("=")[0] ?? "";
      if (/[$*?[{}`]/.test(name) || REDIRECTING_ENV.test(name)) {
        return envBlock(name);
      }
    }
  }
  const envAt = segment.argv.findIndex(
    (word, index) =>
      (word.split("/").pop() ?? "") === "env" &&
      segment.argv.slice(0, index).every((w) => ENV_WRAPPERS.has(w)),
  );
  if (envAt >= 0) {
    const words = segment.argv.slice(envAt + 1);
    for (const [index, word] of words.entries()) {
      const name = word.split("=")[0] ?? "";
      if (
        // `-S` / `-C` also inside a cluster (`-iS`), and any unambiguous
        // abbreviation of `--split-string` / `--chdir` (`--sp`, `--c`).
        // (`-u` takes the rest as its value: `env -uSHELL ls` is fine.)
        /^-[^uSC-]*[SC]/.test(word) ||
        longOption(word, "--split-string", 3) ||
        longOption(word, "--chdir", 3) ||
        (words[index - 1] === "-u" && REDIRECTING_ENV.test(word))
      ) {
        return envBlock(word);
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
        if (REDIRECTING_ENV.test(name)) {
          return envBlock(name);
        }
      } else if (!word.startsWith("-") && words[index - 1] !== "-u") {
        break;
      }
    }
  }
  return null;
}

export function commandGuard(ctx: RuleContext): Objection | null {
  if (ctx.event.action !== "shell") {
    return null;
  }
  if (ctx.event.command === null) {
    return block(
      "command-guard",
      "deny",
      "the command is missing",
      "Retry with an explicit command",
    );
  }
  const pipelines = tokenizeAll(ctx.event.command);
  const parsed = pipelines.filter((pipeline) => pipeline.ok);
  if (parsed.length !== pipelines.length) {
    return unparseableBlock();
  }
  for (const pipeline of parsed) {
    const denied = firstDeny(ctx.charter.commands.deny, pipeline);
    if (denied) {
      return commandDeny(denied);
    }
  }
  for (const pipeline of parsed) {
    for (const segment of pipeline.segments) {
      const rewrites = environmentDeny(segment) ?? gitRewriteDeny(segment);
      if (rewrites) {
        return rewrites;
      }
    }
  }
  const replacement = parsed
    .map((pipeline) => rewriteCommand(ctx.charter.commands.rewrite, pipeline))
    .find((candidate) => candidate);
  if (replacement) {
    return block(
      "command-guard",
      "rewrite",
      `npm install is rewritten to ${replacement}`,
      `Run ${replacement}`,
      replacement,
    );
  }
  return null;
}

/** The shell expands a leading `~`; the tokenizer does not. */
function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function secretDeny(path: string): Objection {
  return block(
    "secret-read-guard",
    "deny",
    `reading ${path} is denied`,
    "Use .env.example for non-secret templates",
  );
}

export function secretReadGuard(ctx: RuleContext): Objection | null {
  const secrets = ctx.charter.paths.secrets_deny_read;
  if (ctx.event.action === "read") {
    if (ctx.event.path === null) {
      return secretDeny("an unknown path");
    }
    // An external path is absolute: only its basename can match a secret pattern.
    const target = ctx.event.external
      ? basename(ctx.event.path)
      : ctx.event.path;
    return denyListMatches(secrets, target) ? secretDeny(ctx.event.path) : null;
  }
  if (ctx.event.action !== "shell" || ctx.event.command === null) {
    return null;
  }
  const expansion = expansionDeny(ctx);
  if (expansion) {
    return expansion;
  }
  const home = ctx.home ?? homedir();
  // Each word resolves from the directory the shell is in when it runs.
  for (const { segment, cwd } of trackedSteps(ctx, ctx.event.command)) {
    for (const candidate of secretCandidates(segment)) {
      const path = expandHome(candidate.path, home);
      const resolved = resolveRepoPath(path, cwd, ctx.root);
      if (!resolved.ok && candidate.secretOnly) {
        if (denyListMatches(secrets, basename(path))) {
          return secretDeny(path);
        }
        continue;
      }
      if (!resolved.ok) {
        // Same treatment as the Read and Write tools: an outside path must match
        // `paths.external` for this read or write, and only its basename is checked.
        const allowed =
          resolved.reason === "escape"
            ? externalAllows(
                ctx.charter.paths.external,
                candidate.write ? "write" : "read",
                path,
                cwd,
                home,
              )
            : null;
        if (allowed === null) {
          throw new EngineFailure("path escapes the worktree");
        }
        if (denyListMatches(secrets, basename(allowed))) {
          return secretDeny(allowed);
        }
        continue;
      }
      if (denyListMatches(secrets, resolved.path)) {
        return secretDeny(resolved.path);
      }
    }
  }
  return null;
}
