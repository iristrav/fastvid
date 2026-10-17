/**
 * VIDEO 660 — AT LEAST ONE ANIMATION IN EVERY STARTED MINUTE.
 *
 * The owner's rule: "zorg er voor dat per 1 minuut wel in elke video animatie zit. Gewoon om de
 * kijkers vast te houden." The text director (`onScreenTextDirector`) caps graphics at three moments
 * a minute; nothing guaranteed a floor, and a minute of plain footage with no card, map or year
 * left the viewer with nothing moving on top of the picture.
 *
 * Runs after the director, on the finished plan. For every started minute that has no drawn
 * graphic in it:
 *
 *   1. A graphic the PLANNER made for this minute and the director switched off only for crowding
 *      (`too_much_text_at_once`, `graphic_budget_exceeded`) comes back when nothing else is on
 *      screen beside it any more — the planner's own map, chart or card beats anything made here.
 *   2. Otherwise one is drawn from a sentence SPOKEN in that minute, from its own words, never
 *      invented: a year in the sentence becomes a year card that types; else a name the sentence
 *      says (capitalised words inside it); else its key words.
 *
 * It never lands on top of another text or graphic, never on a sentence's full-frame card, and
 * sits bottom left at the normal text size like every other text (`ON_SCREEN_TEXT_STYLE`). A minute
 * where no sentence has a free moment stays as it is and is reported in `missing`.
 */
import { ON_SCREEN_TEXT_STYLE, type ProjectTimeline, type TimelineGraphic } from "./projectTimeline";
import { graphicIsRenderable } from "./graphicsVocabulary";
import { filmTopicWords, relevantWordsIn, shortOnScreenLabel } from "./onScreenWords";

export const ANIMATION_FLOOR_ID_PREFIX = "gfx_floor_";
/** How long an added animation stays: long enough to read, short enough not to sit on the film. */
const FLOOR_MIN_SEC = 2;
const FLOOR_MAX_SEC = 3.5;
/** Into the sentence before it appears, so the voice has started the thought. */
const FLOOR_LEAD_SEC = 0.4;
const REVIVABLE = new Set(["too_much_text_at_once", "graphic_budget_exceeded"]);

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at by for with from as is are was were be been being it its this that these those " +
    "he she they we you i his her their our your them him us there here then than so not no do does did have has had " +
    "will would can could should may might must into over under after before about also just very more most such " +
    "de het een en of maar van te in op aan bij voor met uit als is zijn was waren wordt werd worden dit dat deze die " +
    "hij zij ze wij we jij je ik zijn haar hun ons onze jullie er hier daar dan niet geen doen deed heeft hebben had " +
    "zal zou kan kon moet mag ook nog al toen want omdat dus wel heel meer meest zo"
  ).split(" ")
);

export type AnimationFloorResult = {
  added: Array<{ id: string; minute: number; graphicType: string; label: string }>;
  revived: Array<{ id: string; minute: number; graphicType: string }>;
  /** Started minutes left without an animation: no sentence in them had a free moment. */
  missing: number[];
  /** Year cards added here type; the caller lays the typing sound under them. */
  typewriter: Array<{ id: string; start: number; text: string }>;
};

type Span = { start: number; end: number };
const overlaps = (a: Span, b: Span): boolean => a.start < b.end && b.start < a.end;

/** The year a sentence says, as written (1000–2099). */
export function yearIn(text: string): string | null {
  return /\b(1[0-9]{3}|20[0-9]{2})\b/.exec(text)?.[1] ?? null;
}

/**
 * VIDEO 662 — words that open a sentence or a clause and are never part of a name: render 72's
 * fallback scene read "Meanwhile Brussels" because "Meanwhile, Brussels" lost its comma first.
 */
const NEVER_A_NAME = new Set(
  (
    "meanwhile however yet still today now then instead moreover furthermore indeed nevertheless nonetheless " +
    "thus hence therefore later finally first second third besides consequently ultimately sometimes often " +
    "intussen echter toch nu toen vandaag daarna later uiteindelijk bovendien"
  ).split(" ")
);
/**
 * VIDEO 662 — adverbs are filler for a phrase too: "Brussels often sits" took "often" as a key word.
 */
const ADVERBS = new Set(
  "often always never even only already again sometimes usually rarely perhaps really quite almost still yet soon".split(" ")
);
const isFiller = (w: string): boolean => STOPWORDS.has(w.toLowerCase()) || ADVERBS.has(w.toLowerCase());

/** Lower-case words that sit inside a name: Otto von Bismarck, Vincent van Gogh. */
const NAME_PARTICLES = new Set(["von", "van", "de", "der", "den", "da", "di", "du", "la", "le", "del", "ter", "ten"]);

/**
 * A name the sentence says: a run of capitalised words (with a particle like "von" inside it), at
 * most four words. The sentence's first word counts only when the name goes on after it — a lone
 * capital at the start is just the start of a sentence.
 */
export function nameIn(text: string): string | null {
  const words = text.replace(/[.,;:!?"“”()]/g, " ").split(/\s+/).filter(Boolean);
  const cap = (w: string | undefined) =>
    !!w && /^\p{Lu}/u.test(w) && !STOPWORDS.has(w.toLowerCase()) && !NEVER_A_NAME.has(w.toLowerCase());
  let best: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!cap(words[i])) continue;
    const run: string[] = [words[i]!];
    let j = i + 1;
    while (j < words.length && run.length < 4) {
      if (cap(words[j])) run.push(words[j++]!);
      else if (NAME_PARTICLES.has(words[j]!) && cap(words[j + 1])) run.push(words[j++]!, words[j++]!);
      else break;
    }
    if (i === 0 && run.length === 1) continue;
    if (run.length > best.length) best = run;
    i = j - 1;
  }
  return best.length ? best.join(" ") : null;
}

/**
 * VIDEO 660 — a short phrase of the sentence, in reading order: the first run of two or three words
 * that are not filler, clause by clause ("By loosening monetary controls while …" → "loosening
 * monetary controls"). Null when no clause has two such words in a row.
 */
export function phraseIn(text: string): string | null {
  for (const clause of text.split(/[,;:.!?—–()"“”]/)) {
    let run: string[] = [];
    for (const w of clause.split(/\s+/).filter(Boolean)) {
      if (isFiller(w) || w.length < 3 || /^\d/.test(w)) {
        if (run.length >= 2) break;
        run = [];
        continue;
      }
      run.push(w);
      if (run.length === 3) break;
    }
    if (run.length >= 2) return run.join(" ");
  }
  return null;
}

/** The sentence's key words: the longest run of up to three words that are not filler. */
export function keyWordsIn(text: string): string | null {
  /**
   * VIDEO 662 — a run never crosses a comma or a full stop: render 72's animation read
   * "breathtakingly distinct reveal" across "distinct, reveal". Clause by clause, like `phraseIn`.
   */
  let best: string[] = [];
  const score = (r: string[]) => r.length * 100 + r.join("").length;
  for (const clause of text.split(/[,;:.!?—–()"“”]/)) {
    let run: string[] = [];
    for (const w of clause.split(/\s+/).filter(Boolean)) {
      if (isFiller(w) || w.length < 3) {
        run = [];
        continue;
      }
      run.push(w);
      if (run.length > 3) run.shift();
      if (score(run) > score(best)) best = [...run];
    }
  }
  return best.length ? best.join(" ") : null;
}

function drawnGraphics(timeline: ProjectTimeline): TimelineGraphic[] {
  return timeline.tracks.flatMap((t) => (t.kind === "GRAPHICS" ? t.graphics.filter((g) => !g.disabled) : []));
}

function busySpans(timeline: ProjectTimeline): Span[] {
  return timeline.tracks.flatMap((t): Span[] =>
    t.kind === "GRAPHICS"
      ? t.graphics.filter((g) => !g.disabled)
      : t.kind === "TEXT"
        ? t.texts.filter((x) => !x.disabled)
        : []
  );
}

export function ensureAnimationEveryMinute(timeline: ProjectTimeline): AnimationFloorResult {
  const out: AnimationFloorResult = { added: [], revived: [], missing: [], typewriter: [] };
  const duration = timeline.durationSec;
  if (!(duration > 0)) return out;
  const gfxTrack = timeline.tracks.find((t) => t.kind === "GRAPHICS");
  if (gfxTrack?.kind !== "GRAPHICS") return out;

  const minutes = Math.ceil(duration / 60);
  for (let m = 0; m < minutes; m++) {
    const window: Span = { start: m * 60, end: Math.min((m + 1) * 60, duration) };
    if (drawnGraphics(timeline).some((g) => overlaps(g, window))) continue;

    /* 1 — the planner's own graphic, switched off only for crowding, when it is alone now. */
    const revivable = gfxTrack.graphics
      .filter((g) => g.disabled && REVIVABLE.has(g.disabledReason ?? "") && g.start >= window.start && g.start < window.end)
      .filter((g) => !busySpans(timeline).some((s) => overlaps(s, g)))
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))[0];
    if (revivable) {
      revivable.disabled = false;
      delete revivable.disabledReason;
      out.revived.push({ id: revivable.id, minute: m, graphicType: revivable.graphicType });
      continue;
    }

    /* 2 — one drawn from a sentence spoken in this minute, in its own words. */
    const busy = busySpans(timeline);
    /**
     * VIDEO 663 — one or two words, and the video's own: a year, a name the sentence says (at most two
     * words), else only words the film says in more than one sentence. Render 72 drew "breathtakingly
     * distinct reveal" here — the sentence's longest words, not the film's subject.
     */
    const topic = filmTopicWords(timeline.sentences ?? []);
    const candidates = (timeline.sentences ?? [])
      .filter((s) => s.text?.trim() && s.startSec != null && s.endSec != null && s.startSec >= window.start && s.startSec < window.end)
      .map((s) => {
        const start = Number((s.startSec! + FLOOR_LEAD_SEC).toFixed(3));
        const end = Number(Math.min(start + FLOOR_MAX_SEC, s.endSec!, duration).toFixed(3));
        const text = s.text!.trim();
        const year = yearIn(text);
        const name = year ? null : shortOnScreenLabel(nameIn(text));
        const key = year || name ? null : relevantWordsIn(text, topic);
        const pick = year
          ? { graphicType: "date_card", label: year }
          : name
            ? { graphicType: "label", label: name }
            : key
              ? { graphicType: "emphasis", label: key }
              : null;
        return { s, start, end, pick, rank: year ? 0 : name ? 1 : 2 };
      })
      .filter((c) => c.pick && c.end - c.start >= FLOOR_MIN_SEC && !busy.some((b) => overlaps(b, c)))
      .filter((c) => graphicIsRenderable(c.pick!.graphicType, {}, c.pick!.label))
      .sort((a, b) => a.rank - b.rank || a.start - b.start);
    const chosen = candidates[0];
    if (!chosen) {
      out.missing.push(m);
      continue;
    }
    const id = `${ANIMATION_FLOOR_ID_PREFIX}${m}_${chosen.s.sceneIndex}_${chosen.s.beatIndex}`;
    const typewriter = chosen.pick!.graphicType === "date_card";
    gfxTrack.graphics.push({
      id,
      graphicType: chosen.pick!.graphicType,
      label: chosen.pick!.label,
      data: {
        sceneIndex: chosen.s.sceneIndex,
        beatIndex: chosen.s.beatIndex,
        animationFloor: true,
        ...(typewriter ? { typewriter: true } : {}),
      },
      start: chosen.start,
      end: chosen.end,
      style: { ...ON_SCREEN_TEXT_STYLE },
      animation: typewriter ? undefined : "slide_up",
    });
    out.added.push({ id, minute: m, graphicType: chosen.pick!.graphicType, label: chosen.pick!.label });
    if (typewriter) out.typewriter.push({ id, start: chosen.start, text: chosen.pick!.label });
  }
  return out;
}
