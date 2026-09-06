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
const modelDir = path.join(cacheDir, ...CLIP_MODEL.split("/"));
/**
 * RECURSIVELY, which the first attempt was not — and the build said so:
 *
 *     [PrefetchCLIP] image tower cached
 *     [PrefetchCLIP] text tower cached
 *     [PrefetchCLIP] FAILED: no .onnx
 *
 * Both towers were cached correctly. @xenova/transformers writes the weights to
 * `<model>/onnx/model_quantized.onnx` and leaves only JSON config in the model directory, so a
 * flat listing finds nothing. `clipModelExistsLocally` asked the same question the same wrong
 * way and has answered false for every cached model it was ever given; this build is what
 * surfaced it, and both are fixed together.
 */
const onnx = fs.existsSync(modelDir)
  ? fs.readdirSync(modelDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".onnx"))
  : [];
if (onnx.length === 0) {
  console.error(
    `[PrefetchCLIP] FAILED: no .onnx anywhere under ${modelDir} — runtime would download anyway`
  );
  process.exit(1);
}
console.log(`[PrefetchCLIP] done — ${onnx.length} onnx file(s): ${onnx.join(", ")}`);
