import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicBuild } from "../scripts/build.ts";

let dist = "";
afterEach(() => rmSync(dist, { recursive: true, force: true }));

function setup(): string {
  dist = mkdtempSync(join(tmpdir(), "wardens-dist-"));
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "wardens.mjs"), "old");
  return dist;
}

describe("atomicBuild", () => {
  it("keeps the old bundle in place until the new one is complete", () => {
    setup();
    let during = "";
    atomicBuild(dist, (out) => {
      during = readFileSync(join(dist, "wardens.mjs"), "utf8");
      writeFileSync(join(out, "wardens.mjs"), "new");
      expect(readFileSync(join(dist, "wardens.mjs"), "utf8")).toBe("old");
    });
    expect(during).toBe("old");
    expect(readFileSync(join(dist, "wardens.mjs"), "utf8")).toBe("new");
    expect(readdirSync(dist)).toEqual(["wardens.mjs"]);
  });

  it("leaves the old bundle untouched when the build fails", () => {
    setup();
    expect(() =>
      atomicBuild(dist, () => {
        throw new Error("tsup failed");
      }),
    ).toThrow("tsup failed");
    expect(readFileSync(join(dist, "wardens.mjs"), "utf8")).toBe("old");
    expect(readdirSync(dist)).toEqual(["wardens.mjs"]);
  });

  it("leaves the old bundle when the build produced no bundle", () => {
    setup();
    expect(() => atomicBuild(dist, () => {})).toThrow();
    expect(readFileSync(join(dist, "wardens.mjs"), "utf8")).toBe("old");
    expect(existsSync(join(dist, ".tmp-1"))).toBe(false);
  });

  it("works when dist has no bundle yet", () => {
    setup();
    rmSync(join(dist, "wardens.mjs"));
    atomicBuild(dist, (out) => writeFileSync(join(out, "wardens.mjs"), "new"));
    expect(readFileSync(join(dist, "wardens.mjs"), "utf8")).toBe("new");
  });
});
