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
  formatFallback,
  formatGraphics,
  formatRoute,
  formatSelection,
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

/* ═══════════════════════ the lines ═══════════════════════ */

describe("R172 — a selection line answers 'why this clip'", () => {
  const line = formatSelection({
    renderId: "rabc",
    sceneIndex: 1, beatIndex: 4,
    query: "apple park aerial",
    provider: "youtube_cc", providerAssetId: "vid123",
    score: 0.8123, signals: ["clipSimilarity", "keywordScore"],
    runnerUpProvider: "wikimedia", runnerUpScore: 0.7891,
    duplicatePenalty: 0.12,
  });

  it("names the render, the beat, the asset and the score", () => {
    expect(line).toContain("render=rabc");
    expect(line).toContain("beat=s1b4");
    expect(line).toContain("provider=youtube_cc");
    expect(line).toContain("assetId=vid123");
    expect(line).toContain("score=0.8123");
  });

  /** "Why not something better" is answered by the margin over the next best, not by the whole pool. */
  it("names what it beat, and by how much", () => {
    expect(line).toContain("runnerUp=wikimedia");
    expect(line).toContain("margin=0.0232");
  });

  it("says when a duplicate penalty was part of the decision", () => {
    expect(line).toContain("dupPenalty=0.12");
  });

  it("omits what it does not know rather than printing a placeholder", () => {
    const bare = formatSelection({ renderId: "r1", sceneIndex: 0, beatIndex: 0, provider: "pexels" });
    expect(bare).not.toContain("score=");
    expect(bare).not.toContain("runnerUp=");
    expect(bare).not.toContain("undefined");
    expect(bare).not.toContain("null");
  });
});

describe("R172 — a source attempt line tells 'tried and found nothing' from 'never tried'", () => {
  it("records an attempt that found nothing", () => {
    const line = formatSourceAttempt({
      renderId: "r1", sceneIndex: 2, source: "youtube", mode: "creative_common",
      attempted: true, found: 0,
    });
    expect(line).toContain("attempted=true");
    expect(line).toContain("found=0");
  });

  it("records a source that was never tried, with the reason", () => {
    const line = formatSourceAttempt({
      renderId: "r1", sceneIndex: 2, source: "youtube",
      attempted: false, reason: "no YOUTUBE_API_KEY configured",
    });
    expect(line).toContain("attempted=false");
    expect(line).toContain("reason=");
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

describe("R172 RULE 9 — every fallback says why, from and to", () => {
  it("names all three", () => {
    const line = formatFallback({
      renderId: "r1", what: "graphics",
      from: "remotion", to: "libass",
      why: "no chrome-headless-shell on this host",
    });
    expect(line).toContain("what=graphics");
    expect(line).toContain("from=remotion");
    expect(line).toContain("to=libass");
    expect(line).toContain("why=");
  });

  it("a route line marks whether the configured path was actually taken", () => {
    const taken = formatRoute({ renderId: "r1", configured: "cinematic_timeline", actual: "cinematic_timeline" });
    expect(taken).toContain("fallback=false");

    const fell = formatRoute({
      renderId: "r1", configured: "cinematic_timeline", actual: "legacy_compose",
      reason: "render job could not be claimed",
    });
    expect(fell).toContain("fallback=true");
    expect(fell).toContain("reason=");
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

  it("is applied to every free-text value a formatter prints", () => {
    const lines = [
      formatSourceAttempt({
        renderId: "r1", sceneIndex: 0, source: "pexels", attempted: true,
        reason: `HTTP 403 from https://api.pexels.com/v1/videos?key=${"abcdef01".repeat(4)}`,
      }),
      formatFallback({
        renderId: "r1", what: "media", from: "youtube", to: "pexels",
        why: `download failed: https://rr3---sn-x.googlevideo.com/videoplayback?sig=${"deadbeef".repeat(4)}`,
      }),
      formatGraphics({
        renderId: "r1", planned: 1, rendered: 0, renderer: "libass",
        skipped: [`overlay failed at https://internal.host/render?token=${"0123abcd".repeat(4)}`],
      }),
      formatSelection({
        renderId: "r1", sceneIndex: 0, beatIndex: 0, provider: "pexels",
        query: `https://evil.example/leak?key=${"0123abcd".repeat(4)}`,
      }),
    ];
    for (const line of lines) {
      expect(line, line).not.toMatch(/https?:\/\/[^\s<]/);
      expect(line, line).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    }
  });

  it("bounds how much untrusted text can reach a log at all", () => {
    expect(scrubForLog("x".repeat(1000)).length).toBeLessThanOrEqual(160);
  });

  /** A provider name and an asset id are how you find the asset again, and neither is a secret. */
  it("still prints the two things needed to find an asset again", () => {
    const line = formatSelection({
      renderId: "r1", sceneIndex: 0, beatIndex: 0,
      provider: "wikimedia", providerAssetId: "File_Example.webm",
    });
    expect(line).toContain("provider=wikimedia");
    expect(line).toContain("assetId=File_Example.webm");
  });
});
