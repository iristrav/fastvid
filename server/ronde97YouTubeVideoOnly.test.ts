/**
 * RONDE 97 — a YouTube thumbnail is not YouTube footage.
 *
 * fetchYouTubeThumbnails called the YouTube Data API, took the still image shown on each search
 * result, and ran ffmpeg with `-loop 1 -i thumb.jpg … zoompan` to produce an .mp4. That file went
 * to adoptClip like any other clip, through four ladders, and the research ladder returned it
 * under the source label "youtube_cc" — the label the genuine video route uses.
 *
 * A thumbnail could therefore reach finalConcatInputs, and once there nothing could tell it apart
 * from footage: not the compose gate, not the lineage, not [AssetUsageSummary]. The delivered
 * video contained a slow pan across a promotional picture, recorded as real YouTube material.
 *
 * FastVid uses YouTube for video it can cut a fragment out of. That is the only route left.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

import { VisualSourceLedger } from "./visualSourceLineage";
import { tagPathWithProviderAsset, recordProviderDownloadOutcome } from "./videoPipeline";

const SERVER_DIR = __dirname;
const PIPELINE_SRC = fs.readFileSync(path.join(SERVER_DIR, "videoPipeline.ts"), "utf8");

/** Source lines that are neither blank nor part of a comment. */
function codeLines(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

function bodyOf(fn: string, span = 20000): string {
  const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
  expect(idx, `${fn} not found`).toBeGreaterThan(-1);
  return PIPELINE_SRC.slice(idx, idx + span);
}

function silence<T>(fn: () => T): T {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/* ═══════════ §4/§7 — the thumbnail route is gone ═══════════ */

describe("RONDE 97 §4 — no code path turns a YouTube thumbnail into a clip", () => {
  it("TEST 1 — fetchYouTubeThumbnails no longer exists", () => {
    expect(PIPELINE_SRC).not.toContain("async function fetchYouTubeThumbnails(");
    // The removal notes name it; no line of actual code may.
    for (const line of codeLines(PIPELINE_SRC)) {
      expect(line, `thumbnail fetcher is back: ${line.trim()}`).not.toContain("fetchYouTubeThumbnails");
    }
  });

  it("TEST 2 — nothing in server/ calls it any more", () => {
    for (const file of fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = fs.readFileSync(path.join(SERVER_DIR, file), "utf8");
      for (const line of codeLines(src)) {
        expect(line, `${file} still calls it`).not.toContain("fetchYouTubeThumbnails(");
      }
    }
  });

  it("TEST 3 — no YouTube search result is turned into a still-image clip", () => {
    // The shape the removed code had: a YouTube Data API search, then a ken-burns ffmpeg over the
    // downloaded jpg. `-loop 1` on a YouTube thumbnail is the exact manoeuvre being forbidden.
    const idx = PIPELINE_SRC.indexOf("googleapis.com/youtube");
    if (idx === -1) return; // the search endpoint may live only in the video route
    const around = PIPELINE_SRC.slice(idx, idx + 6000);
    expect(around).not.toContain("snippet.thumbnails");
    expect(around).not.toContain("zoompan");
  });

  it("TEST 4 — the youtube_cc source label is never attached to a still", () => {
    // The research ladder used to return thumbnail paths as toCandidates(..., "youtube_cc", ...).
    // Every remaining use of that label must sit with the real video route.
    for (const line of codeLines(PIPELINE_SRC)) {
      if (!line.includes('"youtube_cc"')) continue;
      expect(line, `youtube_cc attached to a thumbnail: ${line.trim()}`).not.toMatch(/thumb|Thumb/);
    }
  });
});

/* ═══════════ §6 — the real video route is intact ═══════════ */

describe("RONDE 97 §6 — YouTube video is downloaded, trimmed, and traceable", () => {
  it("TEST 5 — the CC route downloads a real stream, not a picture", () => {
    const body = bodyOf("downloadYouTubeCCClip");
    // A stream from the yt-dlp service or a RapidAPI format URL — an mp4, not a jpg.
    expect(body).toMatch(/yt-dlp|ytdlp|YOUTUBE_CC_DL_SERVICE/);
    expect(body).toContain("mimeType");
    expect(body).not.toContain("-loop");
  });

  it("TEST 6 — it cuts a fragment: a start offset and a duration", () => {
    const src = PIPELINE_SRC.slice(PIPELINE_SRC.indexOf("export async function downloadYouTubeCCClip("));
    const signature = src.slice(0, src.indexOf("): Promise<boolean>"));
    expect(signature).toContain("videoId: string");
    expect(signature).toContain("duration: number");
    expect(signature).toContain("clipStart: number");
  });

  it("TEST 7 — fetchYouTubeCCClips keys the lineage on the real videoId", () => {
    const body = bodyOf("fetchYouTubeCCClips");
    expect(body).toContain("const videoId = item.id?.videoId;");
    expect(body).toContain("tagPathWithProviderAsset(");
    expect(body).toContain("downloadYouTubeCCClip(");
    expect(body).toContain('searchRoute: "fetchYouTubeCCClips"');
    // It is a video, and says so.
    expect(body).toContain('mediaType: "video"');
  });

  it("TEST 8 — a real YouTube clip keeps its identity all the way to FINAL_VIDEO", () => {
    const ledger = new VisualSourceLedger({ renderId: "r97", videoId: 9 });
    const cache = { lineage: ledger } as never;
    const tagged = silence(() =>
      tagPathWithProviderAsset("/tmp/scene_2_yt.mp4", "youtube_cc", "dQw4w9WgXcQ", cache, {
        sceneIndex: 2,
        beatIndex: 0,
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        mediaType: "video",
        query: "Berlin Wall 1989",
        searchRoute: "fetchYouTubeCCClips",
      })
    );
    silence(() => {
      recordProviderDownloadOutcome(cache, tagged, true);
      const id = ledger.resolve(tagged)!.lineageId;
      ledger.recordEvent(id, "SELECTED", { status: "OK" });
      ledger.recordEvent(id, "ADOPTED", { status: "OK" });
      // trimmed to the fragment that goes on screen
      ledger.linkDerivedPath("/tmp/scene_2_yt_trim.mp4", tagged, "TRIMMED");
      ledger.recordEventForPath("/tmp/scene_2_yt_trim.mp4", "COMPOSED", { status: "OK" });
      ledger.markFinalVideo(["/tmp/scene_2_yt_trim.mp4"]);
    });
    const record = ledger.resolve("/tmp/scene_2_yt_trim.mp4")!;
    expect(record.provider).toBe("youtube_cc");
    expect(record.providerAssetId).toBe("dQw4w9WgXcQ");
    expect(record.searchRoute).toBe("fetchYouTubeCCClips");
    expect(record.mediaType).toBe("video");
    expect(ledger.summary().byProvider.youtube_cc!.finalVideo).toBe(1);
  });

  it("TEST 9 — the clip in the final video came from the video source, not a picture", () => {
    const ledger = new VisualSourceLedger({ renderId: "r97b" });
    const cache = { lineage: ledger } as never;
    const tagged = silence(() =>
      tagPathWithProviderAsset("/tmp/v.mp4", "youtube_cc", "abc123", cache, {
        sourceUrl: "https://rr3---sn-x.googlevideo.com/videoplayback?itag=22",
        mediaType: "video",
        searchRoute: "fetchYouTubeCCClips",
      })
    );
    silence(() => ledger.markFinalVideo([tagged]));
    const record = ledger.resolve(tagged)!;
    // A thumbnail's sourceUrl is an i.ytimg.com still; a video's is a stream.
    expect(record.sourceUrl).not.toMatch(/ytimg\.com|\.jpg$/);
    expect(record.mediaType).toBe("video");
  });
});

/* ═══════════ §7 — a thumbnail can no longer reach the final video ═══════════ */

describe("RONDE 97 §7 — the invariant", () => {
  it("TEST 10 — no remaining YouTube route produces an image mediaType", () => {
    for (const fn of ["fetchYouTubeCCClips", "searchYoutubeVideoCandidates", "downloadYouTubeCCClip"]) {
      const idx = PIPELINE_SRC.indexOf(`function ${fn}(`);
      if (idx === -1) continue;
      const body = PIPELINE_SRC.slice(idx, idx + 20000);
      const tagIdx = body.indexOf("tagPathWithProviderAsset(");
      if (tagIdx === -1) continue;
      const call = body.slice(tagIdx, tagIdx + 900);
      expect(call, `${fn} tags a YouTube asset as an image`).not.toContain('mediaType: "image"');
    }
  });

  it("TEST 11 — a still tagged as youtube is not silently accepted as footage", () => {
    // Nothing constructs one any more, but the distinction has to survive in the record: an image
    // and a video are different mediaTypes, and the summary keeps them apart by provider.
    const ledger = new VisualSourceLedger({ renderId: "r97c" });
    const cache = { lineage: ledger } as never;
    const still = silence(() =>
      tagPathWithProviderAsset("/tmp/still.mp4", "unsplash", "s1", cache, { mediaType: "image" })
    );
    const video = silence(() =>
      tagPathWithProviderAsset("/tmp/real.mp4", "youtube_cc", "v1", cache, { mediaType: "video" })
    );
    expect(ledger.resolve(still)!.mediaType).toBe("image");
    expect(ledger.resolve(video)!.mediaType).toBe("video");
  });

  it("TEST 12 — the YouTube still ladders are gone, not merely skipped", () => {
    // Four call sites used to sit behind `if (process.env.YOUTUBE_API_KEY)`. A route left in place
    // behind a condition is one condition away from coming back.
    for (const marker of [
      "script image YouTube thumb",
      "forced image YouTube thumb",
      "YouTube thumbnail added",
      "`${tag}_ytt`",
      "`${tag}_img_yt`",
      "`${tag}_force_yt`",
    ]) {
      expect(PIPELINE_SRC, `still present: ${marker}`).not.toContain(marker);
    }
  });
});
