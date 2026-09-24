/**
 * Self-learning archive ingestion — promote winning external clips into the own archive.
 *
 * When an external (Pexels / Pixabay / Wikimedia / Internet Archive) clip wins a beat
 * and passes quality gates, it is automatically uploaded to R2, persisted as a
 * MediaArchiveAsset, and indexed so future retrievals can find it via embedding search.
 *
 * Over time the archive grows and internet retrieval is needed less.
 *
 * Feature flag: ENABLE_EXTERNAL_ASSET_INGESTION=true
 *
 * Entry point: ingestExternalClipToArchive(localPath, metadata) → assetId | null
 * All errors are swallowed — ingestion is always best-effort.
 */

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { storagePut } from "./storage";
import { createMediaArchiveAsset, findMediaArchiveAssetBySourceUrlHash } from "./db";
import { AUTO_ARCHIVES, autoArchiveKind } from "./stockArchive";
import { formatPreviewRefusal, verifyArchivePreview } from "./archivePreviewCheck";
import { extractFrameAtFraction } from "./localClipVision";
import { indexArchiveAssetEmbedding } from "./archiveEmbeddingIndex";
import { cachedClipBakedEditTextVerdict } from "./archiveClipFilter";
import { beatClipTextFilterMaxChecks } from "./sourcingPolicy";
import { recordVisualSearchMemory, type ClassifiedEntity } from "./visualSearchMemory";
import { Semaphore } from "./_core/semaphore";
import type { InsertMediaArchiveAsset } from "../drizzle/schema";

// Callers fire this fire-and-forget per winning beat with no cap of their own (videoPipeline.ts's
// funnel-clip loop), and each call reads the whole clip into memory + uploads it — several
// beats landing at once during a render could otherwise stack up unbounded concurrent
// read+upload work purely for this best-effort background feature.
const ingestionLimiter = new Semaphore(2);

// ─── Types ────────────────────────────────────────────────────────────────────

export type IngestMetadata = {
  title: string;
  tags: string[];
  /** e.g. "pexels:12345" or "wikimedia:File_Foo.mp4" */
  sourceNote: string;
  mediaType: "video" | "image";
  mimeType: string;
  durationSec?: number;
  /**
   * RONDE 9b: true only when the render this clip won was person-locked (a real name drives
   * the video). AWS Rekognition person-tagging runs ONLY then — celebrity recognition on
   * B-roll/place/object footage is wasted spend and adds nothing.
   */
  personContext?: boolean;
  /** License note, e.g. "CC0", "Pexels license" */
  licenseNote?: string;
  /** Override which archive to ingest into; defaults to the first active archive. */
  archiveId?: number;
  /**
   * RONDE 647 — stock footage, going into the separate "Stockbeelden" archive. The only way a
   * Pexels or Pixabay clip is admitted; without it RONDE 9's refusal stands.
   */
  stockArchive?: boolean;
  /**
   * RONDE 648 — the picture editor approved THIS clip for the beat it is about to fill. Only then
   * may a clip with baked-in on-screen text be kept: it is stored with `hasBakedEditText = 1`, which
   * curated sourcing already treats as "never offer this again unasked" (`hasKnownBakedEditText`).
   */
  approvedForBeat?: boolean;

  // F3-26: structured web-sourcing provenance (all optional — admin uploads and older callers
  // that don't have this data keep working unchanged).
  /** The original remote URL this clip was downloaded from. Used for duplicate detection. */
  sourceUrl?: string;
  /** Provider name, e.g. "internet_archive", "wikimedia", "pexels", "pixabay", "youtube_cc". */
  sourcePlatform?: string;
  /** Creator/uploader/channel name, when the source exposes one. */
  sourceCreator?: string;
  /** License URL, when the source exposes one (e.g. a Creative Commons deed link). */
  licenseUrl?: string;
  /** The original search query that led to this candidate being found. */
  originalQuery?: string;
  /** The specific query variant that actually matched (may equal originalQuery). */
  matchedQuery?: string;
  /** Recognized entities this clip is relevant to, e.g. ["Justin Bieber"]. */
  entities?: ClassifiedEntity[];
  /** General topics, e.g. ["music", "pop culture"]. */
  topics?: string[];
};

export type IngestResult = {
  assetId: number;
  storageKey: string;
  /** True when this reused an already-archived asset instead of ingesting a new one. */
  reused?: boolean;
};

/**
 * ROUND 596 §3 — WHY THE ARCHIVE SAID NO, IN A WORD THE CALLER CAN BRANCH ON.
 *
 * ── The sentence this replaces ──────────────────────────────────────────────────────────────
 *
 *     ARCHIVE_INGEST_REFUSED … the archive ingestion refused extend_s1b3_….mp4
 *                              (its own quality gate, or a storage failure)
 *
 * Eleven different refusals in this function all returned the bare `null` that produced that line,
 * and the line then guessed between two of them with an "or". Render 595 refused three
 * `extend_*.mp4` clips and the log cannot say whether the file was too small, too long, carrying
 * burnt-in subtitles, unreadable by the frame extractor, or whether the upload failed — and those
 * need entirely different work. "Probably the quality gate" is not a diagnosis.
 *
 * ── The rule these codes follow ─────────────────────────────────────────────────────────────
 *
 * Every code below is returned by exactly one `return` in `ingestExternalClipToArchiveInner`, and
 * no code exists that the code cannot produce. `reasonDetail` carries the measured number that
 * decided it — the byte count, the duration, the ffmpeg message — never a restatement of the code.
 */
export type IngestRefusalCode =
  /** RONDE 9's standing exception: stock footage is never CURATED archive material. */
  | "EXEMPT_SOURCE"
  /** RONDE 647 — stock headed for the Stockbeelden archive, and that archive could not be had. */
  | "STOCK_ARCHIVE_UNAVAILABLE"
  /** `fs.statSync` threw: the file the caller says it has is not readable. */
  | "SOURCE_FILE_UNREADABLE"
  /** Below `MIN_FILE_BYTES` — a placeholder or a truncated download. */
  | "FILE_TOO_SMALL"
  /** Outside [`MIN_VIDEO_DURATION_SEC`, `MAX_VIDEO_DURATION_SEC`]. */
  | "INVALID_DURATION"
  /** RONDE 24: burnt-in subtitles or a news chyron. */
  | "BAKED_EDIT_TEXT"
  /** RONDE 118: no decodable picture could be pulled out of the file. */
  | "PREVIEW_UNREADABLE"
  /** No active archive exists to ingest into. Configuration, not content. */
  | "NO_ACTIVE_ARCHIVE"
  /** `storagePut` threw or the bytes could not be read off disk. */
  | "STORAGE_WRITE_FAILED"
  /** The row could not be created after the bytes were stored. */
  | "RECORD_FAILED"
  /** Something else threw. The message is carried in `reasonDetail`. */
  | "UNKNOWN";

export type IngestRefusal = {
  status: "refused";
  reasonCode: IngestRefusalCode;
  /** The measurement that decided it. Never a restatement of the code. */
  reasonDetail: string;
  /** §3's diagnostic set, filled from what was actually observed. Absent means not measured. */
  fileExists?: boolean;
  fileSizeBytes?: number;
  mimeType?: string;
  durationSec?: number;
};

export type IngestOutcome = (IngestResult & { status: "ingested" }) | IngestRefusal;

const refuse = (
  reasonCode: IngestRefusalCode,
  reasonDetail: string,
  observed?: Omit<IngestRefusal, "status" | "reasonCode" | "reasonDetail">
): IngestRefusal => ({ status: "refused", reasonCode, reasonDetail, ...observed });

function hashSourceUrl(sourceUrl: string): string {
  return createHash("sha256").update(sourceUrl.trim()).digest("hex");
}

// ─── Quality gates ────────────────────────────────────────────────────────────

/** Minimum file size in bytes — reject placeholder / broken downloads. */
const MIN_FILE_BYTES = 50_000; // 50 KB
/** Minimum video duration to admit (seconds). */
const MIN_VIDEO_DURATION_SEC = 3;
/** Maximum video duration — very long clips waste storage and encode time. */
const MAX_VIDEO_DURATION_SEC = 120;

/**
 * ROUND 596 §3 — the gate now says WHICH threshold, and what it measured.
 *
 * The three conditions are untouched — same constants, same comparisons, same verdicts. What is
 * added is the answer to "which one", which the caller could previously only guess at.
 */
function qualityGateRefusal(localPath: string, metadata: IngestMetadata): IngestRefusal | null {
  let sizeBytes: number;
  try {
    sizeBytes = fs.statSync(localPath).size;
  } catch (err) {
    return refuse("SOURCE_FILE_UNREADABLE", (err as Error).message?.slice(0, 160) ?? "statSync threw", {
      fileExists: false,
      mimeType: metadata.mimeType,
    });
  }
  const observed = {
    fileExists: true,
    fileSizeBytes: sizeBytes,
    mimeType: metadata.mimeType,
    ...(metadata.durationSec != null ? { durationSec: metadata.durationSec } : {}),
  };
  if (sizeBytes < MIN_FILE_BYTES) {
    return refuse("FILE_TOO_SMALL", `${sizeBytes} bytes < ${MIN_FILE_BYTES}`, observed);
  }
  if (metadata.mediaType === "video") {
    const dur = metadata.durationSec ?? 0;
    if (dur > 0 && dur < MIN_VIDEO_DURATION_SEC) {
      return refuse("INVALID_DURATION", `${dur.toFixed(2)}s < ${MIN_VIDEO_DURATION_SEC}s`, observed);
    }
    if (dur > MAX_VIDEO_DURATION_SEC) {
      return refuse("INVALID_DURATION", `${dur.toFixed(2)}s > ${MAX_VIDEO_DURATION_SEC}s`, observed);
    }
  }
  return null;
}

// ─── F3-26: query/entity/source learning loop ─────────────────────────────────

/** Records one visual-search-memory row per recognized entity (or a single "topic" row when no
 *  entities were recognized) so a future beat about the same entity/topic can reuse the query +
 *  source that worked here. Best-effort — never throws. */
async function recordSearchMemoryForIngestion(
  metadata: IngestMetadata,
  assetId: number,
  success: boolean
): Promise<void> {
  const query = metadata.matchedQuery ?? metadata.originalQuery;
  const source = metadata.sourcePlatform;
  if (!query || !source) return; // nothing to remember without a query + source

  const entities = metadata.entities && metadata.entities.length > 0
    ? metadata.entities
    : metadata.topics && metadata.topics.length > 0
      ? metadata.topics.map((t) => ({ type: "topic" as const, value: t }))
      : [];
  if (entities.length === 0) return;

  await Promise.all(
    entities.map((e) =>
      recordVisualSearchMemory({
        entity: e.value,
        entityType: e.type,
        query,
        source,
        sourceUrl: metadata.sourceUrl,
        assetId,
        success,
      })
    )
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ingests a locally available external clip into the archive.
 * Runs quality gate → uploads to R2 → persists DB record → indexes embedding.
 * Returns the new assetId on success, null on any failure.
 * Never throws.
 */
export async function ingestExternalClipToArchive(
  localPath: string,
  metadata: IngestMetadata
): Promise<IngestResult | null> {
  const outcome = await ingestExternalClipToArchiveWithReason(localPath, metadata);
  if (outcome.status !== "ingested") return null;
  const { status: _ignored, ...result } = outcome;
  return result;
}

/**
 * The same ingestion, with the refusal it actually made.
 *
 * `storeForProduction` calls this one, because it is the caller that has to explain the refusal to
 * an operator. Everything else keeps the null-returning shape above — the fire-and-forget callers
 * in the pipeline have nothing to do with a reason, and giving them one would only invite a
 * decision to be made in a place that must not make decisions.
 */
export async function ingestExternalClipToArchiveWithReason(
  localPath: string,
  metadata: IngestMetadata
): Promise<IngestOutcome> {
  return ingestionLimiter.run(() => ingestExternalClipToArchiveInner(localPath, metadata));
}

async function ingestExternalClipToArchiveInner(
  localPath: string,
  metadata: IngestMetadata
): Promise<IngestOutcome> {
  try {
    // RONDE 9 (render 519 + admin evidence): stock footage is never archive material. A generic
    // Pexels clip that won a Hitler beat was ingested tagged "adolf hitler" and then outranked
    // real archival footage on every later render about the same person (self-poisoning loop).
    // Defense-in-depth: the funnel call site already refuses, this blocks every other caller.
    const platform = (metadata.sourcePlatform ?? "").toLowerCase();
    const sourcePrefix = metadata.sourceNote.toLowerCase();
    const isStock =
      platform === "pexels" || platform === "pixabay" ||
      sourcePrefix.startsWith("pexels:") || sourcePrefix.startsWith("pixabay:");
    /**
     * RONDE 647 — stock goes to its OWN archive or nowhere. The Stockbeelden archive is inactive,
     * so curated sourcing never offers what is kept there; RONDE 9's poisoning cannot come back.
     */
    let stockArchiveId: number | null = null;
    if (isStock && !metadata.stockArchive) {
      console.log(
        `[Ingestion] Skipping ${metadata.sourcePlatform ?? metadata.sourceNote.split(":")[0]} clip — stock footage is never ingested into the curated archive`
      );
      return refuse("EXEMPT_SOURCE", `${platform || sourcePrefix.split(":")[0]} is stock footage`);
    }
    if (isStock) {
      const { ensureStockMediaArchive } = await import("./db");
      stockArchiveId = await ensureStockMediaArchive().catch(() => null);
      if (stockArchiveId == null) {
        return refuse("STOCK_ARCHIVE_UNAVAILABLE", "the Stockbeelden archive could not be found or created");
      }
    }

    const gate = qualityGateRefusal(localPath, metadata);
    if (gate) return gate;

    // RONDE 24: never let footage with baked-in on-screen text into the archive.
    //
    // This archive fills itself from what the pipeline finds while searching, so anything admitted
    // here is permanent and gets re-offered to every later render. Ingestion had no text check at
    // all, which is how burnt-in subtitles and news chyrons accumulated: renders 526/527 found 10
    // of 17 assets flagged, leaving only 7 usable. Rejecting at the door — before the upload and
    // the DB row — is what stops that from growing, and it costs nothing extra for the common
    // case: the beat gate (RONDE 23) has usually already judged this exact clip, and the shared
    // memo in archiveClipFilter returns that verdict instead of re-running the vision call.
    const overlayKey = metadata.sourceUrl || `${metadata.sourceNote}:${path.basename(localPath)}`;
    const overlay = await cachedClipBakedEditTextVerdict(
      localPath,
      metadata.mimeType,
      overlayKey,
      beatClipTextFilterMaxChecks()
    );
    /**
     * RONDE 648 — AN APPROVED SHOT WITH TEXT IS KEPT, AND MARKED SO IT IS NOT OFFERED AGAIN.
     *
     * Render 606: the picture editor passed a YouTube shot of Hitler at a rally for s1b0 and one of
     * Berlin in ruins for s2b0; both carried on-screen text, this door refused them, and the push
     * gate — every shot must be readable from our own storage — then refused them for the film.
     * Two rules that together kept approved YouTube out of every film. The operator's choice: such a
     * shot is kept for the beat that approved it, with `hasBakedEditText = 1`, which curated
     * sourcing already filters out — so RONDE 24's reason (text re-offered to every later render)
     * still holds. Unapproved clips with text are refused exactly as before.
     */
    const hasText = overlay.verdict === "has_text";
    if (hasText && !metadata.approvedForBeat) {
      console.log(
        `[Ingestion] Skipping "${metadata.title.slice(0, 60)}" — baked-in on-screen text, not archive material`
      );
      return refuse("BAKED_EDIT_TEXT", overlay.reason ?? "the on-screen-text check said has_text", {
        mimeType: metadata.mimeType,
      });
    }
    if (hasText) {
      console.log(
        `[Ingestion] "${metadata.title.slice(0, 60)}" has baked-in on-screen text and was approved for ` +
          `its beat — kept for that beat, marked hasBakedEditText=1 so no later render is offered it unasked`
      );
    }
    /**
     * RONDE 222 — a clip nobody looked at is not admitted as a clip that was cleared.
     *
     * It is still ADMITTED: refusing every unchecked clip would empty the archive whenever the
     * vision path is slow, budgeted out or switched off, which is a far worse failure than the one
     * this guards against. What changes is what gets written down. See the row below.
     */
    if (overlay.verdict === "not_asked") {
      console.warn(
        `[Ingestion] "${metadata.title.slice(0, 60)}" admitted WITHOUT an on-screen-text verdict — ` +
          `${overlay.reason ?? "no reason recorded"}; stored as unjudged so a later render asks`
      );
    }

    // F3-26: duplicate protection — the same web source URL must not be archived twice. Checked
    // before touching R2/DB so a repeat hit is a cheap read instead of a second upload+insert.
    const sourceUrlHash = metadata.sourceUrl ? hashSourceUrl(metadata.sourceUrl) : undefined;
    if (sourceUrlHash) {
      const existing = await findMediaArchiveAssetBySourceUrlHash(sourceUrlHash);
      if (existing) {
        console.log(
          `[Ingestion] Source already archived — reusing assetId=${existing.id} instead of re-ingesting ` +
          `(${metadata.sourceUrl})`
        );
        await recordSearchMemoryForIngestion(metadata, existing.id, true);
        return {
          status: "ingested",
          assetId: existing.id,
          storageKey: existing.storageKey ?? "",
          reused: true,
        };
      }
    }

    // Resolve archive to ingest into
    let archiveId = stockArchiveId ?? metadata.archiveId;
    if (!archiveId) {
      /**
       * RONDE 648 — by the kind of source, never "the most recently updated archive".
       *
       * That rule put 57 YouTube segments into an archive named Stockbeelden, and 36 more into WW2
       * when WW2 happened to be the latest. YouTube goes to YouTube, everything else FastVid finds
       * and keeps goes to Overig; stock was routed above.
       */
      const kind = autoArchiveKind(metadata);
      const { ensureAutoMediaArchive } = await import("./db");
      const target = await ensureAutoMediaArchive(kind).catch(() => null);
      if (target == null) {
        return refuse("NO_ACTIVE_ARCHIVE", `the ${AUTO_ARCHIVES[kind].name} archive could not be found or created`);
      }
      archiveId = target;
    }

    // Build a deterministic storage key to avoid duplicates
    const ext = path.extname(localPath) || (metadata.mediaType === "video" ? ".mp4" : ".jpg");
    const safeSource = metadata.sourceNote.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 64);
    const storageKey = `archive-ingested/${archiveId}/${safeSource}${ext}`;

    // RONDE 9: content-true person tags via AWS Rekognition celebrity recognition — tags must
    // describe what is SHOWN, never what the narration said (the old beat-keyword tags poisoned
    // the archive). Best-effort: no keys or any error → no person tags, ingestion continues.
    let recognizedPersonTags: string[] = [];
    try {
      // RONDE 9b: only for person-locked renders (metadata.personContext) — Rekognition is a
      // PERSON check, running it on place/object/B-roll footage is pure wasted spend.
      // Lazy import: the AWS SDK is heavyweight and only needed when keys are configured.
      const { isRekognitionEnabled, recognizeCelebritiesInFile } = await import("./rekognitionCelebrity");
      if (metadata.personContext === true && isRekognitionEnabled()) {
        const rek = await recognizeCelebritiesInFile(localPath, metadata.mediaType, metadata.durationSec ?? null);
        recognizedPersonTags = rek.persons.map((p) => p.name);
        if (recognizedPersonTags.length > 0) {
          console.log(
            `[Ingestion] Rekognition identified in "${metadata.title.slice(0, 60)}": ${recognizedPersonTags.join(", ")}`
          );
        }
      }
    } catch (err) {
      console.warn(`[Ingestion] Rekognition tagging skipped:`, (err as Error).message?.slice(0, 120));
    }
    const contentTags = Array.from(new Set([...(metadata.tags ?? []), ...recognizedPersonTags]));

    /**
     * RONDE 118 — prove the preview before anything is stored or registered.
     *
     * Ingested assets arrive from the open internet, so a truncated download or a container with
     * no decodable picture is the normal failure here, not the exotic one. `localPath` is the
     * real downloaded file, which makes this the cheapest and most honest place to ask.
     */
    const preview = await verifyArchivePreview({
      localPath,
      mediaType: metadata.mediaType,
      extractFrame: extractFrameAtFraction,
    });
    if (!preview.ok) {
      console.warn(formatPreviewRefusal(`"${metadata.title.slice(0, 60)}"`, preview));
      return refuse("PREVIEW_UNREADABLE", preview.reason ?? "no decodable frame", {
        mimeType: metadata.mimeType,
        ...(metadata.durationSec != null ? { durationSec: metadata.durationSec } : {}),
      });
    }

    let data: Buffer;
    let key: string;
    let url: string;
    try {
      data = await fs.promises.readFile(localPath);
      ({ key, url } = await storagePut(storageKey, data, metadata.mimeType));
    } catch (err) {
      /**
       * §3 — "its own quality gate, OR a storage failure" was one sentence for two opposite
       * problems. This is the storage half, and it is now named separately: nothing about the clip
       * is wrong, and re-judging the clip is the wrong response to it.
       */
      return refuse("STORAGE_WRITE_FAILED", (err as Error).message?.slice(0, 160) ?? "storagePut threw", {
        fileExists: true,
        mimeType: metadata.mimeType,
      });
    }

    const insertData: InsertMediaArchiveAsset = {
      archiveId,
      title: metadata.title.slice(0, 512),
      mediaType: metadata.mediaType,
      mixKind: stockArchiveId != null ? "stock" : metadata.mediaType === "video" ? "real_video" : "photo",
      mimeType: metadata.mimeType,
      storageUrl: url,
      storageKey: key,
      tags: contentTags,
      sourceNote: metadata.sourceNote.slice(0, 512),
      licenseNote: (metadata.licenseNote ?? "").slice(0, 256) || undefined,
      durationSec: metadata.durationSec,
      isActive: 1,
      sourceUrl: metadata.sourceUrl,
      sourceUrlHash,
      sourcePlatform: metadata.sourcePlatform?.slice(0, 64),
      sourceCreator: metadata.sourceCreator?.slice(0, 256),
      licenseUrl: metadata.licenseUrl?.slice(0, 512),
      downloadedAt: new Date(),
      originalQuery: metadata.originalQuery?.slice(0, 512),
      matchedQuery: metadata.matchedQuery?.slice(0, 512),
      entities: metadata.entities?.map((e) => e.value),
      topics: metadata.topics,
      /**
       * RONDE 24: record the overlay verdict so the first render that considers this asset does not
       * pay a fresh vision call to rediscover what we already know.
       *
       * RONDE 222 — BUT ONLY WHEN THERE IS A VERDICT TO RECORD.
       *
       * This wrote a flat 0 — "inspected, carries no added text" — for every clip that reached this
       * line, including the ones no detector ever looked at: a spent budget, a timeout, a vision
       * path switched off, a clip no frame could be pulled from. All of those returned `false` and
       * all of them were written down as cleared. The row is permanent and every later render
       * short-circuits on it, so one unanswered call became a standing claim about the pixels.
       *
       * Measured: render 574 delivered 27 seconds of footage carrying a broadcaster's on-screen
       * logo — roughly 40% of that film — and its log holds not one `hasBakedEditText` verdict.
       *
       * `null` is the value the schema already uses for "not judged yet", and the RONDE 24 comment
       * above describes exactly what it causes: the next render that considers this asset asks the
       * question properly. That is the correct cost for a clip nobody has looked at, and it is paid
       * once rather than inherited forever.
       */
      hasBakedEditText: overlay.verdict === "clean" ? 0 : hasText ? 1 : null,
      // RONDE 118: verified a few lines above, before the bytes were even stored.
      previewCheckedAt: new Date(),
    };

    const assetId = await createMediaArchiveAsset(insertData);
    if (!assetId) {
      return refuse("RECORD_FAILED", "createMediaArchiveAsset returned no id", {
        fileExists: true,
        fileSizeBytes: data.length,
        mimeType: metadata.mimeType,
      });
    }

    // Index embedding in background — non-blocking
    void indexArchiveAssetEmbedding({
      id: assetId,
      title: metadata.title,
      tags: contentTags,
      sourceNote: metadata.sourceNote,
    }).catch(() => {});

    // F3-26: remember which query/entity/source combination found this asset — best-effort,
    // never blocks or fails the ingestion itself.
    void recordSearchMemoryForIngestion(metadata, assetId, true).catch(() => {});

    console.log(
      `[Ingestion] Admitted external clip to archive: assetId=${assetId} source=${metadata.sourceNote} ` +
      `size=${Math.round(data.length / 1024)}KB`
    );
    return { status: "ingested", assetId, storageKey: key };
  } catch (err) {
    console.warn("[Ingestion] Failed to ingest external clip:", (err as Error).message?.slice(0, 100));
    return refuse("UNKNOWN", (err as Error).message?.slice(0, 160) ?? "an unnamed error", {
      mimeType: metadata.mimeType,
    });
  }
}
