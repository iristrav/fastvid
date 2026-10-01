/**
 * RONDE 138 — the gate that threw away approved clips, and the image provider you already pay for.
 *
 * ── A1: "scope abandoned" was being read as "reject" ─────────────────────────────────────────
 *
 * Video 558 lost fourteen clips at the very last step:
 *
 *     Scene 1 beat 4: skipping clip that fails compose gate scene_1_b4_curated_a57618.mp4
 *     Scene 1 beat 4: skipping clip that fails compose gate scene_1_b4_curated_a57654.mp4
 *     Scene 2 beat 0: skipping clip that fails compose gate scene_2_b0_curated_a57566.mp4   …
 *
 * Ten of them were already-downloaded archive files that had passed the technical gate, been judged
 * by Vision and been adopted. Scene 1 finished with 2 unique clips where it needed 13, and the
 * render reported "19 van 22 beats zonder goedgekeurd eigen beeld".
 *
 * The cause is one line in montageClipPassesComposeGate:
 *
 *     if (sceneFetchAborted()) return false;
 *
 * Its reasoning was sound as far as it went — once the scope's timeout has fired every probe below
 * throws immediately and is swallowed as a false "unusable stream", so running them is waste. The
 * conclusion did not follow: skipping a CHECK is not failing it, and a clip does not become
 * unusable because the scene ran out of time looking for other clips.
 *
 * The gate now answers from a measurement this render already took (probeVideoStreamMeta memoises
 * on inode+ctime, so it costs no subprocess — the only thing the abort actually forbids). A file
 * with no prior measurement is still refused, which is what keeps the freshly-written derived files
 * (pad_combined_*.mp4, the overlay output) from slipping through unverified.
 *
 * ── B: an image provider that exists in this deployment ──────────────────────────────────────
 *
 * The ladder promises "AI clip when stock/YouTube miss — never grey" and video 558 shipped seven
 * colour cards, because that promise needs an image API and there was none: no Stability key, no
 * Leonardo key, Kling absent (adopt audit kling=0), and _core's generateImage wants a
 * BUILT_IN_FORGE_API_URL that is not set. OpenAI was configured the whole time — as the LLM.
 */
import { describe, expect, it } from "vitest";

const read = (rel: string) => {
  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(__dirname, "..", rel), "utf8");
};
/**
 * Source with PROSE comments removed.
 *
 * Only block comments that BEGIN a line are stripped, which is what an explanatory comment looks
 * like. The obvious `/\*[\s\S]*?\*\/` desynchronises on a `*​/` inside a string or a regex, and on a
 * 37 000-line file that silently swallows real code: measured on videoPipeline.ts it removed
 * `fetchPexelsClips` entirely and four of six `renderAiStillToClip` call sites, which would make
 * every `not.toContain` assertion below pass for the wrong reason. Inline `/* ignore *​/` survives,
 * which is harmless.
 */
const readCode = (rel: string) =>
  read(rel)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

function composeGateBody(): string {
  const src = readCode("server/videoPipeline.ts");
  const start = src.indexOf("async function montageClipPassesComposeGate(");
  expect(start, "montageClipPassesComposeGate not found").toBeGreaterThan(0);
  const body = src.slice(start, src.indexOf("\n}\n", src.indexOf("const curatedId = curatedClipPathAssetId", start)));
  expect(body.length).toBeGreaterThan(500);
  return body;
}

/* ═══════════════════════ A1 — the compose gate ═══════════════════════ */

describe("RONDE 138 §A1 — an abandoned scope no longer rejects a measured clip", () => {

  it("the accessor spawns nothing — that is the entire reason it may run under abort", () => {
    const src = readCode("server/videoPipeline.ts");
    const start = src.indexOf("function memoisedVideoStreamMeta(");
    expect(start).toBeGreaterThan(0);
    const fn = src.slice(start, src.indexOf("\n}", start));
    expect(fn).toContain("videoStreamMetaMemo.get(key)");
    for (const forbidden of ["exec(", "execFile", "await ", "ffprobe", "FFPROBE"]) {
      expect(fn, `the memo reader must not ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("an unmeasurable path returns undefined, which is not the same as 'no meta'", () => {
    /**
     * probeMemoKey returns null when the file cannot be stat'ed. That has to stay distinguishable
     * from a memo miss, because `null` is a RECORDED verdict ("measured, and there is no video
     * stream") while `undefined` means nobody has looked.
     */
    const src = readCode("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("function memoisedVideoStreamMeta("),
      src.indexOf("\n}", src.indexOf("function memoisedVideoStreamMeta("))
    );
    expect(fn).toContain("if (key === null) return undefined;");
  });
});

/* ═══════════════════════ B — the OpenAI image provider ═══════════════════════ */

describe("RONDE 138 §B — the OpenAI image provider", () => {
  it("is gone, with its switch: no generated image can reach a film", () => {
    /**
     * Code audit P13: ENABLE_OPENAI_IMAGE_FALLBACK only fed a readiness line; no route generated an
     * image. The flag, its readiness helper and the health field were removed together.
     */
    const src = readCode("server/videoPipeline.ts");
    expect(src).not.toContain("ENABLE_OPENAI_IMAGE_FALLBACK");
    expect(src).not.toContain("openAiImageFallbackEnabled");
    expect(src).not.toContain("generateOpenAiImageClip");
  });
});
