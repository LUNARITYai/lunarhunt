import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLedgerDirectory } from "../src/ledger/reader.ts";
import {
  closeQuietly,
  DEFAULT_LIMITS,
  FAILURE_REASONS,
  LedgerFailure,
  type LedgerFs,
  openChecked,
  type WriterDeps,
  writeLedgerRecord,
} from "../src/ledger/writer.ts";
import {
  ledgerDirectory,
  sampleRecord,
  tempHome,
} from "./fixtures/ledger/sample.ts";

const worker = join(import.meta.dirname, "fixtures/ledger/append-worker.ts");

function lines(path: string): string[] {
  return fs.readFileSync(path, "utf8").split("\n");
}

/** A home whose `panopticon`, `ledger` and project directories exist with mode 0700. */
function preparedHome(project = "lunarhunt"): { home: string; dir: string } {
  const home = tempHome();
  const dir = ledgerDirectory(home, project);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const part of [dir, join(dir, ".."), join(dir, "../..")]) {
    fs.chmodSync(part, 0o700);
  }
  return { home, dir };
}

function fail(result: ReturnType<typeof writeLedgerRecord>): string {
  return result.ok ? "ok" : result.reason;
}

describe("writer: a record", () => {
  it("creates the directories with 0700 and the file with 0600, and appends one line", () => {
    const home = tempHome();
    const result = writeLedgerRecord(sampleRecord(), { home });
    expect(result).toEqual({ ok: true });
    const dir = ledgerDirectory(home);
    for (const part of [dir, join(dir, ".."), join(dir, "../..")]) {
      expect(fs.statSync(part).mode & 0o777).toBe(0o700);
    }
    const file = join(dir, "events.jsonl");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(lines(file)).toEqual([JSON.stringify(sampleRecord()), ""]);
    expect(writeLedgerRecord(sampleRecord(), { home }).ok).toBe(true);
    expect(lines(file)).toHaveLength(3);
  });

  it("writes `_unknown` records to their own directory", () => {
    const home = tempHome();
    const record = sampleRecord({ project: "_unknown", tool: null });
    expect(writeLedgerRecord(record, { home }).ok).toBe(true);
    expect(
      fs.existsSync(join(ledgerDirectory(home, "_unknown"), "events.jsonl")),
    ).toBe(true);
  });

  it("stays inside the writer budget", () => {
    const calls: Record<string, number> = {};
    const real: Record<string, unknown> = { ...fs };
    const count = <K extends keyof LedgerFs>(name: K): Partial<LedgerFs> => ({
      [name]: (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1;
        return (real[name] as (...a: unknown[]) => unknown)(...args);
      },
    });
    const names = [
      "lstatSync",
      "mkdirSync",
      "readdirSync",
      "renameSync",
      "openSync",
      "fstatSync",
      "readSync",
      "writeSync",
      "closeSync",
    ] as const;
    const spy = Object.assign({}, ...names.map(count)) as Partial<LedgerFs>;
    const { home } = preparedHome();
    expect(writeLedgerRecord(sampleRecord(), { home, fs: spy }).ok).toBe(true);
    expect(writeLedgerRecord(sampleRecord(), { home, fs: spy }).ok).toBe(true);
    expect(calls).toEqual({
      lstatSync: 6,
      openSync: 2,
      fstatSync: 2,
      readSync: 1,
      writeSync: 2,
      closeSync: 2,
    });
    for (const key of Object.keys(calls)) {
      calls[key] = 0;
    }
    writeLedgerRecord(sampleRecord(), { home: tempHome(), fs: spy });
    expect(calls.mkdirSync).toBe(5);
    expect(calls.lstatSync).toBe(3);
  });

  it("never throws, whatever the filesystem does", () => {
    const { home, dir } = preparedHome();
    fs.writeFileSync(join(dir, "events.jsonl"), "x\n", { mode: 0o600 });
    const boom = () => {
      throw new Error("/secret/path EIO");
    };
    for (const name of [
      "lstatSync",
      "openSync",
      "fstatSync",
      "readSync",
      "writeSync",
    ] as const) {
      const result = writeLedgerRecord(sampleRecord(), {
        home,
        fs: { [name]: boom },
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
    expect(writeLedgerRecord(undefined, { home })).toEqual({
      ok: false,
      reason: "schema",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(fail(writeLedgerRecord(cyclic, { home }))).toBe("schema");
  });

  it("never throws while rotating or closing", () => {
    const { home, dir } = preparedHome();
    fs.writeFileSync(join(dir, "events.jsonl"), "x\n", { mode: 0o600 });
    const boom = () => {
      throw new Error("/secret/path EIO");
    };
    const limits = { project: { rotateBytes: 1 } };
    for (const [name, ok] of [
      ["readdirSync", false],
      ["renameSync", false],
      ["closeSync", true],
    ] as const) {
      const result = writeLedgerRecord(sampleRecord(), {
        home,
        limits,
        pid: 1,
        fs: { [name]: boom },
      });
      expect(result.ok).toBe(ok);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("writes what the schema returned, not a second read of the input", () => {
    const { home, dir } = preparedHome();
    let reads = 0;
    const record = sampleRecord();
    Object.defineProperty(record, "branch", {
      enumerable: true,
      get: () => `branch-${++reads}`,
    });
    expect(writeLedgerRecord(record, { home }).ok).toBe(true);
    const [written] = lines(join(dir, "events.jsonl"));
    const branch = JSON.parse(written ?? "").branch;
    expect(branch).toMatch(/^branch-[0-9]+$/);
    expect(branch).not.toBe("branch-1");
  });

  it("maps a record that cannot be read or serialised to schema", () => {
    const { home } = preparedHome();
    const hostile = sampleRecord();
    Object.defineProperty(hostile, "branch", {
      enumerable: true,
      get: () => {
        throw new Error("/secret/path");
      },
    });
    expect(writeLedgerRecord(hostile, { home })).toEqual({
      ok: false,
      reason: "schema",
    });
    expect(
      fail(writeLedgerRecord({ ...sampleRecord(), issue: 10n }, { home })),
    ).toBe("schema");
  });
});

describe("writer: descriptors", () => {
  /** Every descriptor the writer opens must be closed again, on every path. */
  function tracked(overrides: Partial<LedgerFs> = {}, failSecondOpen = false) {
    const open = new Set<number>();
    let opens = 0;
    const base: Partial<LedgerFs> = {
      openSync: ((path: string, flags: number, mode: number) => {
        opens += 1;
        if (failSecondOpen && opens === 2) {
          throw new Error("EMFILE");
        }
        const fd = fs.openSync(path, flags, mode);
        open.add(fd);
        return fd;
      }) as LedgerFs["openSync"],
      closeSync: ((fd: number) => {
        open.delete(fd);
        fs.closeSync(fd);
      }) as LedgerFs["closeSync"],
    };
    return { fs: { ...base, ...overrides }, open };
  }

  const foreign = ((fd: number) => {
    const st = fs.fstatSync(fd);
    return Object.create(st, { uid: { value: st.uid + 1 } });
  }) as LedgerFs["fstatSync"];

  const cases: [
    string,
    string,
    (dir: string, home: string) => Partial<LedgerFs>,
    Partial<WriterDeps>,
  ][] = [
    ["ok", "ok", () => ({}), {}],
    [
      "a FIFO",
      "not_regular",
      (dir) => {
        execFileSync("mkfifo", [join(dir, "events.jsonl")]);
        return {};
      },
      {},
    ],
    [
      "a hard link",
      "link_count",
      (dir, home) => {
        fs.writeFileSync(join(home, "other.txt"), "");
        fs.linkSync(join(home, "other.txt"), join(dir, "events.jsonl"));
        return {};
      },
      {},
    ],
    ["a foreign owner", "not_owned", () => ({ fstatSync: foreign }), {}],
    [
      "a failing read",
      "write",
      (dir) => {
        fs.writeFileSync(join(dir, "events.jsonl"), "x\n", { mode: 0o600 });
        return {
          readSync: (() => {
            throw new Error("EIO");
          }) as LedgerFs["readSync"],
        };
      },
      {},
    ],
    [
      "a failing write",
      "write",
      () => ({
        writeSync: (() => {
          throw new Error("EIO");
        }) as LedgerFs["writeSync"],
      }),
      {},
    ],
    [
      "the total cap",
      "cap",
      (dir) => {
        fs.writeFileSync(join(dir, "events.jsonl"), "x\n", { mode: 0o600 });
        return {};
      },
      { limits: { project: { rotateBytes: 1, totalBytes: 1 } } },
    ],
    [
      "a failed rename",
      "rotate",
      (dir) => {
        fs.writeFileSync(join(dir, "events.jsonl"), "x\n", { mode: 0o600 });
        return {
          renameSync: (() => {
            throw new Error("EXDEV");
          }) as LedgerFs["renameSync"],
        };
      },
      { limits: { project: { rotateBytes: 1 } } },
    ],
  ];

  it.each(cases)("closes what it opened: %s", (_name, reason, setup, extra) => {
    const { home, dir } = preparedHome();
    const overrides = setup(dir, home);
    const { fs: spy, open } = tracked(overrides);
    expect(
      fail(writeLedgerRecord(sampleRecord(), { home, fs: spy, ...extra })),
    ).toBe(reason);
    expect(open.size).toBe(0);
  });

  it("closes the first descriptor when the open after a rotation fails", () => {
    const { home, dir } = preparedHome();
    fs.writeFileSync(join(dir, "events.jsonl"), "x\n", { mode: 0o600 });
    const { fs: spy, open } = tracked({}, true);
    const result = writeLedgerRecord(sampleRecord(), {
      home,
      fs: spy,
      limits: { project: { rotateBytes: 1 } },
    });
    expect(fail(result)).toBe("open");
    expect(open.size).toBe(0);
  });

  it("exports the checked open for the failure-line appender", () => {
    const { dir } = preparedHome();
    const uid = process.getuid?.() ?? 0;
    const { fd, st } = openChecked(fs, join(dir, "failures.jsonl"), uid);
    closeQuietly(fs, fd);
    expect(st.isFile()).toBe(true);
    expect(fs.statSync(join(dir, "failures.jsonl")).mode & 0o777).toBe(0o600);
    execFileSync("mkfifo", [join(dir, "fifo.jsonl")]);
    try {
      openChecked(fs, join(dir, "fifo.jsonl"), uid);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerFailure);
      expect((error as LedgerFailure).reason).toBe("not_regular");
    }
  });
});

describe("writer: failure reasons", () => {
  it("names every reason of the spec", () => {
    expect([...FAILURE_REASONS]).toEqual([
      "home_unresolved",
      "not_directory",
      "symlink",
      "not_owned",
      "bad_mode",
      "mkdir",
      "open",
      "not_regular",
      "link_count",
      "write",
      "too_long",
      "schema",
      "rotate",
      "cap",
    ]);
  });

  it("home_unresolved: no home, or a relative one", () => {
    expect(fail(writeLedgerRecord(sampleRecord(), { home: null }))).toBe(
      "home_unresolved",
    );
    expect(fail(writeLedgerRecord(sampleRecord(), { home: "relative" }))).toBe(
      "home_unresolved",
    );
  });

  it("too_long: a hand-made oversize record, before the schema", () => {
    const { home, dir } = preparedHome();
    const oversize = { ...sampleRecord(), padding: "x".repeat(4096) };
    expect(fail(writeLedgerRecord(oversize, { home }))).toBe("too_long");
    expect(fs.existsSync(join(dir, "events.jsonl"))).toBe(false);
  });

  it("schema: a hand-made record with an extra key, and one that fails a field rule", () => {
    const { home, dir } = preparedHome();
    expect(
      fail(writeLedgerRecord({ ...sampleRecord(), command: "ls" }, { home })),
    ).toBe("schema");
    expect(
      fail(writeLedgerRecord(sampleRecord({ branch: "a\nb" }), { home })),
    ).toBe("schema");
    expect(fs.existsSync(join(dir, "events.jsonl"))).toBe(false);
  });

  it("symlink: each of the three directories", () => {
    for (const level of [0, 1, 2]) {
      const { home, dir } = preparedHome();
      const victim = [join(dir, "../.."), join(dir, ".."), dir][level] ?? "";
      const moved = `${victim}-real`;
      fs.renameSync(victim, moved);
      fs.symlinkSync(moved, victim);
      expect(fail(writeLedgerRecord(sampleRecord(), { home }))).toBe("symlink");
    }
  });

  it("not_directory: a file where a directory belongs", () => {
    const { home, dir } = preparedHome();
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "");
    expect(fail(writeLedgerRecord(sampleRecord(), { home }))).toBe(
      "not_directory",
    );
    const second = tempHome();
    fs.mkdirSync(join(second, ".local"));
    fs.writeFileSync(join(second, ".local", "state"), "");
    expect(fail(writeLedgerRecord(sampleRecord(), { home: second }))).toBe(
      "not_directory",
    );
  });

  it("not_owned: a directory of another UID", () => {
    const { home } = preparedHome();
    const uid = process.getuid?.() ?? 0;
    expect(
      fail(writeLedgerRecord(sampleRecord(), { home, uid: uid + 1 })),
    ).toBe("not_owned");
  });

  it("bad_mode: a directory with mode 0755", () => {
    for (const level of [0, 1, 2]) {
      const { home, dir } = preparedHome();
      fs.chmodSync(
        [join(dir, "../.."), join(dir, ".."), dir][level] ?? "",
        0o755,
      );
      expect(fail(writeLedgerRecord(sampleRecord(), { home }))).toBe(
        "bad_mode",
      );
    }
  });

  it("mkdir race: a directory another writer created is judged, not trusted", () => {
    for (const [mode, expected] of [
      [0o755, "bad_mode"],
      [0o700, "ok"],
    ] as const) {
      const { home, dir } = preparedHome();
      fs.chmodSync(join(dir, "../.."), mode);
      let first = true;
      const racing: Partial<LedgerFs> = {
        lstatSync: ((path: string) => {
          if (first) {
            first = false;
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return fs.lstatSync(path);
        }) as LedgerFs["lstatSync"],
        mkdirSync: (() => {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }) as LedgerFs["mkdirSync"],
      };
      expect(
        fail(writeLedgerRecord(sampleRecord(), { home, fs: racing })),
      ).toBe(expected);
    }
  });

  it("mkdir: a directory that cannot be created", () => {
    const deny = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect(
      fail(
        writeLedgerRecord(sampleRecord(), {
          home: tempHome(),
          fs: { mkdirSync: deny },
        }),
      ),
    ).toBe("mkdir");
  });

  it("open: a symlink at the file path, and no write through it", () => {
    const { home, dir } = preparedHome();
    const target = join(home, "target.txt");
    fs.writeFileSync(target, "");
    fs.symlinkSync(target, join(dir, "events.jsonl"));
    expect(fail(writeLedgerRecord(sampleRecord(), { home }))).toBe("open");
    expect(fs.readFileSync(target, "utf8")).toBe("");
  });

  it("not_regular: a FIFO at the file path, without blocking", () => {
    const { home, dir } = preparedHome();
    execFileSync("mkfifo", [join(dir, "events.jsonl")]);
    expect(fail(writeLedgerRecord(sampleRecord(), { home }))).toBe(
      "not_regular",
    );
  });

  it("link_count: a hard link, and nothing written", () => {
    const { home, dir } = preparedHome();
    const other = join(home, "other.txt");
    fs.writeFileSync(other, "");
    fs.linkSync(other, join(dir, "events.jsonl"));
    expect(fail(writeLedgerRecord(sampleRecord(), { home }))).toBe(
      "link_count",
    );
    expect(fs.readFileSync(other, "utf8")).toBe("");
  });

  it("not_owned: a file of another UID", () => {
    const { home } = preparedHome();
    const foreign: Partial<LedgerFs> = {
      fstatSync: ((fd: number) => {
        const st = fs.fstatSync(fd);
        return Object.create(st, { uid: { value: st.uid + 1 } });
      }) as LedgerFs["fstatSync"],
    };
    expect(fail(writeLedgerRecord(sampleRecord(), { home, fs: foreign }))).toBe(
      "not_owned",
    );
  });

  it("write: a short write is a failure, not completed", () => {
    const { home } = preparedHome();
    const short: Partial<LedgerFs> = {
      writeSync: ((fd: number, data: Buffer) =>
        fs.writeSync(fd, data, 0, 10)) as LedgerFs["writeSync"],
    };
    expect(fail(writeLedgerRecord(sampleRecord(), { home, fs: short }))).toBe(
      "write",
    );
  });
});

describe("writer: partial lines", () => {
  it("starts a new line after a line without a newline, and the reader sees one malformed line", () => {
    const { home, dir } = preparedHome();
    const file = join(dir, "events.jsonl");
    fs.writeFileSync(file, '{"v":1,"rec', { mode: 0o600 });
    expect(writeLedgerRecord(sampleRecord(), { home }).ok).toBe(true);
    expect(lines(file)).toEqual([
      '{"v":1,"rec',
      JSON.stringify(sampleRecord()),
      "",
    ]);
    const records: unknown[] = [];
    const stats = readLedgerDirectory(dir, (record) => records.push(record));
    expect(records).toHaveLength(1);
    expect(stats).toMatchObject({ malformed: 1, partial: 0 });
  });

  it("adds no prefix after a complete line or in an empty file", () => {
    const { home, dir } = preparedHome();
    fs.writeFileSync(join(dir, "events.jsonl"), "", { mode: 0o600 });
    writeLedgerRecord(sampleRecord(), { home });
    writeLedgerRecord(sampleRecord(), { home });
    expect(
      fs.readFileSync(join(dir, "events.jsonl"), "utf8").match(/\n\n/),
    ).toBeNull();
  });
});

describe("writer: rotation and caps", () => {
  const now = () => new Date("2026-11-20T08:09:10.123Z");

  function deps(home: string, extra: Partial<WriterDeps> = {}): WriterDeps {
    return { home, now, pid: 4242, ...extra };
  }

  it("rotates at the size, names the file by UTC time and pid, and starts a new one", () => {
    const { home, dir } = preparedHome();
    const limits = { project: { rotateBytes: 600 } };
    for (let index = 0; index < 3; index += 1) {
      expect(writeLedgerRecord(sampleRecord(), deps(home, { limits })).ok).toBe(
        true,
      );
    }
    expect(fs.readdirSync(dir).sort()).toEqual([
      "events-20261120T080910Z-4242.jsonl",
      "events.jsonl",
    ]);
    expect(lines(join(dir, "events-20261120T080910Z-4242.jsonl"))).toHaveLength(
      3,
    );
    expect(lines(join(dir, "events.jsonl"))).toHaveLength(2);
    expect(fs.statSync(join(dir, "events.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("does not rotate below the size", () => {
    const { home, dir } = preparedHome();
    const limits = { project: { rotateBytes: 100_000 } };
    for (let index = 0; index < 5; index += 1) {
      writeLedgerRecord(sampleRecord(), deps(home, { limits }));
    }
    expect(fs.readdirSync(dir)).toEqual(["events.jsonl"]);
  });

  it("rotate: a failed rename writes nothing", () => {
    const { home, dir } = preparedHome();
    fs.writeFileSync(join(dir, "events.jsonl"), `${"x".repeat(100)}\n`, {
      mode: 0o600,
    });
    const refuse = () => {
      throw new Error("EXDEV");
    };
    const result = writeLedgerRecord(
      sampleRecord(),
      deps(home, {
        limits: { project: { rotateBytes: 50 } },
        fs: { renameSync: refuse },
      }),
    );
    expect(fail(result)).toBe("rotate");
    expect(lines(join(dir, "events.jsonl"))).toHaveLength(2);
  });

  it("rotate: a second rotation by one pid in one second does not replace the first", () => {
    const { home, dir } = preparedHome();
    const limits = { project: { rotateBytes: 600 } };
    const results = Array.from({ length: 5 }, () =>
      fail(writeLedgerRecord(sampleRecord(), deps(home, { limits }))),
    );
    expect(results).toEqual(["ok", "ok", "ok", "ok", "rotate"]);
    const rotated = join(dir, "events-20261120T080910Z-4242.jsonl");
    expect(lines(rotated)).toHaveLength(3);
    expect(lines(join(dir, "events.jsonl"))).toHaveLength(3);
  });

  it("rotate: a file planted at the rotated name is not replaced", () => {
    const { home, dir } = preparedHome();
    const planted = join(dir, "events-20261120T080910Z-4242.jsonl");
    fs.writeFileSync(planted, "planted\n");
    fs.writeFileSync(join(dir, "events.jsonl"), `${"x".repeat(100)}\n`, {
      mode: 0o600,
    });
    const limits = { project: { rotateBytes: 50 } };
    expect(
      fail(writeLedgerRecord(sampleRecord(), deps(home, { limits }))),
    ).toBe("rotate");
    expect(fs.readFileSync(planted, "utf8")).toBe("planted\n");
    expect(lines(join(dir, "events.jsonl"))).toHaveLength(2);
  });

  it("rotate: a rotated name that differs only in case is not replaced", () => {
    const { home, dir } = preparedHome();
    const variant = join(dir, "EVENTS-20261120T080910Z-4242.JSONL");
    fs.writeFileSync(variant, "planted\n");
    fs.writeFileSync(join(dir, "events.jsonl"), `${"x".repeat(100)}\n`, {
      mode: 0o600,
    });
    const limits = { project: { rotateBytes: 50 } };
    expect(
      fail(writeLedgerRecord(sampleRecord(), deps(home, { limits }))),
    ).toBe("rotate");
    expect(fs.readFileSync(variant, "utf8")).toBe("planted\n");
    expect(lines(join(dir, "events.jsonl"))).toHaveLength(2);
  });

  it("cap: stops writing at the total cap until files are removed", () => {
    const { home, dir } = preparedHome();
    const limits = { project: { rotateBytes: 600, totalBytes: 1500 } };
    const results: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      results.push(
        fail(
          writeLedgerRecord(sampleRecord(), deps(home, { limits, pid: index })),
        ),
      );
    }
    expect(results.slice(0, 3)).toEqual(["ok", "ok", "ok"]);
    expect(results).toContain("cap");
    expect(results.slice(results.indexOf("cap"))).not.toContain("ok");
    const total = fs
      .readdirSync(dir)
      .reduce((sum, name) => sum + fs.statSync(join(dir, name)).size, 0);
    expect(total).toBeLessThan(1500 + 600);
    for (const name of fs.readdirSync(dir)) {
      if (name !== "events.jsonl") {
        fs.rmSync(join(dir, name));
      }
    }
    expect(writeLedgerRecord(sampleRecord(), deps(home, { limits })).ok).toBe(
      true,
    );
  });

  describe("entry cap (question 14)", () => {
    function crowded(project: string, others: number) {
      const prepared = preparedHome(project);
      fs.writeFileSync(
        join(prepared.dir, "events.jsonl"),
        `${"x".repeat(100)}\n`,
        { mode: 0o600 },
      );
      for (let index = 0; index < others; index += 1) {
        fs.writeFileSync(join(prepared.dir, `planted-${index}`), "");
      }
      return prepared;
    }

    it("defaults to 256 entries for a project and for `_unknown`", () => {
      expect(DEFAULT_LIMITS.project.maxEntries).toBe(256);
      expect(DEFAULT_LIMITS.unknown.maxEntries).toBe(256);
    });

    it("cap: 257 entries fail right after the listing, before any per-entry lstat", () => {
      const { home, dir } = crowded("lunarhunt", 256);
      expect(fs.readdirSync(dir)).toHaveLength(257);
      const inside: string[] = [];
      let listings = 0;
      let renames = 0;
      const result = writeLedgerRecord(sampleRecord(), {
        home,
        now: () => new Date("2026-11-20T08:09:10.123Z"),
        pid: 4242,
        limits: { project: { rotateBytes: 50 } },
        fs: {
          readdirSync: ((path: string) => {
            listings += 1;
            return fs.readdirSync(path);
          }) as LedgerFs["readdirSync"],
          lstatSync: ((path: string) => {
            if (path.startsWith(`${dir}/`)) {
              inside.push(path);
            }
            return fs.lstatSync(path);
          }) as LedgerFs["lstatSync"],
          renameSync: (() => {
            renames += 1;
          }) as LedgerFs["renameSync"],
        },
      });
      expect(fail(result)).toBe("cap");
      expect(listings).toBe(1);
      expect(inside).toEqual([]);
      expect(renames).toBe(0);
      expect(lines(join(dir, "events.jsonl"))).toEqual(["x".repeat(100), ""]);
    });

    it("writes with exactly 256 entries and fails with 257", () => {
      const limits = { project: { rotateBytes: 50 } };
      const at = crowded("lunarhunt", 255);
      expect(fs.readdirSync(at.dir)).toHaveLength(256);
      expect(
        writeLedgerRecord(sampleRecord(), {
          home: at.home,
          limits,
          pid: 1,
        }).ok,
      ).toBe(true);
      // The rotation added one file: the next scan sees 257 entries.
      fs.writeFileSync(join(at.dir, "events.jsonl"), `${"x".repeat(100)}\n`);
      expect(
        fail(
          writeLedgerRecord(sampleRecord(), { home: at.home, limits, pid: 2 }),
        ),
      ).toBe("cap");
    });

    it("takes the entry limit from the injected limits and recovers once entries are removed", () => {
      const { home, dir } = crowded("lunarhunt", 3);
      const limits = { project: { rotateBytes: 50, maxEntries: 3 } };
      expect(
        fail(writeLedgerRecord(sampleRecord(), { home, limits, pid: 1 })),
      ).toBe("cap");
      fs.rmSync(join(dir, "planted-0"));
      expect(
        writeLedgerRecord(sampleRecord(), { home, limits, pid: 1 }).ok,
      ).toBe(true);
    });

    it("does not count entries below the rotation size", () => {
      const { home } = crowded("lunarhunt", 300);
      fs.writeFileSync(join(ledgerDirectory(home), "events.jsonl"), "", {
        mode: 0o600,
      });
      expect(writeLedgerRecord(sampleRecord(), { home }).ok).toBe(true);
    });

    it("applies to `_unknown` as well", () => {
      const { home } = crowded("_unknown", 5);
      const unknown = sampleRecord({ project: "_unknown", tool: null });
      expect(
        fail(
          writeLedgerRecord(unknown, {
            home,
            limits: { unknown: { rotateBytes: 50, maxEntries: 5 } },
            pid: 1,
          }),
        ),
      ).toBe("cap");
    });
  });

  it("uses smaller limits for `_unknown`", () => {
    const { home, dir } = preparedHome("_unknown");
    const unknown = sampleRecord({ project: "_unknown", tool: null });
    const bytes = Buffer.byteLength(`${JSON.stringify(unknown)}\n`);
    const limits = {
      unknown: { rotateBytes: bytes * 2, totalBytes: bytes * 4 },
    };
    const results = Array.from({ length: 20 }, (_, index) =>
      fail(writeLedgerRecord(unknown, deps(home, { limits, pid: index }))),
    );
    expect(results).toContain("cap");
    expect(fs.readdirSync(dir).length).toBeGreaterThan(1);
    const project = sampleRecord();
    for (let index = 0; index < 20; index += 1) {
      expect(
        writeLedgerRecord(project, deps(home, { limits, pid: index })).ok,
      ).toBe(true);
    }
  });
});

describe("writer: concurrency", () => {
  it("keeps whole lines from 8 processes appending 500 records each", async () => {
    const { home, dir } = preparedHome();
    const codes = await Promise.all(
      Array.from(
        { length: 8 },
        (_, index) =>
          new Promise<number | null>((resolve) => {
            spawn(
              process.execPath,
              [
                "--experimental-strip-types",
                worker,
                home,
                String(index),
                "500",
              ],
              { stdio: "ignore" },
            ).on("close", resolve);
          }),
      ),
    );
    expect(codes).toEqual(new Array(8).fill(0));
    let parsed = 0;
    const stats = readLedgerDirectory(dir, () => {
      parsed += 1;
    });
    expect(parsed).toBe(4000);
    expect(stats).toMatchObject({ malformed: 0, partial: 0 });
  }, 120_000);

  it("creates the directories once when processes race on a fresh home", async () => {
    const home = tempHome();
    const codes = await Promise.all(
      Array.from(
        { length: 6 },
        (_, index) =>
          new Promise<number | null>((resolve) => {
            spawn(
              process.execPath,
              ["--experimental-strip-types", worker, home, String(index), "5"],
              { stdio: "ignore" },
            ).on("close", resolve);
          }),
      ),
    );
    expect(codes).toEqual(new Array(6).fill(0));
    expect(readLedgerDirectory(ledgerDirectory(home), () => {}).malformed).toBe(
      0,
    );
  }, 60_000);
});
