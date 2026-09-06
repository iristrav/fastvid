/**
 * WHERE THE CLIP MODEL IS CACHED, AND WHETHER THAT PLACE OUTLIVES THE PROCESS.
 *
 * ── Why the second half is not a detail ─────────────────────────────────────────────────────
 *
 * Worker log, 2026-09-05, 18:04 to 18:54 — fifty minutes, eleven boots, and eleven of these:
 *
 *     [LocalVision] CLIP model not in cache (/tmp/fastvid-transformers-cache) — will download now
 *       (one-time, ~350MB, persists to volume)
 *
 * It was not one-time and it did not persist. The same log shows why: the web service reports
 * `/data/uploads (✓ persistent volume)`, while the worker service — the process that renders, and
 * the one that needs the model — reports `/app/uploads (⚠ ephemeral)` and runs three replicas. The
 * volume is mounted on the other service, so the lookup below fell through to `os.tmpdir()`, which
 * the container discards. Every replica re-downloaded 350MB on every deploy, and the sentence in
 * the log said that could not be happening.
 *
 * A message asserting persistence it has not checked is worse than no message: it is the thing an
 * operator reads instead of looking. So the choice of directory and the claim about it are made
 * together, here, and every caller reports what this returns rather than a sentence of its own.
 *
 * ── Why this is its own module ──────────────────────────────────────────────────────────────
 *
 * It lived in `localClipVision.ts`, and the preflight has to report it. Importing that module into
 * the preflight pulled `db.ts` in behind it and broke `productionPreflightCli` outright — it is run
 * from an arbitrary working directory, where the `@shared/*` path alias does not resolve. The rule
 * is pure environment logic and needs nothing but `path` and `os`, so it sits where both can reach
 * it without either dragging the other's dependencies along.
 */
import os from "os";
import path from "path";

export type ClipModelCacheLocation = {
  dir: string;
  /** True only when the directory is on a mounted volume — never assumed from the shape of a path. */
  persists: boolean;
  /** Which rule chose it, in the words an operator would use. */
  why: string;
};

/**
 * THE ENVIRONMENT AS IT ARRIVED, BEFORE THIS PROCESS EDITED IT.
 *
 * `configureTransformersEnv()` writes the directory it picked back into `process.env` under all
 * three of these names, because that is how `@xenova/transformers` is told where to look. Anything
 * asking afterwards therefore sees `TRANSFORMERS_CACHE` set and concludes an operator set it — so
 * a `/tmp` fallback would be reported as "set explicitly" rather than as "no volume is mounted",
 * which is the one sentence that would have made the eleven re-downloads legible.
 *
 * The directory is the same either way; the REASON is not, and the reason is what gets acted on.
 * Captured at import, which happens before any warm-up can run.
 */
const AT_IMPORT: NodeJS.ProcessEnv = {
  TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE,
  HF_HOME: process.env.HF_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};

export function clipModelCacheLocation(explicitEnv?: NodeJS.ProcessEnv): ClipModelCacheLocation {
  /** A caller that names an environment gets exactly that one; the default is the real one, unedited. */
  const env: NodeJS.ProcessEnv = explicitEnv ?? { ...process.env, ...AT_IMPORT };
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  /**
   * A path is persistent only if it sits inside the volume THIS host actually has mounted.
   * `/data` is the convention when the platform does not name one; where it does, the mount wins,
   * because a `/data` directory on a host whose volume is elsewhere is just a directory.
   */
  const onVolume = (dir: string) => (volume ? dir.startsWith(volume) : dir.startsWith("/data"));

  const explicit =
    env.TRANSFORMERS_CACHE?.trim() || env.HF_HOME?.trim() || env.XDG_CACHE_HOME?.trim();
  if (explicit) {
    return {
      dir: explicit,
      persists: onVolume(explicit),
      why: onVolume(explicit)
        ? "set explicitly, on the mounted volume"
        : "set explicitly, and NOT on a mounted volume — the download repeats on every boot",
    };
  }
  if (env.UPLOADS_DIR?.startsWith("/data")) {
    const dir = path.join(path.dirname(env.UPLOADS_DIR), "transformers-cache");
    return { dir, persists: onVolume(dir), why: "beside UPLOADS_DIR on the volume" };
  }
  if (volume) {
    const dir = path.join(volume, "transformers-cache");
    return { dir, persists: true, why: "on RAILWAY_VOLUME_MOUNT_PATH" };
  }
  return {
    dir: path.join(os.tmpdir(), "fastvid-transformers-cache"),
    persists: false,
    why: "no volume is mounted on this service — the 350MB download repeats on every boot",
  };
}
