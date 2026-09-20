/**
 * GRAPHICS §6 — THE LAYER ORDER, PINNED WHERE PIXELS CANNOT PIN IT.
 *
 * ── Why this is a source test and not a pixel test ──────────────────────────────────────────
 *
 * Every other claim this round makes is measured in the delivered MP4. This one cannot be, and the
 * reason is the point: `theGraphicsFixtureReachesTheMp4` proves that a graphic and a caption never
 * share a pixel, and two things that never overlap produce the same frame whichever is drawn
 * first. Swap the order and the video is byte-identical.
 *
 * That makes the order unobservable TODAY and load-bearing TOMORROW. The moment a card and a
 * caption do land on one another — a longer caption, a format with less room, a planner that asks
 * for both at once — the order decides which one the viewer can read. `GraphicsOverlay.tsx` states
 * the decision in a comment: captions sit on top, because a caption is the narration itself and a
 * decorative card covering the spoken words is the one overlap that is never acceptable.
 *
 * A comment is not enforcement. This file reads the component's own JSX and asserts the three
 * layers appear in the order the comment claims, so a reordering is a failing test rather than a
 * silent change of policy nobody notices until a video ships with a date card over a sentence.
 *
 * ── What it deliberately does not do ────────────────────────────────────────────────────────
 *
 * It does not parse JSX or assert on structure beyond the order of the three maps. A test that
 * modelled the component would break on every honest edit; this one breaks only when the answer to
 * "which layer is on top" changes.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { emptyTimeline } from "./projectTimeline";
import { missingEditorialFields, timelineToRemotionProps } from "./remotionProps";

const OVERLAY = readFileSync(join(__dirname, "remotion", "GraphicsOverlay.tsx"), "utf8");

/** Where each track's elements are emitted, in source order — which is paint order in React. */
function emittedAt(track: "graphics" | "texts" | "captions"): number {
  const at = OVERLAY.indexOf(`props.${track}.map(`);
  expect(at, `GraphicsOverlay no longer emits props.${track}`).toBeGreaterThan(-1);
  return at;
}

describe("GRAPHICS §6 — the compositing order is the one the component says it is", () => {
  it("draws graphics FIRST, so anything above them can cover them", () => {
    expect(emittedAt("graphics")).toBeLessThan(emittedAt("texts"));
    expect(emittedAt("graphics")).toBeLessThan(emittedAt("captions"));
  });

  it("draws CAPTIONS LAST, so the spoken words are never covered", () => {
    expect(emittedAt("captions")).toBeGreaterThan(emittedAt("texts"));
    expect(emittedAt("captions")).toBeGreaterThan(emittedAt("graphics"));
  });

  it("and says why, so the next reader knows it is a decision and not an accident", () => {
    expect(OVERLAY).toContain("Captions sit on top deliberately");
  });

  it("the picture is below all three — the overlay carries no background of its own", () => {
    /**
     * The other half of the z-order, and the one a pixel test DOES cover: ffmpeg composites this
     * layer over the film, so the film is the bottom layer by construction. It only stays that way
     * while the overlay paints nothing where nothing was asked for — a background colour here would
     * hide the whole video behind an opaque sheet, and every count upstream would still be right.
     */
    expect(OVERLAY).not.toMatch(/backgroundColor\s*:/);
    expect(OVERLAY).not.toMatch(/background\s*:\s*["'][^"']/);
  });
});

/* ═══════════════════════ §9 — the animation the timeline names ═══════════════════════ */

/**
 * GRAPHICS §9 — A PROP NOBODY PASSED, FOR SEVEN ROUNDS.
 *
 * `GraphicBody` has taken an `animation` prop since RONDE 155, and its doc says "a graphic that
 * wants to slide, pop or mask-reveal uses `animationAt`". Nothing could express that want:
 * `TimelineGraphic` had no such field, `RemotionGraphic` had none, and `Graphic` — the prop's only
 * caller — passed none. So every graphic in every FastVid video entered with `fade_rise`, and the
 * rest of `animationAt`'s vocabulary was reachable only from the TEXT and CAPTIONS tracks.
 *
 * It was found by a mutation that could not be killed: replacing the component's animation with a
 * constant changed nothing, because a constant was already what it got. That is the signature of
 * this defect class — an answer computed somewhere and never carried to where it is used — and the
 * only reliable way to see it is to ask what happens when the value is thrown away.
 *
 * The default is unchanged, so a timeline that names no animation renders exactly as it did.
 */
describe("GRAPHICS §9 — a graphic's animation reaches the component that draws it", () => {
  it("carries the timeline's own animation into the props", () => {
    const t = emptyTimeline(1, { widthPx: 1920, heightPx: 1080, fps: 24 });
    t.durationSec = 2;
    for (const track of t.tracks) {
      if (track.kind === "GRAPHICS") {
        track.graphics.push(
          { id: "a", graphicType: "date_card", label: "1843", data: {}, start: 0, end: 1,
            animation: "mask_reveal" } as never,
          { id: "b", graphicType: "date_card", label: "1844", data: {}, start: 1, end: 2 } as never
        );
      }
    }
    const props = timelineToRemotionProps({ timeline: t });
    expect(props.graphics.find((g) => g.id === "a")!.animation).toBe("mask_reveal");
    /** And the default is stated in the props rather than supplied silently by the component. */
    expect(props.graphics.find((g) => g.id === "b")!.animation).toBe("fade_rise");
  });

  it("the component is actually given it — the prop is not declared and then dropped", () => {
    const src = readFileSync(join(__dirname, "remotion", "components", "Graphics.tsx"), "utf8");
    const body = src.slice(src.indexOf("<GraphicBody"), src.indexOf("</GraphicBody>"));
    expect(body, "GraphicBody is rendered without its animation").toContain("animation={g.animation}");
  });

  it("a dropped animation is REPORTED, not discovered in the finished video", () => {
    const t = emptyTimeline(1, { widthPx: 1920, heightPx: 1080, fps: 24 });
    t.durationSec = 1;
    for (const track of t.tracks) {
      if (track.kind === "GRAPHICS") {
        track.graphics.push({ id: "a", graphicType: "date_card", label: "1843", data: {},
          start: 0, end: 1, animation: "pop" } as never);
      }
    }
    const props = timelineToRemotionProps({ timeline: t });
    expect(missingEditorialFields(t, props)).toEqual([]);
    /** The same check, with the value knocked out — the losslessness guard must name it. */
    const lost = { ...props, graphics: props.graphics.map((g) => ({ ...g, animation: "fade_rise" })) };
    expect(missingEditorialFields(t, lost)).toEqual(["graphic a lost its animation"]);
  });
});
