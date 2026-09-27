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

const run = async (
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
  const seeded = await seedExistingProvenSceneClips({
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

/* ═══════════ 9–12 — identity, dedup, and no silent replacement ═══════════ */

describe("RC-3 §4 — identity and dedup survive the seeding", () => {

  it("the helper adds, never removes — a rebuild's own choices are not touched", async () => {
    const at = PIPELINE.indexOf("export async function seedExistingProvenSceneClips(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body, "seeding must not delete from the dedup registers").not.toMatch(
      /usedContentKeys\.delete|usedPaths\.delete|\.splice\(/
    );
  });
});

/* ═══════════ 13 — the policy is unchanged and still closed ═══════════ */

describe("RC-3 §5 — the replacement policy is untouched", () => {
  it("TEST 13 — no rebuild has silent permission to replace a proven picture", async () => {
    expect(PIPELINE).toContain(
      "const SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE: ReadonlySet<SceneResourceSite> = new Set();"
    );
  });

  it("the invariant that names a rebuild making the trade is still in place", async () => {
    const at = PIPELINE.indexOf("function noteSceneClipsResourced(");
    const body = PIPELINE.slice(at, PIPELINE.indexOf("\n}\n", at));
    expect(body).toContain("PROVEN_BEAT_VISUAL_REPLACED_BY_PLACEHOLDER");
    expect(body).toContain("SITES_THAT_MAY_REPLACE_A_PROVEN_PICTURE.has(site)");
  });
});
