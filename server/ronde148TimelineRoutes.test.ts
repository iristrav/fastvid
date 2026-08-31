/**
 * RONDE 148 §23 — the editor's API, called the way the browser calls it.
 *
 * ── Why `createCaller` and not fetch ─────────────────────────────────────────────────────────
 *
 * `appRouter.createCaller(ctx)` runs the real procedures, the real zod input parsing and — the
 * part that matters most here — the REAL `protectedProcedure` middleware and the real
 * `requireVideoAccess`. A test that called the handler functions directly would prove the happy
 * path and miss the authorisation, which is the one thing in this file that must not be wrong.
 * This is the pattern `video.test.ts` and `auth.logout.test.ts` already use.
 *
 * ── What is faked ────────────────────────────────────────────────────────────────────────────
 *
 * Only the database, and only the handful of functions these routes touch. There is no
 * DATABASE_URL here, and the alternative — skipping these tests — would leave the version
 * conflict, the ownership check and the "one render at a time" rule with no coverage at all.
 *
 * The fake behaves like the real column: `saveVideoTimeline` writes only when the expected version
 * still matches, exactly as the SQL `WHERE timelineVersion = ?` does. A fake that always wrote
 * would make the concurrency test pass while the real thing lost people's edits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TrpcContext } from "./_core/context";
import {
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FORMAT,
  emptyTimeline,
  type ProjectTimeline,
  type TimelineVideoClip,
} from "./projectTimeline";

/* ═══════════════════════ the fake database ═══════════════════════ */

type FakeVideo = {
  id: number;
  userId: number;
  title: string;
  status: string;
  videoUrl: string | null;
  editedVideoUrl: string | null;
  editedVideoTimelineVersion: number | null;
  thumbnailUrl: string | null;
  renderAttempt: number;
};

type FakeJob = {
  id: number;
  videoId: number;
  status: string;
  timelineVersion: number;
  attempt: number;
  progressStep: string;
  progress: number;
  outputUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

const store = vi.hoisted(() => ({
  videos: new Map<number, Record<string, unknown>>(),
  timelines: new Map<number, { raw: unknown; timelineVersion: number }>(),
  jobs: [] as Record<string, unknown>[],
  nextJobId: 1,
  /** Fires just before a save writes — the hook the race test uses. */
  onBeforeSave: null as null | (() => void),
}));

vi.mock("./db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db")>()),
  getVideoById: async (id: number) => store.videos.get(id) ?? null,
  getVideoScenes: async () => null,
  getStoredTimeline: async (id: number) => store.timelines.get(id) ?? null,
  saveVideoTimeline: async (p: {
    id: number; timeline: unknown; expectedVersion: number; nextVersion: number;
  }) => {
    store.onBeforeSave?.();
    const current = store.timelines.get(p.id)?.timelineVersion ?? 0;
    // The conditional UPDATE, reproduced. This is what makes a racing save lose rather than win.
    if (current !== p.expectedVersion) return { saved: false };
    store.timelines.set(p.id, { raw: p.timeline, timelineVersion: p.nextVersion });
    return { saved: true };
  },
  claimRenderAttempt: async (videoId: number) => {
    const v = store.videos.get(videoId) as FakeVideo | undefined;
    if (!v) return null;
    v.renderAttempt += 1;
    return v.renderAttempt;
  },
  createRenderJob: async (p: {
    videoId: number; requestedByUserId?: number | null; timelineVersion: number; attempt: number;
  }) => {
    const job: FakeJob = {
      id: store.nextJobId++,
      videoId: p.videoId,
      status: "queued",
      timelineVersion: p.timelineVersion,
      attempt: p.attempt,
      progressStep: "queued",
      progress: 0,
      outputUrl: null,
      errorCode: null,
      errorMessage: null,
    };
    store.jobs.push(job as unknown as Record<string, unknown>);
    return job;
  },
  getRenderJobById: async (id: number) => store.jobs.find((j) => j.id === id) ?? null,
  listRenderJobsForVideo: async (videoId: number) =>
    store.jobs.filter((j) => j.videoId === videoId).reverse(),
  listActiveRenderJobsForVideo: async (videoId: number) =>
    store.jobs.filter(
      (j) => j.videoId === videoId && (j.status === "queued" || j.status === "running")
    ),
}));

const { appRouter } = await import("./routers");

/* ═══════════════════════ contexts ═══════════════════════ */

function ctxFor(id: number, role: "user" | "admin" = "user"): TrpcContext {
  return {
    user: {
      id,
      openId: `openid-${id}`,
      email: `u${id}@test.com`,
      name: `User ${id}`,
      loginMethod: "manus",
      role,
      subscriptionStatus: "active",
      subscriptionStartDate: new Date(),
      subscriptionEndDate: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
  };
}

const anonCtx: TrpcContext = {
  user: null,
  req: { protocol: "https", headers: {} } as TrpcContext["req"],
  res: { clearCookie: vi.fn() } as unknown as TrpcContext["res"],
};

/* ═══════════════════════ fixtures ═══════════════════════ */

const OWNER = 1;
const STRANGER = 2;
const VIDEO_ID = 10;

function clip(i: number): TimelineVideoClip {
  return {
    id: `vc_${i}`,
    kind: "video",
    source: { provider: "loc", providerAssetId: `item/${i}`, mediaUrl: `https://loc/${i}.mp4` },
    timelineStart: i * 3,
    timelineEnd: (i + 1) * 3,
    motion: "none",
    transitionIn: "hard_cut",
    transitionOut: "hard_cut",
    previewSource: "asset",
  };
}

function goodTimeline(): ProjectTimeline {
  const t = emptyTimeline(VIDEO_ID, DEFAULT_FORMAT);
  t.tracks = [
    { kind: "VIDEO", clips: [clip(0), clip(1)] },
    { kind: "VOICE", clips: [] },
    { kind: "MUSIC", clips: [] },
    { kind: "SFX", clips: [] },
    {
      kind: "CAPTIONS",
      captions: [
        { id: "cap_0", text: "The Battle Begins", start: 0.5, end: 3, style: DEFAULT_CAPTION_STYLE, animation: "fade" },
      ],
    },
    { kind: "TEXT", texts: [] },
    { kind: "GRAPHICS", texts: [] },
  ];
  t.durationSec = 6;
  return t;
}

beforeEach(() => {
  store.videos.clear();
  store.timelines.clear();
  store.jobs = [];
  store.nextJobId = 1;
  store.onBeforeSave = null;
  store.videos.set(VIDEO_ID, {
    id: VIDEO_ID,
    userId: OWNER,
    title: "The Fall of Berlin",
    status: "completed",
    videoUrl: "/local-storage/videos/10/final.mp4",
    editedVideoUrl: null,
    editedVideoTimelineVersion: null,
    thumbnailUrl: null,
    renderAttempt: 0,
  });
});

const owner = () => appRouter.createCaller(ctxFor(OWNER));

/* ═══════════════════════ §21 — authorisation ═══════════════════════ */

describe("§21 — the editor uses the SAME ownership rule as every other video route", () => {
  it("an anonymous caller is refused on every editor route", async () => {
    const anon = appRouter.createCaller(anonCtx);
    await expect(anon.timeline.get({ videoId: VIDEO_ID })).rejects.toThrow();
    await expect(
      anon.timeline.render({ videoId: VIDEO_ID, timelineVersion: 0 })
    ).rejects.toThrow();
    await expect(
      anon.timeline.save({
        videoId: VIDEO_ID,
        timeline: goodTimeline() as never,
        expectedTimelineVersion: 0,
      })
    ).rejects.toThrow();
  });

  it("ANOTHER USER CANNOT OPEN, SAVE OR RENDER SOMEONE ELSE'S VIDEO", async () => {
    const stranger = appRouter.createCaller(ctxFor(STRANGER));
    await expect(stranger.timeline.get({ videoId: VIDEO_ID })).rejects.toThrow(/access/i);
    await expect(
      stranger.timeline.save({
        videoId: VIDEO_ID,
        timeline: goodTimeline() as never,
        expectedTimelineVersion: 0,
      })
    ).rejects.toThrow(/access/i);
    await expect(
      stranger.timeline.render({ videoId: VIDEO_ID, timelineVersion: 0 })
    ).rejects.toThrow(/access/i);
  });

  it("an admin may, because that is the existing rule", async () => {
    const admin = appRouter.createCaller(ctxFor(99, "admin"));
    await expect(admin.timeline.get({ videoId: VIDEO_ID })).resolves.toBeTruthy();
  });

  it("a video that does not exist is NOT_FOUND, not a leak about who owns what", async () => {
    await expect(owner().timeline.get({ videoId: 9999 })).rejects.toThrow(/not found/i);
  });

  it("A JOB FROM ANOTHER VIDEO CANNOT BE READ THROUGH A VIDEO YOU OWN", async () => {
    /**
     * Without the `job.videoId !== input.videoId` comparison the ownership check is decorative:
     * pass a video you own and any jobId you like, and the row comes back.
     */
    store.videos.set(77, { id: 77, userId: STRANGER, title: "theirs", status: "completed", renderAttempt: 0 });
    store.jobs.push({
      id: 555, videoId: 77, status: "completed", timelineVersion: 1, attempt: 1,
      progressStep: "completed", progress: 100, outputUrl: "x", errorCode: null, errorMessage: null,
    });
    await expect(
      owner().timeline.renderJob({ videoId: VIDEO_ID, jobId: 555 })
    ).rejects.toThrow(/not found/i);
  });
});

/* ═══════════════════════ §5 — timeline.get ═══════════════════════ */

describe("§5 — timeline.get", () => {
  it("returns the stored timeline, its version and the video's two URLs", async () => {
    store.timelines.set(VIDEO_ID, { raw: { ...goodTimeline(), version: 3 }, timelineVersion: 3 });
    const result = await owner().timeline.get({ videoId: VIDEO_ID });
    expect(result.timelineVersion).toBe(3);
    expect(result.timelineSource).toBe("stored");
    expect(result.video.videoUrl).toBe("/local-storage/videos/10/final.mp4");
    expect(result.video.editedVideoUrl).toBeNull();
    expect(result.timeline.tracks).toHaveLength(7);
  });

  it("IT IS READ-ONLY — opening a never-edited video does not create a version", async () => {
    /**
     * §5's rule. A GET that wrote would mean looking at a video changes it, and two people opening
     * the same one would fight over a version neither of them edited.
     */
    const before = store.timelines.get(VIDEO_ID);
    const result = await owner().timeline.get({ videoId: VIDEO_ID });
    expect(store.timelines.get(VIDEO_ID)).toBe(before);
    expect(result.timelineVersion).toBe(0);
  });

  it("a video with neither timeline nor manifest opens empty rather than failing", async () => {
    const result = await owner().timeline.get({ videoId: VIDEO_ID });
    expect(result.timelineSource).toBe("empty");
    expect(result.timeline.tracks).toEqual([]);
  });

  it("a damaged stored timeline is REFUSED, not replaced by a reconstruction", async () => {
    /**
     * Falling back to the manifest would show the person their ORIGINAL cut and let them save it
     * over their real edits. Refusing cannot lose work; guessing can.
     */
    store.timelines.set(VIDEO_ID, { raw: { nonsense: true }, timelineVersion: 4 });
    await expect(owner().timeline.get({ videoId: VIDEO_ID })).rejects.toThrow(/TIMELINE_INVALID/);
  });

  it("it reports the render history and the recovery outlook", async () => {
    store.timelines.set(VIDEO_ID, { raw: goodTimeline(), timelineVersion: 1 });
    store.jobs.push({
      id: 1, videoId: VIDEO_ID, status: "completed", timelineVersion: 1, attempt: 1,
      progressStep: "completed", progress: 100, outputUrl: "u", errorCode: null, errorMessage: null,
    });
    const result = await owner().timeline.get({ videoId: VIDEO_ID });
    expect(result.latestRenderJob?.id).toBe(1);
    expect(result.recovery).toEqual({ total: 2, reachable: 2, previewOnly: 0 });
  });
});

/* ═══════════════════════ §6 — timeline.save ═══════════════════════ */

describe("§6 — timeline.save", () => {
  it("a first save takes the timeline from version 0 to 1", async () => {
    const result = await owner().timeline.save({
      videoId: VIDEO_ID,
      timeline: goodTimeline() as never,
      expectedTimelineVersion: 0,
    });
    expect(result.timelineVersion).toBe(1);
    expect(store.timelines.get(VIDEO_ID)?.timelineVersion).toBe(1);
  });

  it("each save increments the version by exactly one", async () => {
    const caller = owner();
    for (const expected of [0, 1, 2]) {
      const r = await caller.timeline.save({
        videoId: VIDEO_ID,
        timeline: goodTimeline() as never,
        expectedTimelineVersion: expected,
      });
      expect(r.timelineVersion).toBe(expected + 1);
    }
  });

  it("A STALE SAVE IS REFUSED AND THE STORED TIMELINE IS UNTOUCHED", async () => {
    store.timelines.set(VIDEO_ID, { raw: goodTimeline(), timelineVersion: 5 });
    await expect(
      owner().timeline.save({
        videoId: VIDEO_ID,
        timeline: goodTimeline() as never,
        expectedTimelineVersion: 4,
      })
    ).rejects.toThrow(/TIMELINE_VERSION_CONFLICT/);
    expect(store.timelines.get(VIDEO_ID)?.timelineVersion).toBe(5);
  });

  it("A SAVE THAT LOSES A RACE ALSO LOSES ITS WRITE", async () => {
    /**
     * Both callers read version 0 and both pass the read-side check. The conditional write is what
     * decides, and the loser must be told rather than silently dropped.
     */
    store.onBeforeSave = () => {
      // Someone else's save lands between our read and our write.
      store.timelines.set(VIDEO_ID, { raw: goodTimeline(), timelineVersion: 1 });
      store.onBeforeSave = null;
    };
    await expect(
      owner().timeline.save({
        videoId: VIDEO_ID,
        timeline: goodTimeline() as never,
        expectedTimelineVersion: 0,
      })
    ).rejects.toThrow(/TIMELINE_VERSION_CONFLICT/);
    expect(store.timelines.get(VIDEO_ID)?.timelineVersion).toBe(1);
  });

  it("AN INVALID TIMELINE IS NEVER STORED", async () => {
    const broken = goodTimeline();
    const track = broken.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    await expect(
      owner().timeline.save({
        videoId: VIDEO_ID,
        timeline: broken as never,
        expectedTimelineVersion: 0,
      })
    ).rejects.toThrow(/TIMELINE_INVALID/);
    expect(store.timelines.has(VIDEO_ID)).toBe(false);
  });

  it("the refusal NAMES the faults instead of saying something went wrong", async () => {
    // §18 — "Geen generieke Something went wrong."
    const broken = goodTimeline();
    const track = broken.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    await expect(
      owner().timeline.save({
        videoId: VIDEO_ID,
        timeline: broken as never,
        expectedTimelineVersion: 0,
      })
    ).rejects.toThrow(/negative_duration/);
  });

  it("THE VALIDATOR IS NOT ALLOWED TO REPAIR ON THE WAY IN", async () => {
    const broken = goodTimeline();
    const track = broken.tracks.find((t) => t.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    await owner()
      .timeline.save({ videoId: VIDEO_ID, timeline: broken as never, expectedTimelineVersion: 0 })
      .catch(() => {});
    // Nothing stored, and the caller's own object was not silently corrected either.
    expect(store.timelines.has(VIDEO_ID)).toBe(false);
    const t = broken.tracks.find((x) => x.kind === "VIDEO");
    expect(t?.kind === "VIDEO" && t.clips[0]!.timelineEnd).toBe(-1);
  });

  it("A TIMELINE FOR A DIFFERENT VIDEO IS REFUSED", async () => {
    /**
     * The ownership check does not close this one: a caller may legitimately own both videos, and
     * saving 7's timeline onto 8 would make 8's render fetch 7's assets.
     */
    const foreign = { ...goodTimeline(), videoId: 999 };
    await expect(
      owner().timeline.save({
        videoId: VIDEO_ID,
        timeline: foreign as never,
        expectedTimelineVersion: 0,
      })
    ).rejects.toThrow(/belongs to video 999/);
  });

  it("a save round-trips: what comes back is what timeline.get then returns", async () => {
    const caller = owner();
    const edited = goodTimeline();
    const caps = edited.tracks.find((t) => t.kind === "CAPTIONS");
    if (caps?.kind === "CAPTIONS") caps.captions[0]!.text = "The Battle for Europe Begins";
    await caller.timeline.save({
      videoId: VIDEO_ID,
      timeline: edited as never,
      expectedTimelineVersion: 0,
    });
    const after = await caller.timeline.get({ videoId: VIDEO_ID });
    const stored = after.timeline.tracks.find((t) => t.kind === "CAPTIONS");
    expect(stored?.kind === "CAPTIONS" && stored.captions[0]!.text).toBe("The Battle for Europe Begins");
    expect(after.timelineVersion).toBe(1);
  });
});

/* ═══════════════════════ §16 — editText through the API ═══════════════════════ */

describe("§16 — timeline.editText changes one element and bumps the version", () => {
  beforeEach(() => {
    store.timelines.set(VIDEO_ID, { raw: goodTimeline(), timelineVersion: 1 });
  });

  it("the caption changes, the video clips do not, and the version goes to 2", async () => {
    const result = await owner().timeline.editText({
      videoId: VIDEO_ID,
      expectedTimelineVersion: 1,
      elementId: "cap_0",
      text: "The Battle for Europe Begins",
    });
    expect(result.timelineVersion).toBe(2);
    const caps = result.timeline.tracks.find((t) => t.kind === "CAPTIONS");
    expect(caps?.kind === "CAPTIONS" && caps.captions[0]!.text).toBe("The Battle for Europe Begins");
    const video = result.timeline.tracks.find((t) => t.kind === "VIDEO");
    expect(video?.kind === "VIDEO" && video.clips.map((c) => c.timelineStart)).toEqual([0, 3]);
  });

  it("an unknown element id is refused", async () => {
    await expect(
      owner().timeline.editText({
        videoId: VIDEO_ID,
        expectedTimelineVersion: 1,
        elementId: "nope",
        text: "x",
      })
    ).rejects.toThrow(/TIMELINE_INVALID/);
  });

  it("an edit that would break the timeline is refused and nothing is stored", async () => {
    await expect(
      owner().timeline.editText({
        videoId: VIDEO_ID,
        expectedTimelineVersion: 1,
        elementId: "cap_0",
        start: 5,
        end: 2,
      })
    ).rejects.toThrow(/TIMELINE_INVALID/);
    expect(store.timelines.get(VIDEO_ID)?.timelineVersion).toBe(1);
  });

  it("a stale version conflicts here too", async () => {
    await expect(
      owner().timeline.editText({
        videoId: VIDEO_ID,
        expectedTimelineVersion: 0,
        elementId: "cap_0",
        text: "x",
      })
    ).rejects.toThrow(/TIMELINE_VERSION_CONFLICT/);
  });
});

/* ═══════════════════════ §7 — timeline.render ═══════════════════════ */

describe("§7 — timeline.render creates a job and returns", () => {
  beforeEach(() => {
    store.timelines.set(VIDEO_ID, { raw: goodTimeline(), timelineVersion: 2 });
  });

  it("a job is queued, carrying the version and a fresh attempt", async () => {
    const result = await owner().timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 });
    expect(result.job.status).toBe("queued");
    expect(result.job.timelineVersion).toBe(2);
    expect(result.job.attempt).toBe(1);
    expect(result.job.videoId).toBe(VIDEO_ID);
  });

  it("the attempt is claimed BEFORE the job exists, so a job never carries an unknown number", async () => {
    await owner().timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 });
    const video = store.videos.get(VIDEO_ID) as unknown as FakeVideo;
    expect(video.renderAttempt).toBe(1);
    expect((store.jobs[0] as unknown as FakeJob).attempt).toBe(1);
  });

  it("A SECOND RENDER IS REFUSED WHILE ONE IS ACTIVE", async () => {
    const caller = owner();
    await caller.timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 });
    await expect(
      caller.timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 })
    ).rejects.toThrow(/RENDER_ALREADY_RUNNING/);
    expect(store.jobs).toHaveLength(1);
  });

  it("once the first job finishes, a new render is allowed and gets attempt 2", async () => {
    const caller = owner();
    await caller.timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 });
    (store.jobs[0] as unknown as FakeJob).status = "completed";
    const second = await caller.timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 });
    expect(second.job.attempt).toBe(2);
  });

  it("rendering a version the server does not hold is refused", async () => {
    await expect(
      owner().timeline.render({ videoId: VIDEO_ID, timelineVersion: 1 })
    ).rejects.toThrow(/TIMELINE_VERSION_CONFLICT/);
    expect(store.jobs).toHaveLength(0);
  });

  it("AN UNRECOVERABLE CLIP IS NAMED AS SUCH, not reported as a broken timeline", async () => {
    /**
     * "Your timeline is malformed" is a bug report; "the source for this shot is gone" is
     * something the person can fix by replacing that shot. Which code they get decides which
     * conversation they have.
     */
    const t = goodTimeline();
    const track = t.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.source = { provider: "wikimedia" };
    store.timelines.set(VIDEO_ID, { raw: t, timelineVersion: 2 });
    await expect(
      owner().timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 })
    ).rejects.toThrow(/ASSET_NOT_REHYDRATABLE/);
    expect(store.jobs).toHaveLength(0);
  });

  it("an invalid timeline never becomes a job", async () => {
    const broken = goodTimeline();
    const track = broken.tracks.find((x) => x.kind === "VIDEO");
    if (track?.kind === "VIDEO") track.clips[0]!.timelineEnd = -1;
    store.timelines.set(VIDEO_ID, { raw: broken, timelineVersion: 2 });
    await expect(
      owner().timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 })
    ).rejects.toThrow(/TIMELINE_INVALID/);
    expect(store.jobs).toHaveLength(0);
  });

  it("§10 — a queued job reports its PHASE by name, with no invented percentage", async () => {
    const caller = owner();
    const created = await caller.timeline.render({ videoId: VIDEO_ID, timelineVersion: 2 });
    const job = await caller.timeline.renderJob({ videoId: VIDEO_ID, jobId: created.job.id });
    expect(job.progressStep).toBe("queued");
    expect(job.progress).toBe(0);
  });
});

/* ═══════════════════════ THE ACCEPTANCE FLOW (§32), through the API ═══════════════════════ */

describe("§32 — open, edit, save, render", () => {
  it("the whole loop up to a queued job, in order", async () => {
    const caller = owner();
    store.timelines.set(VIDEO_ID, { raw: goodTimeline(), timelineVersion: 1 });

    // 1. open
    const opened = await caller.timeline.get({ videoId: VIDEO_ID });
    expect(opened.timelineVersion).toBe(1);

    // 2. change a caption locally
    const edited = JSON.parse(JSON.stringify(opened.timeline)) as ProjectTimeline;
    const caps = edited.tracks.find((t) => t.kind === "CAPTIONS");
    if (caps?.kind === "CAPTIONS") caps.captions[0]!.text = "The Battle for Europe Begins";

    // 3. save → version + 1
    const saved = await caller.timeline.save({
      videoId: VIDEO_ID,
      timeline: edited as never,
      expectedTimelineVersion: 1,
    });
    expect(saved.timelineVersion).toBe(2);

    // 4. render that exact version
    const queued = await caller.timeline.render({
      videoId: VIDEO_ID,
      timelineVersion: saved.timelineVersion,
    });
    expect(queued.job.status).toBe("queued");
    expect(queued.job.timelineVersion).toBe(2);

    // 5. the editor can poll it
    const polled = await caller.timeline.renderJob({ videoId: VIDEO_ID, jobId: queued.job.id });
    expect(polled.timelineVersion).toBe(2);

    // and the saved text really is the text the job will render
    const stored = store.timelines.get(VIDEO_ID)!.raw as ProjectTimeline;
    const storedCaps = stored.tracks.find((t) => t.kind === "CAPTIONS");
    expect(storedCaps?.kind === "CAPTIONS" && storedCaps.captions[0]!.text).toBe(
      "The Battle for Europe Begins"
    );
  });
});
