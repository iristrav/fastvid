/**
 * WHAT KIND OF FAILURE THIS WAS — RONDE 629.
 *
 * ── Why a classifier, when `ffmpegComplaint` already exists ─────────────────────────────────
 *
 * RONDE 601 built `ffmpegComplaint` to answer "what did ffmpeg SAY", and it does that well. This
 * answers a different question — "what KIND of thing went wrong" — because a recovery strategy
 * cannot be selected from a sentence. A geometry mismatch and a missing input file arrive as prose
 * and need opposite responses: one is repaired by re-encoding a segment, the other by rehydrating
 * an asset.
 *
 * This is deliberately NOT a second diagnostic system. It consumes `ffmpegComplaint`'s output and
 * the same stderr, and adds no probing of its own. The evidence for the geometry classes comes from
 * RONDE 627's `probeSegmentShape`, which already runs on a failed join.
 *
 * ── The one rule that shapes every pattern below ────────────────────────────────────────────
 *
 * ffmpeg prints the CONSEQUENCE louder than the CAUSE. Render 599's four lines were three
 * consequences and one stream number:
 *
 *     [auto_scale_11 @ 0x…] Failed to configure output pad on auto_scale_11
 *     Error reinitializing filters!
 *     Failed to inject frame into filter network: Resource temporarily unavailable
 *     Error while processing the decoded data for stream #10:0
 *
 * So a classifier that reads the first line it sees would call that RESOURCE, on the strength of
 * the words "Resource temporarily unavailable" in a line that is about a filter graph refusing a
 * frame. Every pattern here is therefore matched against the WHOLE stderr and ordered most
 * specific first, and the consequence lines are never allowed to decide on their own.
 *
 * `auto_scale` is the exception that proves it: ffmpeg only inserts an auto-scaler when two links
 * disagree about size or format, so its failure IS evidence of a geometry-family fault even though
 * the line itself names no dimensions.
 *
 * ── UNKNOWN is a real answer ────────────────────────────────────────────────────────────────
 *
 * A failure nothing here recognises is `UNKNOWN`, and `UNKNOWN` means "do not guess a recovery".
 * Inventing a class for an unmatched string would send the recovery engine down a strategy chosen
 * by a coincidence of wording, which is worse than admitting the classifier has not met this
 * failure before.
 */

export type FfmpegFailureClass =
  /** Two inputs disagree about width/height, or an auto-scaler could not reconcile them. */
  | "GEOMETRY"
  /** Two inputs disagree about pixel format, or no conversion between them exists. */
  | "PIXEL_FORMAT"
  /** Two inputs arrive on different time bases. */
  | "TIMEBASE"
  /** The filter graph is malformed, or a named filter is missing from this build. */
  | "FILTER_GRAPH"
  /** A `-map` names a stream or label that does not exist. */
  | "STREAM_MAPPING"
  /** The encoder or decoder asked for is not available. */
  | "CODEC"
  /** Memory or disk ran out. */
  | "RESOURCE"
  /** The bytes of an input could not be decoded. */
  | "DECODE"
  /** Audio and video disagree about length or timestamps. */
  | "AUDIO_VIDEO_MISMATCH"
  /** The container could not be written. */
  | "MUX"
  /** An input file is not there. */
  | "INPUT_MISSING"
  /** Our own wrapper cut the call off. */
  | "TIMEOUT"
  /** Nothing here recognised it. Never a licence to pick a recovery at random. */
  | "UNKNOWN";

/**
 * Ordered most specific first. The first rule whose pattern appears anywhere in the text wins, so
 * a rule that could also match a consequence line must sit below the rule that names the cause.
 */
const RULES: ReadonlyArray<{ cls: FfmpegFailureClass; re: RegExp }> = [
  /** Our own wrapper's message, which is not ffmpeg's and must not be read as one. */
  { cls: "TIMEOUT", re: /\bTimeout:\s|\bexceeded \d+s\b/ },

  /** The size line render 596 died on, and the auto-scaler that stands in for it. */
  { cls: "GEOMETRY", re: /parameters \(size \d+x\d+\) do not match/i },
  { cls: "GEOMETRY", re: /Failed to configure output pad on auto_scale/i },
  { cls: "GEOMETRY", re: /\b(?:width|height) (?:does not match|mismatch)/i },

  { cls: "PIXEL_FORMAT", re: /Impossible to convert between the formats/i },
  { cls: "PIXEL_FORMAT", re: /pixel format[^\n]*(?:do(?:es)? not match|mismatch|unsupported)/i },

  { cls: "TIMEBASE", re: /time ?base[^\n]*do(?:es)? not match/i },

  { cls: "INPUT_MISSING", re: /No such file or directory/i },

  { cls: "RESOURCE", re: /No space left on device|Cannot allocate memory|Out of memory/i },

  { cls: "CODEC", re: /Unknown encoder|Unknown decoder|Encoder not found|Decoder not found/i },
  { cls: "CODEC", re: /codec[^\n]*not (?:currently )?supported/i },

  { cls: "STREAM_MAPPING", re: /Stream map [^\n]* matches no streams/i },
  { cls: "STREAM_MAPPING", re: /Output with label '[^']*' does not exist/i },

  { cls: "FILTER_GRAPH", re: /No such filter/i },
  { cls: "FILTER_GRAPH", re: /Error (?:initializing|while initializing) (?:the )?(?:complex )?filter/i },
  { cls: "FILTER_GRAPH", re: /Invalid argument[^\n]*filter|filter[^\n]*Invalid argument/i },

  { cls: "DECODE", re: /Invalid data found when processing input/i },
  { cls: "DECODE", re: /Error while decoding|corrupt(?:ed)? (?:frame|packet|input)/i },

  { cls: "AUDIO_VIDEO_MISMATCH", re: /Non-monotonou?s (?:DTS|PTS)/i },

  { cls: "MUX", re: /Could not write header|muxer[^\n]*(?:error|fail)/i },

  /**
   * LAST, and only as a family. `Error reinitializing filters!` and
   * `Failed to inject frame into filter network` are consequences of the graph refusing a frame —
   * true of a geometry fault, a format fault and a genuine graph fault alike. Reaching this rule
   * means none of the specific patterns above matched, so the honest answer is the family the
   * symptom belongs to and not one of its possible causes.
   */
  { cls: "FILTER_GRAPH", re: /Error reinitializing filters|Failed to inject frame into filter network/i },
];

export type FfmpegFailureDiagnosis = {
  cls: FfmpegFailureClass;
  /** The line that decided it, so a reader can disagree with the classifier. */
  evidence: string;
};

/** Everything that might carry ffmpeg's words: the thrown message and its captured stderr. */
function textOf(err: unknown): string {
  if (typeof err === "string") return err;
  const e = err as { message?: unknown; stderr?: unknown } | null;
  const parts = [
    typeof e?.message === "string" ? e.message : "",
    typeof e?.stderr === "string" ? e.stderr : "",
  ];
  return parts.filter(Boolean).join("\n");
}

export function classifyFfmpegFailure(err: unknown): FfmpegFailureDiagnosis {
  const text = textOf(err);
  if (!text.trim()) return { cls: "UNKNOWN", evidence: "" };
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (!m) continue;
    /** The whole line the match sits on — a fragment out of context is not evidence. */
    const start = text.lastIndexOf("\n", m.index) + 1;
    const end = text.indexOf("\n", m.index);
    const line = text.slice(start, end === -1 ? undefined : end).trim();
    return { cls: rule.cls, evidence: line.slice(0, 300) };
  }
  return { cls: "UNKNOWN", evidence: text.split("\n")[0]?.trim().slice(0, 300) ?? "" };
}

/**
 * Do the segment shapes settle it?
 *
 * RONDE 627 probes every segment when a join fails. That probe is the only direct evidence the
 * geometry family has, so it is read here rather than re-derived: a classifier that said GEOMETRY
 * while every segment measured identical would be guessing, and one that said FILTER_GRAPH while
 * one segment was two pixels shorter would be wrong.
 *
 * Returns null when there is nothing to say — no probe, or nothing odd — so a caller can print it
 * unconditionally without inventing a finding.
 */
export function geometryEvidenceFromShapes(params: {
  cls: FfmpegFailureClass;
  reference: string | null;
  odd: ReadonlyArray<{ name: string; shape: string | null }>;
}): string | null {
  const { cls, reference, odd } = params;
  if (reference == null) return null;
  if (odd.length === 0) {
    return cls === "GEOMETRY" || cls === "PIXEL_FORMAT" || cls === "TIMEBASE"
      ? `every segment measured identical, so ${cls} is the SYMPTOM and not the cause`
      : null;
  }
  return `${odd.length} segment(s) differ from the majority: ${odd
    .map((o) => `${o.name}=${o.shape ?? "UNPROBEABLE"}`)
    .join(" | ")}`;
}

/** One line for the log, so a render's failure class is greppable across productions. */
export function formatFfmpegFailure(
  stage: string,
  d: FfmpegFailureDiagnosis,
  shapeNote?: string | null
): string {
  return (
    `[FfmpegFailure] stage=${stage} class=${d.cls} evidence="${d.evidence}"` +
    (shapeNote ? ` shapes="${shapeNote}"` : "")
  );
}

/**
 * The failure classes a SIMPLER TREATMENT can answer — RONDE 630.
 *
 * SAFE_RENDER removes effects, camera moves and transitions. That is a real answer to a graph that
 * could not be built or executed, and to the geometry family, because an auto-scaler is only
 * inserted between links a filter chain created.
 *
 * It is NOT an answer to anything else, and the omissions are the point:
 *
 *   · INPUT_MISSING and DECODE — the bytes are the problem. A missing or undecodable asset is
 *     exactly as missing without a zoompan in front of it; this is rehydration's job.
 *   · RESOURCE — a full disk does not become emptier.
 *   · CODEC — an encoder this build does not have stays absent.
 *   · MUX, AUDIO_VIDEO_MISMATCH — these happen after the picture is joined, so simplifying the
 *     picture changes nothing about them.
 *   · TIMEOUT — a second full render is the most expensive possible response to running out of time.
 *   · UNKNOWN — by definition no strategy has been shown to answer it, and guessing one here is what
 *     `UNKNOWN` exists to prevent.
 *
 * Attempting a safe render for any of these would spend a whole second render to fail the same way.
 */
export const SAFE_RENDER_ANSWERS: ReadonlySet<FfmpegFailureClass> = new Set<FfmpegFailureClass>([
  "FILTER_GRAPH",
  "GEOMETRY",
  "PIXEL_FORMAT",
  "TIMEBASE",
  "STREAM_MAPPING",
]);
