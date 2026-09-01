/**
 * RONDE 149 — the centred zoom, across the shapes and lengths the brief names.
 *
 * RONDE 147 fixed the pan and tested the bound at one image width (1920) and three zoom levels.
 * This round's brief asks for two things that were not covered: the specific clip durations
 * (3, 5, 8, 12 seconds and longer) and DIFFERENT IMAGE ASPECT RATIOS.
 *
 * Both matter for the same reason the original bug existed. The old travel was computed in
 * TypeScript as a pixel count, so it could not know how wide the image would turn out to be — a
 * tall portrait scan and a wide panorama got the same 1000px pan, and the portrait had far less
 * room to give. The fix moved the bound INTO the ffmpeg expression as a share of `(iw-iw/zoom)/2`,
 * where `iw` is whatever the actual input is, so the guarantee is per-image by construction.
 *
 * These tests evaluate that expression the way ffmpeg would, for real image shapes, and check the
 * sampling window never leaves the source. No production code is changed by this round; this is
 * the regression net for the shapes the earlier round did not enumerate.
 */
import { describe, expect, it } from "vitest";

import {
  KEN_BURNS_MAX_PAN_SHARE,
  buildKenBurnsTail,
  kenBurnsCenterXExpr,
} from "./documentaryStyle";

/** The eased progress curve buildKenBurnsTail uses, so the test drives the real shape. */
const EASE_SHARE = 0.35;
const progressAt = (t: number) =>
  EASE_SHARE * Math.sin((Math.PI / 2) * t) + (1 - EASE_SHARE) * t;

/**
 * Evaluate the x expression the way ffmpeg's zoompan does, for one frame.
 *
 * Mirrors `kenBurnsCenterXExpr` exactly: centre, plus a signed share of the room the CURRENT zoom
 * leaves. Kept as its own small function so a change to the production expression that this test
 * does not mirror shows up as a failure rather than passing silently.
 */
function xAt(params: {
  imageWidth: number;
  zoom: number;
  direction: "left" | "right" | null;
  progress: number;
}): number {
  const { imageWidth: iw, zoom, direction, progress } = params;
  const centre = iw / 2 - iw / zoom / 2;
  if (!direction) return centre;
  const afforded = (iw - iw / zoom) / 2;
  const offset = afforded * KEN_BURNS_MAX_PAN_SHARE * progress;
  return direction === "left" ? centre - offset : centre + offset;
}

/** Real shapes an archive throws at the pipeline, not just 16:9. */
const IMAGE_SHAPES: ReadonlyArray<{ label: string; width: number; height: number }> = [
  { label: "16:9 landscape", width: 1920, height: 1080 },
  { label: "4:3 archive scan", width: 1600, height: 1200 },
  { label: "3:2 photograph", width: 1800, height: 1200 },
  { label: "portrait scan", width: 1080, height: 1920 },
  { label: "square", width: 1200, height: 1200 },
  { label: "wide panorama", width: 3840, height: 1080 },
  { label: "small thumbnail", width: 640, height: 480 },
];

const DURATIONS_SEC = [3, 5, 8, 12, 20, 45];
const ZOOM_LEVELS = [1.0, 1.02, 1.04, 1.1, 1.2];

describe("RONDE 149 — the sampling window never leaves the image", () => {
  it("holds for every shape, zoom, direction and point in the shot", () => {
    for (const shape of IMAGE_SHAPES) {
      for (const zoom of ZOOM_LEVELS) {
        for (const direction of ["left", "right", null] as const) {
          // Walk the whole shot, not just the endpoints: the eased curve is monotonic, but a
          // future change to it must not be able to overshoot in the middle unnoticed.
          for (let step = 0; step <= 20; step++) {
            const progress = progressAt(step / 20);
            const x = xAt({ imageWidth: shape.width, zoom, direction, progress });
            const windowW = shape.width / zoom;
            const label = `${shape.label} zoom=${zoom} dir=${direction} t=${step / 20}`;
            expect(x, label).toBeGreaterThanOrEqual(-1e-9);
            expect(x + windowW, label).toBeLessThanOrEqual(shape.width + 1e-9);
          }
        }
      }
    }
  });

  it("the subject stays near the middle — the drift never reaches the edge of the room", () => {
    // "Centred" is stronger than "inside the frame": the window may use only a fraction of the
    // room the zoom affords, so the centre of the image stays close to the centre of the shot.
    for (const shape of IMAGE_SHAPES) {
      for (const zoom of [1.02, 1.04, 1.2]) {
        const afforded = (shape.width - shape.width / zoom) / 2;
        const worst = Math.abs(
          xAt({ imageWidth: shape.width, zoom, direction: "left", progress: 1 }) -
            (shape.width / 2 - shape.width / zoom / 2)
        );
        expect(worst, `${shape.label} zoom=${zoom}`).toBeLessThanOrEqual(afforded * KEN_BURNS_MAX_PAN_SHARE + 1e-9);
        expect(KEN_BURNS_MAX_PAN_SHARE).toBeLessThan(1);
      }
    }
  });

  it("a zoom of exactly 1.0 is pixel-perfectly centred — no drift at all", () => {
    for (const shape of IMAGE_SHAPES) {
      for (const direction of ["left", "right", null] as const) {
        const x = xAt({ imageWidth: shape.width, zoom: 1.0, direction, progress: 1 });
        expect(x, `${shape.label} dir=${direction}`).toBeCloseTo(0, 9);
      }
    }
  });
});

describe("RONDE 149 — duration does not change how far the frame travels", () => {
  it("the bound term is identical for 3s through 45s", () => {
    /**
     * This is the defect restated as a property. The old travel was `panStep * totalFrames` with
     * `panStep` itself derived from `totalFrames`, so a 12-second still panned eighteen times as
     * far as a 3-second one. The expression now carries no duration-dependent distance at all —
     * only the progress denominator changes, and that is the frame count, not a travel.
     */
    const xOf = (vf: string) => vf.match(/x='([^']+)'/)?.[1] ?? "";
    const shapes = DURATIONS_SEC.map((d) => xOf(buildKenBurnsTail(d, 1.04, "center", "pan-left")));
    for (const expr of shapes) {
      expect(expr).toContain(`-(iw-iw/zoom)/2*${KEN_BURNS_MAX_PAN_SHARE}*`);
      // No literal pixel distance may appear as a travel term.
      expect(expr).not.toMatch(/[-+]\d{2,}\*\(0\.35\*sin/);
    }
    // Normalising away the frame counts, every duration produces the same expression.
    const normalised = new Set(shapes.map((e) => e.replace(/\d+/g, "N")));
    expect(normalised.size).toBe(1);
  });

  it("centre and pan variants agree on where the shot starts", () => {
    // Whatever the variant, frame zero is the centre of the image: the offset term is zero at
    // progress 0, so nothing jumps when a shot begins.
    for (const direction of ["left", "right", null] as const) {
      for (const shape of IMAGE_SHAPES) {
        const start = xAt({ imageWidth: shape.width, zoom: 1.04, direction, progress: 0 });
        const centre = shape.width / 2 - shape.width / 1.04 / 2;
        expect(start, `${shape.label} dir=${direction}`).toBeCloseTo(centre, 9);
      }
    }
  });

  it("the production expression is the one this test models", () => {
    // If kenBurnsCenterXExpr changes shape, xAt above stops representing it — so pin the form.
    expect(kenBurnsCenterXExpr("left", "P")).toBe(
      `iw/2-(iw/zoom/2)-(iw-iw/zoom)/2*${KEN_BURNS_MAX_PAN_SHARE}*P`
    );
    expect(kenBurnsCenterXExpr("right", "P")).toBe(
      `iw/2-(iw/zoom/2)+(iw-iw/zoom)/2*${KEN_BURNS_MAX_PAN_SHARE}*P`
    );
    expect(kenBurnsCenterXExpr(null, "P")).toBe("iw/2-(iw/zoom/2)");
  });
});
