/**
 * Per-video audit trail — clips successfully adopted per beat (for quality report geo checks).
 */
import * as path from "path";
import { recordGoodClipAdoption } from "./clipGoodCache";
import type { VisualSourceLedger } from "./visualSourceLineage";

export type ClipAdoptEntry = {
  sceneIndex: number;
  beatIndex: number;
  beatText: string;
  basename: string;
  source: string;
  assetTitle?: string;
  segmentGeoLock?: string | null;
  /** Worst CLIP frame score (0–10) when vision gate ran on adopt. */
  visionScore10?: number;
  /** DB asset ID — only set for own_archive clips, used for editorial score feedback. */
  assetId?: number;
};

export type AdoptAuditSummary = {
  beatsFilled: number;
  bySource: Record<string, number>;
  stockBeats: number;
  wikiBeats: number;
  archiveBeats: number;
  klingBeats: number;
  fallbackBeats: number;
  hints: string[];
};

const MAX_ENTRIES = 120;

export function createClipAdoptAudit(): ClipAdoptEntry[] {
  return [];
}

/**
 * RONDE 86 — the audit array and the lineage ledger are two views of one event.
 *
 * Every adoption in the pipeline already flows through recordClipAdopt, and every call site
 * hands it `dedup.clipAdoptAudit`. Binding the render's ledger to that array means the lineage
 * is written at all ~20 of those sites without any of them changing, and — more importantly —
 * without a future adoption route being able to record an audit entry and forget the lineage.
 * A WeakMap keyed on the array keeps the ledger's lifetime exactly the render's: when the
 * VisualDedupState goes, so does the entry.
 */
const ledgerByAudit = new WeakMap<ClipAdoptEntry[], VisualSourceLedger>();

export function bindLineageLedger(audit: ClipAdoptEntry[], ledger: VisualSourceLedger): void {
  ledgerByAudit.set(audit, ledger);
}

export function lineageLedgerFor(audit: ClipAdoptEntry[]): VisualSourceLedger | undefined {
  return ledgerByAudit.get(audit);
}

export function recordClipAdopt(
  audit: ClipAdoptEntry[],
  sceneIndex: number,
  beatIndex: number,
  beatText: string,
  clipPath: string,
  source: string,
  assetTitle?: string,
  segmentGeoLock?: string | null,
  assetId?: number,
  visionScore10?: number
): void {
  // Deliberately BEFORE the MAX_ENTRIES guard. That cap exists to bound a log array that is
  // summarised for a report; the lineage is the record of what is in the finished video, and a
  // long render must not stop recording provenance at clip 120.
  const ledger = ledgerByAudit.get(audit);
  const route = adoptRouteForSource(source);
  if (ledger) {
    // A beat filled by the rescue ladder or by a colour card is not the same event as a beat
    // filled by the route that was supposed to fill it, and the funnel has to be able to say
    // which happened — render 536's report could name neither.
    const provider = ledger.providerFor(clipPath) ?? source;
    if (route === "fallback") ledger.countFunnel("fallback", provider);
    else if (route === "rescue" || route === "backfill") ledger.countFunnel("rescue", provider);
  }
  ledger?.recordAdoption(clipPath, {
    sceneIndex,
    beatIndex,
    sourceLabel: source,
    assetTitle: assetTitle?.trim() || undefined,
    archiveAssetId: typeof assetId === "number" ? assetId : undefined,
    visionScore10:
      typeof visionScore10 === "number" && visionScore10 > 0 ? Math.round(visionScore10) : undefined,
    query: beatText?.slice(0, 160) || undefined,
    route,
    // Only used when the ledger has never seen this clip — an adoption route that produced its
    // file without going through putCachedProviderAsset. The source label is then the most
    // specific true thing available, which still beats reading the filename.
    provider: source,
  });

  if (audit.length >= MAX_ENTRIES) return;
  const entry: ClipAdoptEntry = {
    sceneIndex,
    beatIndex,
    beatText,
    basename: path.basename(clipPath),
    source,
    assetTitle: assetTitle?.trim() || undefined,
    segmentGeoLock: segmentGeoLock ?? undefined,
    visionScore10:
      typeof visionScore10 === "number" && visionScore10 > 0 ? Math.round(visionScore10) : undefined,
    assetId: typeof assetId === "number" ? assetId : undefined,
  };
  audit.push(entry);
  recordGoodClipAdoption(entry, assetId);
}

/**
 * Which of the ledger's routes an adopt-audit source label describes.
 *
 * The labels are the pipeline's own vocabulary and already encode this: "rescue_*" is the rescue
 * ladder, "fallback"/"rescue_placeholder" is a colour card, and everything else is a beat filled
 * by the route that was supposed to fill it.
 */
export function adoptRouteForSource(source: string): "primary" | "fallback" | "rescue" | "backfill" | "graphic" {
  const s = (source ?? "").trim().toLowerCase();
  if (s === "fallback" || s === "rescue_placeholder") return "fallback";
  if (s.startsWith("rescue_")) return "rescue";
  if (s === "guaranteed" || s.startsWith("backfill") || s === "rescue_extend" || s === "extend") {
    return "backfill";
  }
  if (s === "motion_graphic" || s === "graphic" || s === "mgfx") return "graphic";
  return "primary";
}

/** Summarize adopt audit for qualityReport — sourcing mix per beat. */
export function summarizeAdoptAudit(audit: ClipAdoptEntry[]): AdoptAuditSummary {
  const bySource: Record<string, number> = {};
  for (const entry of audit) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
  }

  // Production finding: recordClipAdopt can be called more than once for the SAME
  // sceneIndex+beatIndex — independent recovery layers (compose-time rescue, strict-refill
  // "already attempted" guaranteed-fill, emergency-finish, Path A/B rescue loops, ...) can each
  // re-attempt the same beat and each record their own adopt entry. Counting every entry toward
  // fallbackBeats/stockBeats/etc. double-counted those re-attempts as separate beats — a real
  // render logged "35/14 filled beat(s) used the color/text fallback", which is impossible if
  // beatsFilled (14) is genuinely the number of unique beats. Each unique beat now contributes
  // its FINAL recorded source exactly once — later entries for the same beat are presumed to
  // reflect that beat's more current state (the same assumption the render pipeline itself makes
  // when a later recovery layer re-adopts a beat).
  // Final review round — Bug 2: several guaranteed-fill call sites record scene-level "padding"
  // adopt entries under a sentinel beatIndex (999, 1001, 8888, 9999, and the 2000+slot range used
  // by appendGuaranteedSceneClips) specifically so they can never collide with a real narrative
  // beatIndex. Those sentinel entries don't correspond to one of the scene's actual narrative
  // beats — counting them here would inflate beatsFilled past the true beat count (e.g. 14 real
  // narrative beats + 6 sentinel entries must still report beatsFilled = 14, not 20).
  const isSentinelBeatIndex = (beatIndex: number): boolean =>
    beatIndex >= 2000 || beatIndex === 999 || beatIndex === 1001 || beatIndex === 8888 || beatIndex === 9999;

  const finalSourceByBeat = new Map<string, string>();
  for (const entry of audit) {
    if (isSentinelBeatIndex(entry.beatIndex)) continue;
    finalSourceByBeat.set(`${entry.sceneIndex}:${entry.beatIndex}`, entry.source);
  }

  let stockBeats = 0;
  let wikiBeats = 0;
  let archiveBeats = 0;
  let klingBeats = 0;
  let fallbackBeats = 0;

  for (const source of finalSourceByBeat.values()) {
    if (source === "pexels" || source === "pixabay" || source === "stock" || source === "rescue_stock") {
      stockBeats += 1;
    } else if (source === "wikimedia" || source === "wikimedia_video") {
      wikiBeats += 1;
    } else if (
      source === "archive" || source === "archive_fetch" ||
      source.startsWith("rescue_similar") || source === "rescue_archive" ||
      // RONDE 51: the real provider names the scene-pool path reports. These are archives —
      // Internet Archive, Library of Congress, NARA, NASA, Openverse, media.ccc.de — but none of
      // them matched any branch, so a beat filled from one of them counted toward beatsFilled
      // and toward no category at all. Render 530 reported "beats=13 wiki=0 arch=7 stock=0"
      // while six of those thirteen beats had come from exactly these sources.
      source === "internet_archive" || source === "loc" || source === "nara" ||
      source === "nasa" || source === "openverse" || source === "mediaccc" ||
      source === "europeana" || source === "gdelt" || source === "sepiasearch" ||
      source === "flickr" || source === "rescue_wikimedia"
    ) {
      archiveBeats += 1;
    } else if (source === "kling" || source === "rescue_ai") {
      klingBeats += 1;
    } else if (source === "fallback" || source === "rescue_placeholder") {
      fallbackBeats += 1;
    }
  }

  const beatsFilled = finalSourceByBeat.size;
  const hints: string[] = [];
  if (beatsFilled > 0 && wikiBeats === 0 && archiveBeats === 0) {
    hints.push("Alle beats via stock/Kling — upload meer relevant archief (vision + semantic match).");
  }
  if (stockBeats > beatsFilled * 0.5 && beatsFilled >= 3) {
    hints.push(`${stockBeats}/${beatsFilled} beats uit stock — meer archiefclips helpen (geen geo-tags nodig).`);
  }
  if (klingBeats > 0) {
    hints.push(`${klingBeats} Kling-clip(s) — controleer of archief/stock beter kan matchen.`);
  }
  if (fallbackBeats > 0) {
    hints.push(`${fallbackBeats} kleur-fallback beat(s) — sourcing faalde op die zinnen.`);
  }

  return {
    beatsFilled,
    bySource,
    stockBeats,
    wikiBeats,
    archiveBeats,
    klingBeats,
    fallbackBeats,
    hints,
  };
}
