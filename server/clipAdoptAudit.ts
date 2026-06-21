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
  };
  audit.push(entry);
  recordGoodClipAdoption(entry, assetId);
}

/** Summarize adopt audit for qualityReport — sourcing mix per beat. */
export function summarizeAdoptAudit(audit: ClipAdoptEntry[]): AdoptAuditSummary {
  const bySource: Record<string, number> = {};
  const beatKeys = new Set<string>();
  let stockBeats = 0;
  let wikiBeats = 0;
  let archiveBeats = 0;
  let klingBeats = 0;
  let fallbackBeats = 0;

  for (const entry of audit) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + 1;
    beatKeys.add(`${entry.sceneIndex}:${entry.beatIndex}`);
    if (entry.source === "pexels" || entry.source === "pixabay" || entry.source === "stock") {
      stockBeats += 1;
    } else if (entry.source === "wikimedia" || entry.source === "wikimedia_video") {
      wikiBeats += 1;
    } else if (entry.source === "archive" || entry.source === "archive_fetch") {
      archiveBeats += 1;
    } else if (entry.source === "kling") {
      klingBeats += 1;
    } else if (entry.source === "fallback") {
      fallbackBeats += 1;
    }
  }

  const beatsFilled = beatKeys.size;
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
