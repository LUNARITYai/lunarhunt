import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

export function normativeCharter(): string {
  return readFileSync(join(repoRoot, "panopticon.charter.yaml"), "utf8");
}

export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wardens-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "panopticon.charter.yaml"), normativeCharter());
  return dir;
}

export function writeRepoFile(root: string, rel: string, text: string): void {
  const file = join(root, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

export const cliPath = join(repoRoot, "wardens/src/cli.ts");
