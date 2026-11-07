import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { loadCharterAt } from "./charter.ts";
import {
  checkCharterDrift,
  checkTaskDatabases,
  checkWorktreeExclusions,
  checkWorktrees,
  defaultWorktreeDeps,
  type WorktreeCheckDeps,
} from "./doctor-worktree.ts";
import { mapPayload, type ToolName } from "./event.ts";
import { gitToplevel } from "./git.ts";
import { trustedHome, UNRESOLVED_HOME } from "./home.ts";
import { MAPPING_ROWS } from "./mapping.ts";
import { CHARTER_INVALID_MESSAGE } from "./messages.ts";
import { embeddedHash, hashSources } from "./source-hash.ts";
import {
  anchorListsPrimary,
  anchorPath,
  parseAnchor,
  readAnchorText,
  writeAnchor,
} from "./sync/anchor.ts";
import {
  primaryProblem,
  structuralPrimary,
  underWorktreeDir,
} from "./sync/primary.ts";
import {
  CLAUDE_SETTINGS_PATH,
  CURSOR_HOOKS_PATH,
  LAUNCHER_BLOCK_MESSAGE,
  render,
} from "./sync/render.ts";

export type CheckStatus = "ok" | "warn" | "fail";
export type CheckResult = { id: string; status: CheckStatus; message: string };
export type DoctorResult = { exitCode: 0 | 2; stdout: string };

export type DoctorDeps = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Home dir for `~/.claude/settings.json` and the launcher anchor; tests inject it. */
  home: string;
  now: () => number;
  /** Output of `claude --version`, or null when `claude` is not on PATH. */
  claudeVersion: () => string | null;
  /** Enabled glob-related shell options (`setopt` / `shopt -s` output), "" if unknown, null when the shell cannot be run. */
  shellOptions?: () => string | null;
  /** Override of the primary checkout; defaults to the one derived from the file system, never from git. */
  primary?: string;
  /** Owner the anchor file and its directory must have; defaults to the current user. */
  uid?: number;
  /** Override of the real bundle; defaults to `<primary>/wardens/dist/wardens.mjs`. */
  bundlePath?: string;
  /** Overrides of `gh` and the database listing for the worktree checks; tests inject them. */
  worktree?: Partial<WorktreeCheckDeps>;
};

export const DUPLICATES_WARNING =
  "Cursor is running the Claude Code hooks too. Disable third-party hooks in Cursor settings.";
export const STALE_BUNDLE_WARNING =
  "Run pnpm --filter wardens build in the primary checkout.";
export const MIN_CLAUDE_VERSION = [2, 1, 295] as const;

const BUNDLE_REL = "wardens/dist/wardens.mjs";
const DAY_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 2000;
const CHILD_TIMEOUT_MS = 20_000;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJsonFile(file: string): Json | null {
  const text = readText(file);
  if (text === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

type Subscription = {
  tool: ToolName;
  event: string;
  matcher: string | null;
  entry: Json;
};

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Every hook entry in `.claude/settings.json` with its event and matcher regex. */
function claudeSubscriptions(settings: Json): Subscription[] {
  const out: Subscription[] = [];
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of asList(groups)) {
      if (!isRecord(group)) {
        continue;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : null;
      for (const entry of asList(group.hooks)) {
        if (isRecord(entry)) {
          out.push({ tool: "claude", event, matcher, entry });
        }
      }
    }
  }
  return out;
}

/** Every hook entry in `.cursor/hooks.json`. */
function cursorSubscriptions(config: Json): Subscription[] {
  const out: Subscription[] = [];
  const hooks = isRecord(config.hooks) ? config.hooks : {};
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of asList(entries)) {
      if (isRecord(entry)) {
        const matcher =
          typeof entry.matcher === "string" ? entry.matcher : null;
        out.push({ tool: "cursor", event, matcher, entry });
      }
    }
  }
  return out;
}

type Subscriptions =
  | { ok: true; subs: Subscription[] }
  | { ok: false; message: string };

function subscriptionsAt(toplevel: string): Subscriptions {
  const claude = readJsonFile(join(toplevel, CLAUDE_SETTINGS_PATH));
  if (!claude) {
    return {
      ok: false,
      message: `${CLAUDE_SETTINGS_PATH} is missing or not JSON`,
    };
  }
  const cursor = readJsonFile(join(toplevel, CURSOR_HOOKS_PATH));
  if (!cursor) {
    return {
      ok: false,
      message: `${CURSOR_HOOKS_PATH} is missing or not JSON`,
    };
  }
  return {
    ok: true,
    subs: [...claudeSubscriptions(claude), ...cursorSubscriptions(cursor)],
  };
}

/** `^(A|B)$` to `["A", "B"]`; any other matcher is one alternative; no matcher is `[null]`. */
function alternatives(matcher: string | null): (string | null)[] {
  if (matcher === null) {
    return [null];
  }
  const grouped = /^\^\((.*)\)\$$/.exec(matcher);
  return grouped?.[1] !== undefined ? grouped[1].split("|") : [matcher];
}

const result = (
  id: string,
  status: CheckStatus,
  message: string,
): CheckResult => ({ id, status, message });

function checkDrift(toplevel: string): CheckResult {
  const loaded = loadCharterAt(toplevel);
  if (!loaded.ok) {
    return result("drift", "fail", "The Charter is invalid");
  }
  const drifted = [...render(loaded.charter)]
    .filter(([path, text]) => readText(join(toplevel, path)) !== text)
    .map(([path]) => path);
  return drifted.length > 0
    ? result(
        "drift",
        "fail",
        `${drifted.join(", ")} differs from wardens sync output`,
      )
    : result("drift", "ok", "generated files match The Charter");
}

function checkFailClosed(toplevel: string): CheckResult {
  const loaded = subscriptionsAt(toplevel);
  if (!loaded.ok) {
    return result("fail-closed", "fail", loaded.message);
  }
  const problems: string[] = [];
  for (const sub of loaded.subs) {
    const guard =
      sub.tool === "claude"
        ? sub.entry.onFailure === "block"
        : sub.entry.failClosed === true;
    const timeout = sub.entry.timeout;
    const label = `${sub.tool} ${sub.event}`;
    if (!guard) {
      problems.push(
        `${label} lacks ${sub.tool === "claude" ? 'onFailure: "block"' : "failClosed: true"}`,
      );
    }
    if (typeof timeout !== "number" || !(timeout > 0)) {
      problems.push(`${label} lacks a timeout`);
    }
  }
  if (loaded.subs.length === 0) {
    problems.push("no hooks are configured");
  }
  return problems.length > 0
    ? result("fail-closed", "fail", problems.join("; "))
    : result(
        "fail-closed",
        "ok",
        `${loaded.subs.length} hooks are fail-closed`,
      );
}

function checkCoverage(toplevel: string): CheckResult {
  const loaded = subscriptionsAt(toplevel);
  if (!loaded.ok) {
    return result("coverage", "fail", loaded.message);
  }
  const key = (tool: string, event: string, matcher: string | null) =>
    `${tool} ${event}${matcher === null ? "" : ` ${matcher}`}`;
  const rows = new Set(
    MAPPING_ROWS.map((r) => key(r.tool, r.event, r.matcher)),
  );
  const subscribed = new Set<string>();
  const problems: string[] = [];
  for (const sub of loaded.subs) {
    for (const alt of alternatives(sub.matcher)) {
      const id = key(sub.tool, sub.event, alt);
      subscribed.add(id);
      if (!rows.has(id)) {
        problems.push(`${id} is subscribed but has no mapping row`);
      }
    }
  }
  for (const row of MAPPING_ROWS) {
    const id = key(row.tool, row.event, row.matcher);
    if (!subscribed.has(id)) {
      problems.push(`${id} has a mapping row but is not subscribed`);
    }
    if (!mapPayload(row.tool, row.event, row.sample).ok) {
      problems.push(`${id} is not mapped by the engine`);
    }
  }
  return problems.length > 0
    ? result("coverage", "fail", problems.join("; "))
    : result("coverage", "ok", `${rows.size} subscriptions have mapping rows`);
}

/** True when `stdout` is the tool's deny for a pre-tool event. */
export function isToolDeny(tool: ToolName, stdout: string): boolean {
  try {
    const out: unknown = JSON.parse(stdout);
    if (!isRecord(out)) {
      return false;
    }
    if (tool === "claude") {
      const specific = out.hookSpecificOutput;
      return isRecord(specific) && specific.permissionDecision === "deny";
    }
    return out.permission === "deny";
  } catch {
    return false;
  }
}

const PRE_EVENT: Record<ToolName, string> = {
  claude: "PreToolUse",
  cursor: "beforeShellExecution",
};

function preSample(tool: ToolName, cwd: string): Json {
  const row = MAPPING_ROWS.find(
    (r) => r.tool === tool && r.event === PRE_EVENT[tool],
  );
  const sample: Json = row ? { ...row.sample } : {};
  if (tool === "claude") {
    sample.tool_name = "Bash";
    sample.tool_input = { command: "echo ok" };
  }
  return { ...sample, cwd, hook_event_name: PRE_EVENT[tool] };
}

function sampleFor(sub: Subscription, toplevel: string): string {
  const row = MAPPING_ROWS.find(
    (r) => r.tool === sub.tool && r.event === sub.event,
  );
  return JSON.stringify({ ...row?.sample, cwd: toplevel });
}

function breakHookMissingBundle(
  toplevel: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const loaded = subscriptionsAt(toplevel);
  if (!loaded.ok) {
    return [loaded.message];
  }
  const problems: string[] = [];
  // The launcher reads `$HOME/.config/panopticon/primaries`. Give it a throwaway
  // home whose anchor trusts this checkout, so only the missing bundle can fail it.
  const home = mkdtempSync(join(tmpdir(), "wardens-doctor-home-"));
  try {
    writeAnchor(home, toplevel);
    for (const sub of loaded.subs) {
      const label = `${sub.tool} ${sub.event}`;
      const command = sub.entry.command;
      if (typeof command !== "string" || !command.includes(BUNDLE_REL)) {
        problems.push(`${label} command does not run ${BUNDLE_REL}`);
        continue;
      }
      const broken = command.replaceAll(
        BUNDLE_REL,
        "wardens/dist/missing-bundle.mjs",
      );
      const res = spawnSync("sh", ["-c", broken], {
        cwd: toplevel,
        env: {
          ...env,
          HOME: home,
          CLAUDE_PROJECT_DIR: toplevel,
          CURSOR_PROJECT_DIR: toplevel,
        },
        input: sampleFor(sub, toplevel),
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      });
      if (typeof res.status !== "number" || res.status === 0) {
        problems.push(`${label} does not fail when the bundle is missing`);
      } else if ((res.stderr ?? "").includes(LAUNCHER_BLOCK_MESSAGE)) {
        problems.push(`${label} launcher did not accept the checkout`);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return problems;
}

function breakHookRealBundle(
  bundlePath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  if (readText(bundlePath) === null) {
    return ["the real bundle is missing, so (b) and (c) cannot run"];
  }
  // The hook reads the Charter of the primary its bundle sits in (#73), so the
  // bundle is copied into an anchored throwaway primary that holds the invalid
  // Charter, under a throwaway HOME. The deny must name that reason.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wardens-doctor-")));
  const repo = join(home, "primary");
  const copy = join(repo, "wardens", "dist", "wardens.mjs");
  const problems: string[] = [];
  try {
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "panopticon.charter.yaml"), "invalid: [\n");
    mkdirSync(dirname(copy), { recursive: true });
    cpSync(bundlePath, copy);
    const schema = join(dirname(bundlePath), "..", "schema");
    if (existsSync(schema)) {
      cpSync(schema, join(repo, "wardens", "schema"), { recursive: true });
    }
    writeAnchor(home, repo);
    for (const tool of ["claude", "cursor"] as const) {
      const args = ["hook", "--tool", tool, "--event", PRE_EVENT[tool]];
      const attempts: [string, string][] = [
        ["an invalid Charter", JSON.stringify(preSample(tool, repo))],
        ["malformed stdin", "not json"],
      ];
      for (const [what, input] of attempts) {
        const res = spawnSync(process.execPath, [copy, ...args], {
          cwd: repo,
          env: { ...env, HOME: home, CLAUDE_PROJECT_DIR: repo },
          input,
          encoding: "utf8",
          timeout: CHILD_TIMEOUT_MS,
        });
        const stdout = res.stdout ?? "";
        const reason =
          what === "an invalid Charter"
            ? stdout.includes(CHARTER_INVALID_MESSAGE)
            : true;
        if (!isToolDeny(tool, stdout) || !reason) {
          problems.push(`${tool} hook does not deny ${what}`);
        }
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return problems;
}

function checkBreakHook(
  toplevel: string,
  bundlePath: string,
  env: NodeJS.ProcessEnv,
): CheckResult {
  const problems = [
    ...breakHookMissingBundle(toplevel, env),
    ...breakHookRealBundle(bundlePath, env),
  ];
  return problems.length > 0
    ? result("break-hook", "fail", problems.join("; "))
    : result(
        "break-hook",
        "ok",
        "hooks fail closed on a missing bundle, an invalid Charter and malformed stdin",
      );
}

/** Machine-dependent: the hook launcher trusts only the primaries listed in the anchor file. */
function checkLauncherAnchor(
  primary: string,
  home: string,
  uid: number | undefined,
): CheckResult {
  if (!isAbsolute(home)) {
    return result(
      "launcher-anchor",
      "fail",
      "cannot resolve HOME, so the launcher anchor was not checked. Set HOME to an absolute path of an existing directory",
    );
  }
  const file = anchorPath(home);
  const text = readAnchorText(home);
  if (text === null) {
    return result(
      "launcher-anchor",
      "fail",
      `${file} is missing. Ask Krzysztof to run wardens sync.`,
    );
  }
  const problems: string[] = [];
  const entries = parseAnchor(text);
  if (text.includes("\r")) {
    problems.push("the anchor contains a carriage return");
  }
  for (const entry of entries) {
    const problem = primaryProblem(entry);
    if (problem !== null) {
      problems.push(`entry ${entry} ${problem}`);
    }
    for (const other of entries) {
      if (
        other !== entry &&
        `${entry}/`.startsWith(`${other}/.claude/worktrees/`)
      ) {
        problems.push(`entry ${entry} lies under ${other}/.claude/worktrees`);
      }
    }
  }
  const own = primaryProblem(primary);
  if (own !== null) {
    problems.push(`this primary ${primary} ${own}`);
  }
  if (!anchorListsPrimary(entries, primary) || underWorktreeDir(primary)) {
    problems.push(`${file} does not list ${primary}`);
  }
  for (const path of [dirname(file), file]) {
    try {
      const stat = statSync(path);
      if ((stat.mode & 0o022) !== 0) {
        problems.push(`${path} must not be writable by group or other`);
      }
      if (uid !== undefined && stat.uid !== uid) {
        problems.push(`${path} is not owned by the current user`);
      }
    } catch {
      problems.push(`${path} cannot be read`);
    }
  }
  return problems.length > 0
    ? result(
        "launcher-anchor",
        "fail",
        `${problems.join("; ")}. Ask Krzysztof to run wardens sync.`,
      )
    : result("launcher-anchor", "ok", `${file} lists this primary checkout`);
}

function checkBundle(primary: string, bundlePath: string): CheckResult {
  const text = readText(bundlePath);
  if (text === null) {
    return result("bundle", "fail", `${bundlePath} is missing`);
  }
  let current: string;
  try {
    current = hashSources(join(primary, "wardens", "src"));
  } catch {
    return result(
      "bundle",
      "fail",
      `${join(primary, "wardens", "src")} could not be read`,
    );
  }
  return embeddedHash(text) === current
    ? result("bundle", "ok", "bundle matches wardens/src")
    : result("bundle", "warn", STALE_BUNDLE_WARNING);
}

type LogEntry = {
  ms: number;
  tool: string;
  session: string;
  key: string;
  foreign: boolean;
};

function parseLog(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || typeof value.ts !== "string") {
      continue;
    }
    const ms = Date.parse(value.ts);
    if (Number.isNaN(ms)) {
      continue;
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    out.push({
      ms,
      tool: str(value.tool),
      session: str(value.session_id),
      // Event class is the normalized action and phase, so Claude and Cursor event names compare.
      key: [
        str(value.action),
        str(value.phase),
        str(value.path) || str(value.command) || str(value.mcp_server),
      ].join("\0"),
      foreign: value.foreign === true,
    });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function hasDuplicatePair(entries: LogEntry[]): boolean {
  const byKey = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    if (entry.session === "" || entry.tool === "") {
      continue;
    }
    const id = `${entry.session}\0${entry.key}`;
    const list = byKey.get(id) ?? [];
    byKey.set(id, [...list, entry]);
  }
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (!a || !b || b.ms - a.ms > DUPLICATE_WINDOW_MS) {
          break;
        }
        if (a.tool !== b.tool) {
          return true;
        }
      }
    }
  }
  return false;
}

function checkDuplicates(toplevel: string, now: number): CheckResult {
  const text = readText(join(toplevel, ".panopticon", "wardens.log.jsonl"));
  if (text === null) {
    return result("duplicates", "ok", "no log yet");
  }
  const recent = parseLog(text).filter((e) => now - e.ms <= 7 * DAY_MS);
  return recent.some((e) => e.foreign) || hasDuplicatePair(recent)
    ? result("duplicates", "warn", DUPLICATES_WARNING)
    : result("duplicates", "ok", "no duplicate hook runs in the last 7 days");
}

function checkDisableAllHooks(toplevel: string, home: string): CheckResult {
  const files = [
    join(toplevel, ".claude", "settings.local.json"),
    ...(isAbsolute(home) ? [join(home, ".claude", "settings.json")] : []),
  ];
  const offenders = files.filter(
    (file) => readJsonFile(file)?.disableAllHooks === true,
  );
  return offenders.length > 0
    ? result(
        "disable-all-hooks",
        "warn",
        `disableAllHooks is true in ${offenders.join(", ")}. Remove it so the Wardens run.`,
      )
    : result("disable-all-hooks", "ok", "hooks are not disabled");
}

function checkClaudeVersion(version: string | null): CheckResult {
  const required = MIN_CLAUDE_VERSION.join(".");
  if (version === null) {
    return result("claude-version", "ok", "claude is not on PATH");
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return result(
      "claude-version",
      "warn",
      `could not parse "${version.trim()}"`,
    );
  }
  const found = [match[1], match[2], match[3]].map(Number);
  const cmp = MIN_CLAUDE_VERSION.map((min, i) => (found[i] ?? 0) - min).find(
    (d) => d !== 0,
  );
  return (cmp ?? 0) >= 0
    ? result("claude-version", "ok", `claude ${found.join(".")} >= ${required}`)
    : result(
        "claude-version",
        "warn",
        `claude ${found.join(".")} is older than ${required}`,
      );
}

function defaultClaudeVersion(): string | null {
  try {
    return execFileSync("claude", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

/**
 * `globdots` (zsh) and `dotglob` (bash) make `*` match dotfiles, so the glob
 * proof for read candidates (#78) would be wrong; the extended-glob options
 * add operators (`^`, `#`, `~`) the tokenizer only treats conservatively.
 */
function checkShellGlobOptions(read: () => string | null): CheckResult {
  let options: string | null;
  try {
    options = read();
  } catch {
    options = null;
  }
  if (options === null) {
    return result(
      "shell-glob-options",
      "warn",
      "could not read the shell's glob options",
    );
  }
  if (/^(globdots|dotglob)\b/m.test(options)) {
    return result(
      "shell-glob-options",
      "fail",
      "globdots/dotglob is on in your shell, so * matches dotfiles. Turn it off for the shell that runs agent commands.",
    );
  }
  if (/^(extendedglob|extglob)\b/m.test(options)) {
    return result(
      "shell-glob-options",
      "warn",
      "extendedglob/extglob is on in your shell. Wardens handle ^, # and ~ in a word conservatively, as wildcards, and may deny harmless commands.",
    );
  }
  return result("shell-glob-options", "ok", "no dotfile globbing");
}

/** The enabled options of the login shell with the user's rc, or null when it cannot be run. "" for a shell this does not know. */
function defaultShellOptions(env: NodeJS.ProcessEnv): string | null {
  // The account's login shell, not `$SHELL`: the environment can name any script.
  let shell = "";
  try {
    shell = userInfo().shell ?? "";
  } catch {
    return null;
  }
  const name = shell.split("/").pop() ?? "";
  const script =
    name === "zsh"
      ? "source ~/.zshrc >/dev/null 2>&1; setopt"
      : name === "bash"
        ? "source ~/.bashrc >/dev/null 2>&1; shopt -s"
        : null;
  if (script === null) {
    return "";
  }
  const res = spawnSync(shell, ["-l", "-c", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    env,
  });
  return res.status === 0 ? res.stdout : null;
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    shellOptions: () => defaultShellOptions(process.env),
    cwd: process.cwd(),
    env: process.env,
    home: trustedHome(process.env) ?? "",
    now: () => Date.now(),
    claudeVersion: defaultClaudeVersion,
  };
}

export function runChecks(ci: boolean, deps: DoctorDeps): CheckResult[] {
  const toplevel = gitToplevel(deps.cwd);
  if (!toplevel) {
    return [result("drift", "fail", "git toplevel could not be resolved")];
  }
  let primary = deps.primary;
  if (primary === undefined) {
    const derived = structuralPrimary(
      toplevel,
      isAbsolute(deps.home) ? deps.home : UNRESOLVED_HOME,
    );
    if (!derived.ok) {
      return [
        result(
          "launcher-anchor",
          "fail",
          `${toplevel} is not a verified primary checkout (${derived.reason})`,
        ),
      ];
    }
    primary = derived.primary;
  }
  const bundlePath = deps.bundlePath ?? join(primary, BUNDLE_REL);
  const results = [
    checkDrift(toplevel),
    checkFailClosed(toplevel),
    checkCoverage(toplevel),
    checkBreakHook(toplevel, bundlePath, deps.env),
    checkBundle(primary, bundlePath),
  ];
  results.push(checkWorktreeExclusions(toplevel));
  if (!ci) {
    const worktreeDeps: WorktreeCheckDeps = {
      ...defaultWorktreeDeps(deps.env, deps.now),
      ...deps.worktree,
    };
    results.push(
      checkLauncherAnchor(primary, deps.home, deps.uid ?? process.getuid?.()),
      checkDuplicates(toplevel, deps.now()),
      checkDisableAllHooks(toplevel, deps.home),
      checkClaudeVersion(deps.claudeVersion()),
      checkShellGlobOptions(deps.shellOptions ?? (() => "")),
      checkWorktrees(primary, worktreeDeps),
      checkTaskDatabases(primary, worktreeDeps),
      checkCharterDrift(toplevel, primary),
    );
  }
  return results;
}

/** `wardens doctor [--ci] [--json]`. */
export function runDoctor(
  opts: { ci: boolean; json: boolean },
  deps: DoctorDeps = defaultDoctorDeps(),
): DoctorResult {
  const results = runChecks(opts.ci, deps);
  const stdout = opts.json
    ? `${JSON.stringify(results)}\n`
    : results.map((r) => `${r.status} ${r.id}: ${r.message}\n`).join("");
  return {
    exitCode: results.some((r) => r.status === "fail") ? 2 : 0,
    stdout,
  };
}
