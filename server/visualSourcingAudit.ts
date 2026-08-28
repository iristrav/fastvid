/**
 * RONDE 135 — one block that says where the pictures came from and why they were refused.
 *
 * ── What was missing ─────────────────────────────────────────────────────────────────────────
 *
 * By RONDE 134 the render could say three separate things:
 *
 *     [Quality] beat image gate — attempts=34 answered=34 (fits=13 does_not_fit=21)
 *     [MismatchFeedback] 21 refusal(s) — search-preventable=16 material=5
 *     [MismatchResearch] attempts=6 produced=4 accepted=2 rejected=2
 *
 * All true, and none of them answers the question that decides what to do next: WHICH PROVIDER
 * produced the refused pictures. "21 refusals" is a fact about the render; "Pexels supplied 9
 * candidates and 8 of them were refused as present-day footage" is a fact about a source, and only
 * the second one tells anybody where to look.
 *
 * RONDE 131 already stores that — `MismatchTally.byKindAndSource` is keyed `${kind}|${source}` —
 * and nothing has ever printed it.
 *
 * ── What this is ─────────────────────────────────────────────────────────────────────────────
 *
 * A formatter. It owns no counters of its own: every number comes from tallies the render already
 * keeps (the gate's judgement counts, the mismatch tally, the research tally, the adopt audit).
 * Nothing here decides anything, and every function is pure.
 *
 * It exists because a number nobody can act on is not observability, and the whole RONDE 131-135
 * line has been about turning "it was wrong" into "here is where to look next".
 */

import {
  mismatchFault,
  summarizeMismatchKinds,
  type MismatchKind,
  type MismatchTally,
} from "./visualMismatchFeedback";

/** Every kind, in report order, so a zero is printed rather than silently missing. */
export const REPORTED_MISMATCH_KINDS: ReadonlyArray<MismatchKind> = [
  "WRONG_PERIOD",
  "MODERN_FOOTAGE",
  "WRONG_SUBJECT",
  "WRONG_PLACE",
  "WRONG_EVENT",
  "TEXT_ON_SCREEN",
  "TITLE_CARD",
  "TALKING_HEAD",
  "LOW_INFORMATION",
  "UNRELATED",
  "UNCLEAR",
];

export type ProviderOutcome = {
  provider: string;
  /** Candidates this provider supplied that the gate actually judged. */
  judged: number;
  /** Of those, how many it refused. */
  refused: number;
  /** judged - refused. Never computed at a call site — see RONDE 105 on counters that partition. */
  accepted: number;
  /** The fault this provider is refused for most often, when it has been refused at all. */
  topKind: MismatchKind | null;
};

/**
 * Per-provider outcomes, worst acceptance first.
 *
 * `judged` is derived from the refusals plus the adoptions, because those are the two things the
 * render actually records per provider. A provider that supplied candidates nobody ever judged
 * does not appear — it has no outcome to report, and inventing a zero for it would suggest the
 * gate looked and said nothing.
 */
export function summarizeProviderOutcomes(params: {
  tally: MismatchTally;
  /** provider -> clips adopted from it, from the render's own adopt audit. */
  adoptedByProvider?: ReadonlyMap<string, number>;
}): ProviderOutcome[] {
  const refusedBySource = new Map<string, number>();
  const kindsBySource = new Map<string, Map<MismatchKind, number>>();

  for (const [key, count] of params.tally.byKindAndSource) {
    const sep = key.indexOf("|");
    if (sep < 0) continue;
    const kind = key.slice(0, sep) as MismatchKind;
    const source = key.slice(sep + 1);
    if (!source) continue;
    refusedBySource.set(source, (refusedBySource.get(source) ?? 0) + count);
    let byKind = kindsBySource.get(source);
    if (!byKind) {
      byKind = new Map();
      kindsBySource.set(source, byKind);
    }
    byKind.set(kind, (byKind.get(kind) ?? 0) + count);
  }

  const providers = new Set<string>([
    ...refusedBySource.keys(),
    ...(params.adoptedByProvider?.keys() ?? []),
  ]);

  const rows: ProviderOutcome[] = [];
  for (const provider of providers) {
    const refused = refusedBySource.get(provider) ?? 0;
    const accepted = params.adoptedByProvider?.get(provider) ?? 0;
    const byKind = kindsBySource.get(provider);
    let topKind: MismatchKind | null = null;
    let topCount = 0;
    for (const [kind, n] of byKind ?? []) {
      if (n > topCount) {
        topCount = n;
        topKind = kind;
      }
    }
    rows.push({ provider, judged: refused + accepted, refused, accepted, topKind });
  }

  // Worst first: the provider costing the render the most refusals is the one to look at.
  return rows.sort((a, b) => b.refused - a.refused || a.provider.localeCompare(b.provider));
}

export type VisualSourcingAuditInput = {
  beats: number;
  visionAttempts: number;
  fits: number;
  doesNotFit: number;
  research: {
    attempts: number;
    produced: number;
    accepted: number;
    rejected: number;
  };
  tally: MismatchTally;
  adoptedByProvider?: ReadonlyMap<string, number>;
};

/**
 * The block a production log prints once per render.
 *
 * Deliberately one string rather than a stream of lines: the whole value is in reading the
 * mismatch breakdown and the provider table together, and interleaved log output separates them.
 */
export function formatVisualSourcingAudit(input: VisualSourcingAuditInput): string {
  const lines: string[] = ["[VisualSourcingAudit]"];
  lines.push(
    `  beats=${input.beats} visionAttempts=${input.visionAttempts} ` +
      `fits=${input.fits} doesNotFit=${input.doesNotFit}`
  );
  lines.push(
    `  research attempts=${input.research.attempts} produced=${input.research.produced} ` +
      `accepted=${input.research.accepted} rejected=${input.research.rejected}`
  );

  const present = new Map(summarizeMismatchKinds(input.tally).map((r) => [r.kind, r.count]));
  const shown = REPORTED_MISMATCH_KINDS.filter((k) => (present.get(k) ?? 0) > 0);
  if (shown.length > 0) {
    lines.push("  mismatchTypes:");
    for (const kind of shown) {
      const n = present.get(kind) ?? 0;
      lines.push(`    ${kind.padEnd(16)} ${String(n).padStart(3)}  (${mismatchFault(kind)})`);
    }
  }

  const providers = summarizeProviderOutcomes({
    tally: input.tally,
    adoptedByProvider: input.adoptedByProvider,
  });
  if (providers.length > 0) {
    lines.push("  providers:");
    for (const p of providers) {
      const rate = p.judged > 0 ? Math.round((p.accepted / p.judged) * 100) : 0;
      const top = p.topKind ? `  mostly=${p.topKind}` : "";
      lines.push(
        `    ${p.provider.padEnd(18)} judged=${String(p.judged).padStart(3)} ` +
          `accepted=${String(p.accepted).padStart(3)} refused=${String(p.refused).padStart(3)} ` +
          `(${String(rate).padStart(3)}%)${top}`
      );
    }
  }
  return lines.join("\n");
}

/**
 * The one sentence worth raising as a warning: a provider that supplied a lot and passed nothing.
 *
 * Reported, never acted on. RONDE 135 §8 is explicit that no provider is removed without evidence,
 * and one render is not evidence about a catalogue — it is a prompt to go and look.
 */
export function findUnproductiveProviders(
  providers: readonly ProviderOutcome[],
  minJudged = 4
): ProviderOutcome[] {
  return providers.filter((p) => p.judged >= minJudged && p.accepted === 0);
}
