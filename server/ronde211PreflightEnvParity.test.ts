/**
 * RONDE 211 — the preflight must read configuration the same way the app does.
 *
 * ── The bug this pins ────────────────────────────────────────────────────────────────────────
 *
 * Both application entrypoints load a `.env` file before reading anything:
 *
 *     server/_core/index.ts:1   import "dotenv/config";
 *     server/worker.ts:1        import "dotenv/config";
 *
 * `server/productionPreflightCli.ts` did not. So on any deployment that keeps its configuration in
 * a `.env` file — which this repository documents, since it ships a `.env.example` — the preflight
 * read an empty process environment and reported PRODUCTION_RENDER_BLOCKED for an app that boots
 * and renders perfectly well.
 *
 * That is the exact mirror of the four errors R201–R210 found, and the more damaging direction: a
 * preflight that says BLOCKED when it is not teaches an operator to stop believing it, and then
 * the one time it is right they ship anyway.
 *
 * ── Why this is a test and not a one-line fix with a comment ─────────────────────────────────
 *
 * The failure is invisible in every environment that happens to export its variables — including
 * this one, and including CI. Only a test that actually puts a `.env` on disk and runs the real
 * CLI against it can tell the two apart, so that is what the behavioural test below does.
 *
 * Nothing here is a credential. The `.env` written by these tests contains a localhost MySQL URL
 * with no password and no host of consequence; the point is that the CLI SEES a file, not what is
 * in it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CLI = path.resolve("server/productionPreflightCli.ts");
const CLI_SRC = fs.readFileSync(CLI, "utf8");

/* ═══════════════════════ the structural half ═══════════════════════ */

describe("R211 — the preflight loads configuration the way the app does", () => {
  /**
   * Read from the entrypoints rather than restated, so this stays true if the project ever moves
   * off dotenv: the rule is PARITY with the app, not the use of one particular library.
   */
  const ENTRYPOINTS = ["server/_core/index.ts", "server/worker.ts"];

  it("the application entrypoints load a .env file", () => {
    for (const f of ENTRYPOINTS) {
      expect(fs.readFileSync(f, "utf8"), `${f} no longer loads dotenv`).toContain('import "dotenv/config"');
    }
  });

  it("and so does the preflight, or it cannot see what the app sees", () => {
    expect(CLI_SRC, "the preflight reads a different environment than the app it describes")
      .toContain('import "dotenv/config"');
  });

  /**
   * It has to be FIRST. `dotenv/config` populates `process.env` as a side effect of being
   * imported, and ES module imports are evaluated in order — so a module imported above it that
   * reads configuration at module scope would read the environment before the file was loaded.
   */
  it("loads it before anything that might read configuration", () => {
    const imports = [...CLI_SRC.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
    expect(imports[0], "dotenv is not the first import — an earlier module could read env first")
      .toContain("dotenv/config");
  });
});

/* ═══════════════════════ the behavioural half ═══════════════════════ */

describe("R211 — a .env on disk actually changes what the preflight reports", () => {
  let dir = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r211-"));
    /**
     * dotenv reads `.env` from the process's working directory, so the CLI is run FROM this
     * directory with an absolute path to the script. No real credential: a localhost URL with no
     * password, present only so the database capability has something to see.
     */
    fs.writeFileSync(
      path.join(dir, ".env"),
      "DATABASE_URL=mysql://preflight-test@127.0.0.1:3306/fastvid_r211\n"
    );
  });

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** The CLI exits 1 when blocked, so a non-zero exit is an outcome here rather than an error. */
  function runPreflight(cwd: string): { id: string; state: string; detail?: string }[] {
    let out = "";
    /**
     * DELETED from the child's environment, not set to "".
     *
     * dotenv deliberately never overwrites a variable that is already present, and an empty string
     * still counts as present — so passing `DATABASE_URL: ""` would block the .env from loading
     * and this test would fail against a perfectly correct fix. That precedence rule is right (a
     * platform's own configuration must win over a file committed next to the code), so the test
     * bends to it rather than the other way round.
     */
    const childEnv = { ...process.env };
    delete childEnv.DATABASE_URL;
    try {
      out = execFileSync("npx", ["tsx", CLI, "--json"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: childEnv,
      });
    } catch (err) {
      out = (err as { stdout?: string }).stdout ?? "";
    }
    const start = out.indexOf("{");
    expect(start, `the preflight produced no JSON: ${out.slice(0, 400)}`).toBeGreaterThan(-1);
    return (JSON.parse(out.slice(start)) as {
      capabilities: { id: string; state: string; detail?: string }[];
    }).capabilities;
  }

  it("sees a DATABASE_URL that exists only in a .env file", () => {
    const database = runPreflight(dir).find((c) => c.id === "database")!;
    expect(
      database.state,
      "the preflight reported the database as missing while the app would have loaded it from .env"
    ).toBe("available");
  }, 120_000);

  /**
   * The control. Same CLI, same empty parent environment, a directory with no `.env` — and the
   * report must go back to blocked. Without this the test above would also pass if the CLI had
   * simply stopped checking the database at all.
   */
  it("and still reports it missing when there is no .env to read", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "r211-empty-"));
    try {
      const database = runPreflight(empty).find((c) => c.id === "database")!;
      expect(database.state).toBe("blocked");
    } finally {
      try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 120_000);
});
