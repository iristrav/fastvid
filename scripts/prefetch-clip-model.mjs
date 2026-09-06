/**
 * BAKE THE CLIP MODEL INTO THE IMAGE, SO NO REPLICA EVER DOWNLOADS IT.
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────
 *
 * The worker log of 2026-09-05 shows eleven boots in fifty minutes and eleven of these:
 *
 *     [LocalVision] CLIP model not in cache (/tmp/fastvid-transformers-cache) — downloading ~350MB
 *     [LocalVision] First-time download — using 300s timeout (attempt 1)
 *
 * The obvious remedy is a Railway volume. It is the wrong one here: a service with a volume is
 * limited to a single replica, and this worker runs three. Trading two thirds of the render
 * capacity to avoid a download is a bad exchange, and the delivered MP4 already goes to S3/R2
 * (`[Preflight] AVAILABLE storage — bucket and keys configured`), so the volume buys little else.
 *
 * Fetching the weights once at BUILD time costs nothing at runtime, keeps all three replicas, and
 * needs no change in the deployment's configuration at all.
 *
 * ── Why it loads rather than downloads ──────────────────────────────────────────────────────
 *
 * It calls the same three entry points `ensureClipPipelinesLoaded` calls, with the same
 * `quantized: true` — the image tower through `pipeline()`, and the text tower through
 * `CLIPTextModelWithProjection` plus its tokenizer, because CLIP's combined ONNX graph demands
 * `pixel_values` on every forward pass and cannot serve text alone.
 *
 * Naming the files to fetch instead would be a second, silent copy of that decision: the day the
 * runtime switches to a different quantization, the build would still be caching the old one and
 * every boot would quietly download again. Loading is the only way the cache is right by
 * construction.
 *
 * ── Failure is loud ─────────────────────────────────────────────────────────────────────────
 *
 * A non-zero exit fails the image build. The alternative — warning and carrying on — produces
 * exactly the state this exists to end: an image that looks fine and re-downloads 350MB per
 * replica per deploy, discoverable only by reading a production log line by line.
 */
const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const cacheDir = process.env.TRANSFORMERS_CACHE || "/opt/models/transformers-cache";

process.env.TRANSFORMERS_CACHE = cacheDir;
process.env.HF_HOME = cacheDir;
process.env.XDG_CACHE_HOME = cacheDir;

const { env, pipeline, AutoTokenizer, CLIPTextModelWithProjection } = await import(
  "@xenova/transformers"
);

env.cacheDir = cacheDir;
/** The one place this must differ from runtime: the build is where downloading is the point. */
env.allowRemoteModels = true;
env.useBrowserCache = false;
env.backends.onnx.wasm.numThreads = 1;

console.log(`[PrefetchCLIP] caching ${CLIP_MODEL} into ${cacheDir}`);

await pipeline("image-feature-extraction", CLIP_MODEL, { quantized: true });
console.log("[PrefetchCLIP] image tower cached");

await AutoTokenizer.from_pretrained(CLIP_MODEL);
await CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { quantized: true });
console.log("[PrefetchCLIP] text tower cached");

/**
 * The same question `clipModelExistsLocally` asks at runtime, asked here while a failure is still
 * cheap. A cache that loaded but wrote nothing recognisable would send every boot back to the
 * network with the build reporting success.
 */
const fs = await import("fs");
const path = await import("path");

const listOnnx = (dir) => {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".onnx"));
  } catch {
    return [];
  }
};

/**
 * THE BUILD ASSERTS THE QUESTION THE RUNTIME WILL ASK, NOT A QUESTION OF ITS OWN.
 *
 * The first attempt checked its own idea of where the weights go, flatly, and failed on a cache
 * that was in fact complete:
 *
 *     [PrefetchCLIP] image tower cached
 *     [PrefetchCLIP] text tower cached
 *     [PrefetchCLIP] FAILED: no .onnx
 *
 * @xenova/transformers writes `<model>/onnx/model_quantized.onnx` and leaves only JSON config in
 * the model directory. `clipModelExistsLocally` asked the same question the same wrong way, so it
 * has answered false for every cached model it was ever given — printing "not in cache" on intact
 * caches and never letting the loader work offline.
 *
 * Mirroring the runtime rule exactly — same directory, same recursion — is what makes a green
 * build mean "the worker will find this". A check with its own opinion can pass while the runtime
 * still downloads, which is the failure this whole layer exists to prevent.
 */
const modelDir = path.join(cacheDir, ...CLIP_MODEL.split("/"));
const asRuntimeSeesIt = listOnnx(modelDir);

if (asRuntimeSeesIt.length > 0) {
  console.log(
    `[PrefetchCLIP] done — ${asRuntimeSeesIt.length} onnx file(s) where the runtime looks: ` +
      asRuntimeSeesIt.join(", ")
  );
  process.exit(0);
}

/**
 * FAILING LOUDLY, AND WITH THE ANSWER IN IT.
 *
 * Two different problems produce an empty result: nothing was written at all, or it was written
 * somewhere this build did not expect. They need different fixes and `FAILED: no .onnx` cannot
 * tell them apart — which cost a deploy cycle already. So the cache is searched whole, and when
 * files exist elsewhere their real location is printed: the next build log then names the path to
 * align the runtime with, instead of inviting another guess.
 */
console.error(`[PrefetchCLIP] FAILED: no .onnx under ${modelDir}, where the runtime looks.`);
const anywhere = listOnnx(cacheDir);
if (anywhere.length > 0) {
  console.error(
    `[PrefetchCLIP] but ${anywhere.length} .onnx file(s) DID land under ${cacheDir}:`
  );
  for (const f of anywhere.slice(0, 20)) console.error(`[PrefetchCLIP]   ${f}`);
  console.error(
    "[PrefetchCLIP] the weights are cached; clipModelExistsLocally must be pointed at that path."
  );
} else {
  console.error(`[PrefetchCLIP] and none anywhere under ${cacheDir} either. Tree:`);
  try {
    for (const f of fs
      .readdirSync(cacheDir, { recursive: true, encoding: "utf8" })
      .slice(0, 40)) {
      console.error(`[PrefetchCLIP]   ${f}`);
    }
  } catch (err) {
    console.error(`[PrefetchCLIP]   (${cacheDir} is not readable: ${err.message})`);
  }
}
process.exit(1);
