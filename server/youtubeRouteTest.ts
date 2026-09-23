/**
 * CAN THIS DEPLOYMENT DOWNLOAD A YOUTUBE FILE AT ALL — PER ROUTE, WITHOUT A RENDER. RONDE 641.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * Render 603 found 49 YouTube videos and downloaded none, so nothing from YouTube could reach the
 * film. Its log answers "did it fail" and not "which route cannot deliver": every attempt tried the
 * cloud route, then RapidAPI, inside one shrinking scene budget, so a cloud timeout, a RapidAPI 403
 * and "no time left" are tangled in each line.
 *
 * The boot preflight asks the yt-dlp service whether it can REACH YouTube, and it says yes — while
 * the same service's downloads time out. Reaching is not delivering. This asks for a FILE.
 *
 * ── What it does ────────────────────────────────────────────────────────────────────────────
 *
 * Once after boot, when no render is running, each configured route is asked on its own for five
 * seconds of one small public video, through the pipeline's own `downloadYouTubeCCClip` (restricted
 * with `onlyRoute`) — same request, same headers, same checks as a render uses. One line per route:
 *
 *     [YouTubeRouteTest] route=rapidapi ok=false status=DOWNLOAD_FAILED
 *                        detail=rapidapi:DOWNLOAD_FAILED(http_403:ip_locked) ms=2140
 *
 * It decides nothing and changes nothing a render reads: the latch and memos it may have touched
 * are reset by every render's own start, and the file is deleted.
 */
import fs from "fs";
import path from "path";

/** The yt-dlp service's own egress probe video (services/ytdlp-download/main.py): 19s, public. */
export const ROUTE_TEST_DEFAULT_VIDEO_ID = "jNQXAC9IVRw";

export type YoutubeRoute = "cloud" | "rapidapi";

export type RouteTestResult = {
  route: YoutubeRoute;
  ok: boolean;
  status: string;
  reason: string;
  ms: number;
  bytes: number | null;
};

export function routeTestVideoId(): string {
  const raw = process.env.YOUTUBE_ROUTE_TEST_VIDEO_ID?.trim();
  return raw && /^[A-Za-z0-9_-]{6,32}$/.test(raw) ? raw : ROUTE_TEST_DEFAULT_VIDEO_ID;
}

/** Which routes this deployment has. Presence only — never a value. */
export function configuredRoutes(env: NodeJS.ProcessEnv = process.env): YoutubeRoute[] {
  const out: YoutubeRoute[] = [];
  if (env.YOUTUBE_CC_DL_SERVICE?.trim()) out.push("cloud");
  if (env.RAPIDAPI_KEY?.trim()) out.push("rapidapi");
  return out;
}

export function formatRouteTest(videoId: string, r: RouteTestResult): string {
  return (
    `[YouTubeRouteTest] route=${r.route} video=${videoId} ok=${r.ok} status=${r.status} ` +
    `reason=${r.reason || "none"} ms=${r.ms} bytes=${r.bytes ?? "none"}`
  );
}

/** The verdict across routes, in one line an operator can act on. */
export function summariseRouteTests(results: readonly RouteTestResult[]): string {
  if (results.length === 0) {
    return "[YouTubeRouteTest] SUMMARY no YouTube download route is configured — no YouTube file can arrive";
  }
  const working = results.filter((r) => r.ok).map((r) => r.route);
  const broken = results.filter((r) => !r.ok).map((r) => r.route);
  if (working.length === 0) {
    return (
      `[YouTubeRouteTest] SUMMARY NO ROUTE DELIVERS A FILE (${broken.join(", ")} failed) — ` +
      "no YouTube picture can reach a film from this deployment until one does"
    );
  }
  return (
    `[YouTubeRouteTest] SUMMARY delivers=${working.join(",")}` +
    (broken.length ? ` fails=${broken.join(",")}` : "")
  );
}

export type RouteTestDeps = {
  download: (route: YoutubeRoute, videoId: string, outPath: string) => Promise<{ ok: boolean; status?: string; reason?: string }>;
  workDir: () => string;
  cleanup: (dir: string) => void;
  now: () => number;
};

export async function runYoutubeRouteTests(
  routes: readonly YoutubeRoute[],
  videoId: string,
  deps: RouteTestDeps
): Promise<RouteTestResult[]> {
  const results: RouteTestResult[] = [];
  const dir = deps.workDir();
  try {
    for (const route of routes) {
      const outPath = path.join(dir, `${route}.mp4`);
      const started = deps.now();
      const got = await deps
        .download(route, videoId, outPath)
        .catch((err: Error) => ({ ok: false, status: "THREW", reason: err.message?.slice(0, 120) }));
      let bytes: number | null = null;
      try {
        bytes = fs.statSync(outPath).size;
      } catch {
        bytes = null;
      }
      results.push({
        route,
        ok: got.ok && bytes != null && bytes > 0,
        status: got.status ?? (got.ok ? "DOWNLOAD_SUCCESS" : "UNKNOWN"),
        reason: got.reason ?? "",
        ms: deps.now() - started,
        bytes,
      });
    }
  } finally {
    deps.cleanup(dir);
  }
  return results;
}

/** Production wiring: the pipeline's own downloader, one route at a time. */
export async function runProductionYoutubeRouteTest(): Promise<RouteTestResult[]> {
  const pipeline = await import("./videoPipeline");
  const failure = await import("./providerFailureClass");
  const videoId = routeTestVideoId();
  const results = await runYoutubeRouteTests(configuredRoutes(), videoId, {
    download: async (route, id, outPath) => {
      /** Each route starts from a clean latch, so one route's refusal cannot skip the other's test. */
      failure.resetCloudEgressBlocked();
      /** A source held from the other route's test would be re-cut instead of fetched. */
      failure.forgetYoutubeSourceFile(id);
      const outcome: { status?: string; reason?: string } = {};
      const ok = await pipeline.withSceneFetchTimeout(
        () =>
          pipeline.downloadYouTubeCCClip(
            id, 5, 5, outPath, -1, "route test", undefined, true, outcome as never, undefined, route
          ),
        120_000,
        `youtube route test ${route}`
      );
      failure.forgetYoutubeSourceFile(id);
      return { ok, status: outcome.status, reason: outcome.reason };
    },
    workDir: () => fs.mkdtempSync(path.join(pipeline.TMP_DIR, "fastvid_ytroutetest_")),
    cleanup: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    now: () => Date.now(),
  });
  failure.resetCloudEgressBlocked();
  for (const r of results) console.log(formatRouteTest(videoId, r));
  console.log(summariseRouteTests(results));
  return results;
}

/** Once, a minute after boot, only if nothing is rendering. Off with ENABLE_YOUTUBE_ROUTE_TEST=false. */
export function scheduleYoutubeRouteTest(delayMs = 60_000): void {
  if (process.env.ENABLE_YOUTUBE_ROUTE_TEST === "false") return;
  const t = setTimeout(async () => {
    try {
      const { workerIsIdle } = await import("./youtubePrefetch");
      if (!(await workerIsIdle())) {
        console.log("[YouTubeRouteTest] skipped — a render is running; not competing with it");
        return;
      }
      await runProductionYoutubeRouteTest();
    } catch (err) {
      console.warn(`[YouTubeRouteTest] could not run: ${(err as Error).message?.slice(0, 160)}`);
    }
  }, delayMs);
  t.unref?.();
}
