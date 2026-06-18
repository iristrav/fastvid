/**
 * Per-video audit trail — clips successfully adopted per beat (for quality report geo checks).
 */
import * as path from "path";

export type ClipAdoptEntry = {
  sceneIndex: number;
  beatIndex: number;
  beatText: string;
  basename: string;
  source: string;
  assetTitle?: string;
  segmentGeoLock?: string | null;
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
  segmentGeoLock?: string | null
): void {
  if (audit.length >= MAX_ENTRIES) return;
  audit.push({
    sceneIndex,
    beatIndex,
    beatText,
    basename: path.basename(clipPath),
    source,
    assetTitle: assetTitle?.trim() || undefined,
    segmentGeoLock: segmentGeoLock ?? undefined,
  });
}
