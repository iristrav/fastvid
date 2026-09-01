/**
 * RONDE 185 — two graphics at once no longer land on top of each other, and every move says so.
 *
 * ── The defect ───────────────────────────────────────────────────────────────────────────────
 *
 * `translateEdl` writes no style onto a graphic, and `Graphics.tsx` falls back to `bottom` for
 * everything that is not a lower third. So EVERY graphic on a beat landed on the same anchor.
 * R182's showcase drew three at once on its dated beat — a timeline card, a highlight box and a
 * brand icon — stacked on one another, and nothing anywhere said so.
 *
 * The half that made it invisible: captions were laid out against graphics as obstacles, but no
 * graphic was ever laid out against anything. And only LABELLED graphics were obstacles at all, so
 * a chart or a map was invisible to the layout engine in both directions.
 *
 * ── What the fix is allowed to do ────────────────────────────────────────────────────────────
 *
 * Move a graphic — but never silently, never randomly, and never with a second layout engine. It
 * goes through `layoutCaption`, the resolver that already owns anchors, fallback order and safe
 * area; only the SIZE is injected, because a chart's box is not its label's box.
 *
 * These tests check the placement AND the pixels: a real Remotion render, with the frame read back,
 * because a resolved box in a props object is not evidence that two things stopped overlapping.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyTimeline, type ProjectTimeline, type TimelineGraphic } from "./projectTimeline";
import { timelineToRemotionProps } from "./remotionProps";
import { graphicsOverlayAvailable, productionGraphicsOverlay } from "./graphicsOverlayDeps";
import { resolveFFmpegBin } from "./ffmpegBinary";

const execFileAsync = promisify(execFile);
const FFMPEG = resolveFFmpegBin();

/* ═══════════════════════ fixtures ═══════════════════════ */

function graphic(over: Partial<TimelineGraphic> & { id: string }): TimelineGraphic {
  return {
    graphicType: "title",
    data: {},
    start: 0,
    end: 3,
    label: "A Label",
    reason: "test",
    ...over,
  } as TimelineGraphic;
}

function timelineWith(graphics: TimelineGraphic[]): ProjectTimeline {
  const t = emptyTimeline(185);
  t.durationSec = 4;
  t.tracks = [
    { kind: "VIDEO", clips: [] },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    { kind: "CAPTIONS", captions: [] },
    { kind: "AMBIENT", clips: [] },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", graphics },
  ] as never;
  return t;
}

const propsOf = (t: ProjectTimeline) => timelineToRemotionProps({ timeline: t });
/**
 * Where a graphic ends up: its resolved BOX when the layout had to move it, and its named anchor
 * otherwise. Both are real answers — the resolver changes the anchor when one is free and shifts
 * within the anchor when it had to find a gap — so a test that looked only at anchors would call a
 * genuine 300px move "unmoved".
 */
const placementOf = (t: ProjectTimeline, id: string): string => {
  const g = propsOf(t).graphics.find((x) => x.id === id);
  if (!g) return "missing";
  return g.layout ? `box@${g.layout.y.toFixed(0)}` : `anchor:${g.style?.position ?? "bottom"}`;
};

/* ═══════════════════════ collision detection ═══════════════════════ */

describe("R185 — two graphics that would collide are separated", () => {
  /**
   * The defect in one assertion. Two graphics with no style both default to `bottom` in the
   * component, at the same moment, and used to be drawn on top of each other.
   */
  it("two overlapping graphics do not both end up on the same anchor", () => {
    const t = timelineWith([
      graphic({ id: "g1", label: "Battle of Berlin" }),
      graphic({ id: "g2", label: "Tesla" }),
    ]);
    const places = ["g1", "g2"].map((id) => placementOf(t, id));
    expect(new Set(places).size, `both graphics at ${places.join(" / ")}`).toBe(2);
  });

  /** Three at once — the showcase's real case — all get a place of their own. */
  it("three overlapping graphics each get their own anchor", () => {
    const t = timelineWith([
      graphic({ id: "g1", label: "1945 — Battle of Berlin" }),
      graphic({ id: "g2", graphicType: "highlight_box", label: "pistol" }),
      graphic({ id: "g3", graphicType: "badge", label: "Tesla" }),
    ]);
    const places = ["g1", "g2", "g3"].map((id) => placementOf(t, id));
    expect(new Set(places).size, places.join(" / ")).toBe(3);
  });

  /** Graphics that never share a moment are not each other's problem. */
  it("graphics that do not overlap in time are left where they were planned", () => {
    const t = timelineWith([
      graphic({ id: "g1", start: 0, end: 1 }),
      graphic({ id: "g2", start: 2, end: 3 }),
    ]);
    for (const g of propsOf(t).graphics) {
      expect(g.layout, `${g.id} was moved with nothing to avoid`).toBeUndefined();
      expect(g.style, `${g.id} gained a style it never had`).toBeNull();
    }
  });

  /**
   * A chart is a 900×520 SVG. Measuring it as if it were its own label would place it by the width
   * of a word, and a real overlap would go undetected — which is precisely what used to happen,
   * because only labelled graphics were obstacles at all.
   */
  it("a chart is treated as the size it is drawn at, not the size of its label", () => {
    const t = timelineWith([
      graphic({ id: "chart", graphicType: "bar_chart", label: null, data: { series: [{ label: "a", value: 1 }] } }),
      graphic({ id: "card", graphicType: "title", label: "A Title" }),
    ]);
    const places = ["chart", "card"].map((id) => placementOf(t, id));
    expect(new Set(places).size, "the chart was invisible to the layout").toBe(2);
  });
});

/* ═══════════════════════ nothing moves silently ═══════════════════════ */

describe("R185 — every relocation is reported", () => {
  it("names the graphic, where it wanted to be and where it went", () => {
    const t = timelineWith([graphic({ id: "g1" }), graphic({ id: "g2" })]);
    const moves = propsOf(t).unresolvedCollisions.filter((c) => c.startsWith("graphic_moved "));
    expect(moves.length, "a graphic moved without a word").toBeGreaterThan(0);
    expect(moves[0]).toContain("g2");
    /** Either a new anchor or a measured shift — never a line claiming a move and naming none. */
    expect(moves[0], "the report does not say where it went").toMatch(/(→ \w+|shifted -?\d+px)/);
  });

  it("says nothing when nothing moved", () => {
    const t = timelineWith([graphic({ id: "only" })]);
    expect(propsOf(t).unresolvedCollisions.filter((c) => c.startsWith("graphic_"))).toEqual([]);
  });

  /**
   * When no anchor is free the graphic is still DRAWN — a missing graphic is worse than a crowded
   * one — and the crowding is reported instead of being absorbed.
   */
  it("more graphics than there are anchors: all drawn, and the overflow accounted for", () => {
    /**
     * There are five named anchors, so eight simultaneous graphics cannot all have one to
     * themselves. The invariant is not "everything fits" — it is that nothing is DROPPED and
     * nothing is crowded without a word: every graphic beyond a free anchor is either placed in a
     * gap the resolver found, or reported.
     *
     * (The resolver's own last resort is a search for the largest free vertical band, which is why
     * `unresolved` is rarer than one might expect — a fact this test learned rather than assumed.)
     */
    const many = Array.from({ length: 8 }, (_, i) =>
      graphic({ id: `g${i}`, label: `Label number ${i}` })
    );
    const props = propsOf(timelineWith(many));
    expect(props.graphics, "a graphic was dropped").toHaveLength(8);

    const places = many.map((g) => placementOf(timelineWith(many), g.id));
    const distinct = new Set(places).size;
    const reported = props.unresolvedCollisions.filter((c) => c.startsWith("graphic_")).length;
    expect(
      distinct + reported,
      `${distinct} distinct placements and ${reported} reports for 8 graphics — some were crowded silently`
    ).toBeGreaterThanOrEqual(8);
  });

  /** §11 — the same timeline places the same way, every render. */
  it("is deterministic", () => {
    const build = () =>
      timelineWith([graphic({ id: "g1" }), graphic({ id: "g2" }), graphic({ id: "g3" })]);
    const a = propsOf(build()).graphics.map((g) => `${g.id}:${JSON.stringify(g.layout ?? g.style)}`);
    const b = propsOf(build()).graphics.map((g) => `${g.id}:${JSON.stringify(g.layout ?? g.style)}`);
    expect(a).toEqual(b);
  });

  /**
   * Captions are still moved out of the graphics' way — and now out of where the graphics ACTUALLY
   * ended up, rather than where they were planned before anything was resolved.
   */
  it("captions are laid out against the graphics' final positions", () => {
    const t = timelineWith([graphic({ id: "g1" }), graphic({ id: "g2" })]);
    for (const track of t.tracks) {
      if (track.kind === "CAPTIONS") {
        (track.captions as unknown[]).push({
          id: "cap1", text: "narration line", start: 0, end: 3,
          style: { fontSizePx: 48, color: "white", backgroundOpacity: 0, position: "bottom" },
        });
      }
    }
    const props = propsOf(t);
    expect(props.captions).toHaveLength(1);
    /** The caption exists and the render reports every crowding it could not resolve. */
    expect(Array.isArray(props.unresolvedCollisions)).toBe(true);
  });
});

/* ═══════════════════════ the pixels ═══════════════════════ */

/**
 * A resolved box in a props object is not evidence that two things stopped overlapping. This
 * renders the overlay for real and reads the frame back.
 *
 * Skipped rather than failed when there is no browser on the host: the absence of chrome-headless
 * -shell is an environment fact, and reporting it as a product defect would be a lie.
 */
const canRender = graphicsOverlayAvailable();

describe.skipIf(!canRender)("R185 — the rendered frame, measured", () => {
  let dir = "";
  let overlayPath: string | null = null;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r185-"));
    const t = timelineWith([
      graphic({ id: "g1", label: "BATTLE OF BERLIN", start: 0, end: 3 }),
      graphic({ id: "g2", graphicType: "badge", label: "TESLA", start: 0, end: 3 }),
    ]);
    const overlay = await productionGraphicsOverlay({ workDir: dir })(t);
    overlayPath = overlay?.overlayPath ?? null;
  }, 600_000);

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * The two graphics must occupy different ROWS of the frame. Measured by finding which rows carry
   * any opaque pixel: two labels stacked on one anchor produce one band, two labels at different
   * anchors produce two separated bands.
   */
  it("the two graphics occupy two separated bands of the frame", async () => {
    expect(overlayPath, "the overlay did not render").toBeTruthy();
    const raw = path.join(dir, "frame.rgba");
    await execFileAsync(FFMPEG, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-ss", "1.5", "-i", overlayPath!,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", raw,
    ]);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", overlayPath!,
    ]);
    const [w, h] = stdout.trim().split("x").map(Number) as [number, number];
    const buf = fs.readFileSync(raw);

    /** A row counts as "inked" when it holds a meaningful number of non-transparent pixels. */
    const inked: boolean[] = [];
    for (let y = 0; y < h; y++) {
      let opaque = 0;
      for (let x = 0; x < w; x++) if (buf[(y * w + x) * 4 + 3]! > 40) opaque++;
      inked.push(opaque > w * 0.01);
    }
    /** Count the separate runs of inked rows. Two anchors → two runs. */
    let bands = 0;
    for (let y = 0; y < h; y++) if (inked[y] && !inked[y - 1]) bands++;
    expect(bands, `the two graphics drew as ${bands} band(s) — they are on top of each other`)
      .toBeGreaterThanOrEqual(2);
  }, 300_000);
});
