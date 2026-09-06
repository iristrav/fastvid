/**
 * HOW A GRAPHIC WAS DRAWN, NOT ONLY WHETHER IT WAS.
 *
 * ── The ambiguity this removes ──────────────────────────────────────────────────────────────
 *
 * RONDE 160 §7 proved every member of `RENDERABLE_GRAPHICS` puts visible ink on screen, by
 * rendering all thirty-two into a ProRes 4444 and reading the alpha plane back. `rendered` is
 * therefore an honest count: nothing is tallied that draws nothing.
 *
 * What it could not say is HOW. Eleven of the thirty-two have no `case` of their own and reach the
 * switch's `default:`, which draws the label as a bold text card — the same output `text` and
 * `headline` get. So `rendered=6` could mean six graphics in their intended form, six text cards,
 * or any mix.
 *
 * Two rounds of this audit read it wrong. RONDE 107 counted `timeline_event` and `date_card` as
 * "reaching a component" when they reach the generic card. RONDE 108 concluded from the missing
 * `badge` case that badge does not render at all, having failed to read the pixel test the
 * vocabulary's own doc points at. Both mistakes came from one number that answered two questions.
 *
 * ── The test that actually matters ──────────────────────────────────────────────────────────
 *
 * `EXPLICITLY_DESIGNED_GRAPHICS` writes the switch's contents down a second time, and a second
 * copy drifts. So the first test below parses Graphics.tsx and fails the day a case is added or
 * removed without updating the list. Everything else here is arithmetic; that one is the guard.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  EXPLICITLY_DESIGNED_GRAPHICS,
  RENDERABLE_GRAPHICS,
  graphicIsRenderable,
  graphicRendererClass,
} from "./graphicsVocabulary";
import { formatGraphics } from "./renderCorrelation";

/** The switch's own cases, read from the component rather than trusted. */
const switchCases = (): Set<string> => {
  const src = fs.readFileSync(
    path.join(__dirname, "remotion", "components", "Graphics.tsx"),
    "utf8"
  );
  const at = src.indexOf("switch (g.graphicType)");
  expect(at, "the graphic type switch moved or was renamed").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  expect(body, "the switch lost its default branch").toContain("default:");
  return new Set([...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!));
};

/* ═════════ 1 — the list cannot drift from the switch ═════════ */

describe("the design list is the switch, written down", () => {
  it("names exactly the types that have their own case", () => {
    expect([...EXPLICITLY_DESIGNED_GRAPHICS].sort()).toEqual([...switchCases()].sort());
  });

  it("every case is also a renderable name — no orphan branches", () => {
    const orphans = [...switchCases()].filter((c) => !RENDERABLE_GRAPHICS.has(c));
    expect(orphans, "a case for a type the vocabulary does not admit").toEqual([]);
  });

  /** The measured 21/11 split, pinned so a change to either side is deliberate. */
  it("the distribution is 21 designed and 11 generic", () => {
    const generic = [...RENDERABLE_GRAPHICS].filter((t) => !EXPLICITLY_DESIGNED_GRAPHICS.has(t));
    expect(EXPLICITLY_DESIGNED_GRAPHICS.size).toBe(21);
    expect(generic.length).toBe(11);
    expect(generic.sort()).toEqual([
      "badge", "callout", "date_card", "emphasis", "headline", "label",
      "subtitle", "text", "timeline_event", "title", "warning",
    ]);
  });
});

/* ═════════ 2 — the classifier refines renderability, never contradicts it ═════════ */

describe("classification agrees with the renderability predicate", () => {
  const label = "Tesla";
  const data = { label };

  it("a type with its own case is explicit", () => {
    expect(graphicRendererClass("lower_third", data, label)).toBe("explicit");
  });

  it("a default-only type is generic, not unsupported", () => {
    expect(graphicRendererClass("badge", data, label)).toBe("generic");
    expect(graphicIsRenderable("badge", data, label), "it does draw — RONDE 160 read its pixels").toBe(true);
  });

  it("a name the vocabulary does not admit is unsupported", () => {
    expect(graphicRendererClass("animated_icon", data, label)).toBe("unsupported");
  });

  /** A payload-driven refusal stays a refusal: the split never rescues an empty chart. */
  it("a data-driven type with no data is unsupported, whatever its case", () => {
    expect(graphicRendererClass("bar_chart", {}, null)).toBe("unsupported");
    expect(EXPLICITLY_DESIGNED_GRAPHICS.has("bar_chart"), "it does have a case").toBe(true);
  });

  it.each([...RENDERABLE_GRAPHICS])("%s classifies as explicit or generic, never both", (type) => {
    const cls = graphicRendererClass(type, { label: "x" }, "x");
    /** Data-driven types need a payload; with a bare label they are honestly unsupported. */
    expect(["explicit", "generic", "unsupported"]).toContain(cls);
    if (cls !== "unsupported") {
      expect(cls === "explicit").toBe(EXPLICITLY_DESIGNED_GRAPHICS.has(type));
    }
  });
});

/* ═════════ 3 — the invariant the round exists for ═════════ */

describe("rendered = explicitRendered + genericRendered", () => {
  const tally = (types: string[]) => {
    const classes = types.map((t) => graphicRendererClass(t, { label: "x" }, "x"));
    return {
      explicitRendered: classes.filter((c) => c === "explicit").length,
      genericRendered: classes.filter((c) => c === "generic").length,
      unsupported: classes.filter((c) => c === "unsupported").length,
    };
  };

  it("holds on a mixed set", () => {
    const t = tally(["lower_third", "quote", "badge", "title", "animated_icon"]);
    expect(t.explicitRendered).toBe(2);
    expect(t.genericRendered).toBe(2);
    expect(t.unsupported).toBe(1);
    expect(t.explicitRendered + t.genericRendered).toBe(4);
  });

  it("holds across the whole vocabulary", () => {
    const t = tally([...RENDERABLE_GRAPHICS]);
    expect(t.explicitRendered + t.genericRendered + t.unsupported).toBe(RENDERABLE_GRAPHICS.size);
  });

  it("an unsupported graphic is never counted as rendered", () => {
    expect(tally(["animated_icon", "highlight_box", "arrow", "chart", "comparison"])).toEqual({
      explicitRendered: 0,
      genericRendered: 0,
      unsupported: 5,
    });
  });
});

/* ═════════ 4 — the log line, and its backward compatibility ═════════ */

describe("the [Graphics] line", () => {
  it("carries the split when the caller supplies it", () => {
    const line = formatGraphics({
      renderId: "r1", planned: 8, rendered: 6,
      explicitRendered: 4, genericRendered: 2,
      skipped: ["motion graphic highlight_box"], renderer: "remotion",
    });
    expect(line).toContain("rendered=6");
    expect(line).toContain("explicitRendered=4");
    expect(line).toContain("genericRendered=2");
    expect(line).toContain("skipped=1");
  });

  /** Three existing callers pass neither field; their output must not change. */
  it("reads exactly as before when they are omitted", () => {
    const line = formatGraphics({
      renderId: "r1", planned: 2, rendered: 2, skipped: [], renderer: "remotion",
    });
    expect(line).not.toContain("explicitRendered");
    expect(line).not.toContain("genericRendered");
    expect(line).toContain("rendered=2");
  });

  it("the cinematic reporter classifies per graphic, not from the vocabulary split", () => {
    const src = fs.readFileSync(path.join(__dirname, "cinematicPipeline.ts"), "utf8");
    const at = src.indexOf("export function formatCinematicGraphics");
    const body = src.slice(at, at + 1400);
    expect(body).toContain("graphics.map((g) => graphicRendererClass(");
    expect(body).toContain("const rendered = explicitRendered + genericRendered;");
  });
});
