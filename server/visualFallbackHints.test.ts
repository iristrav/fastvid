import { describe, expect, it } from "vitest";
import {
  buildEnglishVisualKeywordFromSentence,
  matchVisualFallbackHint,
} from "./visualFallbackHints";
import { fallbackVisualIntent, resolveBeatVisualIntent } from "./scriptVisualKeywords";

describe("visualFallbackHints", () => {
  it("matches entrepreneur Dutch sentence", () => {
    const hint = matchVisualFallbackHint(
      "Veel ondernemers verspillen uren per week aan handmatig werk."
    );
    expect(hint?.primary).toBe("entrepreneur working laptop");
  });

  it("matches Netherlands infrastructure sentence", () => {
    const hint = matchVisualFallbackHint(
      "De infrastructuur van Nederland is uniek in de wereld."
    );
    expect(hint?.primary).toBe("netherlands infrastructure aerial");
  });

  it("matches Dutch cycling with Netherlands context", () => {
    const hint = matchVisualFallbackHint("In Nederland fietsen miljoenen mensen elke dag.");
    expect(hint?.primary).toBe("amsterdam cyclists street");
  });

  it("translates Dutch nouns to English keywords", () => {
    expect(buildEnglishVisualKeywordFromSentence("Mensen fietsen dagelijks in Amsterdam.")).toMatch(
      /cycling|amsterdam|bicycle/
    );
  });

  it("fallbackVisualIntent never returns bare Dutch tokens for entrepreneur beat", () => {
    const intent = fallbackVisualIntent(
      "Veel ondernemers verspillen uren per week aan handmatig werk."
    );
    expect(intent.primary_keyword).toBe("entrepreneur working laptop");
    expect(intent.primary_keyword).not.toMatch(/ondernemer|verspillen/);
  });

  it("resolveBeatVisualIntent upgrades weak stored intent", () => {
    const map = new Map([
      [
        "veel ondernemers verspillen uren per week aan handmatig werk.",
        {
          sentence: "Veel ondernemers verspillen uren per week aan handmatig werk.",
          visual_intent: "generic scene",
          primary_keyword: "documentary broll scene",
          secondary_keyword: "documentary broll scene",
          fallback_keyword: "documentary broll scene",
          scene_type: "other",
          priority_subject: "scene",
        },
      ],
    ]);
    const resolved = resolveBeatVisualIntent(
      "Veel ondernemers verspillen uren per week aan handmatig werk.",
      map
    );
    expect(resolved.primary_keyword).toBe("entrepreneur working laptop");
  });
});
