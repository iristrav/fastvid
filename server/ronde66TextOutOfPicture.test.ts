import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * RONDE 66 — get the text out of the picture.
 *
 * Render 532 drew no text of its own: no drawtext, no burnt subtitles, no screen labels anywhere
 * in the log. Everything readable on screen came from the source footage — and the filter meant
 * to catch that fired 3 times out of 35.
 *
 * The prompt is why. It rejected only DOMINANT text and said in as many words that lower thirds,
 * burnt-in subtitles, captions, headlines and watermarks were no reason to refuse a clip. So it
 * passed exactly what the beat-image gate kept reporting from the same footage:
 *
 *     "Title card with text 'History Excursion' and flames"
 *     "Propaganda or newsreel title card with text 'Soviet Fights Back! Russia Stops Hitler!'"
 *     "An academic article titled 'Physician Suicide: A Scoping Literature Review'"
 *
 * Size was the wrong axis. A small modern subtitle burnt into archive footage is as wrong as a
 * big one; a newspaper headline the camera is pointed AT is the documentary itself.
 */

const FILTER = () => fs.readFileSync(path.join(__dirname, "archiveClipFilter.ts"), "utf8");

describe("RONDE 66 — the test is origin, not size", () => {
  it("the size-based rule is gone", () => {
    const src = FILTER();
    expect(src).not.toContain("DOMINANTE, onbruikbare tekst");
    expect(src).not.toContain("Kleine, marginale documentaire-labels zijn GEEN reden voor afwijzing");
    // The old prompt's central claim — that a small subtitle is acceptable — is gone with it.
    expect(src).not.toContain("kleine, niet-dominante ondertitels");
  });

  it("the question the prompt asks is where the text came from", () => {
    const src = FILTER();
    expect(src).toContain("De vraag is NIET hoe groot de tekst is, maar waar hij vandaan komt");
    expect(src).toContain("ACHTERAF TOEGEVOEGD");
    expect(src).toContain("ECHT VOOR DE CAMERA");
  });

  it("everything render 532 let through is now named explicitly", () => {
    const src = FILTER();
    for (const kind of [
      "titelkaarten",       // "History Excursion", "Soviet Fights Back!"
      "schermafdruk van een webpagina", // the Physician Suicide article
      "aftelklok",          // archive leaders
      "kanaalbranding",     // YouTube intros
      "watermerken",
      "lower thirds",
    ]) {
      expect(src).toContain(kind);
    }
  });

  it("a subtitle is refused however small, and whatever language it is in", () => {
    const src = FILTER();
    expect(src).toContain("ingebakken ondertitels of captions, ook kleine, ook in de taal van de narratie");
  });

  it("text that was really in front of the lens is kept — that is the documentary", () => {
    const src = FILTER();
    for (const kept of [
      "krant, boek of brief",
      "straatnaambord",
      "historische kaart",
      "opschriften op uniformen",
    ]) {
      expect(src).toContain(kept);
    }
    expect(src).toContain("hasBakedEditText = false — tekst die deel is van de opgenomen werkelijkheid");
  });

  it("it is given a way to decide the ambiguous case rather than guessing", () => {
    const src = FILTER();
    expect(src).toContain("meebeweegt met het beeld");
  });

  it("a clip with no text at all is still fine", () => {
    expect(FILTER()).toContain("false wanneer er helemaal geen tekst in beeld is");
  });
});

describe("RONDE 66 — it looks where the text actually is", () => {
  it("samples the opening and the tail, not only the middle third", () => {
    const src = FILTER();
    expect(src).toContain("[dur * 0.15, dur * 0.5, dur * 0.85]");
    // 0.35/0.65 covered the middle and missed the title card, the leader and the end card.
    expect(src).not.toContain("[dur * 0.35, dur * 0.65]");
  });

  it("fast mode still takes a single frame, and a very short clip one", () => {
    const src = FILTER();
    expect(src).toContain("? [dur * 0.5]");
    expect(src).toContain("? [dur > 0 ? dur * 0.5 : 0]");
  });

  it("still fails open — a filter outage must not empty a montage", () => {
    const src = FILTER();
    const idx = src.indexOf("async function detectOnScreenTextInImages(");
    const block = src.slice(idx, idx + 1800);
    expect(block).toContain("catch (err)");
    expect(block).toMatch(/catch \(err\)[\s\S]{0,220}return false;/);
  });

  it("one frame showing text condemns the clip", () => {
    expect(FILTER()).toContain("markeer true als minstens één still tekst toont");
  });
});
