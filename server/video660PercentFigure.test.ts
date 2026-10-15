/**
 * VIDEO 660 — fix 4: a percentage on screen is never a bare ring. Render 69 opened on a ring counting
 * to 10% with nothing under it (the label "10%" restated the figure and was dropped): it read as a
 * loading indicator. The drawn graphic is checked here as markup, at its last frame.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("remotion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("remotion")>()),
  useCurrentFrame: () => 10_000,
}));

import { PercentageRing } from "./remotion/components/Charts";

const draw = (data: Record<string, unknown>) =>
  renderToStaticMarkup(React.createElement(PercentageRing, { data, durationInFrames: 90 }));

describe("4 — the percentage graphic as drawn", () => {
  it("with a label that says what the figure is: the ring, the figure and the label", () => {
    const svg = draw({ toValue: 10, suffix: "%", label: "Europe's inflation soared" });
    expect(svg).toContain("<circle");
    expect(svg).toContain("10%");
    expect(svg).toContain("Europe&#x27;s inflation soared");
  });

  it("a label that only restates the figure: no ring at all — the figure alone, large", () => {
    const svg = draw({ toValue: 10, suffix: "%", label: "10%" });
    expect(svg).not.toContain("<circle");
    expect(svg).toContain("10%");
    expect(svg).toMatch(/font-size="168"/);
  });

  it("no label: no bare ring either", () => {
    const svg = draw({ toValue: 25, suffix: "%" });
    expect(svg).not.toContain("<circle");
    expect(svg).toContain("25%");
  });
});
