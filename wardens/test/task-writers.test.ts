import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sources(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
  });
}

const WRITES =
  /\b(writeFileSync|writeFresh|appendFileSync|copyFileSync|cpSync|renameSync|symlinkSync|linkSync|createWriteStream|writeFile|copyFile|cp)\s*\(/;
const NAMES_TASK_FILE = /["'`]task\.json["'`]/;

/**
 * #96: a task.json without its hash record is denied as unrecorded by every
 * guard, so no code path may write or copy one without writing the record. The
 * single writer is `installTask` in `worktree/setup.ts`, which writes the file
 * and the record together; a new writer must go through it.
 */
describe("every writer of .panopticon/task.json records its hash", () => {
  const writers = sources(SRC)
    .filter((file) => {
      const text = readFileSync(file, "utf8");
      return NAMES_TASK_FILE.test(text) && WRITES.test(text);
    })
    .map((file) => relative(SRC, file).split("\\").join("/"));

  it("has exactly one source that writes the file", () => {
    expect(writers).toEqual(["worktree/setup.ts"]);
  });

  it("writes the record in the function that writes the file", () => {
    const text = readFileSync(join(SRC, "worktree", "setup.ts"), "utf8");
    const start = text.indexOf("export function installTask(");
    const end = text.indexOf("\n}\n", start);
    const body = text.slice(start, end);
    expect(body).toMatch(/writeFresh\(join\(dir, "task\.json"\)/);
    expect(body).toMatch(/recordTaskHash\(home, primary, wt, text\)/);
    // The only call site of the file write is that function.
    expect(text.match(/"task\.json"/g)?.length).toBe(1);
  });

  it.each(["worktree/setup.ts", "worktree/hook.ts"])(
    "%s reaches the writer only through installTask",
    (file) => {
      const text = readFileSync(join(SRC, file), "utf8");
      expect(text).toContain("installTask(");
    },
  );

  it("the hook never names the file itself", () => {
    const text = readFileSync(join(SRC, "worktree", "hook.ts"), "utf8");
    expect(text).not.toMatch(NAMES_TASK_FILE);
  });
});
