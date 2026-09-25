import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import {
  archiveIdsForFootageRights,
  classifyYoutubeFootageLicence,
  footageRightsReport,
  youtubeVideoIdFor,
  type FootageArchiveRow,
} from "./footageRights";
import type { ProjectTimeline, TimelineVideoClip } from "./projectTimeline";

/**
 * RONDE 652 — "rights NOT proven, verify manually before publishing" was written only to the
 * render log. The operator keeps using that footage and tells the customer instead.
 */
function clip(p: Partial<TimelineVideoClip> & Pick<TimelineVideoClip, "id" | "timelineStart" | "timelineEnd">): TimelineVideoClip {
  return {
    kind: "video",
    source: { provider: "curated_archive" },
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: { kind: "none" },
    ...p,
  } as TimelineVideoClip;
}

function timeline(clips: TimelineVideoClip[]): ProjectTimeline {
  return { tracks: [{ kind: "VIDEO", clips }] } as unknown as ProjectTimeline;
}

const ROWS: FootageArchiveRow[] = [
  { id: 1, licenseNote: "creativeCommon", sourcePlatform: "youtube_cc", sourceNote: "youtube_cc:AAAAAAAAAAA", title: "CC newsreel" },
  { id: 2, licenseNote: "youtube", sourcePlatform: "youtube_cc", sourceUrl: "https://www.youtube.com/watch?v=BBBBBBBBBBB&t=40s", title: "Standard doc" },
  { id: 3, licenseNote: null, sourcePlatform: "youtube_cc", sourceNote: "youtube_cc:CCCCCCCCCCC@120s", title: "Fair-use find" },
  { id: 4, licenseNote: "Pexels license", sourcePlatform: "pexels", title: "Stock city" },
];

describe("what the archive recorded decides the status, and nothing more", () => {
  it("reads the search mode the clip was found under", () => {
    expect(classifyYoutubeFootageLicence("creativeCommon")).toBe("creative_commons");
    expect(classifyYoutubeFootageLicence("creative_common")).toBe("creative_commons");
    expect(classifyYoutubeFootageLicence("youtube")).toBe("standard_youtube_licence");
    expect(classifyYoutubeFootageLicence(null)).toBe("unknown");
    expect(classifyYoutubeFootageLicence("")).toBe("unknown");
  });

  it("finds the YouTube id in the clip, the archive note or the source URL", () => {
    const c = clip({ id: "a", timelineStart: 0, timelineEnd: 2, source: { provider: "youtube_cc", providerAssetId: "DDDDDDDDDDD" } });
    expect(youtubeVideoIdFor(c)).toBe("DDDDDDDDDDD");
    const viaArchive = clip({ id: "b", timelineStart: 0, timelineEnd: 2, source: { provider: "curated_archive", archiveAssetId: 2 } });
    expect(youtubeVideoIdFor(viaArchive, ROWS[1])).toBe("BBBBBBBBBBB");
    expect(youtubeVideoIdFor(viaArchive, ROWS[2])).toBe("CCCCCCCCCCC");
  });
});

describe("the report lists every YouTube video on screen, with where it appears", () => {
  const tl = timeline([
    clip({ id: "s0", timelineStart: 0, timelineEnd: 3, source: { provider: "curated_archive", archiveAssetId: 1 } }),
    clip({ id: "s1_p1", timelineStart: 3, timelineEnd: 6, source: { provider: "curated_archive", archiveAssetId: 2 } }),
    clip({ id: "s1_p2", timelineStart: 6, timelineEnd: 9, source: { provider: "curated_archive", archiveAssetId: 2 } }),
    clip({ id: "s2", timelineStart: 9, timelineEnd: 12, source: { provider: "curated_archive", archiveAssetId: 4 } }),
    clip({ id: "s3", timelineStart: 12, timelineEnd: 16, source: { provider: "youtube_cc", providerAssetId: "EEEEEEEEEEE" } }),
    clip({ id: "s4", timelineStart: 16, timelineEnd: 20, disabled: true, source: { provider: "curated_archive", archiveAssetId: 3 } }),
  ]);

  it("asks the archive only for the rows it needs", () => {
    expect(archiveIdsForFootageRights(tl).sort()).toEqual([1, 2, 4]);
  });

  it("counts proven and unproven footage separately; stock and disabled shots are not in it", () => {
    const r = footageRightsReport(tl, ROWS);
    expect(r.entries.map((e) => [e.youtubeVideoId, e.status])).toEqual([
      ["AAAAAAAAAAA", "creative_commons"],
      ["BBBBBBBBBBB", "standard_youtube_licence"],
      ["EEEEEEEEEEE", "unknown"],
    ]);
    expect(r.needsCheck).toBe(2);
    expect(r.youtubeSeconds).toBe(13);
    expect(r.needsCheckSeconds).toBe(10);
  });

  it("merges the pieces of one shot into one appearance and links the video", () => {
    const b = footageRightsReport(tl, ROWS).entries.find((e) => e.youtubeVideoId === "BBBBBBBBBBB")!;
    expect(b.appearances).toEqual([{ start: 3, end: 9 }]);
    expect(b.youtubeUrl).toBe("https://www.youtube.com/watch?v=BBBBBBBBBBB");
  });

  it("says nothing for a video without YouTube footage", () => {
    const r = footageRightsReport(
      timeline([clip({ id: "x", timelineStart: 0, timelineEnd: 5, source: { provider: "curated_archive", archiveAssetId: 4 } })]),
      ROWS
    );
    expect(r).toEqual({ entries: [], needsCheck: 0, youtubeSeconds: 0, needsCheckSeconds: 0 });
  });
});

describe("the customer is shown it next to the finished video", () => {
  const ROUTER = fs.readFileSync(path.join(__dirname, "timelineRouter.ts"), "utf8");
  const DASH = fs.readFileSync(path.join(__dirname, "../client/src/pages/Dashboard.tsx"), "utf8");
  const NOTICE = fs.readFileSync(path.join(__dirname, "../client/src/components/FootageRightsNotice.tsx"), "utf8");

  it("is a read-only query behind the same ownership check as the editor", () => {
    const at = ROUTER.indexOf("footageRights: protectedProcedure");
    expect(at).toBeGreaterThan(-1);
    const body = ROUTER.slice(at, ROUTER.indexOf("editText: protectedProcedure", at));
    expect(body).toContain("requireVideoAccess(await getVideoById(input.videoId), ctx);");
    expect(body).toContain(".query(");
    expect(body).not.toMatch(/\.mutation\(|saveStoredTimeline|createRenderJob/);
  });

  it("renders the notice for a completed video", () => {
    expect(DASH).toContain("<FootageRightsNotice videoId={video.id} />");
    expect(NOTICE).toContain("trpc.timeline.footageRights.useQuery");
    expect(NOTICE).toContain("Check the rights before publishing");
  });
});
