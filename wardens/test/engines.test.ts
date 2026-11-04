import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGINES,
  embeddedModelSuffixPattern,
  resolveRole,
} from "../src/engines.ts";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

describe("engine adapters", () => {
  it("resolves cursor effort into the model id and claude --effort", () => {
    expect(
      resolveRole({ engine: "cursor", model: "grok-4.7", effort: "medium" }),
    ).toEqual({ model: "grok-4.7-medium", args: [] });
    expect(
      resolveRole({
        engine: "cursor",
        model: "grok-4.7",
        effort: "high",
        fast: true,
      }),
    ).toEqual({ model: "grok-4.7-high-fast", args: [] });
    expect(
      resolveRole({
        engine: "cursor",
        model: "grok-4.7",
        effort: "medium",
        fast: false,
      }),
    ).toEqual({ model: "grok-4.7-medium", args: [] });
    expect(
      resolveRole({ engine: "claude", model: "opus", effort: "high" }),
    ).toEqual({ model: "opus", args: ["--effort", "high"] });
    expect(
      resolveRole({
        engine: "claude",
        model: "opus",
        effort: "low",
        fast: true,
      }),
    ).toEqual({ model: "opus", args: ["--effort", "low"] });
  });

  it("keeps the schema engine enum equal to the registry keys", () => {
    const schema = JSON.parse(
      readFileSync(
        join(repoRoot, "wardens/schema/charter.schema.json"),
        "utf8",
      ),
    ) as {
      $defs: {
        engine: { enum: string[] };
        claudeEffort: { enum: string[] };
        cursorEffort: { enum: string[] };
        cursorModelSuffix: { pattern: string };
      };
    };
    expect(schema.$defs.engine.enum).toEqual(Object.keys(ENGINES));
    expect(schema.$defs.claudeEffort.enum).toEqual([...ENGINES.claude.efforts]);
    expect(schema.$defs.cursorEffort.enum).toEqual([...ENGINES.cursor.efforts]);
    expect(schema.$defs.cursorModelSuffix.pattern).toBe(
      embeddedModelSuffixPattern(ENGINES.cursor.efforts),
    );
  });
});
