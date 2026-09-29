/**
 * RONDE 113 — no characters are drawn into the picture.
 *
 * Text was reported in a delivered video. It did not come from one place, which is the whole
 * finding: THREE separate engines can burn characters into a frame and two of them were on by
 * default, while seven more were off but a single environment variable from being on again.
 *
 *   · visualDirector          — person labels, stat highlights, A-vs-B comparisons, bullet
 *                               lists, pull quotes, counters, map markers      ← DEFAULT ON
 *   · cinematicEffects        — year badges, animated stat counters, section
 *                               headlines, name badges, keyword pills           ← DEFAULT ON
 *   · editorialGraphics       — whole generated cards adopted as beat footage   ← DEFAULT ON
 *
 * The year badge is the sharpest example of why flipping switches was not the fix: it was drawn
 * even inside `yearsOnly`, the restricted mode that exists precisely to suppress extra on-screen
 * text. So "years only" never meant "no text", it meant "less text" — and every switch looked
 * correctly set while characters kept reaching delivered videos.
 *
 * One rule now, asked inside each feature's own `…Enabled()` rather than at the call sites, so a
 * caller cannot route around it and a future text feature cannot quietly become the eighth.
 *
 * NOT covered, on purpose: text that was already in the footage (a chyron, a watermark, an
 * archive intertitle) — the pipeline rejects those clips at adoption via archiveClipHasBakedEditText
 * — and subtitles, which are a per-video switch the operator ticks themselves.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import {
  BURNED_IN_TEXT_SOURCES,
  burnedInTextAllowed,
  describeOnScreenTextPolicy,
} from "./onScreenTextPolicy";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
const CINEMATIC = fs.readFileSync(path.join(__dirname, "cinematicEffectsEngine.ts"), "utf8");
const POLICY = fs.readFileSync(path.join(__dirname, "onScreenTextPolicy.ts"), "utf8");

/** Every module in server/ that contains a drawtext filter. */
function modulesWithDrawtext(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
      if (fs.readFileSync(full, "utf8").includes("drawtext=")) out.push(full);
    }
  };
  walk(__dirname);
  return out;
}

const ORIGINAL = process.env.ALLOW_BURNED_IN_TEXT;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOW_BURNED_IN_TEXT;
  else process.env.ALLOW_BURNED_IN_TEXT = ORIGINAL;
});

function withTextAllowed<T>(fn: () => T): T {
  process.env.ALLOW_BURNED_IN_TEXT = "true";
  try {
    return fn();
  } finally {
    delete process.env.ALLOW_BURNED_IN_TEXT;
  }
}

/* ═══════════ the rule ═══════════ */

describe("RONDE 113 — the default is no text", () => {
  it("burned-in text is off unless it is explicitly switched on", () => {
    delete process.env.ALLOW_BURNED_IN_TEXT;
    expect(burnedInTextAllowed()).toBe(false);
    // ...and only that exact value re-enables it, so a stray "1"/"yes" cannot.
    for (const value of ["1", "yes", "on", "TRUE", ""]) {
      process.env.ALLOW_BURNED_IN_TEXT = value;
      expect(burnedInTextAllowed(), value).toBe(false);
    }
    expect(withTextAllowed(() => burnedInTextAllowed())).toBe(true);
  });

  it("the rule has no dependencies, so no import cycle can weaken it", () => {
    expect(POLICY).not.toContain("\nimport ");
  });

  it("the render says out loud that it drew no text", () => {
    delete process.env.ALLOW_BURNED_IN_TEXT;
    const line = describeOnScreenTextPolicy();
    expect(line).toContain("[OnScreenText]");
    expect(line).toContain("no burned-in text");
    expect(withTextAllowed(() => describeOnScreenTextPolicy())).toContain("ALLOWED");
    expect(PIPELINE).toContain('pipelineReport.add("summary", describeOnScreenTextPolicy());');
  });
});

/* ═══════════ every gate ═══════════ */

describe("RONDE 113 — every text engine is held off", () => {
  const gates: Array<[string, () => Promise<boolean>]> = [
    ["editorialGraphics", async () => (await import("./editorialGraphicsEngine")).editorialGraphicsEnabled()],
    ["screenLabels", async () => (await import("./sourcingPolicy")).screenLabelsEnabled()],
    ["facelessSubtitles", async () => (await import("./sourcingPolicy")).facelessSubtitlesEnabled()],
    ["extraOnScreenText", async () => (await import("./sourcingPolicy")).extraOnScreenTextEnabled()],
    ["motionGraphics", async () => (await import("./sourcingPolicy")).motionGraphicsInVideosEnabled()],
  ];

  for (const [name, gate] of gates) {
    it(`${name} is closed by default`, async () => {
      delete process.env.ALLOW_BURNED_IN_TEXT;
      expect(await gate()).toBe(false);
    });
  }

  it("the three that were ON by default are the ones that mattered", () => {
    /**
     * Their env flags all read `!== "false"`, so nothing had to be configured wrong for text to
     * appear — it was the shipped default.
     */
    const defaultOn = BURNED_IN_TEXT_SOURCES.filter((s) => s.wasDefaultOn).map((s) => s.engine);
    expect(defaultOn).toEqual([
      "visualDirector",
      "cinematicEffects overlays",
      "editorialGraphics",
    ]);
  });
});

/* ═══════════ the year badge ═══════════ */

describe("RONDE 113 — the cinematic overlays draw nothing", () => {

  it("the two label builders refuse on their own too, not only at the call site", () => {
    /**
     * buildIntervalScreenLabelOverlays and buildBeatAlignedYearOverlays were reachable only
     * through screenLabelsEnabled() at the call site. That gate is closed now as well, but a
     * call-site gate is one `if` a future caller can forget and these builders' whole output is
     * text — so they refuse for themselves.
     */
    for (const fn of ["buildIntervalScreenLabelOverlays", "buildBeatAlignedYearOverlays"]) {
      const idx = CINEMATIC.indexOf(`export async function ${fn}(`);
      expect(idx, fn).toBeGreaterThan(-1);
      expect(CINEMATIC.slice(idx, idx + 900), fn).toContain("if (!burnedInTextAllowed()) return [];");
    }
  });

  it("both motion-graphics entry points refuse independently", () => {
    const mg = fs.readFileSync(path.join(__dirname, "motionGraphicsEngine.ts"), "utf8");
    expect(mg).toContain("if (!plan || !motionGraphicsEnabled()) return false;");
    expect(mg).toContain("if (!motionGraphicsEnabled()) return null;");
  });
});

/* ═══════════ nothing was missed ═══════════ */

describe("RONDE 113 — every drawtext module is accounted for", () => {
  /**
   * The sweep that makes this round more than a list of switches: find every module in server/
   * that can emit a drawtext filter, and require each one to be either behind the policy or
   * genuinely unreachable from the render.
   */
  const REACHABLE_AND_GATED = [
    "editorialGraphicsEngine.ts",
    "motionGraphicsEngine.ts",
    "cinematicEffectsEngine.ts",
    "documentaryStyle.ts",
    "videoPipeline.ts",
  ];
  /** Not imported by videoPipeline.ts, directly or through the modules it does import. */
  const UNREACHABLE_FROM_RENDER = [
    "cinematicEditingEngine/captionPlanner.ts",
    "motionGraphicsLayer.ts",
    "ffmpegSanitize.ts",
    /**
     * RONDE 146 — mentions `drawtext` and cannot draw it.
     *
     * `ffmpegBinary.ts` is the shared binary resolver. It names the filter in two places: a
     * comment explaining WHY a system ffmpeg is preferred over ffmpeg-static, and
     * `ffmpegHasFilter(bin, "drawtext")`, which ASKS a binary whether the filter exists so a
     * render can report its own capabilities. Neither builds a filter graph, and this module emits
     * no ffmpeg command that renders anything.
     *
     * Listed here rather than gated behind `burnedInTextAllowed()` because gating it would be
     * wrong in an interesting way: the capability REPORT is most useful exactly when text is
     * switched off, since that is when nobody would otherwise discover that this build could not
     * have drawn text anyway.
     */
    "ffmpegBinary.ts",
  ];

  it("the sweep finds no module outside those two lists", () => {
    const found = modulesWithDrawtext().map((f) => path.relative(__dirname, f));
    const known = new Set([...REACHABLE_AND_GATED, ...UNREACHABLE_FROM_RENDER]);
    const unaccounted = found.filter((f) => !known.has(f));
    expect(
      unaccounted,
      `new drawtext module(s) — gate them behind burnedInTextAllowed() or add them to the ` +
        `unreachable list with a reason: ${unaccounted.join(", ")}`
    ).toEqual([]);
  });

  it("the unreachable ones really are unreachable from the render", () => {
    // videoPipeline.ts is the only entry point that composes a delivered file.
    for (const file of ["cinematicMotion/renderer", "cinematicMotion/counter", "cinematicEditingEngine/captionPlanner"]) {
      expect(PIPELINE, file).not.toContain(`from "./${file}"`);
    }
    expect(PIPELINE).not.toContain("professionalRenderEngine");
  });
});

/* ═══════════ what stays ═══════════ */

describe("RONDE 113 — what this deliberately does not touch", () => {
  /**
   * VIDEO 619 — subtitles are no longer a per-video switch in the dashboard. Every text, subtitles
   * included, arrives switched off and is turned on in the editor (`leaveOnScreenTextToTheEditor`),
   * so there is no request field left for this policy to override.
   */
  it("subtitles are turned on in the editor, not by a per-video switch", () => {
    const routers = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
    expect(routers).not.toContain("enableSubtitles: z.boolean()");
    expect(routers).toContain("enableSubtitles: 0,");
  });

  it("footage that ALREADY contains text is still refused at adoption", () => {
    // A chyron or watermark in the source is a sourcing question, and it already has an answer.
    const curated = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    expect(curated).toContain("has baked edit text — skipped");
  });
});
