/**
 * WHERE EACH SOURCE LOSES ITS FOOTAGE.
 *
 * ── What the existing report could and could not say ────────────────────────────────────────
 *
 * `[AssetUsageSummary]` already counts, per provider: found, validated, selected, downloaded,
 * assigned, rendered, unused. It is a good report and it answers "how much did each source
 * contribute". It cannot answer the question a render with 137 downloads and 7 used actually
 * raises, which is WHERE the other 130 went.
 *
 * The step it is missing is the picture editor. Between `downloaded` and `assigned` sits the beat
 * image judge, and that is where most of a render's candidates stop. But its verdicts live in
 * `BeatRelevanceLedger`, keyed by clip path, with no idea which provider any of them came from —
 * and the lineage ledger knows the provider and nothing about verdicts. Two complete records,
 * neither able to answer the joint question.
 *
 * ── Why a join at report time and not two more counters ─────────────────────────────────────
 *
 * Adding `visionJudged` and `visionAccepted` to `SUMMARY_COUNTERS` would mean every route that
 * judges a clip also remembering to record it against its provider. That is the seam this codebase
 * keeps rediscovering — `recordClipAdopt`, the still/moving counters, the beat verdicts, the
 * delivered set — a rule several routes must remember, remembered by one.
 *
 * Both ledgers are already complete and already keyed by clip path. Joining them at the end reads
 * what happened rather than asking every route to report it, so a new retrieval route appears in
 * this table the day it adopts its first clip, without touching this file.
 */
import type { BeatRelevanceLedger } from "./beatVisualRelevance";

/** What the picture editor did with one provider's candidates. */
export type ProviderVisionCounts = {
  /** Clips from this provider that a model actually looked at. */
  judged: number;
  /** …and said belong under the line they were being considered for. */
  fits: number;
  /** …and refused. */
  refused: number;
  /** …and could not tell. A refusal and a shrug are different outcomes. */
  unclear: number;
  /**
   * Refused, and used anyway because every alternative was refused too.
   *
   * A real picture beats a grey card — RONDE 67's product decision, kept. It is counted separately
   * because a render with many of these is not a render whose gate is working; it is a render
   * whose retrieval failed and whose gate is being overruled.
   */
  reprieved: number;
};

export type ProviderFunnelRow = ProviderVisionCounts & { provider: string };

function empty(): ProviderVisionCounts {
  return { judged: 0, fits: 0, refused: 0, unclear: 0, reprieved: 0 };
}

/**
 * The picture editor's verdicts, attributed to the source each clip came from.
 *
 * `providerOf` is injected rather than imported so this stays pure and testable: in production it
 * is the lineage ledger's `resolve`, and a clip the ledger cannot place is counted under the same
 * `UNVERIFIED` label the usage summary uses, never redistributed across the sources that can be
 * proven.
 */
export function providerVisionFunnel(params: {
  ledger: BeatRelevanceLedger;
  providerOf: (clipPath: string) => string | null | undefined;
  /** The label for a clip whose source cannot be proven. Matches the usage summary's. */
  unverifiedLabel?: string;
}): ProviderFunnelRow[] {
  const unverified = params.unverifiedLabel ?? "UNVERIFIED";
  const byProvider = new Map<string, ProviderVisionCounts>();

  for (const [clipPath, entry] of params.ledger.byClipPath) {
    const provider = params.providerOf(clipPath)?.trim() || unverified;
    const row = byProvider.get(provider) ?? empty();
    const d = entry.decision;

    /**
     * `evaluated` is the gate's own answer to "did a model look at this", and it is the only
     * honest basis for `judged`. A verdict read back from a cache is a real verdict about a real
     * look — it simply did not cost this render a call — so it counts here; what does not count is
     * a decline, which arrives with `evaluated: false`.
     */
    if (d.evaluated === false) {
      byProvider.set(provider, row);
      continue;
    }
    row.judged++;
    if (d.verdict === "fits") row.fits++;
    else if (d.verdict === "does_not_fit") row.refused++;
    else row.unclear++;
    if (d.reprieved) row.reprieved++;
    byProvider.set(provider, row);
  }

  return [...byProvider.entries()]
    .map(([provider, counts]) => ({ provider, ...counts }))
    .sort((a, b) => {
      if (a.provider === unverified) return 1;
      if (b.provider === unverified) return -1;
      return b.judged - a.judged;
    });
}

/**
 * One line per provider, plus a total. Empty when nothing was judged.
 *
 * The acceptance rate is stated because it is the number that makes a source's problem legible: a
 * provider with 40 judged and 2 fits is not contributing footage, whatever its download count says,
 * and that is invisible in a report that only counts what was adopted.
 */
export function formatProviderFunnel(rows: readonly ProviderFunnelRow[]): string[] {
  if (rows.length === 0) {
    return ["[ProviderFunnel] no clip from any provider reached the picture editor"];
  }
  const rate = (r: ProviderVisionCounts) =>
    r.judged === 0 ? "n/a" : `${Math.round((r.fits / r.judged) * 100)}%`;
  const line = (label: string, r: ProviderVisionCounts) =>
    `[ProviderFunnel] provider=${label} judged=${r.judged} fits=${r.fits} ` +
    `refused=${r.refused} unclear=${r.unclear} reprieved=${r.reprieved} accepted=${rate(r)}`;

  const total = rows.reduce<ProviderVisionCounts>((sum, r) => {
    sum.judged += r.judged;
    sum.fits += r.fits;
    sum.refused += r.refused;
    sum.unclear += r.unclear;
    sum.reprieved += r.reprieved;
    return sum;
  }, empty());

  const lines = rows.map((r) => line(r.provider, r));
  lines.push(line("TOTAL", total));

  /**
   * The finding worth spelling out. A source that supplied plenty of candidates and had almost all
   * of them refused is a RETRIEVAL problem — the queries are finding the wrong material — and it
   * reads in a table as a low number among other low numbers unless something says so.
   */
  for (const r of rows) {
    if (r.judged >= 8 && r.fits === 0) {
      lines.push(
        `[ProviderFunnel] ${r.provider} supplied ${r.judged} judged clips and NOT ONE was accepted ` +
          "— the queries sent to this source are finding the wrong material"
      );
    }
  }
  if (total.reprieved > 0 && total.reprieved >= total.fits) {
    lines.push(
      `[ProviderFunnel] ${total.reprieved} of the pictures in this film were REFUSED and used ` +
        `anyway (accepted outright: ${total.fits}) — the gate is being overruled more often than ` +
        "it is being satisfied, which is a retrieval failure rather than a gate problem"
    );
  }
  return lines;
}
