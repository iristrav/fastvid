/**
 * RONDE 112 — the graphics overlay, MEASURED.
 *
 * ── What this file guards ────────────────────────────────────────────────────────────────────
 *
 * Every graphics number this codebase reports is a PREDICATE over the plan: `rendered` asks
 * `graphicIsRenderable`, RONDE 110's split asks `graphicRendererClass` of the same population.
 * None of them looks at the file that was composited. RONDE 111 traced the chain and found
 * REMOTION → FINAL MP4 to be the only transition with no measurement of any kind.
 *
 * The probe is that measurement, and these tests are its proof. The three that matter run REAL
 * ffmpeg against REAL ProRes 4444 files built here — one with ink, one entirely transparent — so
 * "the probe reports ink" is verified by reading an alpha channel, not by agreeing with a stub.
 * A stubbed exec would only prove the parser can read a string this file wrote.
 *
 * ── What it deliberately does NOT claim ──────────────────────────────────────────────────────
 *
 * That a particular graphic is visible in the delivered MP4. The overlay is one file with no
 * per-graphic markers, so the honest ceiling is "the layer heading into the composite carried
 * ink". RONDE 111 finding 5 records that limit as inherent, and nothing here pretends past it.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INK_ALPHA_FLOOR,
  SAMPLE_FPS,
  formatOverlayInk,
  overlayInkProbeArgs,
  parseSignalstatsYMax,
  probeOverlayInk,
  summariseInk,
} from "./graphicsOverlayInk";
import { resolveFFmpegBin } from "./ffmpegBinary";
import { formatGraphics } from "./renderCorrelation";
import { graphicRendererClass } from "./graphicsVocabulary";
import { RENDERABLE_GRAPHICS, graphicIsRenderable } from "./remotion/components/Graphics";

const execFileAsync = promisify(execFile);

let workDir = "";
let inkOverlay = "";
let clearOverlay = "";

/**
 * One second of ProRes 4444, alpha fully opaque or fully clear.
 *
 * ProRes 4444 because that is what `renderGraphicsOverlay` writes; the probe must be proven against
 * the codec and bit depth it will actually meet, not against a convenient 8-bit stand-in — the
 * 10-bit alpha channel is precisely where a naive reading of YMAX goes wrong.
 */
async function writeOverlay(file: string, colour: string): Promise<void> {
  await execFileAsync(resolveFFmpegBin(), [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi",
    "-i", `color=c=${colour}:s=64x64:d=1:r=10,format=yuva444p10le`,
    "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
    file,
  ]);
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ronde112-ink-"));
  inkOverlay = path.join(workDir, "graphics_overlay.mov");
  clearOverlay = path.join(workDir, "transparent_overlay.mov");
  await writeOverlay(inkOverlay, "red@1.0");
  await writeOverlay(clearOverlay, "black@0.0");
}, 120_000);

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

/* ═══════════════════════ 1-3. the real measurements ═══════════════════════ */

describe("the probe reads a real overlay's alpha channel", () => {
  it("reports ink for an overlay that has some", async () => {
    const r = await probeOverlayInk(inkOverlay, resolveFFmpegBin(), (bin, args) =>
      execFileAsync(bin, args as string[], { maxBuffer: 1024 * 1024 * 16 })
    );
    expect(r.status).toBe("ink");
    expect(r.framesSampled).toBeGreaterThan(0);
    expect(r.inkFrames).toBe(r.framesSampled);
    /** Fully opaque, normalised to 8 bits by the filter chain — not the 4095 of the raw 10-bit plane. */
    expect(r.maxAlpha).toBe(255);
    expect(r.overlay).toBe("graphics_overlay.mov");
    expect(r.reason).toBeUndefined();
  }, 60_000);

  it("reports transparent — and zero ink frames — for an overlay that drew nothing", async () => {
    const r = await probeOverlayInk(clearOverlay, resolveFFmpegBin(), (bin, args) =>
      execFileAsync(bin, args as string[], { maxBuffer: 1024 * 1024 * 16 })
    );
    expect(r.status).toBe("transparent");
    expect(r.inkFrames).toBe(0);
    expect(r.maxAlpha).toBe(0);
    /**
     * The distinction the whole module turns on: this overlay WAS read. `framesSampled` proves the
     * "no" is a measurement rather than an absence of one.
     */
    expect(r.framesSampled).toBeGreaterThan(0);
  }, 60_000);

  it("reports UNKNOWN, not transparent, when the probe cannot read the file", async () => {
    const missing = path.join(workDir, "there-is-no-such-overlay.mov");
    const r = await probeOverlayInk(missing, resolveFFmpegBin(), (bin, args) =>
      execFileAsync(bin, args as string[], { maxBuffer: 1024 * 1024 * 16 })
    );
    expect(r.status).toBe("unknown");
    expect(r.framesSampled).toBe(0);
    expect(r.reason).toBeTruthy();
    /** An unreadable overlay must never be reported as one that contains no ink. */
    expect(r.status).not.toBe("transparent");
  }, 60_000);

  it("never throws — a failed measurement cannot fail a render that is otherwise fine", async () => {
    const r = await probeOverlayInk(inkOverlay, "/definitely/not/an/ffmpeg", async () => {
      throw new Error("spawn ENOENT");
    });
    expect(r.status).toBe("unknown");
    expect(r.reason).toContain("probe failed");
  });
});

/* ═══════════════════════ the pure layer ═══════════════════════ */

describe("the measurement itself", () => {
  it("reads every YMAX ffmpeg printed, in order", () => {
    const out = [
      "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YMAX=0",
      "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YMAX=207",
      "[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YMAX=255",
    ].join("\n");
    expect(parseSignalstatsYMax(out)).toEqual([0, 207, 255]);
  });

  it("skips a malformed line rather than reading it as a black frame", () => {
    expect(parseSignalstatsYMax("lavfi.signalstats.YMAX=\nlavfi.signalstats.YMAX=12")).toEqual([12]);
  });

  it("counts a frame as ink only above the floor", () => {
    const r = summariseInk("o.mov", [0, INK_ALPHA_FLOOR, INK_ALPHA_FLOOR + 1], 5);
    expect(r.inkFrames).toBe(1);
    expect(r.framesSampled).toBe(3);
    expect(r.status).toBe("ink");
  });

  it("calls no samples UNKNOWN, never transparent", () => {
    const r = summariseInk("o.mov", [], 5);
    expect(r.status).toBe("unknown");
    expect(r.reason).toBe("probe read no frames");
  });

  it("samples at a bounded rate, and says so in the arguments", () => {
    const args = overlayInkProbeArgs("/w/graphics_overlay.mov");
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("alphaextract");
    expect(vf).toContain(`fps=${SAMPLE_FPS}`);
    /** Normalising to 8-bit gray is what makes `maxAlpha` mean one thing across bit depths. */
    expect(vf).toContain("format=gray");
    expect(args).toContain("-f");
    expect(args).toContain("null");
  });

  it("names the overlay in the log line and never its path", () => {
    const line = formatOverlayInk(summariseInk("graphics_overlay.mov", [255, 255], 40));
    expect(line.startsWith("[Graphics] ")).toBe(true);
    expect(line).toContain("overlay=graphics_overlay.mov");
    expect(line).toContain("ink=ink");
    expect(line).toContain("inkFrames=2/2");
    expect(line).not.toContain("/w/");
  });
});

/* ═══════════════════════ 4-6. nothing else moved ═══════════════════════ */

describe("the existing graphics contract is untouched", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "timelineRenderer.ts"), "utf8");

  it("keeps the overlay-missing fallback exactly where it was", () => {
    /** The existence gate still decides which route runs; the probe was added inside it, not over it. */
    expect(renderer).toContain("if (overlay && fs.existsSync(overlay.overlayPath)) {");
    expect(renderer).toContain("was not written, fell back to the libass route");
    expect(renderer).toContain("graphics overlay unavailable, fell back to the libass route");
  });

  it("probes the overlay before compositing it, so the answer describes the composite's input", () => {
    const gate = renderer.indexOf("if (overlay && fs.existsSync(overlay.overlayPath)) {");
    const probe = renderer.indexOf("probeOverlayInk(overlay.overlayPath", gate);
    const composite = renderer.indexOf("overlay=format=auto:shortest=1", gate);
    expect(gate).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(gate);
    expect(composite).toBeGreaterThan(probe);
  });

  it("reports a transparent or unmeasurable overlay instead of passing over it in silence", () => {
    expect(renderer).toContain("contains no visible ink in");
    expect(renderer).toContain("graphics overlay ink could not be measured");
  });

  it("leaves `rendered` a count of graphics, with no ink term anywhere near it", () => {
    /**
     * RONDE 112's §7 in one assertion: the probe must not make `rendered` mean `delivered`. The
     * line that reports the counts takes no ink parameter, so an overlay measurement cannot leak
     * into a number that has always meant "the planner asked for a graphic this build can draw".
     */
    const line = formatGraphics({
      renderId: "r1",
      planned: 3,
      rendered: 2,
      explicitRendered: 1,
      genericRendered: 1,
      skipped: [],
      renderer: "remotion",
    });
    expect(line).toContain("rendered=2");
    expect(line).not.toContain("ink");
    expect(line).not.toContain("delivered");
  });

  it("keeps rendered = explicit + generic, over exactly the population `rendered` counts", () => {
    /**
     * The payload is deliberately generic and deliberately incomplete, so some types answer "not
     * renderable" — a bar chart with no series draws nothing whatever its name is. That is the
     * point: the split must partition the RENDERABLE ones and nothing else, which is how
     * `formatCinematicGraphics` derives `rendered`. Asserting against the vocabulary's size instead
     * would quietly assume every type is renderable with any data, which is false.
     */
    const data = { series: [{ label: "A", value: 1 }], points: [], toValue: 1 };
    const types = [...RENDERABLE_GRAPHICS];
    const renderable = types.filter((t) => graphicIsRenderable(t, data, "L"));
    const classes = types.map((t) => graphicRendererClass(t, data, "L"));
    const explicit = classes.filter((c) => c === "explicit").length;
    const generic = classes.filter((c) => c === "generic").length;
    const unsupported = classes.filter((c) => c === "unsupported").length;
    expect(renderable.length).toBeGreaterThan(0);
    expect(explicit + generic).toBe(renderable.length);
    expect(unsupported).toBe(types.length - renderable.length);
  });
});
