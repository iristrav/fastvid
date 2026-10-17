/**
 * VIDEO 663 — TEXT IN THE PICTURE IS ONE OR TWO WORDS, AND THE VIDEO'S OWN WORDS.
 *
 * The owner, after video 662: "let ook op de tekst in beeld. Dat het maar 1 of 2 woorden zijn. En een
 * goede grootte. En relevant aan de video." Render 72 drew "breathtakingly distinct reveal" (the
 * animation floor's three longest non-filler words), "Meanwhile Brussels — Brussels often sits" and
 * "LA — climatic differences frame" (a fallback scene's name with a phrase under it).
 *
 * The rule, everywhere text is drawn over the picture (subtitles are not text in the picture):
 *
 *   - at most `MAX_ON_SCREEN_WORDS` words on a line, and a second line only on a full-frame card;
 *   - a year, a name or a place the sentence says is always relevant;
 *   - any other word only when the film says it more than once (`filmTopicWords`) — the video's
 *     subject, not the sentence's adjective — and never an adverb or an adjective by its form;
 *   - a line that cannot be said in two words (a quote, a reveal line) is switched off, not cut.
 *
 * Data graphics (charts, counters, maps) draw numbers and places, not sentences: untouched.
 */
import { ON_SCREEN_TEXT_STYLE, type ProjectTimeline, type TimelineGraphic, type TimelineText } from "./projectTimeline";

export const MAX_ON_SCREEN_WORDS = 2;
export const TOO_MANY_WORDS = "too_many_words";

const FILLER = new Set(
  (
    "the a an and or but of to in on at by for with from as is are was were be been being it its this that these those " +
    "he she they we you i his her their our your them him us there here then than so not no do does did have has had " +
    "will would can could should may might must into over under after before about also just very more most such " +
    "meanwhile however yet still today now instead moreover furthermore indeed nevertheless thus hence therefore later " +
    "finally first second third often always never even only already again sometimes usually rarely perhaps really quite almost soon " +
    "one two three every each many much some any all other another same own while when where which who whom whose what why how " +
    "de het een en of maar van te in op aan bij voor met uit als is zijn was waren wordt werd worden dit dat deze die"
  ).split(" ")
);

/** Words that read as a quality or a manner by their form: "breathtakingly", "distinct" is caught by the topic rule instead. */
const NOT_A_SUBJECT_FORM = /(?:ly|ous|ful|ive|able|ible|less|ness|ish|est|ing)$/i;
/** Particles inside a name: "van Gogh", "von Bismarck", "da Vinci". */
const NAME_PARTICLES = new Set(["von", "van", "de", "der", "den", "da", "di", "du", "la", "le", "del", "ter", "ten"]);
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);
const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?$/i;

const words = (s: string): string[] => s.replace(/[.,;:!?"“”()—–]/g, " ").split(/\s+/).filter(Boolean);
const norm = (w: string): string => w.toLowerCase().replace(/['’]s$/, "").replace(/[^\p{L}\p{N}]/gu, "");

export function wordCount(s: string | null | undefined): number {
  return words(s ?? "").length;
}

/**
 * The content words the film says in two or more of its sentences: what the video is about.
 * Lower-cased; fillers and words shorter than four letters left out.
 */
export function filmTopicWords(sentences: ReadonlyArray<{ text?: string | null }>): Set<string> {
  const seen = new Map<string, number>();
  for (const s of sentences) {
    const own = new Set(words(s.text ?? "").map(norm).filter((w) => w.length >= 4 && !FILLER.has(w)));
    for (const w of own) seen.set(w, (seen.get(w) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n >= 2).map(([w]) => w));
}

/**
 * A sentence's relevant words for the picture, at most two, in its own order: the film's topic words
 * it says (adjacent ones together), never a word that names a quality or a manner by its form. Null
 * when the sentence says none of the film's subject.
 */
export function relevantWordsIn(sentence: string, topic: ReadonlySet<string>): string | null {
  return firstSubjectWords(sentence, (n) => topic.has(n));
}

/**
 * A sentence's first word (with the next one when that qualifies too) that could name a subject at
 * all: four letters or more, not filler, not a quality or a manner by its form. The last resort of a
 * fallback scene, which must say something; never used where text is optional.
 */
export function subjectWordsIn(sentence: string): string | null {
  return firstSubjectWords(sentence, (n) => n.length >= 4 && !FILLER.has(n));
}

function firstSubjectWords(sentence: string, ok: (normalised: string) => boolean): string | null {
  const qualifies = (w: string | undefined): boolean => {
    if (!w) return false;
    const n = norm(w);
    return n.length > 0 && ok(n) && !NOT_A_SUBJECT_FORM.test(n);
  };
  for (const clause of sentence.split(/[,;:.!?—–()"“”]/)) {
    const ws = clause.split(/\s+/).filter(Boolean);
    for (let i = 0; i < ws.length; i++) {
      if (!qualifies(ws[i])) continue;
      const pair = qualifies(ws[i + 1]);
      return (pair ? `${ws[i]} ${ws[i + 1]}` : ws[i]!).replace(/[^\p{L}\p{N}\s'’-]/gu, "");
    }
  }
  return null;
}

/**
 * A label shortened to at most two words, keeping what it names:
 *   a date      → "October 1944", else its year;
 *   "Berlin, Germany" → "Berlin";
 *   a person    → "van Gogh", "Luther King" (the surname end, a particle kept with it);
 *   anything else → its first two words that are not filler.
 * Null when nothing of it survives.
 */
export function shortOnScreenLabel(label: string | null | undefined): string | null {
  const raw = (label ?? "").trim();
  if (!raw) return null;
  const beforeComma = raw.split(",")[0]!.trim();
  const ws = words(beforeComma);
  if (ws.length <= MAX_ON_SCREEN_WORDS) return ws.join(" ") || null;
  const year = ws.findIndex((w) => /^(1[0-9]{3}|20[0-9]{2})$/.test(w));
  if (year >= 0) {
    const month = ws[year - 1];
    return month && MONTHS.test(month) ? `${month} ${ws[year]}` : ws[year]!;
  }
  const capitalised = ws.every((w) => /^\p{Lu}/u.test(w) || NAME_PARTICLES.has(w.toLowerCase()) || NAME_SUFFIXES.has(w.toLowerCase()));
  if (capitalised) {
    const core = ws.filter((w) => !NAME_SUFFIXES.has(w.toLowerCase()));
    const particle = core.findIndex((w) => NAME_PARTICLES.has(w.toLowerCase()));
    if (particle >= 0 && core.length - particle <= MAX_ON_SCREEN_WORDS) return core.slice(particle).join(" ");
    return core.slice(-MAX_ON_SCREEN_WORDS).join(" ");
  }
  const kept = ws.filter((w) => !FILLER.has(w.toLowerCase()));
  return kept.slice(0, MAX_ON_SCREEN_WORDS).join(" ") || null;
}

/** Graphic types whose label is a sentence's words; data graphics draw numbers and places. */
const WORD_GRAPHICS = new Set([
  "lower_third", "name", "label", "emphasis", "location_card", "date_card", "chapter_card", "chapter_title", "title", "callout", "animated_text",
]);
/** Key-word graphics: shortening them keeps the wrong words ("breathtakingly distinct"). */
const KEYWORD_GRAPHICS = new Set(["emphasis", "callout", "animated_text"]);
/** Lines that are a sentence by nature: two words of them are not the line. */
const SENTENCE_GRAPHICS = new Set(["quote"]);
const SUBTITLE_KEYS = ["subtitle", "role", "description", "country", "region"] as const;

/**
 * The rule applied to a whole timeline, in place: every text and word graphic over the picture is at
 * most two words — shortened where it names something, switched off (`too_many_words`) where it is a
 * sentence. A second line (a card's subtitle, a role) is shortened the same way and kept only on a
 * card that IS the picture. Anything the person edited is theirs and left alone. Returns one line per
 * change.
 */
export function limitOnScreenWords(timeline: ProjectTimeline): string[] {
  const notes: string[] = [];
  for (const track of timeline.tracks) {
    if (track.kind === "TEXT") {
      for (const t of track.texts ?? []) limitText(t, notes);
    } else if (track.kind === "GRAPHICS") {
      for (const g of track.graphics ?? []) limitGraphic(g, notes);
    }
  }
  return notes;
}

/** Key-word pop-ups: the director keeps them off (or brings back a reveal of one or two words); never cut here. */
const KEYWORD_ROLES = new Set(["animated_text", "callout"]);

function limitText(t: TimelineText, notes: string[]): void {
  if (t.disabled || (t as { editedByUser?: boolean }).editedByUser) return;
  if (KEYWORD_ROLES.has(t.role ?? "")) return;
  const first = t.text.split("\n")[0]!.trim();
  if (wordCount(t.text) <= MAX_ON_SCREEN_WORDS && !t.text.includes("\n")) return;
  const role = t.role ?? "";
  /** a quote or a reveal line is a sentence: off, never cut into two words that say something else */
  if (role === "quote" || t.animation === "typewriter" && !/^(1[0-9]{3}|20[0-9]{2})$/.test(first)) {
    t.disabled = true;
    t.disabledReason = TOO_MANY_WORDS;
    notes.push(`${t.id} "${first}" — a sentence, not one or two words: switched off`);
    return;
  }
  const short = shortOnScreenLabel(first);
  if (!short) {
    t.disabled = true;
    t.disabledReason = TOO_MANY_WORDS;
    notes.push(`${t.id} "${first}" — nothing of it is one or two words: switched off`);
    return;
  }
  notes.push(`${t.id} "${t.text.replace(/\n/g, " / ")}" → "${short}"`);
  t.text = short;
}

function limitGraphic(g: TimelineGraphic, notes: string[]): void {
  if (g.disabled || (g as { editedByUser?: boolean }).editedByUser) return;
  if (SENTENCE_GRAPHICS.has(g.graphicType) && wordCount(g.label) > MAX_ON_SCREEN_WORDS) {
    g.disabled = true;
    g.disabledReason = TOO_MANY_WORDS;
    notes.push(`${g.id} ${g.graphicType} "${g.label}" — a sentence, not one or two words: switched off`);
    return;
  }
  if (!WORD_GRAPHICS.has(g.graphicType)) return;
  /** a key-word line is the sentence's words, not a name: two of them are not the line — off, never cut */
  if (KEYWORD_GRAPHICS.has(g.graphicType) && wordCount(g.label) > MAX_ON_SCREEN_WORDS) {
    g.disabled = true;
    g.disabledReason = TOO_MANY_WORDS;
    notes.push(`${g.id} ${g.graphicType} "${g.label}" — key words, not one or two: switched off`);
    return;
  }
  if (g.label && wordCount(g.label) > MAX_ON_SCREEN_WORDS) {
    const short = shortOnScreenLabel(g.label);
    if (!short) {
      g.disabled = true;
      g.disabledReason = TOO_MANY_WORDS;
      notes.push(`${g.id} ${g.graphicType} "${g.label}" — nothing of it is one or two words: switched off`);
      return;
    }
    notes.push(`${g.id} ${g.graphicType} "${g.label}" → "${short}"`);
    g.label = short;
    for (const k of ["label", "title", "name", "locationName"] as const) {
      if (typeof g.data?.[k] === "string" && wordCount(g.data[k] as string) > MAX_ON_SCREEN_WORDS) g.data[k] = short;
    }
  }
  if (!g.data) return;
  const fullFrame = g.data.primaryVisual === true;
  for (const k of SUBTITLE_KEYS) {
    const v = g.data[k];
    if (typeof v !== "string" || !v.trim()) continue;
    /** a second line only on a card that is the picture itself; over footage, the name alone */
    if (!fullFrame && g.graphicType !== "location_card") {
      delete g.data[k];
      notes.push(`${g.id} ${g.graphicType} second line "${v}" — over the picture the first line alone`);
      continue;
    }
    if (wordCount(v) <= MAX_ON_SCREEN_WORDS) continue;
    const short = shortOnScreenLabel(v);
    if (short) {
      g.data[k] = short;
      notes.push(`${g.id} ${g.graphicType} second line "${v}" → "${short}"`);
    } else {
      delete g.data[k];
      notes.push(`${g.id} ${g.graphicType} second line "${v}" — switched off`);
    }
  }
}

/** VIDEO 663 — graphics that are words over the picture (cards that ARE the picture excepted). */
const TEXT_OVER_PICTURE = new Set([...WORD_GRAPHICS, ...SENTENCE_GRAPHICS, "title_card"]);

/**
 * VIDEO 663 — EVERY TEXT OVER THE PICTURE STANDS BOTTOM LEFT.
 *
 * The owner: "de tekst moet altijd links onderin in beeld komen." Render 73 drew "BELGIUM" bottom
 * centre: a card with no position of its own fell back to the centre. Every text and word graphic over
 * the picture is placed bottom left, left-aligned, at the normal size when it had none. A card that is
 * the sentence's whole picture (`primaryVisual`), charts and maps keep their own place; anything the
 * person edited is theirs. Returns how many were moved.
 */
export function placeTextBottomLeft(timeline: ProjectTimeline): number {
  let moved = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "TEXT") {
      for (const t of track.texts ?? []) {
        if ((t as { editedByUser?: boolean }).editedByUser) continue;
        if (t.style?.position === "bottom_left" && t.style.align === "left") continue;
        t.style = { ...ON_SCREEN_TEXT_STYLE, ...(t.style ?? {}), position: "bottom_left", align: "left" };
        moved++;
      }
    } else if (track.kind === "GRAPHICS") {
      for (const g of track.graphics ?? []) {
        if ((g as { editedByUser?: boolean }).editedByUser || g.data?.primaryVisual === true || !TEXT_OVER_PICTURE.has(g.graphicType)) continue;
        if (g.style?.position === "bottom_left") continue;
        g.style = { ...ON_SCREEN_TEXT_STYLE, ...(g.style ?? {}), position: "bottom_left", align: "left" };
        moved++;
      }
    }
  }
  return moved;
}
