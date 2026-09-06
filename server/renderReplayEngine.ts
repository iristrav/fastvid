/**
 * REPLAYING A RENDER'S DECISIONS AGAINST TODAY'S CODE.
 *
 * ── What this does, and the one thing that makes it worth having ────────────────────────────
 *
 * A bundle holds facts: this fetch found asset 57488 in archive "ww2"; the editor said APPROVED
 * for that content key. This rebuilds the lineage ledger from those facts using the CURRENT
 * `ensureCuratedAssetLineageOn`, marks eligibility through the CURRENT `markEligible`, and asks
 * the CURRENT `adoptionGuardVerdict` what it makes of each adoption.
 *
 * Nothing here re-implements any of that. If the replay drew its own conclusions from its own copy
 * of the rules it would only ever prove that the copy agrees with itself; every judgement below
 * comes from the same functions the render calls.
 *
 * ── Why the diff is the output ──────────────────────────────────────────────────────────────
 *
 * The interesting number is not "how many adoptions pass" but "how many pass NOW that did not
 * THEN", because that is the question a fix is trying to answer and the question a production
 * render was being spent on. A replay that agrees with the recorded render everywhere means the
 * change under test did nothing — which is a real result, delivered for free.
 *
 * ── What a bundle cannot answer ─────────────────────────────────────────────────────────────
 *
 * Everything downstream of the adoption decision: compose, encode, the actual pixels, timing, the
 * delivered file. A replay says whether a clip would be ADOPTED, not whether the film is good.
 * `REPLAY_SCOPE_NOTE` is printed on every run so that limit travels with the numbers.
 */
import { adoptionGuardVerdict, adoptionPolicyFor, type AdoptionVisionVerdict } from "./adoptionPolicy";
import { ensureCuratedAssetLineageOn } from "./visualSourceLineage";
import type { ReplayAdoptionFact, ReplayBundle } from "./renderReplay";
import { VisualSourceLedger } from "./visualSourceLineage";

/** The floor the render applies before starting a YouTube transfer — quoted, not enforced here. */
export const YOUTUBE_MIN_DOWNLOAD_WINDOW_MS_FOR_REPORT = 12_000;

export const REPLAY_SCOPE_NOTE =
  "REPLAY — lineage, eligibility, vision requirement and the adoption guard, recomputed from " +
  "recorded facts. No fetching, no decoding, no compose. Says what would be ADOPTED, not what " +
  "the finished film looks like.";

export type ReplayDecision = {
  scene: number;
  beat: number;
  route: string;
  /** What the render decided at the time. */
  before: { eligible: boolean; allowed: boolean; code: string | null };
  /** What today's code decides from the same facts. */
  after: { eligible: boolean; allowed: boolean; code: string | null };
  vision: string;
  changed: boolean;
};

export type ReplayResult = {
  decisions: ReplayDecision[];
  /** Adoptions refused then and allowed now — the number a fix is trying to move. */
  recovered: ReplayDecision[];
  /** Allowed then and refused now — a regression, and far more important than `recovered`. */
  lost: ReplayDecision[];
  lineageOpened: number;
  fetchesWithoutPick: number;
  eligibleNow: number;
  eligibleBefore: number;
};

/**
 * The ledger, rebuilt from the fetch facts exactly as the render would build it.
 *
 * A fetch with no pick opens nothing — the same honest outcome as in the render, where such a clip
 * can never satisfy REAL_FUNNEL. Inventing a record here would make the replay optimistic in
 * precisely the case the [EligibilityGap] line exists to report.
 */
function rebuildLedger(bundle: ReplayBundle): { ledger: VisualSourceLedger; opened: number; withoutPick: number } {
  const ledger = new VisualSourceLedger({ renderId: `replay:${bundle.meta?.videoId ?? "unknown"}` });
  let opened = 0;
  let withoutPick = 0;
  for (const f of bundle.fetches) {
    if (!f.pick) {
      withoutPick += 1;
      continue;
    }
    /**
     * The render's own writer, called with the pick reconstituted from the recorded facts — not a
     * hand-built record. Only the fields the ledger reads are carried in a bundle (id, archive
     * name, media type, duration, score), so the asset row is narrowed to those; anything the
     * ledger does not read cannot change what it writes.
     */
    ensureCuratedAssetLineageOn(
      ledger,
      {
        asset: { id: f.pick.assetId, mediaType: f.pick.mediaType ?? "video" },
        archiveName: f.pick.archiveName,
        score: f.pick.score ?? 0,
      },
      f.scene,
      f.beat
    );
    opened += 1;
  }
  return { ledger, opened, withoutPick };
}

/**
 * Eligibility, written the way the render writes it: once, centrally, at the vision gate, and only
 * for a clip the ledger can already resolve. `markEligible` returning false is kept as false —
 * that IS the bug this whole line of work has been chasing, and a replay that quietly fixed it
 * would hide the thing it was built to measure.
 */
function markEligibility(ledger: VisualSourceLedger, bundle: ReplayBundle): number {
  let eligible = 0;
  for (const v of bundle.visions) {
    if (!v.contentKey) continue;
    if (ledger.markEligible(v.file, v.contentKey, "replay:vision_gate")) eligible += 1;
  }
  return eligible;
}

/** The editor's verdict for one adoption, from the recorded vision facts. */
function visionFor(bundle: ReplayBundle, a: ReplayAdoptionFact): AdoptionVisionVerdict {
  const hit = bundle.visions.find((v) => v.scene === a.scene && v.beat === a.beat);
  return (hit?.verdict ?? a.vision) as AdoptionVisionVerdict;
}

export function replayBundle(bundle: ReplayBundle): ReplayResult {
  const { ledger, opened, withoutPick } = rebuildLedger(bundle);
  const eligibleNow = markEligibility(ledger, bundle);

  const decisions: ReplayDecision[] = [];
  for (const a of bundle.adoptions) {
    const vision = visionFor(bundle, a);
    const visionFact = bundle.visions.find((v) => v.scene === a.scene && v.beat === a.beat);
    const key = visionFact?.contentKey ?? null;
    const file = visionFact?.file ?? "";
    /**
     * Eligibility as the CURRENT ledger answers it — not the recorded flag. This is the whole
     * point: a fix that opens a record earlier shows up here as a changed answer.
     */
    const eligible = key ? ledger.isEligible(file, key) : false;
    const verdict = adoptionGuardVerdict({
      source: a.route,
      eligible,
      vision,
      visionAvailable: a.visionAvailable,
    });
    const after = {
      eligible,
      allowed: verdict.allowed,
      code: verdict.allowed ? null : verdict.code,
    };
    const before = { eligible: a.eligible, allowed: a.allowed, code: a.code };
    decisions.push({
      scene: a.scene,
      beat: a.beat,
      route: a.route,
      before,
      after,
      vision,
      changed: before.allowed !== after.allowed || before.eligible !== after.eligible,
    });
  }

  return {
    decisions,
    recovered: decisions.filter((d) => !d.before.allowed && d.after.allowed),
    lost: decisions.filter((d) => d.before.allowed && !d.after.allowed),
    lineageOpened: opened,
    fetchesWithoutPick: withoutPick,
    eligibleNow,
    eligibleBefore: bundle.adoptions.filter((a) => a.eligible).length,
  };
}

/** A REAL_FUNNEL route claims a verified own visual; those are the adoptions the gates count. */
export function realFunnelDecisions(result: ReplayResult): ReplayDecision[] {
  return result.decisions.filter((d) => adoptionPolicyFor(d.route).category === "REAL_FUNNEL");
}

export function formatReplayReport(bundle: ReplayBundle, result: ReplayResult): string {
  const lines: string[] = [];
  const meta = bundle.meta;
  lines.push(REPLAY_SCOPE_NOTE);
  lines.push("");
  lines.push(
    `[Replay] video=${meta?.videoId ?? "?"} recordedAt=${meta?.recordedAt ?? "?"} ` +
      `commit=${meta?.commit ?? "?"}`
  );
  lines.push(
    `[Replay] facts: ${bundle.fetches.length} fetch, ${bundle.visions.length} vision, ` +
      `${bundle.adoptions.length} adoption`
  );
  lines.push(
    `[Replay] lineage records opened=${result.lineageOpened} ` +
      `fetchesWithoutPick=${result.fetchesWithoutPick}`
  );
  lines.push(`[Replay] eligible: then=${result.eligibleBefore} now=${result.eligibleNow}`);
  lines.push("");

  const rf = realFunnelDecisions(result);
  const rfAllowedBefore = rf.filter((d) => d.before.allowed).length;
  const rfAllowedAfter = rf.filter((d) => d.after.allowed).length;
  lines.push(`[Replay] REAL_FUNNEL adoptions: then=${rfAllowedBefore}/${rf.length} now=${rfAllowedAfter}/${rf.length}`);
  lines.push("");

  if (result.recovered.length > 0) {
    lines.push(`[Replay] RECOVERED — refused then, adopted now (${result.recovered.length}):`);
    for (const d of result.recovered) {
      lines.push(
        `  scene=${d.scene} beat=${d.beat} route=${d.route} vision=${d.vision} ` +
          `was ${d.before.code ?? "?"} (eligible=${d.before.eligible}) -> allowed (eligible=${d.after.eligible})`
      );
    }
    lines.push("");
  }

  /** Listed before the good news would be, if both are present — a regression outranks a win. */
  if (result.lost.length > 0) {
    lines.push(`[Replay] LOST — adopted then, refused now (${result.lost.length}). This is a regression:`);
    for (const d of result.lost) {
      lines.push(
        `  scene=${d.scene} beat=${d.beat} route=${d.route} vision=${d.vision} ` +
          `now ${d.after.code ?? "?"} (eligible=${d.after.eligible})`
      );
    }
    lines.push("");
  }

  /**
   * RENDER 571's UNANSWERABLE QUESTION, ANSWERED BY COUNTING.
   *
   * `attempts` was the only number that render could report, and it is the one that cannot
   * distinguish a failed transfer from a transfer that never began — the slot is claimed before
   * the download starts. Splitting on `transferStarted` is the whole point of the section: above
   * the line the routes were tried, below it they were not.
   */
  /**
   * `?? []` is backward compatibility, not defensiveness for its own sake: bundles captured before
   * this round are format version 1 with no `downloads` array, and a report must still read them.
   */
  const downloads = bundle.downloads ?? [];
  if (downloads.length > 0) {
    const d = downloads;
    const started = d.filter((x) => x.transferStarted);
    const byStatus = new Map<string, number>();
    for (const x of d) byStatus.set(x.status, (byStatus.get(x.status) ?? 0) + 1);
    lines.push(`[Replay] YouTube downloads: attempts=${d.length} transferStarted=${started.length}`);
    for (const [status, n] of [...byStatus.entries()].sort()) {
      lines.push(`  ${status.padEnd(26)} ${n}`);
    }
    /** When the budget refused them, the margin it refused them by is the actionable number. */
    const budgetBlocked = d.filter((x) => !x.transferStarted && x.remainingMs != null);
    if (budgetBlocked.length > 0) {
      const ms = budgetBlocked.map((x) => x.remainingMs!).sort((a, b) => a - b);
      lines.push(
        `  blocked before transfer with budget left: min=${ms[0]}ms max=${ms[ms.length - 1]}ms ` +
          `(floor=${YOUTUBE_MIN_DOWNLOAD_WINDOW_MS_FOR_REPORT}ms)`
      );
    }
    lines.push("");
  }

  if (result.recovered.length === 0 && result.lost.length === 0) {
    lines.push("[Replay] no adoption changed. The code under test does not move this render.");
    lines.push("");
  }

  return lines.join("\n");
}
