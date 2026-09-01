/**
 * RONDE 203/204 — the provider matrix, and the failure modes it exists to catch.
 *
 * ── What this file can and cannot settle ─────────────────────────────────────────────────────
 *
 * It cannot prove a provider ANSWERS: that needs credentials this environment does not have, and
 * the matrix in the report records those columns as UNPROVEN rather than guessing.
 *
 * What it CAN settle is the half between "a provider answered" and "a clip is on the timeline",
 * because that half is ours. R203 names the specific ways it goes wrong; each one below is either
 * a test here or a pointer to the file that already owns it:
 *
 *   · a watch page downloaded as if it were a video      — R179 owns it (six tests on the branch
 *                                                          order and the fair-use marker)
 *   · the same video twice, or two videos collapsed      — R175 owns it (through the real pool)
 *   · a candidate with no providerAssetId                — here: a pool-wide invariant
 *   · a provider name that changes on the way through    — here: every pool source must be
 *                                                          CLASSIFIED, not silently defaulted
 *   · HTML served with HTTP 200 and treated as media     — here: fixed this round, proven against
 *                                                          a real HTTP server
 *
 * Nothing below restates a fact one of those files already pins. A duplicate assertion is not extra
 * proof; it is a second place to update when the contract changes, and the two drift.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { buildSceneCandidatePool } from "./scenePool";
import { downloadAndTrimPoolCandidate } from "./videoPipeline";
import { engineSourceFor } from "./cinematicPipelineInputs";
import { docGradeSourceKindForProvider } from "./documentaryStyle";

const SRC = fs.readFileSync("server/videoPipeline.ts", "utf8");
const POOL_SRC = fs.readFileSync("server/scenePool.ts", "utf8");

/** The body of the pool download, so a "before/after" claim is made about that function only. */
const DOWNLOAD_BODY = SRC.slice(
  SRC.indexOf("export async function downloadAndTrimPoolCandidate("),
  SRC.indexOf("\nasync function trimDownloadedStockClip(")
);

/**
 * The sources the POOL can produce, read from the code rather than restated — so a provider added
 * or removed changes this list rather than silently disagreeing with it.
 */
function poolSources(): string[] {
  return [...new Set([...POOL_SRC.matchAll(/source:\s*"([a-z_]+)"/g)].map((m) => m[1]!))].sort();
}

/* ═══════════════════════ the matrix, as a structural fact ═══════════════════════ */

describe("R203 — the pool's providers, and what happens to their names downstream", () => {
  it("the pool builds the ten sources the matrix reports", () => {
    expect(poolSources()).toEqual([
      "europeana", "internet_archive", "loc", "nara", "nasa",
      "openverse", "pexels", "pixabay", "wikimedia", "youtube_cc",
    ]);
  });

  /**
   * "Een providernaam die onderweg verandert."
   *
   * `docGradeSourceKindForProvider` is where a provider name becomes an editorial decision: the
   * colour grade pulls saturation differently for archival, stock and generated material, and the
   * shot planner branches on whether a clip is archival at all. A provider it does not recognise
   * returns "unknown" — and that is the honest answer, so this is not a complaint about the
   * classifier. It is a complaint about the POOL: adding an eleventh provider without teaching the
   * classifier about it means real archival footage arriving unclassified, and being treated as
   * neither archival nor stock by two subsystems that both have to decide something.
   *
   * The failure is invisible in the picture — a slightly wrong grade — which is exactly why it
   * needs a test rather than an eye.
   */
  it("every pool source is classified, so none is graded on a default", () => {
    for (const s of poolSources()) {
      expect(docGradeSourceKindForProvider(s), `${s} is not classified`).not.toBe("unknown");
    }
  });

  /**
   * And the classification has to SURVIVE into the engine's own vocabulary, which is a closed union
   * of eight tokens. `engineSourceFor` never fails — its default is "pexels" — so the risk is not
   * an error but a silent demotion: an archival source arriving at the shot planner as stock.
   */
  it("the archival sources stay archival in the engine's vocabulary", () => {
    const archival = poolSources().filter((s) => docGradeSourceKindForProvider(s) === "archive");
    expect(archival.length, "no archival sources found — the classifier changed").toBeGreaterThan(0);
    for (const s of archival) {
      expect(docGradeSourceKindForProvider(engineSourceFor(s)), s).toBe("archive");
    }
  });

  /** YouTube keeps its own token rather than being folded into a neighbour, because the fair-use
   *  treatment and the licence provenance both key off knowing it is YouTube. */
  it("youtube_cc is still youtube_cc after translation", () => {
    expect(engineSourceFor("youtube_cc")).toBe("youtube_cc");
  });

  /**
   * The identity rule. A candidate whose assetId is missing cannot be fetched again tomorrow, which
   * is what rehydration needs — and `downloadAndTrimPoolCandidate` reads `candidate.assetId`
   * unguarded on its first line, so an empty one produces a file named after nothing.
   */
  it("a candidate with no asset id never enters the pool", async () => {
    const pool = await buildSceneCandidatePool({
      sceneIndex: 0,
      sceneText: "A test scene.",
      primaryQuery: "test",
      skipPexels: true, skipPixabay: true, skipInternetArchive: true, skipEuropeana: true,
      skipOpenverse: true, skipNasa: true, skipNara: true, skipLoc: true,
      /** One row the provider gave no id for, and one it did. Only the second may survive. */
      youtubeSearch: async () => [
        { item: { id: {} }, title: "no id", desc: "", rel: 0.9 },
        { item: { id: { videoId: "hasid" } }, title: "has id", desc: "", rel: 0.9 },
      ],
    } as never);
    expect(pool.candidates.filter((c) => !c.assetId)).toEqual([]);
    expect(pool.candidates.some((c) => c.assetId === "hasid")).toBe(true);
  }, 30_000);
});

/* ═══════════════════════ HTML is not video — proven with a real server ═══════════════════════ */

describe("R203 — a provider that answers a media URL with a web page is refused, by reason", () => {
  let server: http.Server;
  let base = "";
  let dir = "";

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r203-"));
    server = http.createServer((req, res) => {
      /**
       * The realistic shape: a provider whose asset has expired answers 200 with a courtesy page.
       * Deliberately LARGER than the byte floor — a small page was already rejected, but for the
       * wrong reason, and the wrong reason is the defect.
       */
      if (req.url?.startsWith("/gone")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>${"<p>no longer available</p>".repeat(4000)}</body></html>`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * ── What this test had to be corrected to prove ─────────────────────────────────────────────
   *
   * It first asserted only that the download returned null, and it PASSED with the fix reverted —
   * so it was proving nothing about the fix. The reason is worth writing down, because it changes
   * what the fix is for: without the guard the page is written to disk as an .mp4 and handed to
   * ffmpeg, which refuses it, and the download returns null anyway. The candidate was never
   * "accepted as a video".
   *
   * The defect is therefore not a corrupt clip on the timeline — it is a REFUSAL THAT LIES. The
   * page is fetched in full, written, decoded and rejected as an encoding failure, which sends an
   * operator to a provider's encoding settings for what is an expired asset.
   *
   * So the assertion is the observable refusal, captured from the running download: it must name
   * the provider and the reason. That is what disappears when the guard does.
   */
  it("refuses the page by naming it a page, not an encoding failure", async () => {
    const candidate = {
      id: "pexels:gone", source: "pexels", assetId: "gone",
      remoteUrl: `${base}/gone`, title: "expired", description: null, tags: [],
      mediaType: "video", durationSec: 8, license: null, width: 1920, height: 1080,
      sourceCreator: null, licenseUrl: null, thumbnailUrl: null,
      clipSimilarity: null, embeddingSimilarity: null, rankingScore: null,
      visionScore: null, selectionScore: null,
    };
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let out: string | null;
    try {
      out = await downloadAndTrimPoolCandidate(candidate as never, dir, 0, 0, 4);
    } finally {
      console.warn = realWarn;
    }

    expect(out, "an HTML page produced a usable clip").toBeNull();
    const refusal = warnings.find((w) => w.includes("reason=html_not_media"));
    expect(refusal, `no html_not_media refusal was logged; got: ${warnings.join(" | ")}`)
      .toBeTruthy();
    /** Named, so the log answers "which provider sent this" without a second lookup. */
    expect(refusal).toContain("source=pexels");
    expect(refusal).toContain("assetId=gone");
    /** And nothing was left behind for a later step to pick up as if it were media. */
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"))).toEqual([]);
  }, 120_000);

  /** Checked BEFORE the body is streamed, so no partial file is written at all. */
  it("the check happens before a single byte is written", () => {
    expect(DOWNLOAD_BODY.indexOf("html_not_media"))
      .toBeLessThan(DOWNLOAD_BODY.indexOf("pipeline(resp.body"));
  });
});

/* ═══════════════════════ R204 — the YouTube chain, structurally ═══════════════════════ */

describe("R204 — YouTube is reachable only through a credential this environment does not have", () => {
  /**
   * No credential means no search FUNCTION at all — not a search that quietly returns nothing.
   * The distinction is the one R175 built the `skipped.youtube_cc` bookkeeping for: a pool that was
   * never handed a search says so, and a pool whose search found nothing says something else.
   *
   * This is the honest floor of R204 in this environment. Whether YouTube ANSWERS is UNPROVEN, and
   * the report says UNPROVEN rather than inferring it from a green test.
   */
  it("without a key the pool is handed no YouTube search", () => {
    const body = SRC.slice(SRC.indexOf("function scenePoolYoutubeSearch("));
    expect(body.slice(0, 800)).toContain("YOUTUBE_API_KEY");
    expect(body.slice(0, 800)).toContain("return undefined");
  });
});
