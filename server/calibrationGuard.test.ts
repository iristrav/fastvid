import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  applyCalibrationGuard,
  resolveCalibrationDatabase,
  databaseHostKey,
  databaseNameOf,
  CalibrationGuardError,
} from "./calibrationGuard";

// RONDE 43 — the calibration worker must not be able to reach the production database.
//
// A calibration worker is an ordinary FastVid worker: it migrates on boot, sweeps stuck videos,
// claims jobs, and every 90 seconds can mark another worker's in-flight renders as failed. The
// queue is `videos.status`, so a shared database IS a shared queue. Pointing it at production is
// a production incident, not a misconfiguration — hence a guard that fails closed.
//
// These tests exercise the guard's real logic against real env objects. The two structural
// checks at the end cover the one property that cannot be asserted behaviourally from here:
// where the call sits in the worker's boot sequence.

const PROD = "mysql://produser:prodsecret@prod-db.railway.internal:3306/railway";
const CALIB = "mysql://caluser:calsecret@calibration-db.railway.internal:3306/railway";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RONDE 43 — production is untouched", () => {
  it("CALIBRATION_MODE unset: returns production and changes nothing", () => {
    const env = { DATABASE_URL: PROD } as NodeJS.ProcessEnv;
    expect(applyCalibrationGuard(env)).toEqual({ mode: "production" });
    expect(env.DATABASE_URL).toBe(PROD);
  });

  it("only the exact string \"true\" arms the guard", () => {
    for (const value of ["false", "TRUE", "1", "yes", " true", ""]) {
      const env = { CALIBRATION_MODE: value, DATABASE_URL: PROD } as NodeJS.ProcessEnv;
      // Not armed -> production, and crucially NOT a hard fail: a stray value must never stop a
      // production worker from booting.
      expect(resolveCalibrationDatabase(env)).toEqual({ mode: "production" });
      expect(env.DATABASE_URL).toBe(PROD);
    }
  });

  it("a production worker with no DATABASE_URL at all still resolves to production", () => {
    expect(resolveCalibrationDatabase({} as NodeJS.ProcessEnv)).toEqual({ mode: "production" });
  });

  it("logs nothing in production mode", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    applyCalibrationGuard({ DATABASE_URL: PROD } as NodeJS.ProcessEnv);
    expect(log).not.toHaveBeenCalled();
  });
});

describe("RONDE 43 — calibration mode fails closed", () => {
  it("no CALIBRATION_DATABASE_URL: hard fail, no fallback to DATABASE_URL", () => {
    const env = { CALIBRATION_MODE: "true", DATABASE_URL: PROD } as NodeJS.ProcessEnv;
    expect(() => resolveCalibrationDatabase(env)).toThrow(CalibrationGuardError);
    expect(() => resolveCalibrationDatabase(env)).toThrow(/requires a separate CALIBRATION_DATABASE_URL/);
    // The production URL is still in place — the guard refused rather than borrowing it.
    expect(env.DATABASE_URL).toBe(PROD);
  });

  it("an empty or whitespace CALIBRATION_DATABASE_URL is treated as missing", () => {
    for (const value of ["", "   "]) {
      const env = {
        CALIBRATION_MODE: "true",
        CALIBRATION_DATABASE_URL: value,
        DATABASE_URL: PROD,
      } as NodeJS.ProcessEnv;
      expect(() => resolveCalibrationDatabase(env)).toThrow(/requires a separate CALIBRATION_DATABASE_URL/);
    }
  });

  it("identical URLs: hard fail", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: PROD,
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv;
    expect(() => resolveCalibrationDatabase(env)).toThrow(/identical to DATABASE_URL/);
  });

  it("same host, different database: hard fail", () => {
    // The scenario the spec singles out — a second schema on the production server. Same
    // migrations run against the same MySQL instance; that is not isolation.
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: "mysql://caluser:calsecret@prod-db.railway.internal:3306/calibration",
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv;
    expect(() => resolveCalibrationDatabase(env)).toThrow(/same database host/);
  });

  it("same host reached with different credentials or casing: still hard fail", () => {
    for (const url of [
      "mysql://someone_else:other@prod-db.railway.internal:3306/calibration",
      "mysql://caluser:calsecret@PROD-DB.RAILWAY.INTERNAL:3306/calibration",
      // implicit default port must compare equal to the explicit one
      "mysql://caluser:calsecret@prod-db.railway.internal/calibration",
    ]) {
      const env = {
        CALIBRATION_MODE: "true",
        CALIBRATION_DATABASE_URL: url,
        DATABASE_URL: PROD,
      } as NodeJS.ProcessEnv;
      expect(() => resolveCalibrationDatabase(env)).toThrow(/same database host/);
    }
  });

  it("an unparseable calibration URL: hard fail", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: "not-a-url",
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv;
    expect(() => resolveCalibrationDatabase(env)).toThrow(/not a parseable database URL/);
  });

  it("an unparseable production URL: hard fail, because isolation cannot be proven", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: CALIB,
      DATABASE_URL: "prod-db.railway.internal:3306",
    } as NodeJS.ProcessEnv;
    expect(() => resolveCalibrationDatabase(env)).toThrow(/cannot prove/);
  });
});

describe("RONDE 43 — calibration mode with a genuinely separate host", () => {
  it("is allowed and reports the calibration database", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: CALIB,
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv;
    expect(resolveCalibrationDatabase(env)).toEqual({
      mode: "calibration",
      databaseUrl: CALIB,
      databaseName: "railway",
    });
  });

  it("DATABASE_URL becomes the calibration URL, so every later getDb() connects there", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: CALIB,
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv;
    vi.spyOn(console, "log").mockImplementation(() => {});
    applyCalibrationGuard(env);
    expect(env.DATABASE_URL).toBe(CALIB);
    expect(env.DATABASE_URL).not.toBe(PROD);
  });

  it("works with no production DATABASE_URL present at all", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: CALIB,
    } as NodeJS.ProcessEnv;
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(applyCalibrationGuard(env).mode).toBe("calibration");
    expect(env.DATABASE_URL).toBe(CALIB);
  });

  it("a different port on the same hostname counts as a different server", () => {
    const env = {
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: "mysql://u:p@prod-db.railway.internal:3307/calibration",
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv;
    expect(resolveCalibrationDatabase(env).mode).toBe("calibration");
  });
});

describe("RONDE 43 — no secret ever reaches the log", () => {
  it("the success line carries the database name and nothing else", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    applyCalibrationGuard({
      CALIBRATION_MODE: "true",
      CALIBRATION_DATABASE_URL: CALIB,
      DATABASE_URL: PROD,
    } as NodeJS.ProcessEnv);

    const printed = log.mock.calls.flat().join(" ");
    for (const secret of [
      CALIB, PROD,
      "calsecret", "prodsecret",          // passwords
      "caluser", "produser",              // users
      "calibration-db.railway.internal",  // hosts
      "prod-db.railway.internal",
    ]) {
      expect(printed).not.toContain(secret);
    }
    expect(printed).toContain("[CalibrationGuard]");
    expect(printed).toContain('"railway"');
  });

  it("no failure message contains a URL, a host, a user or a password", () => {
    const cases: NodeJS.ProcessEnv[] = [
      { CALIBRATION_MODE: "true", DATABASE_URL: PROD },
      { CALIBRATION_MODE: "true", CALIBRATION_DATABASE_URL: PROD, DATABASE_URL: PROD },
      {
        CALIBRATION_MODE: "true",
        CALIBRATION_DATABASE_URL: "mysql://u:p@prod-db.railway.internal:3306/other",
        DATABASE_URL: PROD,
      },
      { CALIBRATION_MODE: "true", CALIBRATION_DATABASE_URL: "not-a-url", DATABASE_URL: PROD },
    ];
    for (const env of cases) {
      let message = "";
      try {
        resolveCalibrationDatabase(env);
        throw new Error("expected the guard to throw");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("expected the guard to throw");
      for (const secret of [
        "prodsecret", "calsecret", "produser", "caluser",
        "prod-db.railway.internal", "calibration-db.railway.internal",
        "mysql://",
      ]) {
        expect(message).not.toContain(secret);
      }
    }
  });
});

describe("RONDE 43 — host comparison uses a real parser", () => {
  it("normalises case and default ports", () => {
    expect(databaseHostKey("mysql://u:p@Host.Example:3306/db")).toBe("host.example:3306");
    expect(databaseHostKey("mysql://u:p@host.example/db")).toBe("host.example:3306");
    expect(databaseHostKey("postgres://u:p@host.example/db")).toBe("host.example:5432");
  });

  it("does not confuse a host with one that merely contains it", () => {
    // A substring check would call these the same server. They are not.
    expect(databaseHostKey("mysql://u:p@db-prod/x")).not.toBe(
      databaseHostKey("mysql://u:p@db-prod-calibration/x")
    );
  });

  it("returns null for unparseable input rather than guessing", () => {
    for (const bad of ["", "   ", "not-a-url", "host:3306/db", "mysql://"]) {
      expect(databaseHostKey(bad)).toBeNull();
    }
  });

  it("databaseNameOf extracts only the database name", () => {
    expect(databaseNameOf(CALIB)).toBe("railway");
    expect(databaseNameOf("mysql://u:p@h/my_db")).toBe("my_db");
    expect(databaseNameOf("garbage")).toBe("unknown");
  });
});

describe("RONDE 43 — placement and blast radius", () => {
  const WORKER = readFileSync(path.join(__dirname, "worker.ts"), "utf8");
  const FUNNEL = readFileSync(path.join(__dirname, "retrievalFunnel.ts"), "utf8");

  it("the guard runs before runMigrations — and before the first database write", () => {
    const guardIdx = WORKER.indexOf("applyCalibrationGuard();");
    const heartbeatIdx = WORKER.indexOf('recordWorkerHeartbeat("worker")');
    const migrateIdx = WORKER.indexOf("await runMigrations();");
    const queueIdx = WORKER.indexOf("startVideoQueueWorker();");
    expect(guardIdx).toBeGreaterThan(-1);
    // recordWorkerHeartbeat already writes to the database, so the guard has to precede it too —
    // sitting merely "just before runMigrations" would be one write too late.
    expect(guardIdx).toBeLessThan(heartbeatIdx);
    expect(guardIdx).toBeLessThan(migrateIdx);
    expect(guardIdx).toBeLessThan(queueIdx);
  });

  it("a failing guard exits the process instead of continuing", () => {
    const guardIdx = WORKER.indexOf("applyCalibrationGuard();");
    const block = WORKER.slice(guardIdx, guardIdx + 300);
    expect(block).toContain("process.exit(1)");
    expect(block).not.toContain("console.warn");
  });

  it("no ranking or retrieval function was touched", () => {
    // The six functions Ronde 42 put out of bounds must read exactly as before.
    expect(FUNNEL).toContain("async function computeArchiveCoverage(");
    expect(FUNNEL).toContain('if (coverage > ARCHIVE_DOMINANT_THRESHOLD) return "archive_dominant";');
    expect(FUNNEL).toContain('if (bestArchiveScore >= BEAT_ARCHIVE_STOP_THRESHOLD) strategy = "archive_only";');
    expect(FUNNEL).toContain("const kwBase = Math.min(1, pick.score / KEYWORD_SCORE_MAX);");
    expect(FUNNEL).toContain("export function pickBestFunnelCandidate(");
    expect(FUNNEL).toContain("export function orderCandidatesForBeatGap(");
    // and no threshold moved
    expect(FUNNEL).toContain("const KEYWORD_SCORE_MAX = 100;");
    expect(FUNNEL).toContain("const ARCHIVE_DOMINANT_THRESHOLD = 0.88;");
    expect(FUNNEL).toContain("const INTERNET_DOMINANT_THRESHOLD = 0.45;");
    expect(FUNNEL).toContain("export const BEAT_ARCHIVE_STOP_THRESHOLD = 0.94;");
    expect(FUNNEL).toContain("export const BEAT_ARCHIVE_ONE_EXTERNAL_THRESHOLD = 0.75;");
    expect(FUNNEL).toContain("export const BEAT_ARCHIVE_ALL_EXTERNAL_THRESHOLD = 0.50;");
  });

  it("the guard module itself touches nothing but env", () => {
    const GUARD = readFileSync(path.join(__dirname, "calibrationGuard.ts"), "utf8");
    // Comments are stripped first: the module's doc comment explains WHY it must run before
    // getDb(), and that prose is not a call. What matters is that no executable line in this
    // module opens a connection, runs a migration or does I/O of any kind.
    const code = GUARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["getDb", "drizzle", "mysql.createPool", "fetch(", "await ", "migrate("]) {
      expect(code).not.toContain(forbidden);
    }
    // and the import surface is empty — nothing can be pulled in transitively.
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toContain("require(");
  });
});
