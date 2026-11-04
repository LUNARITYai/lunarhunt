import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CODEOWNERS", () => {
  it("already gives panopticon.charter.yaml to @koszczapinski", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const text = readFileSync(join(root, ".github/CODEOWNERS"), "utf8");
    expect(text).toMatch(/^panopticon\.charter\.yaml\s+@koszczapinski\s*$/m);
  });
});
