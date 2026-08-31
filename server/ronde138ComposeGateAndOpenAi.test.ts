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
  it("THE BUG: the bare `return false` on abort is gone", () => {
    const body = composeGateBody();
    expect(
      body,
      "an abandoned scope must not reject every clip outright"
    ).not.toContain("if (sceneFetchAborted()) return false;");
    expect(body).toContain("if (sceneFetchAborted()) {");
  });

  it("...and what replaces it consults a measurement already taken", () => {
    const body = composeGateBody();
    expect(body).toContain("const known = memoisedVideoStreamMeta(clipPath);");
    // The same usability rule the non-aborted path applies — not a looser one.
    expect(body).toContain("montageStreamMetaUsable(known, montageClipStartSec(sceneIndex, clipIndex))");
  });

  it("a file with NO prior measurement is still refused", () => {
    /**
     * The half of the guarantee that keeps derived files honest. pad_combined_*.mp4 and the
     * text-overlay output are written moments before this call and have never been probed, so a
     * half-written ffmpeg result cannot ride through on "we were in a hurry".
     */
    const body = composeGateBody();
    const abortBlock = body.slice(
      body.indexOf("if (sceneFetchAborted()) {"),
      body.indexOf("if (!(await isValidVideoFile(clipPath)))")
    );
    expect(abortBlock).toContain("return false;");
    /**
     * The block does contain a `return true` — that is the whole point — but it must be reachable
     * only through the guard. An acceptance that did not depend on `known` would let an unmeasured
     * file through, which is exactly what this test exists to forbid.
     */
    const accept = abortBlock.indexOf("return true;");
    expect(accept).toBeGreaterThan(0);
    const beforeAccept = abortBlock.slice(0, accept);
    expect(beforeAccept).toContain("if (known && montageStreamMetaUsable(");
  });

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

  it("the rest of the gate is untouched — every other check still runs", () => {
    // The fix is about WHEN the gate can answer, not about what it checks.
    const body = composeGateBody();
    expect(body).toContain("if (!(await isValidVideoFile(clipPath))) return false;");
    expect(body).toContain("montageStreamMetaUsable(meta, trimStart)");
    expect(body).toContain("probeClipMeanLuma(clipPath, trimStart + 0.08)");
    expect(body).toContain("composeBarrierAllows(");
  });
});

/* ═══════════════════════ B — the OpenAI image provider ═══════════════════════ */

describe("RONDE 138 §B — OpenAI joins the cheap image tier", () => {
  it("it is OFF unless explicitly switched on", () => {
    /**
     * This spends money per beat on an account configured for text. Defaulting it on would bill an
     * operator for a decision they never made.
     */
    const src = readCode("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("export function openAiImageFallbackEnabled("),
      src.indexOf("export async function generateOpenAiImageClip(")
    );
    expect(fn).toContain('process.env.ENABLE_OPENAI_IMAGE_FALLBACK !== "true"');
    expect(fn).toContain("openAiKeyFromEnv()");
  });

  it("the readiness line counts it, so 'AI fallback: on' stays truthful", () => {
    // RONDE 137 made that line honest; it would be false again if a working provider were invisible.
    const src = readCode("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("function cheapAiImageProvidersReady("),
      src.indexOf("function premiumAiVideoFallbackEnabled(")
    );
    expect(fn).toContain("openAiImageFallbackEnabled()");
  });

  it("it sits in the CHEAP tier, after Stability and Leonardo", () => {
    /**
     * Order is the cost decision: a deployment holding a Stability key keeps using it, and OpenAI
     * is what a deployment with only an LLM key falls back to.
     */
    const src = readCode("server/videoPipeline.ts");
    const ladder = src.slice(
      src.indexOf("if (stabilityAiApiKey()) {"),
      src.indexOf("if (!generated && premiumAiVideoFallbackEnabled()) {")
    );
    expect(ladder).toContain("generateOpenAiImageClip(prompt, dur, outPath, sceneIndex)");
    expect(ladder.indexOf("generateStabilityAIClip")).toBeLessThan(ladder.indexOf("generateOpenAiImageClip"));
    expect(ladder.indexOf("generateLeonardoAIClip")).toBeLessThan(ladder.indexOf("generateOpenAiImageClip"));
  });

  it("it produces its clip through the SAME encode as Stability", () => {
    /**
     * Not a copy of the ffmpeg chain. renderAiStillToClip was extracted out of
     * generateStabilityAIClip so both providers hand the montage an identical kind of file, and
     * every gate downstream judges them the same way.
     */
    const src = readCode("server/videoPipeline.ts");
    expect(src).toContain("async function renderAiStillToClip(");
    const openai = src.slice(
      src.indexOf("export async function generateOpenAiImageClip("),
      src.indexOf("export async function generateStabilityAIClip(")
    );
    expect(openai).toContain("renderAiStillToClip(pngPath, outputPath, duration, sceneIndex)");
    // ...and it does not carry its own zoompan/encode.
    expect(openai).not.toContain("zoompan");
    expect(openai).not.toContain("libx264");

    const stability = src.slice(
      src.indexOf("export async function generateStabilityAIClip("),
      src.indexOf("export async function fetchPexelsClips(")
    );
    expect(stability).toContain("renderAiStillToClip(pngPath, outputPath, duration, sceneIndex)");
    expect(stability).not.toContain("zoompan");
  });

  it("a failed request returns null and says the status, rather than throwing", () => {
    /**
     * The status is the only thing an operator can act on: 401 is a key, 429 is a quota, 400 is a
     * refused prompt. A thrown error here would abort a beat that could still fall through.
     */
    const src = readCode("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("export async function generateOpenAiImageClip("),
      src.indexOf("export async function generateStabilityAIClip(")
    );
    expect(fn).toContain("OpenAI image HTTP ${resp.status}");
    expect(fn).toContain("return null;");
    expect(fn).toContain("} catch (err) {");
  });

  it("both response shapes are accepted — bytes and URL", () => {
    // gpt-image-1 answers with b64_json; dall-e-3 answers with a URL.
    const src = readCode("server/videoPipeline.ts");
    const fn = src.slice(
      src.indexOf("export async function generateOpenAiImageClip("),
      src.indexOf("export async function generateStabilityAIClip(")
    );
    expect(fn).toContain("first?.b64_json");
    expect(fn).toContain("first?.url");
  });

  it("quality and model are env-tunable, because they are a billing decision", () => {
    const src = readCode("server/videoPipeline.ts");
    expect(src).toContain('process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-1"');
    expect(src).toContain("process.env.OPENAI_IMAGE_QUALITY?.trim().toLowerCase()");
    // Default is the cheap one — this is a fallback picture, not a hero shot.
    const q = src.slice(
      src.indexOf("function openAiImageQuality("),
      src.indexOf("export function openAiImageFallbackEnabled(")
    );
    expect(q.length).toBeGreaterThan(50);
    expect(q).toContain('return raw === "medium" || raw === "high" ? raw : "low";');
  });
});
