/**
 * VIDEO 621 — THE VIDEO'S MAIN SUBJECT, FOR A SCENE THAT FOUND NOTHING.
 *
 * A scene whose own sentences brought back no picture searches once more, on the main subject of
 * the whole video only. The main subject is read, never invented: the person the render is locked
 * on when there is one, then the name the prompt or title gives the film when the narration says
 * it too (`namedInHeading`), otherwise the name the narration returns to most (in the most scenes,
 * then the most sentences) — never a bare year, and never a name said only once.
 */
import { analyzeVideo, type PlannerInput } from "./youtubeVideoSearchPlanner";

export function videoMainSubject(primaryPerson: string | null | undefined, input: PlannerInput): string | null {
  const person = primaryPerson?.trim();
  if (person) return person;
  const analysis = analyzeVideo(input);
  const named = namedInHeading([input.prompt, input.title], input.sceneTexts.join(" "), analysis.recurring.map((r) => r.term));
  if (named) return named;
  const top = analysis.recurring.find((r) => !/^\d{4}$/.test(r.term) && r.beats >= 2);
  /** A sentence that opens on the name writes "The Titanic"; the subject is "Titanic". */
  return top?.term.replace(/^(?:the|a|an|de|het|een)\s+/i, "").trim() || null;
}

/** Words that join a name ("Fall of the Berlin Wall") but never open or close one. */
const JOINERS = new Set(["of", "the", "de", "a", "an", "and", "het", "een", "van"]);

/**
 * VIDEO 630 — THE NAME THE FILM IS GIVEN, WHEN THE NARRATION SAYS IT TOO.
 *
 * "How World War II Changed the World Forever" said "World War II" once, in its last scene, and
 * "Europe" in two. The recurring rule chose "Europe", and the rescue round searched it for every
 * empty scene: maps of the European Union and tourist squares, zero pictures in three scenes.
 *
 * The prompt and the title say what the film is about. A capitalised run of the prompt or the
 * title is the main subject when the narration contains that same run, written the same way, as
 * whole words — so the subject is still a word the script says, only chosen by the film's own
 * heading. A run of two or more words qualifies on that alone; a single word only when the
 * narration's own name reading (`recurring`) already counts it as a name, so "Changed" or "How"
 * can never become a subject. The longest run wins. With no such run, nothing changes.
 */
export function namedInHeading(
  headings: ReadonlyArray<string | null | undefined>,
  narration: string,
  narrationNames: readonly string[]
): string | null {
  const names = new Set(narrationNames);
  const said = (phrase: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u").test(narration);
  let best: { term: string; words: number } | null = null;
  for (const heading of headings) {
    const words = (heading ?? "").split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    /** Capitalised runs; a joiner may sit inside one ("Fall of the Berlin Wall"). */
    const runs: string[][] = [];
    let run: string[] = [];
    for (const w of [...words, ""]) {
      if (w && (/^\p{Lu}/u.test(w) || (run.length > 0 && JOINERS.has(w.toLowerCase())))) run.push(w);
      else {
        if (run.length) runs.push(run);
        run = [];
      }
    }
    for (const r of runs) {
      for (let i = 0; i < r.length; i++) {
        for (let j = i + 1; j <= Math.min(r.length, i + 5); j++) {
          const part = r.slice(i, j);
          if (JOINERS.has(part[0]!.toLowerCase()) || JOINERS.has(part[part.length - 1]!.toLowerCase())) continue;
          const term = part.join(" ");
          if (/^\d{4}$/.test(term)) continue;
          if (part.length === 1 && !names.has(term)) continue;
          if (!said(term)) continue;
          if (!best || part.length > best.words) best = { term, words: part.length };
        }
      }
    }
  }
  return best?.term ?? null;
}
