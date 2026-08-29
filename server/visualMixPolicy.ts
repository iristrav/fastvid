/**
 * Documentary visual mix — target % per clip type across all beats.
 * Default: 10% real video, 40% photos, 20% stock, 15% screenshots, 15% motion graphics.
 *
 * ─── RONDE 29: what in this module IS wired, and what deliberately is not ────────────────────
 *
 * An audit found this whole file had zero callers. Two halves, two different verdicts:
 *
 * WIRED — resolveTargetMovingShare() and movingShareDeficit() below, plus classifyClipMixKind()
 * for measurement. The render counts the moving/still split of the clips it actually adopts,
 * reports it, and feeds the shortfall back into retrievalFunnel's moving-footage ranking bonus,
 * so a render that is drifting toward an all-stills montage pulls harder on video candidates.
 *
 * NOT WIRED, on purpose — allocateMixCounts / buildInterleavedMixPlan / planVisualMixForBeats.
 * These assign a REQUIRED kind to each beat slot up front ("beat 4 must be a screenshot").
 * Honouring that means overriding the beat's best-matching candidate with a worse one whose
 * only merit is being the right category, which trades directly against the primary goal that
 * every image match its narration. A target the ranking leans toward is the right shape here;
 * a quota the selection must satisfy is not. They stay as they are rather than being deleted,
 * per the standing rule that dead code is only removed once something has replaced it.
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

// ─── RONDE 29: moving-footage target (the wired half — see the file header) ───────────────────

/**
 * Share of a render's adopted clips that should be MOVING footage rather than a still panned
 * with Ken Burns.
 *
 * RONDE 161 — 0.80, on the owner's instruction: "gebruik zoveel mogelijk echte beelden in plaats
 * van afbeeldingen".
 *
 * The number that made the change necessary is render 553's own:
 *
 *     [Quality] Video 553: visual mix — 7/10 moving (70%), 3 still
 *
 * Seventy per cent, and the render applied NO pressure toward video at any point, because
 * movingShareDeficit returns 0 the moment the share reaches the target and 0.45 had been passed
 * long before. The ranking bonus existed and was dormant for the whole render. Raising the target
 * is what turns it back on for exactly the renders this instruction is about.
 *
 * 0.80 rather than 1.0 deliberately. This is a TARGET the ranking leans toward, not a quota the
 * selection must satisfy — see the file header. A photograph that is the only material matching
 * its narration still wins, because the alternative is not a better picture, it is a placeholder
 * card. Match still beats motion; motion now wins every tie that is not a match.
 *
 * The previous value and its reasoning, kept because it is the argument against going further:
 * 0.45 was chosen "deliberately below half, because for many historical subjects the best-MATCHING
 * material genuinely is photographic". That remains true for some beats, which is why the
 * mechanism is a bonus and not a cap, and why archiveMaxImageClipsPerVideo was NOT tightened in
 * the same round — a hard cap on photos produces coloured cards, not footage.
 */
export const DEFAULT_TARGET_MOVING_SHARE = 0.8;

/** Read the target from env (TARGET_MOVING_SHARE=0.45), clamped to 0–1. */
export function resolveTargetMovingShare(): number {
  const raw = process.env.TARGET_MOVING_SHARE?.trim();
  if (!raw) return DEFAULT_TARGET_MOVING_SHARE;
  const n = parseFloat(raw);
  if (isNaN(n) || n < 0 || n > 1) return DEFAULT_TARGET_MOVING_SHARE;
  return n;
}

/**
 * Below this many adopted clips the running share is noise — one still out of one clip is a
 * 100% deficit and would hand the very next candidate the maximum bonus on no evidence.
 */
export const MIN_MIX_SAMPLE = 3;

/**
 * How far below the target this render's moving-footage share currently sits, as 0–1.
 *
 * 0 means "at or above target, or too early to tell" — the neutral value, which leaves the
 * ranking bonus exactly where RONDE 27 set it. 1 means "not a single moving clip so far".
 * Pure function of two counters: no I/O, no state, directly testable.
 */
export function movingShareDeficit(
  movingCount: number,
  totalCount: number,
  target: number = resolveTargetMovingShare()
): number {
  if (totalCount < MIN_MIX_SAMPLE || target <= 0) return 0;
  const share = movingCount / totalCount;
  if (share >= target) return 0;
  return Math.min(1, (target - share) / target);
}

/** One-line moving/still summary for the quality report. */
export function summarizeMovingShare(movingCount: number, stillCount: number): string {
  const total = movingCount + stillCount;
  if (total === 0) return "no clips adopted";
  const pct = Math.round((movingCount / total) * 100);
  return `${movingCount}/${total} moving (${pct}%), ${stillCount} still`;
}

export function summarizeMixPlan(plan: VisualMixKind[]): string {
  const counts = Object.fromEntries(MIX_KINDS.map((k) => [k, 0])) as Record<VisualMixKind, number>;
  for (const k of plan) counts[k]++;
  return MIX_KINDS.map((k) => `${mixKindLabel(k)}=${counts[k]}`).join(", ");
}
