/**
 * RONDE 95 — THE BOUNDED PER-BEAT SHORTLIST, AND THE VISION BOUNDARY IT DRAWS.
 *
 * ── What RONDE 94 left, and why a shortlist is the next thing ───────────────────────────────
 *
 * RONDE 94 made the adoption boundary real: a route claiming REAL_FUNNEL must show eligibility and
 * an APPROVED verdict, or its clip does not enter the montage. That closed the exit. It did nothing
 * about the entrance, and render 568 measured what the entrance looks like:
 *
 *     [VisualFunnel] TOTAL retrieved=3995 eligible=4
 *     beat image gate — attempts=38 answered=38 … never_asked=21
 *     240 image-gate moments not asked
 *
 * Four thousand candidates, thirty-eight questions, and no rule anywhere about WHICH thirty-eight.
 * The picture editor was asked about whatever happened to arrive first at whichever route ran
 * first. A gate that refuses bad adoptions cannot make a good film if nobody ever offers it a good
 * candidate, and nothing in the pipeline decided what to offer.
 *
 * ── What this module is ─────────────────────────────────────────────────────────────────────
 *
 * One per-beat record of the funnel, and one bounded admission list: the candidates this beat is
 * allowed to spend a judgement on. It is NOT a second ranking engine and it retrieves nothing — the
 * existing routes rank and retrieve exactly as they did. It answers one question the pipeline could
 * not previously answer at all: *may this candidate be put to the editor for this beat?*
 *
 * The shortlist is therefore the explicit vision boundary. A candidate that is not admitted is not
 * judged; a candidate that is not judged cannot be APPROVED; and RONDE 94 already refuses a
 * REAL_FUNNEL claim without an approval. So the rule the brief asks for — a candidate outside the
 * shortlist may not later sneak in as REAL_FUNNEL by another route — falls out of the existing
 * enforcement rather than needing a second gate of its own.
 *
 * ── Where the bound comes from ──────────────────────────────────────────────────────────────
 *
 * Not a number picked because it looked reasonable. `MAX_JUDGEMENTS_PER_BEAT` (4) is the existing,
 * documented ceiling on how many judgements one beat may actually spend; its doc calls it "a
 * budget, not a quality setting". A shortlist smaller than that would starve a beat the gate was
 * willing to serve, and one much larger would admit candidates the gate can never reach.
 *
 * The gap between the two is real, though: several of the gate's answers cost no judgement at all
 * — a render-scoped cache hit, a durable-store hit, a decline for an unreadable frame — so a beat
 * can consume shortlist slots without consuming its judgement budget. Twice the ceiling is the
 * headroom for exactly that, and it is where the brief's own example lands.
 */
import { MAX_JUDGEMENTS_PER_BEAT } from "./beatImageRelevanceGate";

function envInt(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** How many candidates one beat may put to the picture editor. Derived, not invented — see above. */
export function maxShortlistPerBeat(): number {
  return envInt("MAX_BEAT_SHORTLIST", MAX_JUDGEMENTS_PER_BEAT * 2, 1, 40);
}

/**
 * RONDE 95 PHASE 10 — WHY THIS BEAT'S PICTURE WAS NEVER PUT TO THE EDITOR.
 *
 * Render 568 reported `verification=never_asked reason=real_footage_never_judged` on 15 of 17
 * beats. That reason is a restatement of the question. These are the answers a render can actually
 * distinguish, and every one of them is produced by real runtime state at the moment it happens —
 * none is inferred afterwards from a counter, which is how "never_asked" became a single bucket in
 * the first place.
 */
export type NotAskedReason =
  /** Retrieval returned nothing at all for this beat. */
  | "NO_CANDIDATES"
  /** Candidates existed; none survived the deterministic eligibility filters. */
  | "NO_ELIGIBLE_CANDIDATES"
  /** Eligible candidates existed but the shortlist for this beat was never populated. */
  | "SHORTLIST_EMPTY"
  /** The beat's shortlist was full — this candidate arrived after the bound was reached. */
  | "SHORTLIST_FULL"
  /** The render's or the beat's judgement budget was spent before this candidate. */
  | "VISION_BUDGET_EXHAUSTED"
  /** The picture editor could not be reached at all in this process. */
  | "VISION_UNAVAILABLE"
  /** The same asset was already handled for this beat. */
  | "DUPLICATE"
  /** The editor looked and said no. Recorded here so the beat's story is complete. */
  | "REJECTED_BY_EDITOR"
  /** The editor looked and could not tell. */
  | "UNCLEAR_BY_EDITOR"
  /** The provider errored, timed out, or was in cooldown. */
  | "PROVIDER_FAILURE"
  /** The candidate was chosen but the bytes never arrived. */
  | "DOWNLOAD_FAILURE"
  /** The bytes arrived but trim/transcode/still-to-video failed. */
  | "PREPARATION_FAILURE"
  /** The route that would have supplied this beat never ran. */
  | "NOT_REACHED"
  /** An adoption policy refused the route before any picture question arose. */
  | "POLICY_BLOCKED";

/** The five states a candidate's vision outcome can be in. Only APPROVED is a positive selection. */
export type BeatVisionOutcome =
  | "APPROVED"
  | "REJECTED"
  | "UNCLEAR"
  | "NOT_ASKED"
  | "VISION_UNAVAILABLE";

/**
 * One beat's funnel, in the order the pipeline actually walks it.
 *
 * Every field is a count of things that happened, written at the moment they happened. Nothing
 * here is derived from anything else here — the point of the record is that the stages can be
 * compared, and two numbers that are computed from one another cannot disagree and so cannot
 * reveal anything.
 */
export type BeatFunnel = {
  sceneIndex: number;
  beatIndex: number;
  retrieved: number;
  normalized: number;
  deduped: number;
  eligible: number;
  ranked: number;
  shortlisted: number;
  visionAsked: number;
  approved: number;
  rejected: number;
  unclear: number;
  unavailable: number;
  notAsked: number;
  /** Content keys admitted to this beat's shortlist, so a re-ask is not a second slot. */
  admitted: Set<string>;
  /** Candidates turned away because the bound was already reached. */
  refusedForCap: number;
  notAskedReasons: Map<NotAskedReason, number>;
};

export type BeatShortlistState = {
  beats: Map<string, BeatFunnel>;
};

export function createBeatShortlistState(): BeatShortlistState {
  return { beats: new Map() };
}

const key = (sceneIndex: number, beatIndex: number): string => `${sceneIndex}:${beatIndex}`;

export function beatFunnel(
  state: BeatShortlistState,
  sceneIndex: number,
  beatIndex: number
): BeatFunnel {
  const k = key(sceneIndex, beatIndex);
  const existing = state.beats.get(k);
  if (existing) return existing;
  const fresh: BeatFunnel = {
    sceneIndex,
    beatIndex,
    retrieved: 0,
    normalized: 0,
    deduped: 0,
    eligible: 0,
    ranked: 0,
    shortlisted: 0,
    visionAsked: 0,
    approved: 0,
    rejected: 0,
    unclear: 0,
    unavailable: 0,
    notAsked: 0,
    admitted: new Set<string>(),
    refusedForCap: 0,
    notAskedReasons: new Map<NotAskedReason, number>(),
  };
  state.beats.set(k, fresh);
  return fresh;
}

/** Candidates a retrieval route produced for this beat, before any filter. */
export function noteRetrieved(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  count: number,
  opts: { normalized?: number; deduped?: number } = {}
): void {
  if (!state || count < 0) return;
  const f = beatFunnel(state, sceneIndex, beatIndex);
  f.retrieved += count;
  f.normalized += opts.normalized ?? count;
  f.deduped += opts.deduped ?? 0;
}

/** One candidate cleared this route's deterministic eligibility criteria. */
export function noteEligible(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number
): void {
  if (!state) return;
  beatFunnel(state, sceneIndex, beatIndex).eligible += 1;
}

/** One candidate was placed in a route's ranked order. */
export function noteRanked(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  count = 1
): void {
  if (!state) return;
  beatFunnel(state, sceneIndex, beatIndex).ranked += count;
}

export type ShortlistAdmission =
  | { admitted: true; alreadyOnList: boolean; slotsUsed: number; cap: number }
  | { admitted: false; reason: NotAskedReason; slotsUsed: number; cap: number };

/**
 * THE BOUNDARY. May this candidate be put to the picture editor for this beat?
 *
 * A candidate already on the list is re-admitted without taking a second slot: the same asset can
 * reach the gate twice (a rescue re-offering it, a derivative of the same source) and refusing the
 * second look would deny a beat a verdict it is entitled to for a reason that has nothing to do
 * with the bound.
 *
 * A candidate with no content identity gets a slot but is not remembered, because there is nothing
 * to remember it by. That is the conservative direction: it is counted against the beat's bound
 * rather than being waved through outside it.
 */
export function admitToShortlist(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  contentKey: string | undefined,
  cap = maxShortlistPerBeat()
): ShortlistAdmission {
  if (!state) return { admitted: true, alreadyOnList: false, slotsUsed: 0, cap };
  const f = beatFunnel(state, sceneIndex, beatIndex);
  const id = (contentKey ?? "").trim();

  if (id && f.admitted.has(id)) {
    return { admitted: true, alreadyOnList: true, slotsUsed: f.admitted.size, cap };
  }
  if (f.shortlisted >= cap) {
    f.refusedForCap += 1;
    return { admitted: false, reason: "SHORTLIST_FULL", slotsUsed: f.shortlisted, cap };
  }
  f.shortlisted += 1;
  if (id) f.admitted.add(id);
  return { admitted: true, alreadyOnList: false, slotsUsed: f.shortlisted, cap };
}

/**
 * RONDE 97 (production timeout) — HAS THIS BEAT FINISHED LOOKING?
 *
 * ── The regression this exists to fix ───────────────────────────────────────────────────────
 *
 * RONDE 95 placed the bound inside `beatClipPassesVisionGate`, which runs AFTER a candidate has
 * been downloaded, probed and transcoded. So a beat whose shortlist was full went on paying the
 * full price for every remaining candidate and then refusing it — and because the route never got
 * a success, it walked its entire candidate list, then the rescue ladder, then the guaranteed
 * ladder. The bound saved the cheap thing (a judgement) and multiplied the expensive one.
 *
 * A real render timed out at 33 minutes. That is what that shape costs.
 *
 * The bound was always meant to mean "this beat has asked enough", not "this candidate fails".
 * This is the question a candidate LOOP asks before paying for the next one, so a beat that has
 * spent its shortlist stops looking instead of failing repeatedly.
 */
export function beatShortlistExhausted(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  cap = maxShortlistPerBeat()
): boolean {
  if (!state) return false;
  const f = state.beats.get(key(sceneIndex, beatIndex));
  return Boolean(f && f.shortlisted >= cap);
}

/** Was this asset ever on this beat's shortlist? The question the adoption guard asks. */
export function isShortlisted(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  contentKey: string | undefined
): boolean {
  if (!state) return false;
  const id = (contentKey ?? "").trim();
  if (!id) return false;
  return state.beats.get(key(sceneIndex, beatIndex))?.admitted.has(id) ?? false;
}

/** A judgement was actually put to the editor for this beat. */
export function noteVisionAsked(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number
): void {
  if (!state) return;
  beatFunnel(state, sceneIndex, beatIndex).visionAsked += 1;
}

/**
 * What the editor said. REJECTED and UNCLEAR are also recorded as named non-asks, because a beat's
 * story has to be able to say "the editor looked twice and refused both" rather than reporting the
 * same emptiness as a beat nobody looked at.
 */
export function noteVisionOutcome(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  outcome: BeatVisionOutcome
): void {
  if (!state) return;
  const f = beatFunnel(state, sceneIndex, beatIndex);
  if (outcome === "APPROVED") f.approved += 1;
  else if (outcome === "REJECTED") {
    f.rejected += 1;
    bumpReason(f, "REJECTED_BY_EDITOR");
  } else if (outcome === "UNCLEAR") {
    f.unclear += 1;
    bumpReason(f, "UNCLEAR_BY_EDITOR");
  } else if (outcome === "VISION_UNAVAILABLE") {
    f.unavailable += 1;
    bumpReason(f, "VISION_UNAVAILABLE");
  } else {
    f.notAsked += 1;
  }
}

/** A named reason this candidate never reached the editor. */
export function noteNotAsked(
  state: BeatShortlistState | undefined,
  sceneIndex: number,
  beatIndex: number,
  reason: NotAskedReason
): void {
  if (!state) return;
  const f = beatFunnel(state, sceneIndex, beatIndex);
  f.notAsked += 1;
  bumpReason(f, reason);
}

function bumpReason(f: BeatFunnel, reason: NotAskedReason): void {
  f.notAskedReasons.set(reason, (f.notAskedReasons.get(reason) ?? 0) + 1);
}

/**
 * The beat's own account of why it has, or has not, a picture the editor approved.
 *
 * `reasonsFor` never returns an empty list for a beat with no approval: a beat that reached the end
 * with nothing and no recorded reason IS the render-568 defect, so it says so in those words rather
 * than printing a blank.
 */
export function reasonsFor(f: BeatFunnel): string[] {
  if (f.notAskedReasons.size > 0) {
    return [...f.notAskedReasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}×${n}`);
  }
  if (f.approved > 0) return [];
  if (f.retrieved === 0) return ["NO_CANDIDATES×1"];
  if (f.eligible === 0) return ["NO_ELIGIBLE_CANDIDATES×1"];
  if (f.shortlisted === 0) return ["SHORTLIST_EMPTY×1"];
  return ["NOT_REACHED×1"];
}

/** One line per beat, and one total. Absent beats print nothing — silence is not a zero. */
export function formatBeatShortlists(state: BeatShortlistState | undefined): string[] {
  if (!state || state.beats.size === 0) return [];
  const cap = maxShortlistPerBeat();
  const beats = [...state.beats.values()].sort(
    (a, b) => a.sceneIndex - b.sceneIndex || a.beatIndex - b.beatIndex
  );
  const lines: string[] = [
    `[BeatFunnel] shortlist cap=${cap} per beat (MAX_JUDGEMENTS_PER_BEAT=${MAX_JUDGEMENTS_PER_BEAT})`,
  ];
  const total = {
    retrieved: 0,
    eligible: 0,
    shortlisted: 0,
    visionAsked: 0,
    approved: 0,
    rejected: 0,
    unclear: 0,
    unavailable: 0,
    notAsked: 0,
    refusedForCap: 0,
  };
  for (const f of beats) {
    total.retrieved += f.retrieved;
    total.eligible += f.eligible;
    total.shortlisted += f.shortlisted;
    total.visionAsked += f.visionAsked;
    total.approved += f.approved;
    total.rejected += f.rejected;
    total.unclear += f.unclear;
    total.unavailable += f.unavailable;
    total.notAsked += f.notAsked;
    total.refusedForCap += f.refusedForCap;
    const reasons = reasonsFor(f);
    lines.push(
      `[BeatFunnel] s${f.sceneIndex}b${f.beatIndex} retrieved=${f.retrieved} eligible=${f.eligible} ` +
        `ranked=${f.ranked} shortlisted=${f.shortlisted}/${cap} visionAsked=${f.visionAsked} ` +
        `approved=${f.approved} rejected=${f.rejected} unclear=${f.unclear} ` +
        `unavailable=${f.unavailable} notAsked=${f.notAsked}` +
        (f.refusedForCap > 0 ? ` cappedOut=${f.refusedForCap}` : "") +
        (reasons.length > 0 ? ` reasons=${reasons.join(",")}` : "")
    );
  }
  lines.push(
    `[BeatFunnel] TOTAL beats=${beats.length} retrieved=${total.retrieved} eligible=${total.eligible} ` +
      `shortlisted=${total.shortlisted} visionAsked=${total.visionAsked} approved=${total.approved} ` +
      `rejected=${total.rejected} unclear=${total.unclear} unavailable=${total.unavailable} ` +
      `notAsked=${total.notAsked} cappedOut=${total.refusedForCap}`
  );
  return lines;
}

/**
 * The invariants this record exists to make checkable.
 *
 * Returns [] on a healthy render. Each finding is a statement that could not be made before,
 * because the numbers it compares did not exist side by side.
 */
export function beatShortlistViolations(state: BeatShortlistState | undefined): string[] {
  if (!state) return [];
  const cap = maxShortlistPerBeat();
  const out: string[] = [];
  for (const f of state.beats.values()) {
    const at = `s${f.sceneIndex}b${f.beatIndex}`;
    if (f.shortlisted > cap) {
      out.push(`[BeatFunnelInvariant] ${at} SHORTLIST_OVER_CAP shortlisted=${f.shortlisted} cap=${cap}`);
    }
    if (f.visionAsked > f.shortlisted) {
      out.push(
        `[BeatFunnelInvariant] ${at} VISION_OUTSIDE_SHORTLIST asked=${f.visionAsked} shortlisted=${f.shortlisted}`
      );
    }
    if (f.approved > f.visionAsked) {
      out.push(
        `[BeatFunnelInvariant] ${at} APPROVED_WITHOUT_ASK approved=${f.approved} asked=${f.visionAsked}`
      );
    }
    if (f.approved === 0 && reasonsFor(f).length === 0) {
      out.push(`[BeatFunnelInvariant] ${at} UNEXPLAINED_NO_APPROVAL`);
    }
  }
  return out;
}
