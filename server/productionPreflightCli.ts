/**
 * RONDE 191 — the preflight, wired to this machine.
 *
 *     npx tsx server/productionPreflightCli.ts
 *
 * Separate from `productionPreflight.ts` so the checks themselves stay pure and testable: this file
 * owns the probes that touch the host — a PATH lookup, a browser lookup, a real connection attempt —
 * and nothing else. A test can then exercise every branch of the report without a database.
 *
 * Exits 0 when a real render can be attempted and 1 when it cannot, so CI or a deploy script can
 * gate on it rather than reading the text.
 */
/**
 * RONDE 211 — the same configuration the app reads, loaded the same way.
 *
 * `server/_core/index.ts` and `server/worker.ts` both open with this import. Without it here, the
 * preflight read only the exported process environment, so a deployment keeping its configuration
 * in a `.env` file — which this repository documents, since it ships a `.env.example` — was told
 * PRODUCTION_RENDER_BLOCKED for an app that boots and renders perfectly well.
 *
 * A preflight that cries wolf is worse than none: an operator learns to distrust it, and then
 * ignores the one report that was right. dotenv never overwrites a variable that is already set,
 * so a platform-provided environment is completely unaffected by this.
 *
 * FIRST, deliberately: `dotenv/config` fills `process.env` as an import side effect, and ES module
 * imports evaluate in order — a module above it that read configuration at module scope would read
 * the environment before the file had been loaded.
 */
import "dotenv/config";

import { execFileSync } from "child_process";

import { formatPreflight, preflightJson, productionPreflight, type HostProbes } from "./productionPreflight";
import { graphicsOverlayAvailable } from "./graphicsOverlayDeps";

const probes: HostProbes = {
  hasBinary: (name) => {
    try {
      execFileSync("which", [name], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  hasBrowser: () => graphicsOverlayAvailable(),
  /**
   * A real query, not a URL parse. `SELECT 1` is the smallest thing that proves the credentials
   * work, the host is up and the database accepts connections — the three separate ways a
   * configured DATABASE_URL can still fail to be a database.
   */
  canReachDatabase: async () => {
    try {
      const { getDb } = await import("./db");
      const db = await getDb();
      /** `getDb` returns null when there is nothing to connect to — that IS the answer. */
      if (!db) return false;
      await db.execute("SELECT 1" as never);
      return true;
    } catch {
      return false;
    }
  },
  canReachRedis: async () => {
    try {
      const mod = (await import("ioredis")) as unknown as { default: new (url: string) => {
        ping: () => Promise<string>; quit: () => Promise<unknown>;
      } };
      const client = new mod.default(process.env.REDIS_URL!);
      await client.ping();
      await client.quit();
      return true;
    } catch {
      return false;
    }
  },
};

async function main(): Promise<void> {
  const report = await productionPreflight(probes);
  /** `--json` for a deploy script or a dashboard; the text form stays the default for a human. */
  console.log(process.argv.includes("--json") ? preflightJson(report) : formatPreflight(report));
  /**
   * RONDE 205 — DEGRADED exits 0.
   *
   * The exit code answers "can this environment attempt a real render", and a degraded one can:
   * it produces a real video with fewer retrieval sources, or no karaoke, or on ephemeral storage.
   * Failing the gate on that would stop a deployment that works, and an operator who cannot start
   * at all learns nothing from a signal that is always red.
   */
  process.exit(report.verdict === "PRODUCTION_RENDER_BLOCKED" ? 1 : 0);
}

void main();
