/**
 * RONDE 198 — four holes the previous round found, named honestly, and left open.
 *
 * R197 reported these and did not fix them. Each is the same defect class this project keeps
 * finding: a fact the render already has and never writes down, or two numbers compared that were
 * never comparable. Nothing here is a new feature and nothing here relaxes a gate.
 *
 *   1. THE RESCUE ROUTES TOOK A PICTURE NOBODY LOOKED AT, AND SAID NOTHING. Two last-resort routes
 *      accept a clip on file facts alone — it decodes, it is not black, it is not a fallback — and
 *      never put it to the picture editor. The beat then had a picture and no account of it, which
 *      in the funnel is indistinguishable from a beat that was judged and approved.
 *
 *   2. THE FILM'S PICTURE COULD END BEFORE ITS VOICE. `repairShortSceneVideo` has held the last
 *      frame across a short SCENE for many rounds. Nothing asked the same question of the
 *      assembled film — R195 wired the measurement in, and the render printed the fault and
 *      shipped it.
 *
 *   3. `selected` AND `eligible` WERE NEVER COMPARABLE. `markLineageEligible` is idempotent;
 *      `recordEvent(SELECTED)` is not. One asset offered to two beats produced `eligible=1
 *      selected=2` and a fault line on a render where nothing went wrong.
 *
 *   4. A CLIP DROPPED BY A SCENE REBUILD STAYED MARKED AS IN USE. Nothing anywhere deletes from
 *      `usedPaths`/`usedContentKeys`, so a fetched, verified asset that a rebuild did not take was
 *      unavailable to every later beat for the rest of the render.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkFileAvSync } from "./avSyncCheck";
import {
  beatFunnel,
  createBeatShortlistState,
  noteNotAsked,
  reasonsFor,
} from "./beatShortlist";
import { probeVideoStreamDurationSec, repairShortSceneVideo } from "./videoPipeline";
import { VisualSourceLedger, formatUsageInconsistencies } from "./visualSourceLineage";

const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

/* ═════════════ 1. the rescue routes are visible in the funnel ═════════════ */

describe("R198 §1 — a picture taken without a judgement says so", () => {
  it("the reason survives into the beat's own account", () => {
    const state = createBeatShortlistState();
    noteNotAsked(state, 2, 1, "ADOPTED_WITHOUT_JUDGEMENT");
    expect(reasonsFor(beatFunnel(state, 2, 1))).toEqual(["ADOPTED_WITHOUT_JUDGEMENT×1"]);
  });

  it("it is recorded on the NOT-ASKED side, so it can never read as an approval", () => {
    const state = createBeatShortlistState();
    noteNotAsked(state, 0, 0, "ADOPTED_WITHOUT_JUDGEMENT");
    const f = beatFunnel(state, 0, 0);
    expect(f.notAsked).toBe(1);
    // The three things that would let this beat claim a verified picture. None moved.
    expect(f.approved).toBe(0);
    expect(f.eligible).toBe(0);
    expect(f.visionAsked).toBe(0);
  });

  it("the fast stock route records it at the point it adopts", () => {
    const idx = PIPE.indexOf("fast Pexels \"${q}\"");
    expect(idx).toBeGreaterThan(0);
    const around = PIPE.slice(idx - 700, idx + 200);
    expect(around).toContain('noteNotAsked(dedup.beatShortlist, sceneIndex, beat.index, "ADOPTED_WITHOUT_JUDGEMENT")');
    // The adoption and the record of it are the same event, so they cannot come apart.
    expect(around.indexOf("dedup.usedPaths.add(p)")).toBeLessThan(around.indexOf("noteNotAsked("));
  });

  it("the forced-image route records it too", () => {
    const idx = PIPE.indexOf("const takeFirstValid = async (paths: string[])");
    expect(idx).toBeGreaterThan(0);
    const body = PIPE.slice(idx, idx + 1400);
    expect(body).toContain('"ADOPTED_WITHOUT_JUDGEMENT"');
  });

  it("neither rescue route grants eligibility on the way past the editor", () => {
    /**
     * The whole point of the reason: it accounts for the clip WITHOUT letting it claim the funnel.
     * `markEligible` next to either adoption would let a picture nobody looked at be counted as
     * one that cleared the gates, which is the enforcement REAL_FUNNEL exists for.
     */
    for (const anchor of ['fast Pexels "${q}"', "const takeFirstValid = async (paths: string[])"]) {
      const idx = PIPE.indexOf(anchor);
      const around = PIPE.slice(Math.max(0, idx - 700), idx + 1400);
      expect(around, `${anchor} grants eligibility`).not.toContain("markEligible(");
    }
  });
});

/* ═════════════ 2. the assembled film's picture covers its voice ═════════════ */

describe("R198 §2 — the film, not only each scene", () => {
  let dir: string;
  const ff = (args: string[]) => execFileSync("ffmpeg", ["-y", ...args], { stdio: "ignore" });

  /** A film whose picture stops early under sound that keeps going — video 574's shape. */
  function shortFilm(name: string, pictureSec: number, soundSec: number): string {
    const picture = path.join(dir, `${name}_v.mp4`);
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25", "-t", String(pictureSec),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", picture]);
    const sound = path.join(dir, `${name}_a.mp3`);
    // A tone, not silence: the check reads where the SOUND ends, not where the stream does.
    ff(["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", String(soundSec),
        "-c:a", "libmp3lame", sound]);
    const film = path.join(dir, `${name}_film.mp4`);
    ff(["-i", picture, "-i", sound,
        "-filter_complex", "[0:v]fps=25,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[vout]",
        "-map", "[vout]", "-map", "1:a", "-vsync", "cfr", "-t", String(soundSec),
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-pix_fmt", "yuv420p", film]);
    return film;
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fastvid-r198-"));
  }, 60_000);

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("the defect is real and the check sees it", async () => {
    const film = shortFilm("bug", 6, 12);
    const before = await checkFileAvSync(film);
    expect(before.findings.map((f) => f.code)).toContain("audio_past_picture");
  }, 300_000);

  it("the repair extends the picture across the sound, and the check then passes", async () => {
    const film = shortFilm("fix", 6, 12);
    const before = await checkFileAvSync(film);
    const soundEnd = Math.max(before.envelope.audioSec ?? 0, before.envelope.lastSoundSec ?? 0);
    const covered = await repairShortSceneVideo(
      film, soundEnd, -1, dir, 240_000, "-threads 2", "the assembled film"
    );
    expect(covered).not.toBe(film);
    expect(await probeVideoStreamDurationSec(covered)).toBeGreaterThan(soundEnd - 0.35);
    const after = await checkFileAvSync(covered);
    expect(after.findings.map((f) => f.code)).not.toContain("audio_past_picture");
  }, 300_000);

  it("the film's repair runs BEFORE the export-ready pass, so what ships is validated", () => {
    const idx = PIPE.indexOf("[FinalCoverage] video ${videoId}: picture ends at");
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(PIPE.indexOf("const { path: exportReadyPath, validation: finalValidation }"));
  });

  it("a repair that produces nothing keeps the composed file and says so", () => {
    const idx = PIPE.indexOf("[FinalCoverage] video ${videoId}: picture ends at");
    /**
     * Bounded by the else-branch this test is about rather than by the enclosing `catch`: a
     * second repair (the silent-tail trim) now sits between them, and a fixed window would fail
     * on a change that does not touch what this guards.
     */
    const end = PIPE.indexOf("AND THE OTHER DIRECTION", idx);
    expect(end, "the next repair marks the end of this one").toBeGreaterThan(idx);
    const block = PIPE.slice(idx, end);
    expect(block).toContain("repair did not produce a longer picture");
    expect(block, "the composed file is kept").toContain("shipping as composed");
  });

  it("nothing is repaired unless the sound really outlasts the picture", () => {
    const idx = PIPE.indexOf("const soundOutlastsPicture = preExport.findings.some(");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, idx + 600);
    expect(block).toContain('f.code === "audio_past_picture"');
    expect(block).toContain("soundOutlastsPicture && soundEnd > pictureEnd");
  });

  it("the log names what is being repaired instead of inventing a scene number", () => {
    const idx = PIPE.indexOf("export async function repairShortSceneVideo(");
    const body = PIPE.slice(idx, idx + 1400);
    expect(body).toContain("subject = `Scene ${sceneIndex}`");
    expect(body).not.toContain("[Pipeline] Scene ${sceneIndex}: could not read");
  });
});

/* ═════════════ 3. counters that can be compared ═════════════ */

describe("R198 §3 — assets are compared with assets, not events with assets", () => {
  /** One asset that cleared the gates once and was then offered to two beats. */
  function reusedAsset() {
    const ledger = new VisualSourceLedger({ renderId: "r198", videoId: 198 });
    const rec = ledger.createLineage({
      sceneIndex: 0, beatIndex: 0, candidateId: "archive:a1", contentKey: "archive:a1",
      provider: "archive", providerAssetId: "a1", localPath: "/tmp/a1.mp4", mediaType: "video",
    });
    ledger.markLineageEligible(rec.lineageId, "adopt_clip_gates_cleared");
    ledger.recordEvent(rec.lineageId, "RANKED", { status: "OK" });
    ledger.recordEvent(rec.lineageId, "SELECTED", { status: "OK", reason: "s0b0" });
    ledger.recordEvent(rec.lineageId, "SELECTED", { status: "OK", reason: "s1b2" });
    return { ledger, rec };
  }

  it("THE FALSE ALARM: one asset, two beats, no fault", () => {
    const { ledger } = reusedAsset();
    const summary = ledger.summary();
    // The event counts really do differ — that is honest, and it is why they cannot be compared.
    expect(summary.total.selected).toBe(2);
    expect(summary.total.eligible).toBe(1);
    expect(formatUsageInconsistencies(summary, false)).toEqual([]);
  });

  it("the per-asset counts say one asset reached each stage", () => {
    const { ledger } = reusedAsset();
    const assets = ledger.summary().assetsByStage;
    expect(assets.total.selected).toBe(1);
    expect(assets.total.eligible).toBe(1);
    expect(assets.byProvider.archive!.selected).toBe(1);
  });

  it("A REAL miscount still reports: two assets adopted, one ever validated", () => {
    const ledger = new VisualSourceLedger({ renderId: "r198b", videoId: 198 });
    const ids = ["b1", "b2"].map((id) =>
      ledger.createLineage({
        sceneIndex: 0, beatIndex: 0, candidateId: `nasa:${id}`, contentKey: `nasa:${id}`,
        provider: "nasa", providerAssetId: id, localPath: `/tmp/${id}.mp4`, mediaType: "video",
      })
    );
    ledger.markLineageEligible(ids[0]!.lineageId);
    for (const r of ids) ledger.recordEvent(r.lineageId, "ADOPTED", { status: "OK" });
    const problems = formatUsageInconsistencies(ledger.summary(), false);
    expect(problems.join("\n")).toContain("assigned=2 exceeds validated=1");
  });

  it("the pair that could not tell a fault from a normal render is gone, and only that one", () => {
    const SRC = fs.readFileSync(path.join(__dirname, "visualSourceLineage.ts"), "utf8");
    const idx = SRC.indexOf("const PAIRS: Array<[SummaryCounter, string, SummaryCounter, string, boolean]>");
    const block = SRC.slice(idx, idx + 400);
    expect(block).toContain('["ranked", "ranked", "eligible", "validated", false]');
    expect(block).toContain('["adopted", "assigned", "eligible", "validated", false]');
    expect(block).toContain('["finalVideo", "rendered", "adopted", "assigned", true]');
    expect(block).not.toContain('["selected", "selected"');
  });

  it("the question that pair was pretending to ask is now asked of the asset", () => {
    const ledger = new VisualSourceLedger({ renderId: "r198c", videoId: 198 });
    const rec = ledger.createLineage({
      sceneIndex: 3, beatIndex: 1, candidateId: "pexels:c1", contentKey: "pexels:c1",
      provider: "pexels", providerAssetId: "c1", localPath: "/tmp/c1.mp4", mediaType: "video",
    });
    ledger.recordEvent(rec.lineageId, "ADOPTED", { status: "OK" });
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).toContain("ADOPTED_WITHOUT_ELIGIBLE");
  });

  it("eligibility belongs to the asset, so a trimmed copy of an eligible clip is not a finding", () => {
    const ledger = new VisualSourceLedger({ renderId: "r198d", videoId: 198 });
    const rec = ledger.createLineage({
      sceneIndex: 3, beatIndex: 1, candidateId: "pexels:d1", contentKey: "pexels:d1",
      provider: "pexels", providerAssetId: "d1", localPath: "/tmp/d1.mp4", mediaType: "video",
    });
    ledger.markLineageEligible(rec.lineageId, "adopt_clip_gates_cleared");
    const derived = ledger.linkDerivedPath("/tmp/d1_trim.mp4", "/tmp/d1.mp4", "TRIMMED");
    expect(derived).not.toBeNull();
    ledger.recordEvent(derived!.lineageId, "ADOPTED", { status: "OK" });
    const codes = ledger.reconcile().warnings.map((w) => w.code);
    expect(codes).not.toContain("ADOPTED_WITHOUT_ELIGIBLE");
  });
});

/* ═════════════ 4. a clip a rebuild dropped is available again ═════════════ */

describe("R198 §4 — nothing is held in use that is not in use", () => {
  it("the release sits inside the same branch that reports the drop", () => {
    const idx = PIPE.indexOf("[SceneResourced] ${context} dropped a fetched asset nothing refused");
    expect(idx).toBeGreaterThan(0);
    const block = PIPE.slice(idx, idx + 2600);
    expect(block).toContain("dedup?.usedPaths?.delete(clip)");
    expect(block).toContain("dedup?.usedContentKeys?.delete(contentKey)");
  });

  it("only a proven provider asset is released, never a fallback or an unknown file", () => {
    const idx = PIPE.indexOf("[SceneResourced] ${context} dropped a fetched asset nothing refused");
    const before = PIPE.slice(Math.max(0, idx - 400), idx);
    expect(before).toContain('record.providerStatus === "VERIFIED"');
  });
});
