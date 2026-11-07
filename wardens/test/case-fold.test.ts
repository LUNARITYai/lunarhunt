import { describe, expect, it } from "vitest";
import { loadCharterAt } from "../src/charter.ts";
import { runHook } from "../src/engine.ts";
import { segmentsMeet } from "../src/glob-meet.ts";
import { anyGlob, denyListMatches } from "../src/globs.ts";
import { repoRoot, tempRepo } from "./support.ts";

const charter = (() => {
  const loaded = loadCharterAt(repoRoot);
  if (!loaded.ok) {
    throw new Error(loaded.errors.join("; "));
  }
  return loaded.charter;
})();

/** A concrete path a glob matches: `**` and `*` become a name. */
function sample(glob: string): string {
  return glob
    .replaceAll("**/", "docs/")
    .replaceAll("**", "x.ts")
    .replaceAll("*", "x");
}

const PATHS = [
  ...new Set(
    [
      ...charter.paths.protected.deny,
      ...charter.paths.protected.ask,
      ...charter.paths.generated,
      ...charter.paths.secrets_deny_read,
    ]
      .filter((glob) => !glob.startsWith("!"))
      .map(sample),
  ),
];

/** `.env.example` is the template: the negation in the lists must hold in every case. */
const TEMPLATES = [".env.example", ".ENV.EXAMPLE", "Config/.Env.Example"];

function alternate(text: string): string {
  return [...text]
    .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
    .join("");
}

/** The leaf only: the directories stay canonical, so `allowed_paths` still holds. */
function leaf(path: string, change: (text: string) => string): string {
  const at = path.lastIndexOf("/");
  return `${path.slice(0, at + 1)}${change(path.slice(at + 1))}`;
}

type Outcome = { decision: "allow" | "ask" | "deny"; rule: string };
const STRICTNESS = { allow: 0, ask: 1, deny: 2 } as const;

const root = tempRepo();

function hook(tool: string, input: Record<string, unknown>): Outcome {
  const result = runHook(
    "claude",
    "PreToolUse",
    JSON.stringify({ cwd: root, tool_name: tool, tool_input: input }),
    { cwd: () => root, env: {}, home: root },
  );
  if (result.stdout === "") {
    return { decision: "allow", rule: "none" };
  }
  const out = JSON.parse(result.stdout).hookSpecificOutput;
  const rule = /Warden ([a-z-]+):/.exec(out.permissionDecisionReason)?.[1];
  return { decision: out.permissionDecision, rule: rule ?? "?" };
}

const REQUESTS: Array<[string, (path: string) => Outcome]> = [
  ["Read", (path) => hook("Read", { file_path: path })],
  ["Write", (path) => hook("Write", { file_path: path, content: "x" })],
  [
    "Edit",
    (path) =>
      hook("Edit", { file_path: path, old_string: "a", new_string: "b" }),
  ],
  ["cat", (path) => hook("Bash", { command: `cat ${path}` })],
  ["redirect", (path) => hook("Bash", { command: `echo x > ${path}` })],
  ["append", (path) => hook("Bash", { command: `echo x>>${path}` })],
  ["dd", (path) => hook("Bash", { command: `dd if=a of=${path}` })],
  ["cp", (path) => hook("Bash", { command: `cp a ${path}` })],
  ["tee", (path) => hook("Bash", { command: `tee ${path}` })],
  ["key=path", (path) => hook("Bash", { command: `tool --out=${path}` })],
];

describe("policy globs fold case (#77)", () => {
  it("covers every protected, generated and secret path of the Charter", () => {
    expect(PATHS).toEqual(
      expect.arrayContaining([
        "panopticon.charter.yaml",
        ".env",
        "secrets/x.ts",
        "packages/contracts/openapi.json",
        "packages/api-client/src/x.ts",
        "docs/constitution.md",
        "docs/AGENTS.md",
      ]),
    );
  });

  describe.each(REQUESTS)("through %s", (_name, ask) => {
    it.each(PATHS)(
      "gives the leaf spellings of %s the verdict of the canonical one",
      (path) => {
        const canonical = ask(path);
        for (const spelling of [
          leaf(path, (text) => text.toUpperCase()),
          leaf(path, alternate),
        ]) {
          expect(ask(spelling), spelling).toEqual(canonical);
        }
      },
    );

    it.each(PATHS)(
      "never allows what the canonical %s is refused, in any case",
      (path) => {
        const canonical = ask(path);
        for (const spelling of [
          path.toUpperCase(),
          alternate(path),
          path.toLowerCase(),
        ]) {
          expect(
            STRICTNESS[ask(spelling).decision],
            spelling,
          ).toBeGreaterThanOrEqual(STRICTNESS[canonical.decision]);
        }
      },
    );
  });

  it("keeps the template exemption in every case", () => {
    for (const path of TEMPLATES) {
      expect(denyListMatches(charter.paths.secrets_deny_read, path), path).toBe(
        false,
      );
      expect(denyListMatches(charter.paths.protected.deny, path), path).toBe(
        false,
      );
      expect(hook("Read", { file_path: path }).decision, path).toBe("allow");
    }
  });

  it("folds the dotted, wildcard and directory forms the Charter names", () => {
    expect(denyListMatches(charter.paths.secrets_deny_read, "Sub/.ENV")).toBe(
      true,
    );
    expect(denyListMatches(charter.paths.secrets_deny_read, ".Env.Local")).toBe(
      true,
    );
    expect(
      denyListMatches(charter.paths.secrets_deny_read, "SECRETS/a/b"),
    ).toBe(true);
    expect(
      anyGlob(charter.paths.generated, "Packages/Contracts/OpenAPI.json"),
    ).toBe(true);
    expect(
      anyGlob(charter.paths.protected.ask, "Apps/API/Migrations/001.sql"),
    ).toBe(true);
  });

  it("folds the non-ASCII spellings of the same letters", () => {
    // U+017F (long s) and U+212A (Kelvin sign) fold to ASCII letters.
    expect(
      denyListMatches(charter.paths.secrets_deny_read, "ſecrets/key"),
    ).toBe(true);
    expect(anyGlob(["a/k.md"], "a/K.md")).toBe(true);
  });

  it("keeps allowed_paths exact: a different case is a different directory", () => {
    expect(hook("Write", { file_path: "WARDENS/src/x.ts" }).rule).toBe(
      "scope-guard",
    );
    expect(hook("Write", { file_path: "wardens/src/x.ts" }).decision).toBe(
      "allow",
    );
  });

  it("matches a shell glob against a secret in any case", () => {
    expect(segmentsMeet(".E*", ".env", [], false)).toBe(true);
    expect(segmentsMeet(".ENV", ".env", [], false)).toBe(true);
    expect(segmentsMeet("[.]E[n]V", ".env", [], false)).toBe(true);
    expect(segmentsMeet(".E*", ".env.*", ["*.example"], false)).toBe(true);
    expect(segmentsMeet("*.EXAMPLE", ".env.*", ["*.example"], true)).toBe(
      false,
    );
  });

  it("denies a shell read glob that can name a secret in another case", () => {
    expect(hook("Bash", { command: "cat .E*" }).decision).toBe("deny");
    expect(hook("Bash", { command: "cat SECRET?/*" }).decision).toBe("deny");
  });
});
