/** Documentary-safe FFmpeg xfade transitions — varied, no flash/fadewhite/black. */
export const DOCUMENTARY_MONTAGE_TRANSITIONS = [
  "dissolve",
  "smoothleft",
  "smoothright",
  "smoothup",
  "smoothdown",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "zoomin",
  "distance",
] as const;

export type DocumentaryMontageTransition = (typeof DOCUMENTARY_MONTAGE_TRANSITIONS)[number];

/** Pick a transition for clip join `joinIndex` (1..n-1) within `sceneIndex`. */
export function pickMontageXfadeTransition(sceneIndex: number, joinIndex: number): DocumentaryMontageTransition {
  const n = DOCUMENTARY_MONTAGE_TRANSITIONS.length;
  const seed = sceneIndex * 13 + joinIndex * 5 + (joinIndex % 3);
  return DOCUMENTARY_MONTAGE_TRANSITIONS[((seed % n) + n) % n]!;
}

/** Legacy stock montage — shorter, subtler mix. */
export const STOCK_MONTAGE_TRANSITIONS = ["fade", "dissolve", "smoothleft", "smoothright"] as const;

export function pickStockMontageXfadeTransition(sceneIndex: number, joinIndex: number): string {
  const n = STOCK_MONTAGE_TRANSITIONS.length;
  const seed = sceneIndex * 11 + joinIndex * 3;
  return STOCK_MONTAGE_TRANSITIONS[((seed % n) + n) % n]!;
}
