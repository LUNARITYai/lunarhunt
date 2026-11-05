import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadCharterYaml,
  parseWithZod,
  validateCharterDocument,
  validateWithAjv,
} from "../src/charter.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const charterText = readFileSync(
  join(repoRoot, "panopticon.charter.yaml"),
  "utf8",
);
const normative: unknown = parse(charterText);

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

function clone(): Record<string, unknown> {
  return structuredClone(normative) as Record<string, unknown>;
}

const worktree = {
  required_for_agents: true,
  protected_branches: ["main"],
  base_ref: "origin/main",
  naming: {
    worktree: "{issue}-{slug}",
    branch: "{type}/{issue}-{slug}",
    slug_max_length: 40,
  },
  location: { default: ".claude/worktrees/{name}" },
  setup: {
    steps: [
      "pnpm install --frozen-lockfile",
      "uv sync --frozen",
      "pnpm exec lefthook install",
    ],
    env_template: ".env.example",
    copy_from_primary: [],
  },
  resources: { ports: { web: 30000, api: 31000 } },
  primary_read_only_commands: [
    "git status*",
    "git log*",
    "gh issue view*",
    "gh pr view*",
    "wardens worktree *",
  ],
  cleanup: { stale_after_days: 7 },
};

function withWorktree(
  edit?: (section: Record<string, unknown>) => void,
): Record<string, unknown> {
  const doc = clone();
  const section = structuredClone(worktree) as Record<string, unknown>;
  edit?.(section);
  doc.worktree = section;
  return doc;
}

/** Ajv (JSON Schema) and zod must agree. */
function expectBoth(doc: unknown, expected: boolean): void {
  expect(validateWithAjv(doc).ok).toBe(expected);
  expect(parseWithZod(doc).ok).toBe(expected);
  expect(validateCharterDocument(doc).ok).toBe(expected);
}

describe("charter worktree section", () => {
  it("accepts the proposed values", () => {
    expectBoth(withWorktree(), true);
  });

  it("accepts resources.database", () => {
    expectBoth(
      withWorktree((s) => {
        asRecord(s.resources).database = "lunarhunt_t{issue}";
      }),
      true,
    );
  });

  it("accepts an absent section, and the real Charter validates", () => {
    const doc = clone();
    delete doc.worktree;
    expectBoth(doc, true);
    expect(loadCharterYaml(charterText).ok).toBe(true);
  });

  it("rejects unknown keys at every level", () => {
    expectBoth(
      withWorktree((s) => {
        s.extra = 1;
      }),
      false,
    );
    expectBoth(
      withWorktree((s) => {
        asRecord(s.naming).extra = 1;
      }),
      false,
    );
    expectBoth(
      withWorktree((s) => {
        asRecord(asRecord(s.resources).ports).db = 5432;
      }),
      false,
    );
  });

  it("rejects a non-empty copy_from_primary", () => {
    expectBoth(
      withWorktree((s) => {
        asRecord(s.setup).copy_from_primary = [".env"];
      }),
      false,
    );
  });

  it("rejects a bad port, slug length or stale days", () => {
    expectBoth(
      withWorktree((s) => {
        asRecord(asRecord(s.resources).ports).web = 80;
      }),
      false,
    );
    expectBoth(
      withWorktree((s) => {
        asRecord(asRecord(s.resources).ports).api = 70000;
      }),
      false,
    );
    expectBoth(
      withWorktree((s) => {
        asRecord(s.naming).slug_max_length = 0;
      }),
      false,
    );
    expectBoth(
      withWorktree((s) => {
        asRecord(s.cleanup).stale_after_days = 0;
      }),
      false,
    );
  });

  it("rejects a missing required key", () => {
    expectBoth(
      withWorktree((s) => {
        delete s.base_ref;
      }),
      false,
    );
  });
});
