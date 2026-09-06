/**
 * THE REPLAY MUST BE ABLE TO DISAGREE WITH THE RENDER IT CAME FROM.
 *
 * ── What is actually being tested ───────────────────────────────────────────────────────────
 *
 * A replay harness has one failure mode that matters, and it is silent: if the bundle stores the
 * render's CONCLUSIONS and plays them back, every replay agrees with its render, every fix looks
 * like a no-op, and the tool quietly certifies whatever it is shown. Such a harness is worse than
 * none, because it is trusted.
 *
 * So the central case here is render 570's own shape — an APPROVED clip whose fetch DID find a
 * pick, recorded at a time when the code opened no lineage for it, therefore recorded as
 * `eligible=false, allowed=false, FUNNEL_WITHOUT_EVIDENCE`. Replayed against the current code,
 * which opens the record at the fetch, the same facts must now produce an ADOPTION. If this test
 * ever passes trivially, the harness has stopped measuring anything.
 *
 * The mirror case matters just as much: a fetch with NO pick must stay refused. A replay that
 * turned those green would be inventing provenance, which is the exact failure the pipeline's own
 * [EligibilityGap] line exists to prevent.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  beginReplayRecording,
  loadReplayBundle,
  parseReplayBundle,
  recordReplayFact,
  replayRecordingActive,
  replayRecordingPath,
  resetReplayRecordingForTest,
  type ReplayBundle,
} from "./renderReplay";
import { realFunnelDecisions, replayBundle, formatReplayReport, REPLAY_SCOPE_NOTE } from "./renderReplayEngine";
import { curatedAssetContentKey } from "./curatedMediaSourcing";

const ASSET = 57488;
const KEY = curatedAssetContentKey(ASSET);
const FILE = `scene_1_b6_curated_a${ASSET}.mp4`;

/** Render 570's shape: the fetch found a real pick, and the render of the day refused it anyway. */
const bundleWithPick = (): ReplayBundle => ({
  meta: { kind: "meta", formatVersion: 1, videoId: 570, commit: "df2223e", recordedAt: "2026-09-06T00:00:00Z" },
  fetches: [
    {
      kind: "fetch",
      scene: 1,
      beat: 6,
      route: "curated_fetch",
      file: FILE,
      contentKey: KEY,
      pick: { assetId: ASSET, archiveName: "ww2", mediaType: "video", durationSec: 12, score: 9 },
    },
  ],
  visions: [{ kind: "vision", scene: 1, beat: 6, file: FILE, contentKey: KEY, verdict: "APPROVED", visionAvailable: true }],
  adoptions: [
    {
      kind: "adoption",
      scene: 1,
      beat: 6,
      route: "archive",
      eligible: false,
      vision: "APPROVED",
      visionAvailable: true,
      allowed: false,
      code: "FUNNEL_WITHOUT_EVIDENCE",
    },
  ],
});

/** The same render, for a clip the fetch produced with nothing behind it. */
const bundleWithoutPick = (): ReplayBundle => {
  const b = bundleWithPick();
  b.fetches[0]!.pick = null;
  return b;
};

/* ═════════ 1 — the replay contradicts the render, which is the whole point ═════════ */

describe("a recorded refusal can become an adoption", () => {
  it("opens a lineage record from the recorded pick", () => {
    const r = replayBundle(bundleWithPick());
    expect(r.lineageOpened).toBe(1);
    expect(r.fetchesWithoutPick).toBe(0);
  });

  it("recomputes eligibility rather than replaying the recorded flag", () => {
    const r = replayBundle(bundleWithPick());
    expect(r.eligibleBefore, "what the render recorded").toBe(0);
    expect(r.eligibleNow, "what today's code derives from the same facts").toBe(1);
  });

  it("RENDER 570'S CASE: refused then, adopted now", () => {
    const r = replayBundle(bundleWithPick());
    expect(r.recovered).toHaveLength(1);
    expect(r.recovered[0]!.before.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
    expect(r.recovered[0]!.after.allowed).toBe(true);
    expect(r.recovered[0]!.after.eligible).toBe(true);
  });

  it("and reports no regression", () => {
    expect(replayBundle(bundleWithPick()).lost).toHaveLength(0);
  });
});

/* ═════════ 2 — and it must NOT turn an unprovable clip green ═════════ */

describe("a clip with no pick stays refused", () => {
  it("opens no record for it", () => {
    const r = replayBundle(bundleWithoutPick());
    expect(r.lineageOpened).toBe(0);
    expect(r.fetchesWithoutPick).toBe(1);
  });

  it("stays ineligible and stays refused, approval or not", () => {
    const r = replayBundle(bundleWithoutPick());
    expect(r.eligibleNow).toBe(0);
    expect(r.recovered).toHaveLength(0);
    expect(r.decisions[0]!.after.allowed).toBe(false);
    expect(r.decisions[0]!.after.code).toBe("FUNNEL_WITHOUT_EVIDENCE");
  });
});

/* ═════════ 3 — the vision bar is not softened by replaying ═════════ */

describe("the vision requirement survives the round trip", () => {
  it.each(["REJECTED", "UNCLEAR", "NOT_ASKED"])("an eligible clip judged %s is still refused", (verdict) => {
    const b = bundleWithPick();
    b.visions[0]!.verdict = verdict;
    b.adoptions[0]!.vision = verdict;
    const r = replayBundle(b);
    expect(r.eligibleNow, "eligibility is recomputed regardless of the verdict").toBe(1);
    expect(r.decisions[0]!.after.allowed).toBe(false);
    expect(r.recovered).toHaveLength(0);
  });
});

/* ═════════ 4 — a regression is reported as one ═════════ */

describe("an adoption lost since the render is surfaced", () => {
  it("counts a then-allowed, now-refused decision as lost", () => {
    const b = bundleWithoutPick();
    /** The render of the day allowed it; today's code cannot, because nothing backs it. */
    b.adoptions[0]!.allowed = true;
    b.adoptions[0]!.code = null;
    b.adoptions[0]!.eligible = true;
    const r = replayBundle(b);
    expect(r.lost).toHaveLength(1);
    expect(r.recovered).toHaveLength(0);
  });

  it("names the regression before the win in the report", () => {
    const b = bundleWithoutPick();
    b.adoptions[0]!.allowed = true;
    b.adoptions[0]!.code = null;
    const text = formatReplayReport(b, replayBundle(b));
    expect(text).toContain("This is a regression");
  });
});

/* ═════════ 5 — REAL_FUNNEL is still the category the gates count ═════════ */

describe("the census still runs off the policy table", () => {
  it("archive is counted as a REAL_FUNNEL decision", () => {
    expect(realFunnelDecisions(replayBundle(bundleWithPick()))).toHaveLength(1);
  });

  it("a rescue route is not", () => {
    const b = bundleWithPick();
    b.adoptions[0]!.route = "rescue_archive";
    expect(realFunnelDecisions(replayBundle(b))).toHaveLength(0);
  });
});

/* ═════════ 6 — the bundle carries no secrets, by construction ═════════ */

describe("nothing a credential could hide in is recorded", () => {
  const shapes = Object.keys(bundleWithPick().fetches[0]!.pick!);

  it("a fetch fact carries only identity, never a URL", () => {
    expect(shapes).toEqual(["assetId", "archiveName", "mediaType", "durationSec", "score"]);
  });

  it.each(["storageUrl", "sourceUrl", "http", "token", "key="])("no %s anywhere in a bundle", (needle) => {
    expect(JSON.stringify(bundleWithPick())).not.toContain(needle);
  });

  it("the file is a basename, not a path", () => {
    expect(bundleWithPick().fetches[0]!.file).not.toContain("/");
  });
});

/* ═════════ 7 — recording is off unless asked for, and never breaks a render ═════════ */

describe("the recorder", () => {
  it("is off when the flag is unset", () => {
    expect(replayRecordingPath({})).toBeNull();
    expect(replayRecordingPath({ RENDER_REPLAY_BUNDLE: "/tmp/x.jsonl" })).toBeNull();
  });

  it("is off when the flag is on but no path was given", () => {
    expect(replayRecordingPath({ RENDER_REPLAY_RECORD: "true" })).toBeNull();
  });

  it("records a round trip through a real file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-"));
    const file = path.join(dir, "b.jsonl");
    try {
      expect(beginReplayRecording(571, "40547c9", { RENDER_REPLAY_RECORD: "true", RENDER_REPLAY_BUNDLE: file })).toBe(true);
      expect(replayRecordingActive()).toBe(true);
      recordReplayFact(bundleWithPick().fetches[0]!);
      recordReplayFact(bundleWithPick().visions[0]!);
      recordReplayFact(bundleWithPick().adoptions[0]!);
      const { bundle } = loadReplayBundle(file);
      expect(bundle.meta?.videoId).toBe(571);
      expect(bundle.fetches).toHaveLength(1);
      expect(replayBundle(bundle).recovered).toHaveLength(1);
    } finally {
      resetReplayRecordingForTest();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing when it was never begun", () => {
    resetReplayRecordingForTest();
    expect(replayRecordingActive()).toBe(false);
    expect(() => recordReplayFact(bundleWithPick().visions[0]!)).not.toThrow();
  });

  /** A render killed mid-write ends in half a line; that bundle is still worth reading. */
  it("skips a truncated final line instead of refusing the bundle", () => {
    const good = JSON.stringify(bundleWithPick().fetches[0]);
    const { bundle, skipped } = parseReplayBundle(`${good}\n{"kind":"fetch","sce`);
    expect(bundle.fetches).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});

/* ═════════ 8 — the report states what a replay cannot answer ═════════ */

describe("the scope note travels with the numbers", () => {
  it.each(["No fetching", "no compose", "not what"])("says %s", (phrase) => {
    expect(REPLAY_SCOPE_NOTE).toContain(phrase);
  });

  it("is printed on every report", () => {
    const b = bundleWithPick();
    expect(formatReplayReport(b, replayBundle(b))).toContain(REPLAY_SCOPE_NOTE);
  });
});
