/**
 * VIDEO 621 — THE VIDEO'S MAIN SUBJECT, FOR A SCENE THAT FOUND NOTHING.
 *
 * A scene whose own sentences brought back no picture searches once more, on the main subject of
 * the whole video only. The main subject is read, never invented: the person the render is locked
 * on when there is one, otherwise the name the narration returns to most (in the most scenes, then
 * the most sentences) — never a bare year, and never a name said only once.
 */
import { analyzeVideo, type PlannerInput } from "./youtubeVideoSearchPlanner";

export function videoMainSubject(primaryPerson: string | null | undefined, input: PlannerInput): string | null {
  const person = primaryPerson?.trim();
  if (person) return person;
  const top = analyzeVideo(input).recurring.find((r) => !/^\d{4}$/.test(r.term) && r.beats >= 2);
  /** A sentence that opens on the name writes "The Titanic"; the subject is "Titanic". */
  return top?.term.replace(/^(?:the|a|an|de|het|een)\s+/i, "").trim() || null;
}
