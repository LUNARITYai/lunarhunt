import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  loadCharterYaml,
  parseWithZod,
  validateCharterDocument,
  validateWithAjv,
} from "../src/charter.ts";
import { CHARTER_INVALID_MESSAGE, MESSAGE_PATTERN } from "../src/messages.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const charterText = readFileSync(
  join(repoRoot, "panopticon.charter.yaml"),
  "utf8",
);
const normative: unknown = parse(charterText);

function clone(): Record<string, unknown> {
  return structuredClone(normative) as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected object");
  }
  return value as Record<string, unknown>;
}

describe("charter schema", () => {
  const schema = JSON.parse(
    readFileSync(join(repoRoot, "wardens/schema/charter.schema.json"), "utf8"),
  ) as {
    $schema: string;
    required: string[];
    $defs: {
      risk: { required: string[] };
      covenant: { required: string[] };
    };
  };

  it("is JSON Schema draft 2020-12 and requires the Charter sections", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.required).toEqual(
      expect.arrayContaining([
        "roles",
        "paths",
        "covenant",
        "risk",
        "require_spec_for",
      ]),
    );
    expect(schema.$defs.risk.required).toEqual(
      expect.arrayContaining(["high", "medium", "low"]),
    );
    expect(schema.$defs.covenant.required).toEqual(
      expect.arrayContaining(["agents_md_exempt"]),
    );
  });

  it("requires protected deny and ask, and every role's engine, model and effort", () => {
    const raw = JSON.parse(
      readFileSync(
        join(repoRoot, "wardens/schema/charter.schema.json"),
        "utf8",
      ),
    ) as {
      $defs: {
        paths: { properties: { protected: { required: string[] } } };
        role: { required: string[] };
        roles: { required: string[] };
      };
    };
    expect(raw.$defs.paths.properties.protected.required).toEqual(
      expect.arrayContaining(["deny", "ask"]),
    );
    expect(raw.$defs.role.required).toEqual(
      expect.arrayContaining(["engine", "model", "effort"]),
    );
    expect(raw.$defs.roles.required).toEqual(
      expect.arrayContaining(["debugger"]),
    );
  });
});

describe("normative Charter", () => {
  it("passes Ajv and zod, including the cursor implementer model", () => {
    expect(validateWithAjv(normative).ok).toBe(true);
    const parsed = parseWithZod(normative);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.charter.version).toBe(1);
    expect(parsed.charter.autonomy).toEqual({ phase: 0, kill_switch: false });
    expect(parsed.charter.roles.implementer.engine).toBe("cursor");
    expect(parsed.charter.roles.implementer.model).toBe("grok-4.7-high");
    expect(parsed.charter.roles.debugger.effort).toBe("high");
  });

  it("accepts the file through charter-validate", () => {
    const result = loadCharterYaml(charterText);
    expect(result.ok).toBe(true);
  });
});

describe("charter rejection", () => {
  it("rejects a negated glob other than !*.example", () => {
    const doc = clone();
    const paths = asRecord(doc.paths);
    const protectedPaths = asRecord(paths.protected);
    protectedPaths.deny = ["panopticon.charter.yaml", "!.env.example"];
    expect(validateCharterDocument(doc).ok).toBe(false);

    paths.allowed_paths = ["!apps/**"];
    protectedPaths.deny = ["panopticon.charter.yaml", "!*.example"];
    expect(validateCharterDocument(doc).ok).toBe(false);
  });

  it("rejects a deny list that omits the Charter filename", () => {
    const doc = clone();
    const paths = asRecord(doc.paths);
    const protectedPaths = asRecord(paths.protected);
    protectedPaths.deny = [".env", ".env.*", "!*.example", "secrets/**"];
    expect(validateCharterDocument(doc).ok).toBe(false);
  });

  it("rejects a removed debugger effort", () => {
    const doc = clone();
    const roles = asRecord(doc.roles);
    const debuggerRole = asRecord(roles.debugger);
    delete debuggerRole.effort;
    expect(validateCharterDocument(doc).ok).toBe(false);
  });

  it("rejects a top-level worktree key", () => {
    const doc = clone();
    doc.worktree = { mode: "task" };
    expect(validateCharterDocument(doc).ok).toBe(false);
  });

  it("rejects an empty model, a missing engine and an unknown engine", () => {
    const emptyModel = clone();
    asRecord(asRecord(emptyModel.roles).overseer).model = "";
    expect(validateCharterDocument(emptyModel).ok).toBe(false);

    const missingEngine = clone();
    delete asRecord(asRecord(missingEngine.roles).implementer).engine;
    expect(validateCharterDocument(missingEngine).ok).toBe(false);

    const unknownEngine = clone();
    asRecord(asRecord(unknownEngine.roles).debugger).engine = "openai";
    expect(validateCharterDocument(unknownEngine).ok).toBe(false);
  });

  it("rejects broken YAML", () => {
    expect(loadCharterYaml("version: [\n").ok).toBe(false);
  });
});

describe("charter-validate CLI", () => {
  const cli = join(repoRoot, "wardens/src/cli.ts");

  function run(cwd: string): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "check", "charter-validate"],
      { cwd, encoding: "utf8" },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("allows the normative file and does not exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardens-charter-"));
    execFileSync("git", ["init"], { cwd: dir });
    writeFileSync(join(dir, "panopticon.charter.yaml"), charterText);
    const result = run(dir);
    expect(result.status).not.toBe(1);
    expect(result.status).toBe(0);
    const verdict = JSON.parse(result.stdout) as {
      decision: string;
      rule: string;
    };
    expect(verdict).toMatchObject({
      rule: "none",
      decision: "allow",
      message: null,
    });
  });

  it("denies a missing Charter with exit 2 and a C-30 message", () => {
    const dir = mkdtempSync(join(tmpdir(), "wardens-charter-"));
    execFileSync("git", ["init"], { cwd: dir });
    const result = run(dir);
    expect(result.status).not.toBe(1);
    expect(result.status).toBe(2);
    const verdict = JSON.parse(result.stdout) as {
      decision: string;
      message: string;
      rule: string;
    };
    expect(verdict.rule).toBe("engine");
    expect(verdict.decision).toBe("deny");
    expect(verdict.message).toBe(CHARTER_INVALID_MESSAGE);
    expect(verdict.message).toMatch(MESSAGE_PATTERN);
  });
});
