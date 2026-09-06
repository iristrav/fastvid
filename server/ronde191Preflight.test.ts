/**
 * RONDE 191 — the preflight, and the one property it must never lose.
 *
 * ── Why a leak test comes first ──────────────────────────────────────────────────────────────
 *
 * A preflight report is the single most likely diagnostic to be pasted into an issue, a chat
 * window or a CI log. It is the one place in this codebase where a credential and a human audience
 * meet, and a masked key is still a key written down where it should not be.
 *
 * So the first group below sets every variable to a value that would be unmistakable if it escaped,
 * and asserts that no part of the report contains it — not the JSON, not the formatted text, not a
 * truncation of it. Everything else in the file is about whether the verdict is useful; this is
 * about whether the tool is safe to run at all.
 */
import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  ROUTE_FLAGS,
  checkCapability,
  envPresence,
  formatPreflight,
  productionPreflight,
  type HostProbes,
} from "./productionPreflight";

/* ═══════════════════════ fixtures ═══════════════════════ */

const ALL_GOOD: HostProbes = {
  hasBinary: () => true,
  hasBrowser: () => true,
  canReachDatabase: async () => true,
  canReachRedis: async () => true,
  /** RONDE 95 FINAL — the picture editor loads on a healthy host; see the block of tests below. */
  canLoadVisionModel: async () => true,
};

/** Every variable any capability names, so a "fully configured" environment can be built. */
function everyVariable(): string[] {
  const out = new Set<string>();
  for (const c of CAPABILITIES) {
    for (const n of c.requires) out.add(n);
    for (const n of c.requiresAny ?? []) out.add(n);
  }
  return [...out];
}

function fullyConfigured(value: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const n of everyVariable()) env[n] = value;
  /**
   * RONDE 205 — DATABASE_URL has to be a real MySQL URL, because the capability now checks the
   * SCHEME and not merely the presence. `getDb()` opens a mysql2 pool and returns null for
   * anything else, so "configured with a non-MySQL URL" is a state the preflight has to catch —
   * see the scheme test below. This fixture is the CONFIGURED-CORRECTLY environment, so it
   * carries a URL the production code would actually accept. No host or credentials in it: the
   * probes are injected, so nothing here is ever dialled.
   */
  env.DATABASE_URL = "mysql://localhost:3306/fastvid";
  /**
   * A fully configured host also KEEPS the CLIP model between deploys — see `clipModelCache`, and
   * the worker log of 2026-09-05 where it did not. Written as a literal rather than `value`
   * because this one is printed: it is a directory an operator has to act on, not a credential,
   * and the leak test above must stay able to prove that nothing carrying `value` reaches the
   * output.
   */
  env.RAILWAY_VOLUME_MOUNT_PATH = "/data";
  for (const f of ROUTE_FLAGS) env[f] = "true";
  return env;
}

/* ═══════════════════════ the leak test ═══════════════════════ */

describe("R191 — the report cannot contain a credential", () => {
  /** Distinctive enough that a substring of it escaping would still be found. */
  const SECRET = "SUPERSECRET-abcdefghijklmnop-0123456789";

  it("never prints a value it was given", async () => {
    const report = await productionPreflight(ALL_GOOD, fullyConfigured(SECRET));
    const text = formatPreflight(report);
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  /** Not even a masked or truncated one — a prefix is still a leak. */
  it("does not print a truncation of a value either", async () => {
    const report = await productionPreflight(ALL_GOOD, fullyConfigured(SECRET));
    const everything = formatPreflight(report) + JSON.stringify(report);
    for (const n of [4, 6, 8, 12]) {
      expect(everything, `${n} characters of the value escaped`).not.toContain(SECRET.slice(0, n));
    }
  });

  /**
   * The report is built from NAMES, so the same environment with different values must produce a
   * byte-identical report. If it does not, something in it is derived from a value.
   */
  it("is identical whatever the values are", async () => {
    const a = formatPreflight(await productionPreflight(ALL_GOOD, fullyConfigured("aaaa")));
    const b = formatPreflight(await productionPreflight(ALL_GOOD, fullyConfigured("zzzz-different")));
    expect(a).toBe(b);
  });

  it("reports presence as a boolean, never as the value", () => {
    expect(envPresence("X", { X: SECRET })).toBe(true);
    expect(envPresence("X", { X: "   " })).toBe(false);
    expect(envPresence("X", {})).toBe(false);
  });
});

/* ═══════════════════════ the verdict is useful ═══════════════════════ */

describe("R191 — the verdict says what is blocked and why", () => {
  it("a fully configured, healthy host can attempt a render", async () => {
    const report = await productionPreflight(ALL_GOOD, fullyConfigured("value"));
    expect(report.verdict, report.blockers.join("\n")).toBe("PRODUCTION_RENDER_POSSIBLE");
    expect(report.blockers).toEqual([]);
  });

  /**
   * RONDE 205 — "fatal" is now conditional, and the test says so rather than assuming otherwise.
   *
   * A capability can be fatal AND not apply: `queue` blocks the boot when QUEUE_BACKEND=bullmq is
   * set without a REDIS_URL, and is irrelevant on every other deployment. So the rule is not
   * "every fatal capability is a blocker" — it is "every fatal capability that this configuration
   * actually requires is a blocker", which is a sharper statement and the one that is true.
   */
  it("an empty environment is blocked, and names every fatal capability it requires", async () => {
    const report = await productionPreflight(ALL_GOOD, {});
    expect(report.verdict).toBe("PRODUCTION_RENDER_BLOCKED");
    for (const cap of CAPABILITIES.filter((c) => c.fatal)) {
      const status = report.capabilities.find((c) => c.id === cap.id)!;
      if (status.state === "not_required") continue;
      expect(report.blockers.join("\n"), `${cap.id} is fatal, required and unmentioned`).toContain(cap.id);
    }
    /** And the conditional one really is reported as not applying, rather than silently dropped. */
    expect(report.capabilities.find((c) => c.id === "queue")!.state).toBe("not_required");
  });

  /**
   * The distinction the prose reports could not make. An operator does not act on "NARA_API_KEY is
   * unset"; they act on "the archival sources are down to the four that need no key", and that is a
   * DEGRADED render rather than a blocked one.
   */
  it("a missing optional provider degrades the render rather than blocking it", async () => {
    const env = fullyConfigured("value");
    delete env.EUROPEANA_API_KEY;
    delete env.NARA_API_KEY;
    const report = await productionPreflight(ALL_GOOD, env);
    /**
     * RONDE 205 — DEGRADED, which is a third verdict rather than a nicer word for BLOCKED.
     * The render runs; it runs with four archival sources instead of six.
     */
    expect(report.verdict).toBe("PRODUCTION_RENDER_DEGRADED");
    const archival = report.capabilities.find((c) => c.id === "archival_sources")!;
    expect(archival.available).toBe(false);
    expect(archival.state).toBe("degraded");
    expect(archival.fatal).toBe(false);
    expect(report.blockers, "a degradation was counted as a blocker").toEqual([]);
  });

  it("either of an any-of pair is enough", async () => {
    const env = fullyConfigured("value");
    delete env.OPENAI_API_KEY;
    expect((await productionPreflight(ALL_GOOD, env)).blockers).toEqual([]);
    delete env.GEMINI_API_KEY;
    expect((await productionPreflight(ALL_GOOD, env)).verdict).toBe("PRODUCTION_RENDER_BLOCKED");
  });

  /**
   * The YouTube pair, which is the one an operator gets wrong. A key that finds candidates with no
   * way to fetch them produces a render where YouTube is ranked and never used — the exact shape
   * R179 found in the code, now visible before the render rather than after it.
   */
  it("separates finding a YouTube clip from being able to fetch one", async () => {
    const env = fullyConfigured("value");
    delete env.YOUTUBE_CC_DL_SERVICE;
    delete env.RAPIDAPI_KEY;
    const report = await productionPreflight(ALL_GOOD, env);
    expect(report.capabilities.find((c) => c.id === "youtube_search")!.available).toBe(true);
    expect(report.capabilities.find((c) => c.id === "youtube_download")!.available).toBe(false);
  });
});

/* ═══════════════════════ configured is not the same as reachable ═══════════════════════ */

describe("R191 — a service that is configured but down is not ready", () => {
  /**
   * The failure mode a variable check cannot see. A DATABASE_URL pointing at nothing looks exactly
   * like readiness until a render fails halfway through, so the probe CONNECTS.
   */
  it("a configured but unreachable database blocks the render", async () => {
    const report = await productionPreflight(
      { ...ALL_GOOD, canReachDatabase: async () => false },
      fullyConfigured("value")
    );
    expect(report.verdict).toBe("PRODUCTION_RENDER_BLOCKED");
    expect(report.blockers.join(" ")).toContain("UNREACHABLE");
  });

  it("says NOT CONFIGURED and UNREACHABLE differently, because the fix differs", async () => {
    const unset = await productionPreflight(ALL_GOOD, {});
    expect(unset.host.find((h) => h.id === "mysql")!.detail).toContain("not configured");

    const down = await productionPreflight(
      { ...ALL_GOOD, canReachDatabase: async () => false },
      fullyConfigured("value")
    );
    expect(down.host.find((h) => h.id === "mysql")!.detail).toContain("UNREACHABLE");
  });

  it("no ffmpeg means no render at all", async () => {
    const report = await productionPreflight(
      { ...ALL_GOOD, hasBinary: (n) => n !== "ffmpeg" },
      fullyConfigured("value")
    );
    expect(report.verdict).toBe("PRODUCTION_RENDER_BLOCKED");
  });

  /** A missing browser costs the graphics, not the video — degraded, not blocked. */
  it("no browser degrades the render rather than blocking it", async () => {
    const report = await productionPreflight(
      { ...ALL_GOOD, hasBrowser: () => false },
      fullyConfigured("value")
    );
    /** DEGRADED, not POSSIBLE: the render runs, and the graphics are not drawn. */
    expect(report.verdict).toBe("PRODUCTION_RENDER_DEGRADED");
    expect(report.blockers, "a missing browser was treated as a blocker").toEqual([]);
    const browser = report.host.find((h) => h.id === "chrome_headless_shell")!;
    expect(browser.available).toBe(false);
    expect(browser.detail).toContain("libass");
  });
});

/* ═══════════════════════ the route it would actually take ═══════════════════════ */

describe("R191 — the flags are reported, not required", () => {
  it("shows each route flag as it is set right now", async () => {
    const report = await productionPreflight(ALL_GOOD, { ...fullyConfigured("v"), AI_DIRECTOR: "false" });
    expect(report.routes.find((r) => r.flag === "AI_DIRECTOR")!.on).toBe(false);
    expect(report.routes.find((r) => r.flag === "CINEMATIC_EDITING_ENGINE")!.on).toBe(true);
  });

  /**
   * Flags off is a valid deployment — the legacy route — so it must not be a blocker. What it must
   * not be is a surprise, which is why they appear in the same report as everything else.
   */
  it("all flags off is not a blocker", async () => {
    const env = fullyConfigured("value");
    for (const f of ROUTE_FLAGS) delete env[f];
    const report = await productionPreflight(ALL_GOOD, env);
    expect(report.verdict).toBe("PRODUCTION_RENDER_POSSIBLE");
    expect(report.routes.every((r) => !r.on)).toBe(true);
  });
});


/* ═══════════════ RONDE 95 FINAL — the dependency RONDE 94 made critical ═══════════════ */

describe("RONDE 95 — a host that cannot load the picture editor is reported before the render", () => {
  /**
   * WHY THIS IS A PREFLIGHT ITEM AND NOT A RUNTIME ONE.
   *
   * `beatClipPassesVisionGate` fails open when the local CLIP model will not load — deliberately,
   * and that predates this round. So a render on such a host does not crash. Every picture reads
   * as `unknown`, `visionPipelineIsUnavailable()` becomes true, RONDE 94's adoption guard suspends
   * the vision requirement render-wide, no beat acquires a verified visual, and RONDE 89's export
   * gate then refuses the finished film.
   *
   * Hours of retrieval, download, transcode and compose, thrown away at the last gate — and
   * invisible from the environment, because the model has no key and no URL. It either loads on
   * this machine or it does not, which is why the probe LOADS it rather than reading a variable.
   */
  const noVision: HostProbes = { ...ALL_GOOD, canLoadVisionModel: async () => false };

  it("reports the picture editor for every deployment", async () => {
    const report = await productionPreflight(ALL_GOOD, fullyConfigured("v"));
    const clip = report.host.find((h) => h.id === "clip_vision");
    expect(clip, "the preflight does not probe the picture editor at all").toBeTruthy();
    expect(clip!.available).toBe(true);
  });

  /** With the gate enforced — the default since RONDE 94 — the render cannot succeed. */
  it("blocks the render when adoption is enforced", async () => {
    const env = { ...fullyConfigured("v") };
    delete env.ENFORCE_FUNNEL_ADOPTION;
    const report = await productionPreflight(noVision, env);
    expect(report.verdict).toBe("PRODUCTION_RENDER_BLOCKED");
    expect(report.blockers.join(" ")).toContain("clip_vision");
    expect(report.blockers.join(" ")).toContain("refused at export");
  });

  it("blocks it just as firmly when the flag is set to true", async () => {
    const report = await productionPreflight(noVision, {
      ...fullyConfigured("v"),
      ENFORCE_FUNNEL_ADOPTION: "true",
    });
    expect(report.verdict).toBe("PRODUCTION_RENDER_BLOCKED");
  });

  /**
   * With enforcement explicitly off the same render completes and ships unverified footage — a
   * worse film, not an impossible one. The verdict follows the configuration rather than guessing.
   */
  it("degrades rather than blocks when enforcement is explicitly disabled", async () => {
    const report = await productionPreflight(noVision, {
      ...fullyConfigured("v"),
      ENFORCE_FUNNEL_ADOPTION: "false",
    });
    expect(report.verdict).toBe("PRODUCTION_RENDER_DEGRADED");
    expect(report.blockers.join(" ")).not.toContain("clip_vision");
    expect(report.degradations.join(" ")).toContain("clip_vision");
    expect(report.degradations.join(" ")).toContain("unverified footage");
  });

  /** The report must say what it means for the film, not merely name a component. */
  it("says what a missing picture editor costs", async () => {
    const report = await productionPreflight(noVision, fullyConfigured("v"));
    const clip = report.host.find((h) => h.id === "clip_vision")!;
    expect(clip.detail).toContain("WILL NOT LOAD");
    expect(clip.detail).toContain("verified visual");
  });

  /** A healthy host is neither blocked nor degraded by this check. */
  it("a loading model is not a degradation", async () => {
    const report = await productionPreflight(ALL_GOOD, fullyConfigured("v"));
    expect(report.degradations.join(" ")).not.toContain("clip_vision");
    expect(report.blockers.join(" ")).not.toContain("clip_vision");
  });

  /** And it still cannot leak a credential — the R191 rule applies to the new line too. */
  it("prints no value", async () => {
    const report = await productionPreflight(noVision, fullyConfigured("s3cr3t-value"));
    expect(formatPreflight(report)).not.toContain("s3cr3t-value");
  });
});
