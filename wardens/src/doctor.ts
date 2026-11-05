import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadCharterAt } from "./charter.ts";
import { mapPayload, type ToolName } from "./event.ts";
import { gitToplevel, primaryCheckout } from "./git.ts";
import { MAPPING_ROWS } from "./mapping.ts";
import { embeddedHash, hashSources } from "./source-hash.ts";
import {
  CLAUDE_SETTINGS_PATH,
  CURSOR_HOOKS_PATH,
  render,
} from "./sync/render.ts";

export type CheckStatus = "ok" | "warn" | "fail";
export type CheckResult = { id: string; status: CheckStatus; message: string };
export type DoctorResult = { exitCode: 0 | 2; stdout: string };

export type DoctorDeps = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Home dir for `~/.claude/settings.json`; tests inject it. */
  home: string;
  now: () => number;
  /** Output of `claude --version`, or null when `claude` is not on PATH. */
  claudeVersion: () => string | null;
  /** Override of the primary checkout; defaults to the git common dir's parent. */
  primary?: string;
  /** Override of the real bundle; defaults to `<primary>/wardens/dist/wardens.mjs`. */
  bundlePath?: string;
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
  for (const sub of loaded.subs) {
    const label = `${sub.tool} ${sub.event}`;
    const command = sub.entry.command;
    if (typeof command !== "string" || !command.includes(BUNDLE_REL)) {
      problems.push(`${label} command does not run ${BUNDLE_REL}`);
      continue;
    }
    const broken = command.replace(
      BUNDLE_REL,
      "wardens/dist/missing-bundle.mjs",
    );
    const res = spawnSync("sh", ["-c", broken], {
      cwd: toplevel,
      env: { ...env, CLAUDE_PROJECT_DIR: toplevel },
      input: sampleFor(sub, toplevel),
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    if (typeof res.status !== "number" || res.status === 0) {
      problems.push(`${label} does not fail when the bundle is missing`);
    }
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
  const repo = mkdtempSync(join(tmpdir(), "wardens-doctor-"));
  const problems: string[] = [];
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "panopticon.charter.yaml"), "invalid: [\n");
    for (const tool of ["claude", "cursor"] as const) {
      const args = ["hook", "--tool", tool, "--event", PRE_EVENT[tool]];
      const attempts: [string, string][] = [
        ["an invalid Charter", JSON.stringify(preSample(tool, repo))],
        ["malformed stdin", "not json"],
      ];
      for (const [what, input] of attempts) {
        const res = spawnSync(process.execPath, [bundlePath, ...args], {
          cwd: repo,
          env: { ...env, CLAUDE_PROJECT_DIR: repo },
          input,
          encoding: "utf8",
          timeout: CHILD_TIMEOUT_MS,
        });
        if (!isToolDeny(tool, res.stdout ?? "")) {
          problems.push(`${tool} hook does not deny ${what}`);
        }
      }
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
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
    join(home, ".claude", "settings.json"),
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

export function defaultDoctorDeps(): DoctorDeps {
  return {
    cwd: process.cwd(),
    env: process.env,
    home: homedir(),
    now: () => Date.now(),
    claudeVersion: defaultClaudeVersion,
  };
}

export function runChecks(ci: boolean, deps: DoctorDeps): CheckResult[] {
  const toplevel = gitToplevel(deps.cwd);
  const primary = deps.primary ?? primaryCheckout(deps.cwd);
  if (!toplevel || !primary) {
    return [result("drift", "fail", "git toplevel could not be resolved")];
  }
  const bundlePath = deps.bundlePath ?? join(primary, BUNDLE_REL);
  const results = [
    checkDrift(toplevel),
    checkFailClosed(toplevel),
    checkCoverage(toplevel),
    checkBreakHook(toplevel, bundlePath, deps.env),
    checkBundle(primary, bundlePath),
  ];
  if (!ci) {
    results.push(
      checkDuplicates(toplevel, deps.now()),
      checkDisableAllHooks(toplevel, deps.home),
      checkClaudeVersion(deps.claudeVersion()),
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
