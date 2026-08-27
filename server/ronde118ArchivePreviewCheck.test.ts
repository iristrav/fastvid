/**
 * RONDE 118 — an archive asset must have a preview that can actually be read.
 *
 * Reported from the grid: "Preview mislukt — bestand ontbreekt of is corrupt", on an asset that
 * went on existing as a normal archive item and could still be handed to a render as a candidate.
 *
 * ── Why that was possible ────────────────────────────────────────────────────────────────────
 *
 * All three routes into the archive did the same two things and nothing in between:
 *
 *     storagePut(...)                                  // the bytes go to storage
 *     createMediaArchiveAsset({ ..., isActive: 1 })    // the row goes in, active, immediately
 *
 * Nothing asked whether the bytes were a decodable video, whether ffmpeg could get a frame out of
 * them, or whether an image would decode at all. A truncated download, a container with no video
 * stream, a near-empty write — each became `isActive = 1`, and the candidate query filters on
 * exactly that column and nothing else.
 *
 * The server could not have known: `archiveAssetHasLocalCopy` answers "does a file exist at this
 * URL shape" and returns true for any http URL without fetching a byte. The browser was the first
 * thing in the whole system that actually tried to decode the file — which is why the failure only
 * ever showed up in the UI.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 *
 * Verified before the row is written, at every route in. Never a row first and a check later, so
 * there is no window in which an unverified asset is selectable.
 *
 * These tests use real files made with ffmpeg — a real mp4, a real jpeg, a truncated mp4, a file
 * of random bytes — because the whole defect was that nobody looked at the bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  formatPreviewRefusal,
  verifyArchivePreview,
  verifyArchivePreviewBuffer,
} from "./archivePreviewCheck";
import { extractFrameAtFraction } from "./localClipVision";

let dir = "";
let goodVideo = "";
let goodImage = "";
let truncatedVideo = "";
let garbage = "";
let emptyFile = "";
let audioOnly = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "r118-"));
  goodVideo = path.join(dir, "good.mp4");
  goodImage = path.join(dir, "good.jpg");
  truncatedVideo = path.join(dir, "truncated.mp4");
  garbage = path.join(dir, "garbage.mp4");
  emptyFile = path.join(dir, "empty.mp4");
  audioOnly = path.join(dir, "audio.mp4");

  execSync(
    `ffmpeg -y -f lavfi -i "testsrc=size=320x240:rate=25:duration=3" ` +
      `-c:v libx264 -pix_fmt yuv420p "${goodVideo}" 2>/dev/null`
  );
  execSync(`ffmpeg -y -i "${goodVideo}" -frames:v 1 "${goodImage}" 2>/dev/null`);
  // A download that stopped early: a real header, then nothing. Probes may pass, decoding does not.
  const whole = fs.readFileSync(goodVideo);
  fs.writeFileSync(truncatedVideo, whole.subarray(0, Math.floor(whole.length * 0.08)));
  fs.writeFileSync(garbage, Buffer.alloc(4096, 0x7a));
  fs.writeFileSync(emptyFile, Buffer.alloc(0));
  execSync(
    `ffmpeg -y -f lavfi -i "sine=frequency=440:duration=2" -c:a aac "${audioOnly}" 2>/dev/null`
  );
}, 120_000);

afterAll(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const withFrames = { extractFrame: extractFrameAtFraction };

/* ═══════════ 1. geldig materiaal wordt toegelaten ═══════════ */

describe("RONDE 118 — a real file with a real preview passes", () => {
  it("a valid video, with a frame actually extracted from it", async () => {
    const v = await verifyArchivePreview({ localPath: goodVideo, mediaType: "video", ...withFrames });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.widthPx).toBe(320);
      expect(v.heightPx).toBe(240);
      expect(v.durationSec).toBeGreaterThan(2.5);
    }
  }, 60_000);

  it("a valid image", async () => {
    const v = await verifyArchivePreview({ localPath: goodImage, mediaType: "image" });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.widthPx).toBeGreaterThan(0);
  }, 60_000);

  it("the same bytes in memory give the same answer", async () => {
    // The upload routes hold a Buffer at the moment the decision has to be made.
    const v = await verifyArchivePreviewBuffer({
      buffer: fs.readFileSync(goodVideo),
      mediaType: "video",
      extension: ".mp4",
      ...withFrames,
    });
    expect(v.ok).toBe(true);
  }, 60_000);
});

/* ═══════════ 2. ontbrekend / corrupt bronbestand ═══════════ */

describe("RONDE 118 — a source that is missing or corrupt is refused", () => {
  it("a path that does not exist", async () => {
    const v = await verifyArchivePreview({ localPath: path.join(dir, "nope.mp4"), mediaType: "video" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("source_missing");
  });

  it("a zero-byte file", async () => {
    const v = await verifyArchivePreview({ localPath: emptyFile, mediaType: "video" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("source_unreadable");
  });

  it("random bytes with an .mp4 name", async () => {
    const v = await verifyArchivePreview({ localPath: garbage, mediaType: "video", ...withFrames });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(["source_unreadable", "no_video_stream"]).toContain(v.reason);
  }, 60_000);

  it("a container with sound but no picture", async () => {
    // Real file, real duration, genuinely nothing to preview.
    const v = await verifyArchivePreview({ localPath: audioOnly, mediaType: "video", ...withFrames });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("no_video_stream");
  }, 60_000);

  it("bytes that are not an image, offered as one", async () => {
    const v = await verifyArchivePreview({ localPath: garbage, mediaType: "image" });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("image_unreadable");
  }, 60_000);
});

/* ═══════════ 3. ontbrekende / onleesbare preview ═══════════ */

describe("RONDE 118 — a source that cannot yield a preview frame is refused", () => {
  it("THE CASE THIS ROUND IS ABOUT: a truncated download", async () => {
    /**
     * The failure the grid kept reporting. The header survived the interrupted download, so the
     * file looks plausible from the outside — and the browser is the first thing that discovers
     * it cannot be decoded. Asking for a frame is what catches it server-side.
     */
    const v = await verifyArchivePreview({ localPath: truncatedVideo, mediaType: "video", ...withFrames });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(["no_preview_frame", "preview_unreadable", "source_unreadable", "zero_duration", "no_video_stream"])
        .toContain(v.reason);
    }
  }, 60_000);

  it("a frame extractor that produces nothing is a refusal, not a pass", async () => {
    const v = await verifyArchivePreview({
      localPath: goodVideo,
      mediaType: "video",
      extractFrame: async () => false,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("no_preview_frame");
  }, 60_000);

  it("a frame file that is written but empty is a refusal too", async () => {
    const v = await verifyArchivePreview({
      localPath: goodVideo,
      mediaType: "video",
      extractFrame: async (_src, out) => {
        fs.writeFileSync(out, Buffer.alloc(0));
        return true;
      },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("preview_unreadable");
  }, 60_000);

  it("a frame file with bytes that are not an image is a refusal", async () => {
    const v = await verifyArchivePreview({
      localPath: goodVideo,
      mediaType: "video",
      extractFrame: async (_src, out) => {
        fs.writeFileSync(out, Buffer.alloc(4096, 0x41));
        return true;
      },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("preview_unreadable");
  }, 60_000);

  it("the refusal names the reason, for the log and the column", () => {
    const line = formatPreviewRefusal("clip 3", { ok: false, reason: "no_preview_frame" });
    expect(line).toContain("[PreviewCheck]");
    expect(line).toContain("no_preview_frame");
    expect(line).toContain("not registered as an archive asset");
  });
});

/* ═══════════ 4. de race — geen rij vóór de controle ═══════════ */

describe("RONDE 118 — the row is never written before the check", () => {
  const upload = fs.readFileSync(path.join(__dirname, "archiveUpload.ts"), "utf8");
  const ingestion = fs.readFileSync(path.join(__dirname, "archiveIngestion.ts"), "utf8");

  it("every insert site verifies FIRST", () => {
    /**
     * The ordering is the whole guarantee: there must be no window in which an unverified asset
     * exists as a row. Asserted by position, not by presence.
     */
    for (const [name, src, checkCall] of [
      ["archiveUpload (clips)", upload, "verifyArchivePreviewBuffer({"],
      ["archiveIngestion", ingestion, "verifyArchivePreview({"],
    ] as const) {
      const check = src.indexOf(checkCall);
      const insert = src.indexOf("createMediaArchiveAsset(");
      expect(check, `${name}: no preview check`).toBeGreaterThan(-1);
      expect(insert, `${name}: no insert`).toBeGreaterThan(-1);
      expect(check, `${name}: the check must come before the insert`).toBeLessThan(insert);
    }
  });

  it("a failed check returns before the insert rather than continuing", () => {
    expect(upload).toContain("if (!preview.ok) {");
    expect(ingestion).toContain("if (!preview.ok) {");
    // The split-clip route drops that one clip; the single-file route fails the upload.
    expect(upload).toContain("console.warn(formatPreviewRefusal(`clip ${suffix}`, preview));");
    expect(ingestion).toContain("return null;");
  });

  it("both upload sites and the ingestion site are covered — all three", () => {
    expect((upload.match(/verifyArchivePreviewBuffer\(/g) ?? []).length).toBe(2);
    expect((ingestion.match(/verifyArchivePreview\(/g) ?? []).length).toBe(1);
  });

  it("a verified asset records WHEN it was verified", () => {
    expect((upload.match(/previewCheckedAt: new Date\(\)/g) ?? []).length).toBe(2);
    expect(ingestion).toContain("previewCheckedAt: new Date()");
  });
});

/* ═══════════ 5. bestaande assets kunnen geen kandidaat meer zijn ═══════════ */

describe("RONDE 118 — an asset without a preview cannot be selected", () => {
  const sweep = fs.readFileSync(path.join(__dirname, "archivePreviewSweep.ts"), "utf8");
  const db = fs.readFileSync(path.join(__dirname, "db.ts"), "utf8");

  it("candidate selection already filters on isActive — that is the lever used", () => {
    /**
     * Not a new mechanism: this is the column the schema already uses for "not a usable archive
     * item", and the candidate query filters on it. Enforced in the BACKEND, so an asset without
     * a preview cannot come back through the API or a search either.
     */
    expect(db).toContain("eq(mediaArchiveAssets.isActive, 1)");
  });

  it("a broken preview deactivates the asset and records why", () => {
    expect(sweep).toContain(".set({ isActive: 0, previewCheckedAt: new Date(), previewIssue: verdict.reason })");
  });

  it("a good preview is stamped and left alone", () => {
    expect(sweep).toContain(".set({ previewCheckedAt: new Date(), previewIssue: null })");
  });

  it("nothing is ever deleted", () => {
    expect(sweep).not.toContain("delete(");
    expect(sweep).not.toContain("deleteMediaArchiveAsset");
  });

  it("a storage outage does not disable an archive", () => {
    // A file that cannot be fetched is a storage problem, not a verdict about the asset.
    expect(sweep).toContain("result.unreachable++;");
    const idx = sweep.indexOf("if (!loaded || !loaded.ok) {");
    expect(sweep.slice(idx, idx + 700)).toContain("continue;");
    expect(sweep.slice(idx, idx + 700)).not.toContain("isActive: 0");
  });

  it("it never re-checks an asset an operator switched off themselves", () => {
    expect(sweep).toContain("where.push(eq(mediaArchiveAssets.isActive, 1));");
  });

  it("the sweep is reachable from the admin, bounded and resumable", () => {
    const routers = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    expect(routers).toContain("verifyPreviews: adminProcedure");
    expect(routers).toContain("sweepArchivePreviews(input)");
    expect(sweep).toContain("Math.max(1, Math.min(opts.limit ?? 200, 1000))");
  });
});

/* ═══════════ 6. het schema modelleert dit eerlijk ═══════════ */

describe("RONDE 118 — existing rows are not retroactively declared broken", () => {
  const schema = fs.readFileSync(path.join(__dirname, "..", "drizzle", "schema.ts"), "utf8");

  it("both columns are nullable, so null means 'not checked yet'", () => {
    expect(schema).toContain('previewCheckedAt: timestamp("previewCheckedAt")');
    expect(schema).toContain('previewIssue: varchar("previewIssue", { length: 64 })');
    // No .notNull() and no default on either — the same convention hasBakedEditText uses.
    const idx = schema.indexOf('previewCheckedAt: timestamp("previewCheckedAt")');
    const block = schema.slice(idx, idx + 400);
    expect(block).not.toContain(".notNull()");
  });

  it("the migration adds them as nullable and touches no data", () => {
    const sql = fs.readFileSync(
      path.join(__dirname, "..", "drizzle", "0046_ronde118_archive_preview_check.sql"),
      "utf8"
    );
    expect(sql).toContain("ADD COLUMN `previewCheckedAt` timestamp NULL");
    expect(sql).toContain("ADD COLUMN `previewIssue` varchar(64) NULL");
    expect(sql).not.toContain("UPDATE");
    expect(sql).not.toContain("DELETE");
  });

  it("the migration is registered in the journal", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((e) => e.tag === "0046_ronde118_archive_preview_check");
    expect(entry, "migration 0046 is not in the journal").toBeDefined();
    expect(entry!.idx).toBe(46);
  });
});
