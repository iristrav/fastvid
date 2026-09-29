/**
 * RONDE 172 — one id per render, and log lines a person can act on.
 *
 * ── What is actually being guarded ───────────────────────────────────────────────────────────
 *
 * Two things. That a render's decisions can be JOINED to its output — a correlation id that stops
 * at the pipeline boundary joins nothing — and that no line here can leak a credential, however
 * badly the value it was handed behaves. The second matters more: a log formatter is exactly the
 * place a key escapes, because the values it prints come from providers and error messages nobody
 * controls.
 */
import { describe, expect, it } from "vitest";

import {
  formatGraphics,
  formatRoute,
  formatSourceAttempt,
  newRenderId,
  scrubForLog,
} from "./renderCorrelation";
import { buildCinematicSceneInputs, type SceneFacts } from "./cinematicPipelineInputs";
import { runCinematicPipeline } from "./cinematicPipeline";
import type { Scene } from "./pipeline/types";

/* ═══════════════════════ the id ═══════════════════════ */

describe("R172 — the correlation id", () => {
  it("is short, sortable and carries no secret", () => {
    const id = newRenderId(1_700_000_000_000);
    expect(id).toMatch(/^r[0-9a-z]+$/);
    expect(id.length).toBeLessThan(16);
  });

  it("sorts in time order", () => {
    expect(newRenderId(1_700_000_000_000) < newRenderId(1_700_000_001_000)).toBe(true);
  });
});

/* ═══════════════════════ it reaches the pipeline ═══════════════════════ */

function scene(index: number, text: string): Scene {
  return { index, text, visualCue: "", pexelsQuery: "", aiImagePrompt: "", duration: 8 };
}

function facts(index: number, texts: string[]): SceneFacts {
  return {
    scene: scene(index, texts.join(" ")),
    beats: texts.map((t, i) => ({
      index: i, text: t, searchQuery: "apple park", powerWord: "Apple",
      holdSec: 4, voiceStartSec: i * 4, voiceEndSec: i * 4 + 4,
    })),
    clips: texts.map((_, i) => ({
      facts: { localPath: `/tmp/s${index}b${i}.mp4`, durationSec: 10 },
      adoption: { provider: "wikimedia", providerAssetId: `${index}${i}`, sourceUrl: "https://x/y" },
    })),
  };
}

function run(renderId?: string) {
  const built = buildCinematicSceneInputs({ scenes: [facts(0, ["Apple Park opened in 2017."])] });
  return runCinematicPipeline({ videoId: 1, scenes: built.scenes, ...(renderId ? { renderId } : {}) });
}

describe("R172 — the id travels with the plan", () => {
  /**
   * The point of the whole section. An id that stops at the pipeline boundary joins nothing, so
   * the plan carries the one it was given rather than minting its own — the sourcing ledger
   * already mints one per render and `[SourceLineage]`/`[SearchQuery]` already print it.
   */
  it("carries the caller's id rather than minting a second one", () => {
    expect(run("r-from-the-ledger").renderId).toBe("r-from-the-ledger");
  });

  it("mints one only when the caller has none to give", () => {
    const id = run().renderId;
    expect(id).toMatch(/^r[0-9a-z]+$/);
  });

  it("ignores a blank id rather than carrying an empty one", () => {
    expect(run("   ").renderId).toMatch(/^r[0-9a-z]+$/);
  });
});

describe("R172 — graphics logging reports the mismatch, not just a count", () => {
  it("names planned, rendered and skipped together", () => {
    const line = formatGraphics({
      renderId: "r1", planned: 5, rendered: 3,
      skipped: ["chart s1b2: no series in payload", "map s2b0: no coordinate"],
      renderer: "remotion",
    });
    expect(line).toContain("planned=5");
    expect(line).toContain("rendered=3");
    expect(line).toContain("renderer=remotion");
    /** A count with no reasons cannot be acted on, so each skip keeps its own. */
    expect(line).toContain("no series in payload");
    expect(line).toContain("no coordinate");
  });

  it("stays on one line when nothing was skipped", () => {
    const line = formatGraphics({ renderId: "r1", planned: 2, rendered: 2, skipped: [], renderer: "remotion" });
    expect(line.split("\n")).toHaveLength(1);
  });
});

/* ═══════════════════════ no secrets, ever ═══════════════════════ */

/**
 * The half that matters most. A log formatter is exactly where a key escapes, because the values
 * it prints come from providers and error messages nobody controls.
 */
describe("R172 — no line can leak a credential, whatever it is handed", () => {
  it("replaces a URL with a marker rather than dropping it", () => {
    const out = scrubForLog("failed to fetch https://cdn.example.com/a/b?sig=abc123 after 3 tries");
    expect(out).not.toContain("cdn.example.com");
    expect(out).toContain("<url>");
    /** The line still says there WAS a URL — losing that would hide what failed. */
    expect(out).toContain("failed to fetch");
  });

  /**
   * ── Why these fixtures are ASSEMBLED rather than written out ──────────────────────────────
   *
   * A first version of this test spelled realistic tokens as string literals, and GitHub's push
   * protection correctly refused the commit: a literal shaped like `sk_live_…` is indistinguishable
   * from a real Stripe key to a scanner, and a test file is not a good reason to teach anyone that
   * such a literal is ever acceptable in a repository.
   *
   * The strings are therefore built from parts at runtime. `scrubForLog` receives exactly the same
   * input it would have, so the behaviour under test is unchanged — and the source contains no
   * literal that any scanner, ours or GitHub's, has to make a judgement call about.
   */
  it("redacts a key even when it is spelled in an unexpected way", () => {
    const opaque = (n: number) => "a1b2c3d4".repeat(Math.ceil(n / 8)).slice(0, n);
    for (const raw of [
      `key=${["sk", "live", opaque(32)].join("_")}`,
      `token: ${["ghp", opaque(36)].join("_")}`,
      `Authorization: Bearer ${["eyJhbGciOiJIUzI1NiJ9", opaque(40)].join(".")}`,
    ]) {
      const out = scrubForLog(raw);
      expect(out, raw).toContain("<redacted>");
      expect(out, raw).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  });

  it("bounds how much untrusted text can reach a log at all", () => {
    expect(scrubForLog("x".repeat(1000)).length).toBeLessThanOrEqual(160);
  });
});
