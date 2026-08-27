/**
 * RONDE 108 — trimming in the archive actually trims.
 *
 * Reported as "de knop is er, maar hij werkt niet". The ffmpeg engine underneath was fine — the
 * real command, run against a real ten-second fixture, produces exactly the requested four
 * seconds. Everything between the operator and that command was not.
 *
 * Four separate defects, each of which on its own reads as "the button does nothing":
 *
 *   1. `markStart`/`markEnd` returned in silence when the playhead could not be read. Click,
 *      nothing happens, no message. A control that refuses without saying so is indistinguishable
 *      from a broken one.
 *   2. The server treated an explicitly marked start of 0 as "no range given" and went off to
 *      detect a scene cut instead, then reported "No reliable scene cut detected" — about scene
 *      detection nobody asked for.
 *   3. The apply button was offered for ranges the server was always going to refuse, because the
 *      rule lived server-side where the panel could not ask it.
 *   4. After a SUCCESSFUL trim the card kept its stale scene audit and its scissors button,
 *      because the handler that clears it was never called. The clip really was trimmed and the
 *      screen said otherwise.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

import { MIN_TRIMMED_CLIP_SEC, validateTrimRange } from "@shared/archiveTrim";

const GRID = fs.readFileSync(
  path.join(__dirname, "..", "client", "src", "components", "admin", "ArchiveClipsGrid.tsx"),
  "utf8"
);
const ROUTERS = fs.readFileSync(path.join(__dirname, "routers.ts"), "utf8");
const TRIM = fs.readFileSync(path.join(__dirname, "archiveTrimToScene.ts"), "utf8");

/* ═══════════ the engine, for real ═══════════ */

describe("RONDE 108 — the trim engine itself was never the problem", () => {
  it("the exact command trimArchiveAsset runs produces the requested range", () => {
    /**
     * Run before changing anything, to find out which half was broken. A ten-second source cut to
     * 3s–7s comes out at four seconds. The engine is fine; the path to it was not.
     */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r108-trim-"));
    const src = path.join(dir, "src.mp4");
    const out = path.join(dir, "out.mp4");
    execSync(
      `ffmpeg -y -f lavfi -i "testsrc=size=320x240:rate=25:duration=10" ` +
        `-c:v libx264 -pix_fmt yuv420p "${src}" 2>/dev/null`
    );
    execSync(
      `ffmpeg -y -ss 3.000 -i "${src}" -t 4.000 -c:v libx264 -preset fast -crf 22 ` +
        `-movflags +faststart -c:a aac "${out}" 2>/dev/null`
    );
    const dur = Number(
      execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${out}"`).toString()
    );
    expect(dur).toBeGreaterThan(3.8);
    expect(dur).toBeLessThan(4.2);
    expect(fs.statSync(out).size).toBeGreaterThan(1000);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

/* ═══════════ one rule, both sides ═══════════ */

describe("RONDE 108 — the range rule is shared, so the panel can ask before it sends", () => {
  const DUR = 10;

  it("a real range is accepted", () => {
    const v = validateTrimRange({ startSec: 3, endSec: 7 }, DUR);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.startSec).toBe(3);
      expect(v.endSec).toBe(7);
    }
  });

  it("a start-only range keeps the tail", () => {
    const v = validateTrimRange({ startSec: 4 }, DUR);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.endSec).toBe(DUR);
  });

  it("an end-only range keeps the head", () => {
    const v = validateTrimRange({ endSec: 6 }, DUR);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.startSec).toBe(0);
  });

  it("the whole clip is refused — it would re-encode for nothing", () => {
    const v = validateTrimRange({ startSec: 0, endSec: DUR }, DUR);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("hele clip");
  });

  it("a range shorter than the floor is refused", () => {
    const v = validateTrimRange({ startSec: 2, endSec: 2 + MIN_TRIMMED_CLIP_SEC / 2 }, DUR);
    expect(v.ok).toBe(false);
  });

  it("an inverted range is refused", () => {
    expect(validateTrimRange({ startSec: 7, endSec: 3 }, DUR).ok).toBe(false);
  });

  it("a start past the end of the clip is refused", () => {
    expect(validateTrimRange({ startSec: DUR + 1 }, DUR).ok).toBe(false);
  });

  it("it lives in shared/, and the server re-exports it rather than keeping a second copy", () => {
    expect(TRIM).toContain('} from "@shared/archiveTrim";');
    expect(TRIM).not.toContain("export function validateTrimRange(");
    expect(GRID).toContain('from "@shared/archiveTrim"');
  });
});

/* ═══════════ the four defects ═══════════ */

describe("RONDE 108 #1 — nothing refuses in silence any more", () => {
  it("the playhead reader returns a REASON instead of null", () => {
    expect(GRID).toContain(
      "function playheadSec(): { ok: true; sec: number } | { ok: false; reason: string }"
    );
    // The silent guard is gone from the CODE. The removal note quotes it, so comments are
    // stripped before asking — an assertion that reads its own documentation proves nothing.
    const code = GRID.split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("if (t == null) return;");
  });

  it("marking a point that cannot be read tells the operator why", () => {
    const idx = GRID.indexOf('function markAt(which: "start" | "end")');
    expect(idx).toBeGreaterThan(-1);
    const body = GRID.slice(idx, idx + 1200);
    expect(body).toContain('toast.error("Kan het punt niet bepalen", { description: read.reason })');
  });

  it("marking pauses, so the mark lands on the frame the operator was looking at", () => {
    const idx = GRID.indexOf('function markAt(which: "start" | "end")');
    expect(GRID.slice(idx, idx + 1200)).toContain("getVideo()?.pause();");
  });

  it("the minimum gap between the two marks comes from the shared rule, not a literal", () => {
    const idx = GRID.indexOf('function markAt(which: "start" | "end")');
    const body = GRID.slice(idx, idx + 1200);
    expect(body).toContain("MIN_TRIMMED_CLIP_SEC");
    expect(body).not.toContain("- 0.5)");
  });
});

describe("RONDE 108 #2 — an explicit mark is not overruled by scene detection", () => {
  it("auto-detect runs only when the request carried no range at all", () => {
    const idx = ROUTERS.indexOf("trimToSingleScene: adminProcedure");
    const block = ROUTERS.slice(idx, idx + 2600);
    expect(block).toContain(
      "const operatorGaveRange = input.startSec != null || input.endSec != null;"
    );
    expect(block).toContain("if (!operatorGaveRange && endSec == null) {");
    // The old test treated a defaulted 0 as "nothing was said".
    expect(block).not.toContain("if (endSec == null && startSec <= 0) {");
  });

  it("the client sends both bounds, so there is nothing left to re-interpret", () => {
    const idx = GRID.indexOf("const result = await trimMutation.mutateAsync({");
    const block = GRID.slice(idx, idx + 400);
    expect(block).toContain("startSec: from,");
    expect(block).toContain("endSec: to,");
    // ...and the card's own scissors does the same.
    expect(GRID).toContain("startSec: 0,\n                          endSec: cut,");
  });
});

describe("RONDE 108 #3 — the button says why it cannot, before it is pressed", () => {
  it("the panel validates with the same rule the server uses", () => {
    expect(GRID).toContain("const trimVerdict = validateTrimRange(");
  });

  it("apply is disabled on an impossible range, and the reason is on screen", () => {
    expect(GRID).toContain("disabled={trimming || !trimVerdict.ok}");
    expect(GRID).toContain("title={trimVerdict.ok ? ");
    expect(GRID).toContain("<span className=\"text-xs text-amber-300/90\">{trimVerdict.reason}</span>");
  });

  it("applying still re-checks — a UI check is a courtesy, not a guarantee", () => {
    const idx = GRID.indexOf("async function applyTrim()");
    const body = GRID.slice(idx, idx + 900);
    expect(body).toContain("if (!trimVerdict.ok) {");
    expect(body).toContain('toast.error("Dit bereik kan niet"');
  });

  it("no scissors are offered over a clip that cannot be played", () => {
    expect(GRID).toContain('{asset.mediaType === "video" && !canPlay && (');
    expect(GRID).toContain('{asset.mediaType === "video" && canPlay && (');
    expect(GRID).toContain("Bijknippen kan niet:");
  });

  it("playability follows the video element, not a guess from the row", () => {
    expect(GRID).toContain("const [canPlay, setCanPlay] = useState(asset.mediaAvailable !== false);");
    expect(GRID).toContain('["error", () => setCanPlay(false)]');
    expect(GRID).toContain("setCanPlay(true);");
  });

  it("every listener this effect attaches is removed again", () => {
    // A previous version tracked two by hand and a third was added without a matching removal.
    const idx = GRID.indexOf("const attached: Array<[string, EventListener]> = [];");
    expect(idx).toBeGreaterThan(-1);
    const body = GRID.slice(idx, idx + 1600);
    expect(body).toContain("for (const [type, fn] of attached) v.addEventListener(type, fn);");
    expect(body).toContain(
      "for (const [type, fn] of attached) attachedVideo.removeEventListener(type, fn);"
    );
  });
});

describe("RONDE 108 #4 — a successful trim updates the card", () => {
  it("the modal hands the new duration up instead of dropping it", () => {
    expect(GRID).toContain("onTrimmed={(newDurationSec) => onTrimmed(asset.id, newDurationSec)}");
    expect(GRID).not.toContain("onTrimmed={() => onRefresh()}");
  });

  it("the card's own scissors hands it up too", () => {
    expect(GRID).toContain("onTrimmed(asset.id, result.newDurationSec ?? cut);");
  });

  it("the parent handler is the one that clears the stale scene audit", () => {
    const idx = GRID.indexOf("onTrimmed={(assetId, newDurationSec) => {");
    expect(idx).toBeGreaterThan(-1);
    const body = GRID.slice(idx, idx + 700);
    expect(body).toContain('status: "single_scene"');
    expect(body).toContain("cutTimesSec: []");
    expect(body).toContain("durationSec: newDurationSec");
  });
});
