/**
 * Per-video audit trail — clips successfully adopted per beat (for quality report geo checks).
 */
import * as path from "path";
import { recordGoodClipAdoption } from "./clipGoodCache";

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
    } else if (source === "archive" || source === "archive_fetch" || source.startsWith("rescue_similar") || source === "rescue_archive") {
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
