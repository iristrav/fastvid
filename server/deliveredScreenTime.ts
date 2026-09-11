/**
 * WHAT THE VIEWER ACTUALLY SPENDS THEIR TIME LOOKING AT.
 *
 * ── The film this exists because of ─────────────────────────────────────────────────────────
 *
 * A 76-second documentary about Berlin in 1945 opened on a modern Brink's armoured van, held it
 * for 17.4 seconds unbroken, came back to it twice more, and closed on 17 more seconds of it.
 * Measured on the delivered file:
 *
 *     one modern stock clip     36.29s  47.6%
 *     frozen near-black          4.92s   6.4%
 *     actual archival footage   35.09s  46.0%
 *
 * Every export gate passed it, and not one of them was wrong to. `assertVisualCoverageExportGate`
 * asks whether the beats were filled; they were. `MOSTLY_UNVERIFIED_CLIPS` asks whether the
 * lineage can name the source; Pexels names itself perfectly. And `bySource` — the one number an
 * operator reads to see the mix — is built as
 *
 *     bySource[source] = (bySource[source] ?? 0) + 1;
 *
 * which counts CLIPS. A clip of 36 seconds and a clip of 2 seconds count the same. So a render
 * can be half one piece of footage and report as a healthy spread of a dozen sources.
 *
 * ── What this measures, and why it is the honest number ─────────────────────────────────────
 *
 * Screen time, per source and per distinct piece of footage, as a share of the delivered film.
 * That is the quantity the viewer experiences and the only one in which "half this film is a
 * security van" is a fact rather than an impression. It is measured from the composed clip list
 * and each clip's real duration — not from beat counts, not from the number of candidates a
 * provider offered, and not from a filename.
 *
 * It decides nothing about how footage is chosen. It is a measurement, and a render that wants to
 * refuse on it does so through `screenTimeFindings` — which reports, and leaves blocking to the
 * caller and to an operator who has opted in.
 */

/** One clip as it reaches the delivered film. Repeated entries mean repeated screen time. */
export type DeliveredClip = {
  /** Path on disk. Only ever used as a fallback identity — never parsed for provenance. */
  path: string;
  /** The ledger's answer, or null when it could not name one. Never guessed from the path. */
  source: string | null;
  /**
   * The ledger's content key — the identity that makes "the same footage twice" visible.
   * Null when the resolver could not key the clip; then the path stands in, which over-counts
   * distinct footage rather than under-counting it. An honest error in the safe direction.
   */
  contentKey: string | null;
  /** Real duration of this clip in the composition, in seconds. */
  durationSec: number;
};

export type ScreenTimeShare = {
  totalSec: number;
  /** Seconds per source, highest first. */
  bySource: Array<{ source: string; sec: number; share: number }>;
  /** Seconds per distinct piece of footage, highest first. */
  byFootage: Array<{ key: string; source: string; sec: number; share: number; appearances: number }>;
};

/** The source name used when the ledger could not prove one. Matches the report's own bucket. */
export const UNPROVEN_SOURCE = "UNVERIFIED";

export function computeScreenTimeShare(clips: readonly DeliveredClip[]): ScreenTimeShare {
  const usable = clips.filter((c) => Number.isFinite(c.durationSec) && c.durationSec > 0);
  const totalSec = usable.reduce((n, c) => n + c.durationSec, 0);

  const sourceSec = new Map<string, number>();
  const footage = new Map<string, { source: string; sec: number; appearances: number }>();

  for (const clip of usable) {
    const source = clip.source?.trim() || UNPROVEN_SOURCE;
    sourceSec.set(source, (sourceSec.get(source) ?? 0) + clip.durationSec);
    const key = clip.contentKey?.trim() || clip.path;
    const entry = footage.get(key) ?? { source, sec: 0, appearances: 0 };
    entry.sec += clip.durationSec;
    entry.appearances += 1;
    footage.set(key, entry);
  }

  const share = (sec: number) => (totalSec > 0 ? sec / totalSec : 0);
  return {
    totalSec,
    bySource: [...sourceSec.entries()]
      .map(([source, sec]) => ({ source, sec, share: share(sec) }))
      .sort((a, b) => b.sec - a.sec),
    byFootage: [...footage.entries()]
      .map(([key, e]) => ({ key, source: e.source, sec: e.sec, share: share(e.sec), appearances: e.appearances }))
      .sort((a, b) => b.sec - a.sec),
  };
}

/**
 * The two shares worth refusing a film over.
 *
 * Deliberately generous, because this is a floor on craft rather than an editorial opinion. A
 * documentary may legitimately lean on one strong source; it may not BE one clip. Both defaults
 * sit well above anything a considered edit would produce and well below the 47.6% that shipped.
 */
export const MAX_SINGLE_FOOTAGE_SHARE = 0.25;
export const MAX_SINGLE_SOURCE_SHARE = 0.7;

export type ScreenTimeFinding = {
  code: "ONE_CLIP_DOMINATES" | "ONE_SOURCE_DOMINATES";
  detail: string;
};

/**
 * What the shares say, in the vocabulary the export gate already speaks.
 *
 * Returns findings; it does not throw and does not decide. A render with nothing to say returns
 * an empty list, and that empty list is itself worth printing — see `formatScreenTimeShare`.
 */
export function screenTimeFindings(
  share: ScreenTimeShare,
  limits: { maxFootage?: number; maxSource?: number } = {}
): ScreenTimeFinding[] {
  const maxFootage = limits.maxFootage ?? MAX_SINGLE_FOOTAGE_SHARE;
  const maxSource = limits.maxSource ?? MAX_SINGLE_SOURCE_SHARE;
  const out: ScreenTimeFinding[] = [];
  if (share.totalSec <= 0) return out;

  const topClip = share.byFootage[0];
  if (topClip && topClip.share > maxFootage) {
    out.push({
      code: "ONE_CLIP_DOMINATES",
      detail:
        `one piece of footage fills ${pct(topClip.share)} of the film ` +
        `(${topClip.sec.toFixed(1)}s of ${share.totalSec.toFixed(1)}s, ` +
        `${topClip.appearances} appearance(s), source=${topClip.source}, limit ${pct(maxFootage)}) — ` +
        `the viewer spends more of this film on one shot than on anything else`,
    });
  }

  const topSource = share.bySource[0];
  if (topSource && topSource.share > maxSource) {
    out.push({
      code: "ONE_SOURCE_DOMINATES",
      detail:
        `${topSource.source} fills ${pct(topSource.share)} of the film ` +
        `(${topSource.sec.toFixed(1)}s of ${share.totalSec.toFixed(1)}s, limit ${pct(maxSource)})`,
    });
  }
  return out;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

/**
 * The line every render prints about its own mix.
 *
 * Printed whether or not anything is wrong: a render that says nothing about its mix is
 * indistinguishable from one where this never ran, and the number is worth having on a good film
 * too — it is the only place the delivered mix is stated in the units the viewer experiences.
 */
export function formatScreenTimeShare(share: ScreenTimeShare, findings: ScreenTimeFinding[]): string {
  if (share.totalSec <= 0) {
    return "[ScreenTime] no clip durations available — the delivered mix could not be measured";
  }
  const sources = share.bySource
    .slice(0, 6)
    .map((s) => `${s.source}=${s.sec.toFixed(1)}s/${pct(s.share)}`)
    .join(" ");
  const top = share.byFootage[0];
  const topText = top
    ? ` longest=${pct(top.share)} (${top.sec.toFixed(1)}s, ${top.appearances}x, ${top.source})`
    : "";
  const verdict = findings.length === 0 ? " ok" : ` ${findings.map((f) => f.code).join(",")}`;
  return `[ScreenTime] total=${share.totalSec.toFixed(1)}s ${sources}${topText} —${verdict}`;
}
