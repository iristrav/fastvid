/**
 * WHO PUBLISHED THIS — as a class, not as a list of channels.
 *
 * ── What the audit found ────────────────────────────────────────────────────────────────────
 *
 * `youtubePoolSource.ts` captures `channel: snippet.channelTitle?.trim() || null` and
 * `publishedAt`, stores both on every candidate, and NOTHING READS EITHER. A search on
 * `channelAuthority`, `sourceAuthority`, `authorityScore` and `institutional` returns nothing
 * outside tests. So a national archive, a public broadcaster, a university and an anonymous
 * re-uploader are indistinguishable to the ranking: all four score `youtube_cc: 55`.
 *
 * ── Why a classifier and not a whitelist ────────────────────────────────────────────────────
 *
 * A list of approved channels is unmaintainable and, worse, topic-bound: whoever writes it writes
 * the channels for the videos they happen to be making, and the next subject gets nothing. It is
 * also the hardcoding this architecture exists to remove.
 *
 * What generalises is the VOCABULARY institutions use about themselves. An archive says "archive",
 * "archief", "archivo"; a museum says "museum"; a university says "university" or "universiteit".
 * Those words are in the channel title and the description, in whatever language the institution
 * publishes in, and they are not subject matter — they are what kind of body is speaking. A
 * pattern over that vocabulary works for a Japanese economics video and a Dutch wartime one alike.
 *
 * ── What this is allowed to do ──────────────────────────────────────────────────────────────
 *
 * Produce a CLASS and a confidence. Nothing else. It is never an approval: a clip from a museum
 * still has to pass eligibility, the shortlist, the vision verdict and the adoption guard exactly
 * as before, and a clip from an unknown channel is refused by none of them for that reason. The
 * class is a ranking signal and a line in the report.
 */

/**
 * The classes, strongest evidence of institutional provenance first.
 *
 * `CREATOR` is not a criticism — a great deal of the best material on the platform is made by
 * individuals — it is simply the absence of an institutional claim. `UNKNOWN` is the honest answer
 * when there is no text to judge at all, and is deliberately distinct from `CREATOR`: one says
 * "nobody claimed anything", the other says "we could not look".
 */
export type ChannelAuthorityClass =
  | "GOVERNMENT"
  | "ARCHIVE"
  | "MUSEUM"
  | "UNIVERSITY"
  | "PUBLIC_BROADCASTER"
  | "NEWS"
  | "DOCUMENTARY"
  | "EDUCATIONAL"
  | "CREATOR"
  | "UNKNOWN";

export type ChannelAuthority = {
  authorityClass: ChannelAuthorityClass;
  /** 0..1 — how strongly the text supports the class. `CREATOR`/`UNKNOWN` always score 0. */
  confidence: number;
  /** The words that decided it, so a surprising class can be explained rather than argued about. */
  matched: readonly string[];
};

/**
 * The vocabulary, per class.
 *
 * Multilingual on purpose: an institution publishing in its own language is exactly the case a
 * single-language pattern would miss, and missing it is how a national archive ends up ranked as
 * an anonymous upload. Terms are matched on word boundaries, so "archive" does not fire on
 * "archived" — a channel DESCRIBING an archived video is not itself an archive.
 *
 * Ordered by how specific the claim is. "Bundesarchiv" is a stronger statement than "history".
 */
const VOCABULARY: ReadonlyArray<{ cls: ChannelAuthorityClass; terms: readonly string[] }> = [
  {
    cls: "GOVERNMENT",
    terms: [
      "ministry", "ministerie", "ministerio", "ministère", "government", "overheid", "gobierno",
      "gouvernement", "regierung", "parliament", "parlement", "senate", "congress", "rijksoverheid",
      "federal", "bundes", "national agency", "agency for",
    ],
  },
  {
    cls: "ARCHIVE",
    terms: [
      "archive", "archives", "archief", "archieven", "archivo", "archiv", "archives nationales",
      "bundesarchiv", "national archives", "filmarchive", "film archive", "sound archive",
      "beeld en geluid", "institut national", "library of congress", "national library",
    ],
  },
  {
    cls: "MUSEUM",
    terms: ["museum", "musea", "musée", "museo", "gallery", "galerie", "collection", "collectie", "rijksmuseum"],
  },
  {
    cls: "UNIVERSITY",
    terms: [
      "university", "universiteit", "universidad", "université", "universität", "college",
      "institute of technology", "faculty", "faculteit", "school of", "academy", "academia",
    ],
  },
  {
    cls: "PUBLIC_BROADCASTER",
    terms: [
      "public broadcaster", "publieke omroep", "broadcasting corporation", "rundfunk", "omroep",
      "radiotelevisione", "televisión española", "public television", "public radio",
    ],
  },
  {
    cls: "NEWS",
    terms: ["news", "nieuws", "noticias", "nachrichten", "journal", "press", "reuters", "newsroom", "bulletin"],
  },
  {
    cls: "DOCUMENTARY",
    terms: ["documentary", "documentaire", "documental", "dokumentation", "docu", "films about"],
  },
  {
    cls: "EDUCATIONAL",
    terms: ["education", "educational", "onderwijs", "lessons", "lecture", "lezing", "course", "curriculum", "teaching"],
  },
];

/** How much a class is worth as evidence of institutional provenance. */
const CONFIDENCE: Readonly<Record<ChannelAuthorityClass, number>> = {
  GOVERNMENT: 1,
  ARCHIVE: 1,
  MUSEUM: 0.9,
  UNIVERSITY: 0.85,
  PUBLIC_BROADCASTER: 0.85,
  NEWS: 0.6,
  DOCUMENTARY: 0.5,
  EDUCATIONAL: 0.45,
  CREATOR: 0,
  UNKNOWN: 0,
};

const wordBoundary = (term: string): RegExp =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^\\p{L}\\p{N}]|$)`, "iu");

/**
 * Classify a channel from the text it publishes about itself.
 *
 * `channel` is weighted over `description` implicitly: the channel NAME is the institution's own
 * claim about what it is, while a description can mention a museum without being one. Both are
 * read, and the name is checked first so a name match wins the class.
 *
 * Returns `UNKNOWN` — never `CREATOR` — when there is no text at all. The difference matters: a
 * ranking that treats "we could not look" as "an individual" is asserting something it does not
 * know, which is the class of guess this codebase keeps removing.
 */
export function classifyChannelAuthority(
  channel: string | null | undefined,
  description?: string | null
): ChannelAuthority {
  const name = (channel ?? "").trim();
  const desc = (description ?? "").trim();
  if (!name && !desc) return { authorityClass: "UNKNOWN", confidence: 0, matched: [] };

  for (const haystack of [name, desc]) {
    if (!haystack) continue;
    for (const { cls, terms } of VOCABULARY) {
      const matched = terms.filter((t) => wordBoundary(t).test(haystack));
      if (matched.length > 0) {
        return { authorityClass: cls, confidence: CONFIDENCE[cls], matched };
      }
    }
  }
  /** Text was available and claimed nothing institutional. That is a finding, not an absence. */
  return { authorityClass: "CREATOR", confidence: 0, matched: [] };
}

/** One field for the report — never a decision, and never on its own a reason to adopt. */
export function formatChannelAuthority(a: ChannelAuthority): string {
  return a.matched.length > 0
    ? `${a.authorityClass}(${a.confidence.toFixed(2)}:${a.matched.slice(0, 2).join("+")})`
    : `${a.authorityClass}(${a.confidence.toFixed(2)})`;
}
