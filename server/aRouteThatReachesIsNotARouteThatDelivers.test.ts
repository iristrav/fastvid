/**
 * A ROUTE THAT REACHES YOUTUBE IS NOT A ROUTE THAT DELIVERS A FILE — RONDE 641.
 *
 * Render 603: 49 YouTube videos found, 0 downloaded, so nothing from YouTube could be in the film.
 * Every health check on that deployment said the routes worked: the preflight asked whether the
 * yt-dlp service could REACH YouTube, the youtube-probe endpoint asked whether RapidAPI returned a
 * format. Neither asked for a file. These tests hold the check that does.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readFileSync } from "fs";

import {
  ROUTE_TEST_DEFAULT_VIDEO_ID,
  configuredRoutes,
  runYoutubeRouteTests,
  summariseRouteTests,
  type RouteTestDeps,
} from "./youtubeRouteTest";

const PIPE = readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

describe("§2 — one route at a time, without changing a render", () => {

  it("routes are read by presence only", () => {
    /** RapidAPI is no route at all any more, whatever the environment holds. */
    expect(configuredRoutes({ YOUTUBE_CC_DL_SERVICE: "x", RAPIDAPI_KEY: "y" } as never)).toEqual(["cloud"]);
    expect(configuredRoutes({ YOUTUBE_CC_DL_SERVICE: " " } as never)).toEqual([]);
  });
});

describe("§3 — the test asks for a FILE and reports each route on its own", () => {
  const deps = (
    behave: Record<string, { ok: boolean; bytes: number; reason?: string }>
  ): RouteTestDeps & { cleaned: string[] } => {
    const cleaned: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routetest-"));
    return {
      cleaned,
      workDir: () => dir,
      cleanup: (d) => {
        cleaned.push(d);
        fs.rmSync(d, { recursive: true, force: true });
      },
      now: () => 0,
      download: async (route, _id, outPath) => {
        const b = behave[route]!;
        if (b.bytes > 0) fs.writeFileSync(outPath, Buffer.alloc(b.bytes));
        return { ok: b.ok, status: b.ok ? "DOWNLOAD_SUCCESS" : "DOWNLOAD_FAILED", reason: b.reason };
      },
    };
  };

  it("a route that says ok but leaves no file is NOT ok", async () => {
    const r = await runYoutubeRouteTests(["cloud"], ROUTE_TEST_DEFAULT_VIDEO_ID, deps({ cloud: { ok: true, bytes: 0 } }));
    expect(r[0]!.ok).toBe(false);
  });

  it("each route's own verdict and reason, and the summary names who delivers", async () => {
    const d = deps({
      cloud: { ok: false, bytes: 0, reason: "cloud=DOWNLOAD_TIMEOUT" },
      rapidapi: { ok: true, bytes: 2048 },
    });
    const r = await runYoutubeRouteTests(["cloud", "rapidapi"], ROUTE_TEST_DEFAULT_VIDEO_ID, d);
    expect(r.map((x) => [x.route, x.ok])).toEqual([
      ["cloud", false],
      ["rapidapi", true],
    ]);
    expect(r[0]!.reason).toBe("cloud=DOWNLOAD_TIMEOUT");
    expect(summariseRouteTests(r)).toBe("[YouTubeRouteTest] SUMMARY delivers=rapidapi fails=cloud");
    expect(d.cleaned).toHaveLength(1);
  });

  it("no route delivering is said as the blocker it is", () => {
    expect(
      summariseRouteTests([{ route: "rapidapi", ok: false, status: "DOWNLOAD_FAILED", reason: "", ms: 1, bytes: null }])
    ).toContain("NO ROUTE DELIVERS A FILE");
  });

  it("the worker schedules it, and it yields to a render", () => {
    expect(readFileSync(path.join(__dirname, "worker.ts"), "utf8")).toContain("scheduleYoutubeRouteTest();");
    expect(readFileSync(path.join(__dirname, "youtubeRouteTest.ts"), "utf8")).toContain(
      "a render is running; not competing with it"
    );
  });
});
