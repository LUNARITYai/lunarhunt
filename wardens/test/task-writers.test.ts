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

/** Any call that creates, replaces, links or copies a file or a directory (shell steps are out of reach). */
const WRITES =
  /\b(writeFileSync|writeFresh|appendFileSync|copyFileSync|cpSync|renameSync|symlinkSync|linkSync|createWriteStream|writeFile|copyFile|cp|rename|symlink|link|writeProtected)\s*\(/;
/** The task file in any spelling: bare, joined (`.panopticon/task.json`), quoted or split into path segments. */
const NAMES_TASK_FILE = /task\W{0,8}\.json/i;
/** The directory that holds it, so a copy of the whole directory is seen too. */
const NAMES_DIRECTORY = /\.panopticon/;

/**
 * Files that write below `.panopticon` but never the task file. Each is also
 * checked to stay away from `task.json`; adding a file here needs a reason.
 */
const OTHER_FILES: Record<string, string> = {
  "log.ts": "wardens.log.jsonl",
  "dod.ts": "dod-state.json",
  "doctor.ts": "self-test fixtures in a temporary repository; reads the log",
};

const rel = (file: string) => relative(SRC, file).split("\\").join("/");
const text = (file: string) => readFileSync(join(SRC, file), "utf8");
/** Source without comments: a comment that names the file is not a use of it. */
const code = (file: string) =>
  text(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const files = sources(SRC).map(rel);
const writing = files.filter((file) => WRITES.test(code(file)));

/**
 * #96: a task.json without its hash record is denied as unrecorded by every
 * guard, so no code path may write or copy one without writing the record. The
 * single writer is `installTask` in `worktree/setup.ts`, which writes the file
 * and the record together; a new writer must go through it. Any source that
 * names the file or the `.panopticon` directory and calls a writer or a copy
 * fails here unless it is that function or a listed file that writes
 * something else.
 */
describe("every writer of .panopticon/task.json records its hash", () => {
  it.each([
    'writeFileSync(join(dir, ".panopticon/task.json"), text)',
    'copyFileSync(a, b + "/.panopticon/task.json")',
    'writeFileSync(join(d, ".panopticon", "task", ".json"), text)',
    'writeFresh(join(d, TASK_FILE), "x") // task.json',
  ])("the scan sees a writer spelled: %s", (line) => {
    expect(WRITES.test(line)).toBe(true);
    expect(NAMES_TASK_FILE.test(line)).toBe(true);
  });

  it("the scan sees a copy of the whole directory", () => {
    const line = 'cpSync(join(a, ".panopticon"), join(b, ".panopticon"))';
    expect(WRITES.test(line) && NAMES_DIRECTORY.test(line)).toBe(true);
  });

  it("has exactly one source that writes or copies the task file", () => {
    const naming = writing.filter((file) => NAMES_TASK_FILE.test(code(file)));
    expect(naming).toEqual(["worktree/setup.ts"]);
  });

  it("has no other source that writes or copies below .panopticon", () => {
    const naming = writing.filter((file) => NAMES_DIRECTORY.test(code(file)));
    expect(naming.sort()).toEqual(
      ["worktree/setup.ts", ...Object.keys(OTHER_FILES)].sort(),
    );
  });

  it.each(Object.keys(OTHER_FILES))("%s never names the task file", (file) => {
    expect(code(file)).not.toMatch(NAMES_TASK_FILE);
  });

  it("writes the record in the function that writes the file", () => {
    const source = text("worktree/setup.ts");
    const start = source.indexOf("export function installTask(");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toMatch(/writeFresh\(join\(dir, "task\.json"\)/);
    expect(body).toMatch(/recordTaskHash\(home, primary, wt, text\)/);
    // The only quoted use of the file name in the module is that function.
    expect(source.match(/"task\.json"/g)?.length).toBe(1);
  });

  it.each(["worktree/setup.ts", "worktree/hook.ts"])(
    "%s reaches the writer only through installTask",
    (file) => {
      expect(text(file)).toContain("installTask(");
    },
  );

  it("the hook calls no file writer or copy of its own", () => {
    expect(code("worktree/hook.ts")).not.toMatch(WRITES);
  });
});
