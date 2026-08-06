/** Professional Render Engine — Export Manager (Phase 7).
 *
 *  The per-format orchestrator: for each requested output format (16:9/9:16/1:1), plans a
 *  RenderPlan, validates it, and — only if validation found no errors — encodes it. This file
 *  makes no creative decisions and no format-selection decisions; `ExportRequest.formats` is
 *  caller-supplied (ultimately the user's own export choice).
 *
 *  `resolveClipAsset`/`resolveInputFiles` are both injected, for the same reason
 *  renderPlanner.ts's `ClipAssetResolver` and encoder.ts's `CommandExecutor` are: this
 *  directory has no file I/O and no knowledge of where downloaded candidate assets actually
 *  live on disk. `resolveClipAsset`'s returned `inputLabel` values (e.g. "0:v", "1:v") MUST be
 *  valid FFmpeg input-stream specifiers consistent with the file order `resolveInputFiles`
 *  returns for that same plan — keeping those two in sync is the caller's responsibility once
 *  real asset paths exist; this module doesn't (and can't, without file I/O) verify it.
 *
 *  A render that fails validation never reaches the encoder at all — `encode: null` on its
 *  RenderResult, per "validate before exporting."
 */
import { encode } from "./encoder";
import { planRender, type ClipAssetResolver } from "./renderPlanner";
import { mergeValidationResults, validateEDL, validateRenderPlan } from "./renderValidator";
import type { CommandExecutor, EncodeOptions, ExportFormatResult, ExportRequest, ExportResult, RenderPlan, RenderResult } from "./types";

export type ExportDependencies = {
  resolveClipAsset: ClipAssetResolver;
  resolveInputFiles: (plan: RenderPlan) => string[];
  executor: CommandExecutor;
  encodeOptions?: Partial<Omit<EncodeOptions, "outputPath">>;
};

const DEFAULT_ENCODE_OPTIONS: Omit<EncodeOptions, "outputPath"> = {
  useGpu: false,
  crf: 20,
  preset: "medium",
  maxRetries: 2,
};

function outputPathFor(outputDir: string, videoId: string, format: string): string {
  const safeFormat = format.replace(/[^a-zA-Z0-9]/g, "x");
  return `${outputDir}/${videoId}_${safeFormat}.mp4`;
}

async function exportOneFormat(request: ExportRequest, format: ExportRequest["formats"][number], deps: ExportDependencies): Promise<RenderResult> {
  const startedAt = Date.now();
  const plan = planRender(request.approvedEDL, format, deps.resolveClipAsset);

  const validation = mergeValidationResults(validateEDL(request.approvedEDL), validateRenderPlan(request.approvedEDL, plan));

  if (!validation.isValid) {
    return { videoId: request.videoId, succeeded: false, validation, plan, encode: null, durationMs: Date.now() - startedAt };
  }

  const inputFiles = deps.resolveInputFiles(plan);
  const options: EncodeOptions = {
    ...DEFAULT_ENCODE_OPTIONS,
    ...deps.encodeOptions,
    outputPath: outputPathFor(request.outputDir, request.videoId, format),
  };

  const encodeResult = await encode(plan, inputFiles, options, deps.executor);

  return {
    videoId: request.videoId,
    succeeded: encodeResult.succeeded,
    validation,
    plan,
    encode: encodeResult,
    durationMs: Date.now() - startedAt,
  };
}

/** Exports every requested format for one video, sequentially (each format's own RenderPlan
 *  and encode are independent — this module doesn't parallelize across formats, since the
 *  encoder's own concurrency belongs to whatever process pool wires this up for real, not to
 *  this pure orchestration layer). */
export async function exportVideo(request: ExportRequest, deps: ExportDependencies): Promise<ExportResult> {
  const formats: ExportFormatResult[] = [];

  for (const format of request.formats) {
    const result = await exportOneFormat(request, format, deps);
    formats.push({ format, result });
  }

  return {
    videoId: request.videoId,
    formats,
    allSucceeded: formats.every((f) => f.result.succeeded),
  };
}
