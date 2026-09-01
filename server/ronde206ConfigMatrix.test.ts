/**
 * RONDE 206 — the configuration matrix, checked against the code it claims to describe.
 *
 * ── What this file is defending against ──────────────────────────────────────────────────────
 *
 * A preflight is a SECOND statement of what production needs. The first is the production code
 * itself. Two statements of one fact drift, and this one drifts silently: nothing fails when the
 * preflight is wrong, it just tells an operator to go and configure the wrong thing.
 *
 * R201's inventory found four of those, all of them in the direction that wastes an operator's
 * time or sends them somewhere useless:
 *
 *   · `storage` was fatal and required S3_BUCKET or APP_URL. APP_URL is not storage at all, and
 *     `getStorageBackend()` falls through to local disk, so storage can never actually be absent.
 *   · `narration` required ELEVENLABS_API_KEY alone, though the pipeline reads three TTS
 *     providers — a deployment with a Google TTS key was told it could not render.
 *   · `queue` reported Redis as missing on every deployment, though the default queue polls the
 *     database and never opens Redis at all.
 *   · the database probe was called `postgres`, while `getDb()` opens MySQL and returns null for
 *     any other scheme — the label sent an operator to provision the one engine that cannot work.
 *
 * The five rules below are R206's, and each one is the rule that would have caught one of those
 * before it was written down.
 */
import { describe, expect, it } from "vitest";
import * as fs from "fs";

import {
  CAPABILITIES,
  checkCapability,
  preflightJson,
  productionPreflight,
  type HostProbes,
} from "./productionPreflight";
import { getStorageBackend, isS3StorageEnabled } from "./storageBackend";

const ALL_GOOD: HostProbes = {
  hasBinary: () => true,
  hasBrowser: () => true,
  canReachDatabase: async () => true,
  canReachRedis: async () => true,
};

/** Production sources, so "has a real consumer" is asked of the shipping code and not of a test. */
const PROD_SRC = (() => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) files.push(p);
    }
  };
  walk("server");
  walk("shared");
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
})();

/** Every variable the matrix names, in either group. */
function everyNamedVariable(): string[] {
  const out = new Set<string>();
  for (const c of CAPABILITIES) {
    for (const n of c.requires) out.add(n);
    for (const n of c.requiresAny ?? []) out.add(n);
  }
  return [...out];
}

/* ═══════════════════════ rule 2 — every required variable has a real consumer ═══════════════ */

describe("R206 — nothing in the matrix is required by this file alone", () => {
  /**
   * The dead-variable rule. A preflight that demands a variable no production code reads is
   * telling an operator to go and find a credential that will never be used — and R201 found
   * exactly this shape elsewhere in the environment (AWS_ACCESS_KEY_ID is set on the deployment
   * and read by nothing; the storage layer reads S3_ACCESS_KEY_ID).
   *
   * "Read by production code" means read somewhere OTHER than the preflight itself, which is why
   * the preflight's own two files are excluded from the haystack.
   */
  const HAYSTACK = PROD_SRC.split("\n")
    .filter((l) => !l.includes("productionPreflight"))
    .join("\n");

  for (const name of everyNamedVariable()) {
    it(`${name} is read by production code, not only by the preflight`, () => {
      const read =
        HAYSTACK.includes(`process.env.${name}`) || HAYSTACK.includes(`env.${name}`);
      expect(read, `${name} is required by the preflight and read by nothing`).toBe(true);
    });
  }
});

/* ═══════════════════════ rule 1 — every capability is complete ═══════════════════════ */

describe("R206 — every capability entry says enough to act on", () => {
  it("each has an id, a description, and some way to be satisfied", () => {
    for (const c of CAPABILITIES) {
      expect(c.id, "a capability with no id").toBeTruthy();
      expect(c.describes.length, `${c.id} has no description`).toBeGreaterThan(10);
      /** Either variables decide it, or production code does. Never neither. */
      const decidable =
        c.requires.length > 0 || (c.requiresAny?.length ?? 0) > 0 || Boolean(c.satisfiedBy);
      expect(decidable, `${c.id} can never be satisfied or unsatisfied`).toBe(true);
    }
  });

  it("ids are unique, so two entries cannot describe the same thing differently", () => {
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* ═══════════ rule 5 — the preflight and the production code share one definition ═══════════ */

describe("R206 — storage is decided by the production function, not by a restatement", () => {
  /**
   * The rule that makes drift impossible rather than merely unlikely. `getStorageBackend` is what
   * the render calls; the preflight's `storage` capability calls the same function, so there is no
   * second opinion that can be right on one side and wrong on the other.
   */
  const storage = CAPABILITIES.find((c) => c.id === "storage")!;

  it("asks getStorageBackend rather than listing variables", () => {
    expect(storage.satisfiedBy, "storage went back to guessing from variable names").toBeTruthy();
    expect(storage.requires).toEqual([]);
    expect(storage.requiresAny ?? []).toEqual([]);
  });

  it("agrees with the production function in every configuration", () => {
    const cases: NodeJS.ProcessEnv[] = [
      {},
      { S3_BUCKET: "b" },
      { S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k" },
      { S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" },
      { BUILT_IN_FORGE_API_URL: "u", BUILT_IN_FORGE_API_KEY: "k" },
    ];
    for (const env of cases) {
      const status = checkCapability(storage, env);
      const backend = getStorageBackend(env);
      expect(status.detail, JSON.stringify(Object.keys(env))).toContain(
        backend === "s3" ? "S3" : backend === "forge" ? "Forge" : "local disk"
      );
    }
  });

  /**
   * The specific wrong answer the old entry gave: a bucket with no keys is NOT S3. It reported
   * storage as satisfied while the render would write to local disk — the two disagreeing about
   * the same deployment, which is the whole failure mode rule 5 exists to remove.
   */
  it("a bucket with no keys is not S3 storage, on either side", () => {
    const env = { S3_BUCKET: "b" };
    expect(isS3StorageEnabled(env)).toBe(false);
    expect(checkCapability(storage, env).detail).toContain("local disk");
  });

  /** And APP_URL, which is a canonical public URL, buys no storage whatsoever. */
  it("APP_URL is not a storage mechanism", () => {
    expect(checkCapability(storage, { APP_URL: "https://example.invalid" }).detail)
      .toContain("local disk");
  });
});

/* ═══════════ rule 4 — an optional provider going missing does not block the render ═══════════ */

describe("R206 — a missing optional provider never blocks a render", () => {
  /**
   * Run once per optional capability: drop everything that capability needs, leave the rest
   * configured, and require the verdict to stay out of BLOCKED. One entry marked fatal by mistake
   * is exactly how a deployment that could have rendered gets told it cannot.
   */
  const base = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {};
    for (const n of everyNamedVariable()) env[n] = "set";
    env.DATABASE_URL = "mysql://localhost:3306/fastvid";
    return env;
  };

  for (const cap of CAPABILITIES.filter((c) => !c.fatal)) {
    it(`without ${cap.id} the render is degraded, not blocked`, async () => {
      const env = base();
      for (const n of [...cap.requires, ...(cap.requiresAny ?? [])]) delete env[n];
      const report = await productionPreflight(ALL_GOOD, env);
      expect(report.blockers, `${cap.id} blocked the render`).toEqual([]);

      /**
       * The verdict claim applies only where the capability actually went away.
       *
       * `storage` cannot: `getStorageBackend()` always returns a backend, so removing its
       * variables moves it from S3 to local disk rather than making it unavailable. Asserting
       * DEGRADED for it would be asserting a state the architecture does not have — and the loop
       * is more useful with that stated than with the one entry quietly excluded.
       */
      const status = report.capabilities.find((c) => c.id === cap.id)!;
      if (status.available) {
        expect(status.state, `${cap.id} is satisfied with nothing set`).toBe("available");
        return;
      }
      expect(status.state).toBe("degraded");
      expect(report.verdict).toBe("PRODUCTION_RENDER_DEGRADED");
    });
  }

  /** And the degradation is REPORTED — degrading silently is the other half of the failure. */
  it("names what will be missing rather than dropping it", async () => {
    const env = base();
    delete env.FREESOUND_API_KEY;
    const report = await productionPreflight(ALL_GOOD, env);
    expect(report.degradations.join("\n")).toContain("ambience");
  });
});

/* ═══════════════════════ rule 3 — no dead variable is required ═══════════════════════ */

describe("R206 — the fatal set is the smallest one that is actually fatal", () => {
  /**
   * The headline the whole audit exists to produce: what must an operator set before FastVid can
   * render at all. Pinned as a list so that adding a fatal capability is a deliberate act with a
   * failing test attached, rather than a line quietly added to an array.
   */
  it("three capabilities are unconditionally required, and no more", () => {
    const unconditional = CAPABILITIES.filter((c) => c.fatal && !c.requiredWhen).map((c) => c.id);
    expect(unconditional.sort()).toEqual(["database", "narration", "script"]);
  });

  /** `queue` is fatal only when somebody opted into BullMQ, which is what makes Redis optional. */
  it("the queue is fatal only when the BullMQ backend is switched on", () => {
    const queue = CAPABILITIES.find((c) => c.id === "queue")!;
    expect(queue.fatal).toBe(true);
    expect(checkCapability(queue, {}).state).toBe("not_required");
    expect(checkCapability(queue, { QUEUE_BACKEND: "bullmq" }).state).toBe("blocked");
    expect(checkCapability(queue, { QUEUE_BACKEND: "bullmq", REDIS_URL: "redis://h:6379" }).state)
      .toBe("available");
  });
});

/* ═══════════════════════ the database scheme, which was the silent one ═══════════════════════ */

describe("R206 — a database URL of the wrong kind is caught before the render, not during", () => {
  const database = CAPABILITIES.find((c) => c.id === "database")!;

  /**
   * The failure this prevents is the quietest one in the inventory. `getDb()` refuses any URL that
   * is not mysql:// and returns null with a console warning; every caller then degrades to "no
   * database". So a Postgres URL boots the app, passes every presence check, and loses every write.
   */
  it("a postgres URL is refused, with a reason naming MySQL", () => {
    const status = checkCapability(database, { DATABASE_URL: "postgresql://h:5432/fastvid" });
    expect(status.available).toBe(false);
    expect(status.state).toBe("blocked");
    expect(status.detail).toContain("MySQL");
  });

  it("a mysql URL is accepted", () => {
    expect(checkCapability(database, { DATABASE_URL: "mysql://h:3306/fastvid" }).available).toBe(true);
    expect(checkCapability(database, { DATABASE_URL: "mysql2://h:3306/fastvid" }).available).toBe(true);
  });

  it("an unset URL says unset rather than wrong-scheme", () => {
    expect(checkCapability(database, {}).detail).toContain("missing");
  });
});

/* ═══════════════════════ the matrix is machine-readable, and still leaks nothing ═══════════ */

describe("R206 — the matrix can be read by a script", () => {
  it("serialises every capability with its state and its requirement", async () => {
    const report = await productionPreflight(ALL_GOOD, { DATABASE_URL: "mysql://h:3306/d" });
    const parsed = JSON.parse(preflightJson(report)) as {
      capabilities: Array<{ id: string; state: string; required: boolean }>;
      verdict: string;
    };
    expect(parsed.capabilities).toHaveLength(CAPABILITIES.length);
    for (const c of parsed.capabilities) {
      expect(["available", "degraded", "blocked", "not_required"]).toContain(c.state);
      expect(typeof c.required).toBe("boolean");
    }
    expect(parsed.verdict).toBeTruthy();
  });

  /**
   * R191's rule, carried into the JSON: a machine-readable report is the MOST likely thing to be
   * posted into an issue or a dashboard, so it must be as value-free as the text one.
   */
  it("never carries a value, only a name", async () => {
    const secret = "sk-not-a-real-key-0000";
    const env: NodeJS.ProcessEnv = { DATABASE_URL: "mysql://h:3306/d" };
    for (const n of everyNamedVariable()) env[n] = secret;
    const json = preflightJson(await productionPreflight(ALL_GOOD, env));
    expect(json).not.toContain(secret);
    expect(json).not.toContain(secret.slice(0, 8));
  });
});
