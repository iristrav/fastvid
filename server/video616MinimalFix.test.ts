/**
 * Video 616 — the three minimal repairs, one regression each, plus the rules that must not move.
 *
 *   A/B  a refused YouTube FRAGMENT is not downloaded again this render; the next candidate is tried
 *   C/G  refusals on screen can ask for the existing search #2 — never a third search
 *   D/E  YTContext is asked only when the video's length is unknown
 *   F    ONE_FOOTAGE_FILLS_FILM still refuses a film of one piece of footage
 *   H    a YouTube turn still starts at most `count` downloads
 *
 * No test here reaches the network: `node-fetch` and the global `fetch` answer from this file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const nodeFetchMock = vi.fn();
vi.mock("node-fetch", () => ({ default: (...args: unknown[]) => nodeFetchMock(...args) }));

import {
  fetchYouTubeCCClips,
  youtubeFragmentKey,
  youtubeFragmentKeyFor,
  youtubeFragmentFileTag,
  capYoutubeClipDurationForTest,
} from "./videoPipeline";
import { notePermanentDownloadRefusal, permanentDownloadRefusal, resetPermanentDownloadRefusals } from "./providerFailureClass";
import {
  buildVideoYoutubePool,
  noteVideoYoutubePoolRefusal,
  registerVideoYoutubePool,
  releaseVideoYoutubePool,
  search2Reasons,
  POOL_REFUSALS_FOR_SEARCH2,
  type PoolDeps,
  type SearchItem,
  type Triage,
  type VideoYoutubePool,
} from "./youtubeVideoPool";
import { claimYoutubeSearch, memoryYoutubeSearchBudgetStore } from "./youtubeSearchBudget";
import type { GateVerdict } from "./youtubeVideoSearchPlanner";
import { planScriptGuidedClip } from "./scriptGuidedClipFinder";
import { _resetYoutubeVideoContextCache } from "./youtubeVideoContext";
import { finalTimelineFootageRefusal, type FinalTimelineClip } from "./deliveredScreenTime";
import { deliveryGate } from "./deliveryGate";

/** Direct fetcher calls have no beat provenance; the gate's own behaviour is tested elsewhere. */
process.env.SEARCH_GATE_STRICT = "false";
const ORIGINAL_ENV = { ...process.env };
const silent = () => {};

/* ═══════════════════════ A/B — the refused fragment, and the next candidate ═══════════════════════ */

describe("A/B. a refused YouTube fragment is not downloaded again; the next candidate is", () => {
  let workDir: string;
  let source: string;
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "v616-"));
    source = path.join(workDir, "source.mp4");
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10", "-t", "8",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", source,
    ], { stdio: "ignore" });
  });
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.ENABLE_YOUTUBE_SOURCING = "true";
    process.env.YOUTUBE_API_KEY = "v616-test-key";
    process.env.YOUTUBE_CC_DL_SERVICE = "https://v616-cloud.example.com";
    process.env.ENABLE_SCRIPT_GUIDED_CLIPS = "false";
    process.env.YOUTUBE_SEARCH_MODE = "per_beat";
    resetPermanentDownloadRefusals();
    nodeFetchMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  const ids = ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD"];
  /** A search that finds the four videos, and a cloud service that answers `cloud` per id. */
  function answer(cloud: (id: string) => "ok" | "fail") {
    nodeFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("googleapis.com/youtube/v3/search")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            items: ids.map((id) => ({ id: { videoId: id }, snippet: { title: `Steam locomotive film ${id}`, description: "steam locomotive" } })),
          }),
        });
      }
      if (u.startsWith("https://v616-cloud.example.com/download")) {
        const id = new URL(u).searchParams.get("id") ?? "";
        return cloud(id) === "ok"
          ? Promise.resolve({ ok: true, status: 200, body: fs.createReadStream(source) })
          : Promise.resolve({ ok: false, status: 502, text: async () => "ERROR: Video unavailable" });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => "" });
    });
  }
  const downloadedIds = () =>
    nodeFetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.startsWith("https://v616-cloud.example.com/download"))
      .map((u) => new URL(u).searchParams.get("id"));
  /** Refuse video A's fragment under every duration a pass can ask for (15 s is the no-length start). */
  const refuseFragmentOf = (id: string) => {
    for (const tag of ["ytfu", "ytcc", "ytstd"]) {
      notePermanentDownloadRefusal(youtubeFragmentKeyFor(id, 15, capYoutubeClipDurationForTest(6, tag)), "baked_edit_text_before_vision");
    }
  };

  it("A — a fragment refused earlier this render is not downloaded again", async () => {
    answer(() => "ok");
    refuseFragmentOf(ids[0]!);
    await fetchYouTubeCCClips("steam locomotive", 6, workDir, 0, 1, [], 1, "");
    expect(downloadedIds()).not.toContain(ids[0]);
  });

  it("B — the next candidate from the same results is tried instead, and the skip costs no attempt", async () => {
    answer(() => "ok");
    refuseFragmentOf(ids[0]!);
    const paths = await fetchYouTubeCCClips("steam locomotive", 6, workDir, 0, 1, [], 1, "");
    expect(downloadedIds()).toEqual([ids[1]]);
    expect(paths).toHaveLength(1);
    /** The file names the seconds it holds, so a refusal of it is remembered as exactly those seconds. */
    expect(youtubeFragmentKey(paths[0]!)).toMatch(/^youtube_cc:[0-9a-f]{16}@t150d\d+$/);
  });

  it("A/B — the key written by the refusal and the key read by the fetcher are the same; another start is another fragment", () => {
    const file = `/w/scene_1_ytfu_0_${youtubeFragmentFileTag(242.2, 5)}__pid_youtube_cc-0123456789abcdef.mp4`;
    const other = `/w/scene_1_ytfu_0_${youtubeFragmentFileTag(180.1, 5)}__pid_youtube_cc-0123456789abcdef.mp4`;
    expect(youtubeFragmentKey(file)).toBe("youtube_cc:0123456789abcdef@t2422d50");
    expect(youtubeFragmentKey(file.replace(".mp4", "_transformed.mp4"))).toBe(youtubeFragmentKey(file));
    expect(youtubeFragmentKey(other)).not.toBe(youtubeFragmentKey(file));
    /** Not every file is a YouTube fragment. */
    expect(youtubeFragmentKey("/w/scene_1_b0_curated_a58019.mp4")).toBeNull();
    expect(youtubeFragmentKey("/w/scene_0_ytfu_0__pid_youtube_cc-0123456789abcdef.mp4")).toBeNull();
    notePermanentDownloadRefusal(youtubeFragmentKey(file)!, "mostly_black");
    expect(permanentDownloadRefusal(youtubeFragmentKey(other)!)).toBeNull();
    expect(permanentDownloadRefusal(youtubeFragmentKey(file)!)).toBe("mostly_black");
  });

  it("A — only the two on-screen refusals are remembered, from the refusal itself", () => {
    const PIPE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");
    expect(PIPE).toMatch(
      /if \(reason === "mostly_black" \|\| reason === "baked_edit_text_before_vision"\) \{\s*rememberRefusedYoutubeFragment\(dedup, p, reason\);/
    );
    /** Checked before the slot is claimed, so a skipped fragment is not one of the turn's two attempts. */
    const fn = PIPE.slice(PIPE.indexOf("export async function fetchYouTubeCCClips("));
    expect(fn.indexOf("const fragmentRefused = youtubeFragmentRefusal(")).toBeLessThan(fn.indexOf("if (!claimDownloadSlot()) {"));
  });

  it("H — a turn still starts at most `count` downloads, however many candidates fail", async () => {
    answer(() => "fail");
    await fetchYouTubeCCClips("steam locomotive", 6, workDir, 0, 2, [], 1, "");
    expect(new Set(downloadedIds()).size).toBeLessThanOrEqual(2);
  });
});

/* ═══════════════════════ C/G — search #2 when the pool proves unusable on screen ═══════════════════════ */

function items(prefix: string, n: number): SearchItem[] {
  return Array.from({ length: n }, (_, i) => ({ videoId: `${prefix}${String(i).padStart(10, "0")}`.slice(0, 11), title: `${prefix} ${i}`, description: "", channel: "c", thumb: "t" }));
}
const allow = (): GateVerdict => ({ ok: true });
const kardashians = {
  videoId: 616,
  prompt: "How the Kardashians built a billion-dollar empire",
  title: "The Kardashian Empire",
  sceneTexts: [
    "Kim Kardashian built a billion-dollar fortune from skincare in Los Angeles.",
    "Kris Jenner ran the Kardashian business from Calabasas.",
    "Kylie Jenner turned lip kits into a cosmetics empire in Los Angeles.",
  ],
};
function deps(store = memoryYoutubeSearchBudgetStore()): PoolDeps & { searches: string[] } {
  const searches: string[] = [];
  let q = 0;
  return {
    searches,
    store,
    llm: async () => ({
      choices: [{ message: { content: JSON.stringify({ mainSubject: "Kardashian", recurringSubjects: [], query: ++q === 1 ? "Kardashian Kris Jenner Los Angeles" : "Kylie Jenner cosmetics Calabasas" }) } }],
    }),
    gate: allow,
    search: async (query) => {
      searches.push(query);
      return { status: 200, items: items(searches.length === 1 ? "P" : "Q", 16) };
    },
    details: async (ids) => new Map(ids.map((id) => [id, { durationSec: 480, embeddable: true, live: false }])),
    triage: async (): Promise<Triage> => ({ footageType: "real_footage", servesBeats: [0, 1, 2], depicts: "" }),
    archive: async () => [],
    notFootage: () => null,
    log: silent,
  };
}

describe("C/G. refusals on screen can ask for the existing search #2 — never a third", () => {
  it("C — 16 usable on paper is enough; three of them refused on screen is a reason for search #2", async () => {
    const d = deps();
    const first = await buildVideoYoutubePool(d, kardashians);
    expect(d.searches).toHaveLength(1);
    expect(first.search2Needed).toBe(false);
    const refused = first.candidates.slice(0, 3).map((c) => c.videoId);
    expect(search2Reasons(first, new Set(refused.slice(0, 2)))).toEqual([]);
    expect(search2Reasons(first, new Set(refused))).toEqual([`refused in this render 3 >= ${POOL_REFUSALS_FOR_SEARCH2}`]);

    const again = await buildVideoYoutubePool(d, kardashians, { refusedVideoIds: refused });
    expect(d.searches).toHaveLength(2);
    expect(d.searches[1]).not.toBe(d.searches[0]);
    expect(again.searches).toBe(2);
    expect(again.search2Reason).toContain("refused in this render 3");
    expect(again.candidates.filter((c) => c.from === 2).length).toBeGreaterThan(0);
  });

  it("C — without refusals a stored pool is reused and nothing is searched", async () => {
    const d = deps();
    await buildVideoYoutubePool(d, kardashians);
    const again = await buildVideoYoutubePool(d, kardashians, { refusedVideoIds: [] });
    expect(d.searches).toHaveLength(1);
    expect(again.searches).toBe(1);
  });

  it("C — the render asks the pool once, at the third distinct refused video, and beats then read the new pool", async () => {
    const topUp = vi.fn(async (refused: string[]) => ({ refused }) as unknown as VideoYoutubePool);
    registerVideoYoutubePool(9616, Promise.resolve({ searches: 1 } as VideoYoutubePool), topUp);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    noteVideoYoutubePoolRefusal(9616, "aaaaaaaaaaa");
    noteVideoYoutubePoolRefusal(9616, "aaaaaaaaaaa");
    noteVideoYoutubePoolRefusal(9616, "bbbbbbbbbbb");
    expect(topUp).not.toHaveBeenCalled();
    noteVideoYoutubePoolRefusal(9616, "ccccccccccc");
    noteVideoYoutubePoolRefusal(9616, "ddddddddddd");
    await new Promise((r) => setTimeout(r, 0));
    expect(topUp).toHaveBeenCalledTimes(1);
    expect(topUp).toHaveBeenCalledWith(["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"]);
    releaseVideoYoutubePool(9616);
    log.mockRestore();
  });

  it("G — after search #2 more refusals search nothing; a third search cannot be claimed", async () => {
    const d = deps();
    const first = await buildVideoYoutubePool(d, kardashians);
    const ids = first.candidates.map((c) => c.videoId);
    await buildVideoYoutubePool(d, kardashians, { refusedVideoIds: ids.slice(0, 3) });
    const third = await buildVideoYoutubePool(d, kardashians, { refusedVideoIds: ids.slice(0, 10) });
    expect(d.searches).toHaveLength(2);
    expect(third.searches).toBe(2);
    expect(await claimYoutubeSearch(d.store, kardashians.videoId, 3, silent)).toBe(false);
  });
});

/* ═══════════════════════ D/E — YTContext only when the length is unknown ═══════════════════════ */

describe("D/E. YTContext is asked only when the video's length is unknown", () => {
  let youtubeCalls: string[];
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetYoutubeVideoContextCache();
    youtubeCalls = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown) => {
      youtubeCalls.push(String(input));
      return new Response("", { status: 429 });
    });
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });
  const candidate = { videoId: "c_d8DhDgPwg", title: "How the Kardashians Made Their BILLIONS", metadataScore: 3 };
  const options = (sourceDurationSec?: number) => ({
    beatText: "Kim Kardashian built a billion-dollar fortune.",
    keywords: ["kardashian", "fortune"],
    deadlineMs: Date.now() + 20_000,
    fastMode: true,
    clipDurationSec: 5,
    sourceDurationSec,
  });

  it("D — a known length: no InnerTube, no watch page, no caption request", async () => {
    const plan = await planScriptGuidedClip(candidate, options(537));
    expect(youtubeCalls).toEqual([]);
    expect(plan.sourceDurationSec).toBe(537);
    expect(plan.skip).toBe(false);
  });

  it("E — an unknown length: the existing YTContext route still asks", async () => {
    const plan = await planScriptGuidedClip(candidate, options(undefined));
    expect(youtubeCalls.some((u) => u.includes("youtubei/v1/player"))).toBe(true);
    expect(youtubeCalls.some((u) => u.includes("/watch?v=c_d8DhDgPwg"))).toBe(true);
    expect(plan.skip).toBe(false);
  });
});

/* ═══════════════════════ F — the one-footage rule is untouched ═══════════════════════ */

describe("F. ONE_FOOTAGE_FILLS_FILM still refuses a film of one piece of footage", () => {
  const clip = (id: string, start: number, end: number, archiveAssetId: number): FinalTimelineClip =>
    ({ id, timelineStart: start, timelineEnd: end, source: { provider: "youtube", providerAssetId: String(archiveAssetId), archiveAssetId } });

  it("video 616's timeline — 21 pieces of one clip over 75.8 s — is refused", () => {
    const pieces = Array.from({ length: 21 }, (_, i) => clip(`vc_p${i}`, (75.78 / 21) * i, (75.78 / 21) * (i + 1), 58019));
    const refusal = finalTimelineFootageRefusal(pieces);
    expect(refusal).toContain("100%");
    const verdict = deliveryGate({
      videoId: 616,
      route: "cinematic_timeline",
      timelineExists: true,
      clips: [],
      delivered: null,
      assetsOnly: true,
      footageRefusal: refusal,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.allow === false && verdict.failures.map((f) => f.code)).toContain("ONE_FOOTAGE_FILLS_FILM");
  });
});
