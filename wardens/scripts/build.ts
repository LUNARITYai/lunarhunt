import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = "wardens.mjs";

/**
 * Build into `<dist>/.tmp-<pid>`, then rename the bundle over `<dist>/wardens.mjs`.
 * The rename is atomic on one filesystem, so hooks never see a missing or partial bundle.
 */
export function atomicBuild(
  distDir: string,
  build: (outDir: string) => void,
  pid: number = process.pid,
): void {
  const tmp = join(distDir, `.tmp-${pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    build(tmp);
    renameSync(join(tmp, BUNDLE), join(distDir, BUNDLE));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
  atomicBuild(join(pkg, "dist"), (outDir) => {
    execFileSync("tsup", ["--out-dir", outDir], { cwd: pkg, stdio: "inherit" });
  });
}
