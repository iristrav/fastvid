/**
 * Documentary visual mix — target % per clip type across all beats.
 * Default: 10% real video, 40% photos, 20% stock, 15% screenshots, 15% motion graphics.
 */
export type VisualMixKind =
  | "real_video"
  | "photo"
  | "stock"
  | "screenshot"
  | "motion_graphics";

export const DEFAULT_VISUAL_MIX_PERCENT: Record<VisualMixKind, number> = {
  real_video: 10,
  photo: 40,
  stock: 20,
  screenshot: 15,
  motion_graphics: 15,
};

const MIX_KINDS: VisualMixKind[] = [
  "real_video",
  "photo",
  "stock",
  "screenshot",
  "motion_graphics",
];

/** Off until ENABLE_VISUAL_MIX=true — keeps current pipeline during setup. */
export function visualMixEnabled(): boolean {
  return process.env.ENABLE_VISUAL_MIX === "true";
}

function parseMixPercent(raw: string | undefined, kind: VisualMixKind): number {
  if (!raw?.trim()) return DEFAULT_VISUAL_MIX_PERCENT[kind];
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0) return DEFAULT_VISUAL_MIX_PERCENT[kind];
  return n;
}

/** Read mix from env (VISUAL_MIX_REAL_VIDEO=10 etc.) or defaults. */
export function resolveVisualMixPercent(): Record<VisualMixKind, number> {
  return {
    real_video: parseMixPercent(process.env.VISUAL_MIX_REAL_VIDEO, "real_video"),
    photo: parseMixPercent(process.env.VISUAL_MIX_PHOTO, "photo"),
    stock: parseMixPercent(process.env.VISUAL_MIX_STOCK, "stock"),
    screenshot: parseMixPercent(process.env.VISUAL_MIX_SCREENSHOT, "screenshot"),
    motion_graphics: parseMixPercent(process.env.VISUAL_MIX_MOTION_GRAPHICS, "motion_graphics"),
  };
}

/** Integer counts summing to totalBeats (largest-remainder method). */
export function allocateMixCounts(
  totalBeats: number,
  percent: Record<VisualMixKind, number> = resolveVisualMixPercent()
): Record<VisualMixKind, number> {
  if (totalBeats <= 0) {
    return Object.fromEntries(MIX_KINDS.map((k) => [k, 0])) as Record<VisualMixKind, number>;
  }

  const sumPct = MIX_KINDS.reduce((s, k) => s + percent[k], 0);
  const scale = sumPct > 0 ? 100 / sumPct : 1;

  const raw = MIX_KINDS.map((k) => ({
    kind: k,
    exact: (totalBeats * percent[k] * scale) / 100,
  }));

  const counts = Object.fromEntries(MIX_KINDS.map((k) => [k, 0])) as Record<VisualMixKind, number>;
  let assigned = 0;

  const floors = raw.map((r) => ({
    kind: r.kind,
    floor: Math.floor(r.exact),
    frac: r.exact - Math.floor(r.exact),
  }));

  for (const f of floors) {
    counts[f.kind] = f.floor;
    assigned += f.floor;
  }

  let remaining = totalBeats - assigned;
  floors.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < floors.length && remaining > 0; i++) {
    counts[floors[i].kind]++;
    remaining--;
  }

  return counts;
}

/** Spread slot types so the same kind rarely appears back-to-back. */
export function buildInterleavedMixPlan(
  counts: Record<VisualMixKind, number>
): VisualMixKind[] {
  const remaining = { ...counts };
  const plan: VisualMixKind[] = [];
  let last: VisualMixKind | null = null;
  const total = MIX_KINDS.reduce((s, k) => s + counts[k], 0);

  for (let i = 0; i < total; i++) {
    const candidates = MIX_KINDS.filter((k) => remaining[k] > 0 && k !== last);
    const pool = candidates.length > 0 ? candidates : MIX_KINDS.filter((k) => remaining[k] > 0);
    if (!pool.length) break;

    pool.sort((a, b) => remaining[b] - remaining[a]);
    const pick = pool[0];
    plan.push(pick);
    remaining[pick]--;
    last = pick;
  }

  return plan;
}

export function planVisualMixForBeats(totalBeats: number): VisualMixKind[] {
  const counts = allocateMixCounts(totalBeats);
  return buildInterleavedMixPlan(counts);
}

export function mixKindLabel(kind: VisualMixKind): string {
  switch (kind) {
    case "real_video":
      return "real video";
    case "photo":
      return "photo";
    case "stock":
      return "stock";
    case "screenshot":
      return "screenshot";
    case "motion_graphics":
      return "motion graphics";
  }
}

/** Map adopted clip path → mix category for manifest / QA. */
export function classifyClipMixKind(filePath: string): VisualMixKind {
  const base = filePath.toLowerCase();
  if (/_ai_mgfx|_motion_|_mgfx/i.test(base)) return "motion_graphics";
  if (/_ai_fallback|_stability_|_leonardo_|scene_\d+_b\d+_ai/i.test(base)) return "motion_graphics";
  if (/screenshot|_scr_|_screen_|newspaper|headline|document scan/i.test(base)) return "screenshot";
  if (/pexels|pixabay|_pex_|person_stock|_b\d+_vid\d+/i.test(base)) return "stock";
  if (
    /_archive_|_wikivid|_hist|_gdelt|_septube|_celebrity|_person_vid|celebrity/i.test(base) &&
    !/_wiki_|_serp_|_still/i.test(base)
  ) {
    return "real_video";
  }
  if (/serp|_wiki_|openverse|unsplash|_still|_ov_|_p0_|_p2_/i.test(base)) return "photo";
  if (/\.mp4$|\.webm$/i.test(base)) return "real_video";
  return "photo";
}

export function summarizeMixPlan(plan: VisualMixKind[]): string {
  const counts = Object.fromEntries(MIX_KINDS.map((k) => [k, 0])) as Record<VisualMixKind, number>;
  for (const k of plan) counts[k]++;
  return MIX_KINDS.map((k) => `${mixKindLabel(k)}=${counts[k]}`).join(", ");
}
