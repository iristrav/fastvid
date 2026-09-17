/**
 * RC-3 — A REBUILD DOES NOT START FROM NOTHING.
 *
 * ── The blank line that meant "forfeit everything" ──────────────────────────────────────────
 *
 * `refillSceneStrictVoiceMatch` has two branches. The cheap one — "strict refill already
 * attempted this render" — has seeded its clip list from the adopt audit since a production
 * finding caught it discarding an adopted Internet Archive clip and standing a guaranteed
 * placeholder in its place. The expensive one, the full re-source of every beat, still opened
 * with `const clips: string[] = []`.
 *
 * Render 589's scene 0 took the expensive branch. It held `youtube_cc:0fIJzO7EIYI` — 1751
 * candidates, 104 download attempts, one success, fair-use transformed, judged FIT by the picture
 * editor on beat 0 — and rebuilt without it:
 *
 *     [ArchiveSearch] zin 100 — GEEN kandidaten gevonden in archief
 *     [Pipeline] Scene 0 slot 100: text-overlay fallback OK
 *     [SceneResourced] scene_0_resourced dropped a fetched asset nothing refused:
 *       provider=youtube_cc:0fIJzO7EIYI scene=0 beat=0
 *
 * One rule, two copies, one of them wrong.
 *
 * ── What these tests hold ───────────────────────────────────────────────────────────────────
 *
 * That both branches now carry what the scene already proved; that a card still gets its slot
 * when nothing was proved; that beat ownership stays strict and cardinality cannot drift; and
 * that this door is no wider than the one every other clip goes through — a clip the editor
 * refused without a reprieve is not smuggled back in by it.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { seedExistingProvenSceneClips } from "./videoPipeline";
import {
  createBeatRelevanceLedger,
  type BeatRelevanceLedger,
  type BeatVisualContext,
} from "./beatVisualRelevance";
import { recordExternalRelevanceVerdict } from "./beatRelevanceSeed.test.support";

const PIPELINE = fs.readFileSync(path.join(__dirname, "videoPipeline.ts"), "utf8");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A real file on disk — the helper checks, and must keep checking. */
const file = (name: string): string => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "bytes");
  return p;
};

/** Render 589's own clip names, so the fixture carries the real identities. */
const YT = "scene_0_ytfu_0__pid_youtube_cc-132f0ec33347cc7a_transformed.mp4";
const IA = "scene_0_ia_1__pid_internet_archive-83a770cf64be57ab.mp4";
const CARD = "scene_0_slot100_guaranteed.mp4";

type Entry = { sceneIndex: number; beatIndex: number; basename: string; source: string };

const scene = (index = 0) => ({ index, duration: 16, text: "Kardashians" }) as never;

const dedupOf = (audit: Entry[], relevance?: BeatRelevanceLedger) =>
  ({
    clipAdoptAudit: audit as never,
    usedContentKeys: new Set<string>(),
    usedPaths: new Set<string>(),
    beatRelevance: relevance,
  }) as never;

const run = (
  audit: Entry[],
  opts: {
    relevance?: BeatRelevanceLedger;
    clips?: string[];
    beatDurations?: number[];
    clipBeatIndices?: number[];
    sceneIndex?: number;
  } = {}
) => {
  const clips = opts.clips ?? [];
  const beatDurations = opts.beatDurations ?? [];
  const clipBeatIndices = opts.clipBeatIndices ?? [];
  const dedup = dedupOf(audit, opts.relevance);
  const seeded = seedExistingProvenSceneClips({
    scene: scene(opts.sceneIndex ?? 0),
    workDir: dir,
    dedup,
    clips,
    beatDurations,
    clipBeatIndices,
    holdSecFor: (beatIndex) => 3 + beatIndex,
    branch: "full_resource",
  });
  return { seeded, clips, beatDurations, clipBeatIndices, dedup: dedup as never as { usedContentKeys: Set<string> } };
};

const adopted = (beatIndex: number, basename: string, source = "youtube_cc"): Entry => ({
  sceneIndex: 0,
  beatIndex,
  basename,
  source,
});

/* ═══════════ 1–3 — what the scene proved is carried ═══════════ */

describe("RC-3 §1 — an approved clip survives a rebuild", () => {
  it("TEST 1 — render 589's YouTube clip survives the full strict refill", () => {
    file(YT);
    const r = run([adopted(0, YT)]);
    expect(r.seeded).toBe(1);
    expect(r.clips).toEqual([path.join(dir, YT)]);
    expect(r.clipBeatIndices).toEqual([0]);
  });

  it("TEST 2 — an Internet Archive clip survives it just the same", () => {
    file(IA);
    const r = run([adopted(0, IA, "internet_archive")]);
    expect(r.clips).toEqual([path.join(dir, IA)]);
  });

  it("TEST 3 — and survives the guaranteed-fill branch, which is the same call", () => {
    /**
     * The two branches are one implementation now. The cheap branch's own seeding was the thing
     * that worked; what this asserts is that it is the SAME code, so a fix to one is a fix to both.
     */
    const at = PIPELINE.indexOf("async function refillSceneStrictVoiceMatch(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    const calls = [...body.matchAll(/seedExistingProvenSceneClips\(\{/g)];
    expect(calls.length, "both branches must seed through the one helper").toBe(2);
    expect(body).toContain('branch: "guaranteed_fill_only"');
    expect(body).toContain('branch: "full_resource"');
    expect(body, "a branch is building its own seeding loop again").not.toContain(
      "const realEntriesForScene ="
    );
  });
});

/* ═══════════ 4–5 — the fallback is not blocked ═══════════ */

describe("RC-3 §2 — a card still gets the slot nothing else earned", () => {
  it("TEST 5 — a scene with nothing proved seeds nothing, so the fallback runs as before", () => {
    const r = run([]);
    expect(r.seeded).toBe(0);
    expect(r.clips).toEqual([]);
    expect(r.clipBeatIndices).toEqual([]);
  });

  it("TEST 4 — a placeholder has no claim on a slot it only held for want of anything else", () => {
    file(CARD);
    for (const source of ["fallback", "rescue_placeholder"]) {
      const r = run([adopted(0, CARD, source)]);
      expect(r.seeded, source).toBe(0);
    }
  });

  it("a clip whose file is gone is not carried on the strength of its name", () => {
    const r = run([adopted(0, "never-written.mp4")]);
    expect(r.seeded).toBe(0);
  });

  it("this door is no wider than the montage's — a refused clip is not smuggled through", () => {
    /**
     * §3's "geen declined assets". Asked of `composeBarrierAllows`, the same reader the montage
     * uses, rather than a second rule that could disagree with it.
     */
    const p = file(YT);
    const relevance = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      relevance,
      p,
      "youtube_cc:132f0ec33347cc7a",
      { sceneIndex: 0, beatIndex: 0 } as BeatVisualContext,
      { verdict: "does_not_fit", depicts: "", reason: "" },
      "test"
    );
    expect(run([adopted(0, YT)], { relevance }).seeded).toBe(0);
  });

  it("…and a clip the editor approved comes through that same reader", () => {
    const p = file(YT);
    const relevance = createBeatRelevanceLedger();
    recordExternalRelevanceVerdict(
      relevance,
      p,
      "youtube_cc:132f0ec33347cc7a",
      { sceneIndex: 0, beatIndex: 0 } as BeatVisualContext,
      { verdict: "fits", depicts: "", reason: "" },
      "test"
    );
    expect(run([adopted(0, YT)], { relevance }).seeded).toBe(1);
  });
});

/* ═══════════ 6–8 — beat ownership and cardinality ═══════════ */

describe("RC-3 §3 — beat ownership stays strict", () => {
  it("TEST 6/7 — beat 0 keeps YouTube, beat 1 stays open, beat 2 keeps the archive clip", () => {
    file(YT);
    file(IA);
    const r = run([adopted(0, YT), adopted(2, IA, "internet_archive")]);
    expect(r.clipBeatIndices).toEqual([0, 2]);
    expect(r.clips).toEqual([path.join(dir, YT), path.join(dir, IA)]);
    expect(r.clipBeatIndices, "beat 1 must stay open for ordinary sourcing").not.toContain(1);
  });

  it("a clip never leaks onto a beat that is not its own", () => {
    file(YT);
    const r = run([adopted(3, YT)]);
    expect(r.clipBeatIndices).toEqual([3]);
  });

  it("TEST 8 — the three arrays stay the same length, in step", () => {
    file(YT);
    file(IA);
    const r = run([adopted(0, YT), adopted(2, IA, "internet_archive")]);
    expect(r.clips).toHaveLength(2);
    expect(r.beatDurations).toHaveLength(2);
    expect(r.clipBeatIndices).toHaveLength(2);
    /** The hold comes from the beat, not from the array position. */
    expect(r.beatDurations).toEqual([3, 5]);
  });

  it("TEST 11 — two audit rows for one beat cannot both take it", () => {
    file(YT);
    file(IA);
    const r = run([adopted(0, YT), adopted(0, IA, "internet_archive")]);
    expect(r.seeded).toBe(1);
    expect(r.clipBeatIndices).toEqual([0]);
  });

  it("the same file adopted twice is carried once", () => {
    file(YT);
    const r = run([adopted(0, YT), adopted(1, YT)]);
    expect(r.clips).toEqual([path.join(dir, YT)]);
  });

  it("a beat another pass already filled is left alone", () => {
    file(YT);
    const r = run([adopted(0, YT)], {
      clips: ["/w/already.mp4"],
      beatDurations: [4],
      clipBeatIndices: [0],
    });
    expect(r.seeded).toBe(0);
    expect(r.clips).toEqual(["/w/already.mp4"]);
  });

  it("another scene's adoptions are not this scene's", () => {
    file(YT);
    const r = run([{ sceneIndex: 1, beatIndex: 0, basename: YT, source: "youtube_cc" }]);
    expect(r.seeded).toBe(0);
  });

  it("seeded clips play in narrative beat order, not adoption order", () => {
    file(YT);
    file(IA);
    const r = run([adopted(2, IA, "internet_archive"), adopted(0, YT)]);
    expect(r.clipBeatIndices).toEqual([0, 2]);
  });
});

/* ═══════════ 9–12 — identity, dedup, and no silent replacement ═══════════ */

describe("RC-3 §4 — identity and dedup survive the seeding", () => {
  it("TEST 9/10 — the canonical provider identity is the file's own, untouched", () => {
    /**
     * Seeding copies a path; it derives nothing. The `__pid_youtube_cc-<hash>` tag that carries
     * `provider` and `providerAssetId` through every later resolve is the same string before and
     * after, because nothing here rewrites a name.
     */
    file(YT);
    const r = run([adopted(0, YT)]);
    expect(r.clips[0]).toBe(path.join(dir, YT));
    expect(path.basename(r.clips[0]!)).toContain("__pid_youtube_cc-132f0ec33347cc7a");
  });

  it("TEST 12 — the seeded key is registered, so nothing pushes the same footage again", () => {
    /**
     * Normally the key is already in `usedContentKeys` from the original adoption. It can be
     * absent when `noteSceneClipsResourced` un-stranded this asset after an earlier rebuild
     * dropped it — which is exactly the case where a duplicate would otherwise appear.
     */
    file(YT);
    const r = run([adopted(0, YT)]);
    expect(r.dedup.usedContentKeys.size).toBe(1);
    expect([...r.dedup.usedContentKeys][0]).toContain("youtube_cc");
  });

  it("the helper adds, never removes — a rebuild's own choices are not touched", () => {
    const at = PIPELINE.indexOf("export function seedExistingProvenSceneClips(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body, "seeding must not delete from the dedup registers").not.toMatch(
      /usedContentKeys\.delete|usedPaths\.delete|\.splice\(/
    );
  });

  it("every seeded beat is traced, through the same writer the gated routes use", () => {
    const at = PIPELINE.indexOf("export function seedExistingProvenSceneClips(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain('tracePushOutcome(dedup, candidate, scene.index, entry.beatIndex, true, "accepted_reseed")');
    expect(body).toContain("[SceneSeed]");
  });
});

/* ═══════════ 13 — the policy is unchanged and still closed ═══════════ */

describe("RC-3 §5 — the replacement policy is untouched", () => {
  it("TEST 13 — no rebuild has silent permission to replace a proven picture", () => {
    expect(PIPELINE).toContain(
      "const SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE: ReadonlySet<SceneResourceSite> = new Set();"
    );
  });

  it("the invariant that names a rebuild making the trade is still in place", () => {
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("PROVEN_BEAT_VISUAL_REPLACED_BY_PLACEHOLDER");
    expect(body).toContain("SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE.has(site)");
  });

  it("the cheap branch's guard against a second expensive re-source is kept", () => {
    /** §14: `strictRefillAttemptedScenes` is the one real performance guard here. */
    expect(PIPELINE).toContain("dedup.strictRefillAttemptedScenes.has(scene.index)");
    expect(PIPELINE).toContain("dedup.strictRefillAttemptedScenes.add(scene.index)");
  });

  it("a seeded beat is a filled beat to every reader that already existed", () => {
    /**
     * §14's performance claim, asserted structurally: the expensive sourcing for a beat is skipped
     * because `beatFilled()` and the two later passes all read `clipBeatIndices`, which seeding
     * writes. If that stopped being the ownership register, seeding would stop saving the work.
     */
    const at = PIPELINE.indexOf("async function refillSceneStrictVoiceMatch(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("const beatFilled = () => clipBeatIndices.includes(beat.index);");
    expect(body).toContain("if (clipBeatIndices.includes(beats[bi]!.index)) continue;");
  });
});
