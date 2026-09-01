/**
 * RONDE 166 (§13) — Undo and Redo, on real timelines and real mutations.
 *
 * Every test below edits an actual `ProjectTimeline` the way the editor does — replacing a clip's
 * asset, changing a transform, a camera, an effect, a transition, a caption, a graphic, an audio
 * gain — and then undoes it. Nothing is mocked, because there is nothing to mock: the history holds
 * whole documents, so the test IS the mutation.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  formatHistory,
  newHistory,
  recordEdit,
  redo,
  sameEdit,
  undo,
} from "./timelineHistory";
import { emptyTimeline, timelineDigest, type ProjectTimeline } from "./projectTimeline";

/* ═══════════════════════ fixtures ═══════════════════════ */

function timeline(): ProjectTimeline {
  const t = emptyTimeline(1, { widthPx: 1920, heightPx: 1080, fps: 25 });
  t.durationSec = 8;
  const video = t.tracks.find((x) => x.kind === "VIDEO");
  if (video?.kind !== "VIDEO") throw new Error("no VIDEO track");
  video.clips.push({
    id: "c1", kind: "video",
    source: { provider: "wikimedia", providerAssetId: "aaa" },
    sourceIn: 0, sourceOut: 4, timelineStart: 0, timelineEnd: 4,
    motion: "none", transitionIn: "hard_cut", transitionOut: "hard_cut",
  } as never);
  return t;
}

/** A deep copy with one thing changed — the shape every editor mutation has. */
function edited(t: ProjectTimeline, mutate: (copy: ProjectTimeline) => void): ProjectTimeline {
  const copy = JSON.parse(JSON.stringify(t)) as ProjectTimeline;
  mutate(copy);
  copy.version = t.version + 1;
  return copy;
}

const firstClip = (t: ProjectTimeline) => {
  const track = t.tracks.find((x) => x.kind === "VIDEO");
  if (track?.kind !== "VIDEO") throw new Error("no VIDEO track");
  return track.clips[0]! as Record<string, unknown>;
};

/* ═══════════════════════ every mutation §13 names ═══════════════════════ */

describe("R166 §13 — undo restores the document for every kind of edit", () => {
  /**
   * One table rather than eight near-identical tests. Each entry is a real mutation of a real
   * timeline; the assertion is the same for all of them, which is exactly the point of holding
   * documents instead of per-mutation inverses.
   */
  const MUTATIONS: Array<[string, (t: ProjectTimeline) => void]> = [
    ["replace clip", (t) => { firstClip(t).source = { provider: "pexels", providerAssetId: "zzz" }; }],
    ["transform", (t) => { firstClip(t).transform = { fit: "cover", scale: 1.2 }; }],
    ["camera", (t) => { firstClip(t).camera = { type: "push_in", startScale: 1, endScale: 1.3 }; }],
    ["effects", (t) => { firstClip(t).effects = [{ effectType: "vignette", intensity: 0.5 }]; }],
    ["transition", (t) => { firstClip(t).transitionIn = "crossfade"; }],
    ["trim", (t) => { firstClip(t).sourceIn = 1.5; firstClip(t).sourceOut = 3.5; }],
    ["text", (t) => {
      const tr = t.tracks.find((x) => x.kind === "TEXT");
      if (tr?.kind === "TEXT") tr.texts.push({ id: "t1", text: "Apple Park", start: 0, end: 2 } as never);
    }],
    ["caption", (t) => {
      const tr = t.tracks.find((x) => x.kind === "CAPTIONS");
      if (tr?.kind === "CAPTIONS") tr.captions.push({ id: "cap1", text: "Narration", start: 0, end: 2 } as never);
    }],
    ["graphic", (t) => {
      const tr = t.tracks.find((x) => x.kind === "GRAPHICS");
      if (tr?.kind === "GRAPHICS") tr.graphics.push({ id: "g1", graphicType: "lower_third", label: "Tim Cook", data: {}, start: 0, end: 2 } as never);
    }],
    ["audio", (t) => {
      const tr = t.tracks.find((x) => x.kind === "MUSIC");
      if (tr?.kind === "MUSIC") tr.clips.push({ id: "m1", source: { provider: "freesound", providerAssetId: "1" }, start: 0, end: 4, gain: 0.3 });
    }],
    ["look", (t) => { t.look = { grade: "cinematic" }; }],
  ];

  for (const [name, mutate] of MUTATIONS) {
    it(`undoes a ${name} change`, () => {
      const before = timeline();
      const after = edited(before, mutate);
      /** The mutation must actually change the document, or the test proves nothing. */
      expect(timelineDigest(after), `${name} changed nothing`).not.toBe(timelineDigest(before));

      const h = recordEdit(newHistory(before), after);
      expect(sameEdit(h.present, after)).toBe(true);

      const back = undo(h);
      expect(sameEdit(back.present, before), `undo did not restore the ${name} change`).toBe(true);
    });

    it(`redoes a ${name} change`, () => {
      const before = timeline();
      const after = edited(before, mutate);
      const again = redo(undo(recordEdit(newHistory(before), after)));
      expect(sameEdit(again.present, after), `redo did not reapply the ${name} change`).toBe(true);
    });
  }
});

/* ═══════════════════════ the version rule ═══════════════════════ */

describe("R166 §13 — an undo is an edit, and takes the next version number", () => {
  /**
   * The subtlety this pins. Restoring version 3's CONTENT under version 3 would put two different
   * documents into circulation as "version 3", and `timeline.save` compares versions to detect a
   * concurrent edit — so it would see no conflict and let one overwrite the other in silence.
   */
  it("restores old content under a NEW version, never the old number", () => {
    const before = timeline();
    const after = edited(before, (t) => { t.look = { grade: "cinematic" }; });
    const back = undo(recordEdit(newHistory(before), after));

    expect(sameEdit(back.present, before), "the content is not the old one").toBe(true);
    expect(back.present.version, "an undo reused an old version number").toBeGreaterThan(after.version);
  });

  it("a redo also counts forward", () => {
    const before = timeline();
    const after = edited(before, (t) => { t.look = { grade: "cinematic" }; });
    const h = undo(recordEdit(newHistory(before), after));
    const again = redo(h);
    expect(again.present.version).toBeGreaterThan(h.present.version);
  });

  /** Versions never repeat across a whole undo/redo session. */
  it("no two documents in a session share a version number", () => {
    const before = timeline();
    let h = recordEdit(newHistory(before), edited(before, (t) => { t.look = { grade: "warm" }; }));
    const seen = [before.version, h.present.version];
    h = undo(h); seen.push(h.present.version);
    h = redo(h); seen.push(h.present.version);
    h = undo(h); seen.push(h.present.version);
    expect(new Set(seen).size, "a version number was reused").toBe(seen.length);
  });
});

/* ═══════════════════════ stack behaviour ═══════════════════════ */

describe("R166 §13 — the stack behaves the way an editor expects", () => {
  it("reports what is available", () => {
    const before = timeline();
    expect(canUndo(newHistory(before))).toBe(false);
    expect(canRedo(newHistory(before))).toBe(false);

    const h = recordEdit(newHistory(before), edited(before, (t) => { t.look = { grade: "warm" }; }));
    expect(canUndo(h)).toBe(true);
    expect(canRedo(h)).toBe(false);
    expect(canRedo(undo(h))).toBe(true);
  });

  it("undo at the beginning and redo at the end are no-ops, not errors", () => {
    const h = newHistory(timeline());
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  /**
   * A new edit abandons the redo stack. Keeping it would let a person undo, edit, then redo into a
   * document built from a branch they had already left — gaining changes they never made.
   */
  it("editing after an undo discards the abandoned future", () => {
    const before = timeline();
    const warm = edited(before, (t) => { t.look = { grade: "warm" }; });
    const cold = edited(before, (t) => { t.look = { grade: "cold" }; });

    const undone = undo(recordEdit(newHistory(before), warm));
    expect(canRedo(undone)).toBe(true);

    const branched = recordEdit(undone, cold);
    expect(canRedo(branched), "the abandoned redo survived a new edit").toBe(false);
    expect(sameEdit(branched.present, cold)).toBe(true);
  });

  /**
   * The editor saves on a schedule as well as on a change, so the same document arrives
   * repeatedly. Recording each one would fill the stack with steps that undo nothing.
   */
  it("saving the same edit twice does not add a step", () => {
    const before = timeline();
    const after = edited(before, (t) => { t.look = { grade: "warm" }; });
    const once = recordEdit(newHistory(before), after);
    /** Same content, later version — the version must not make it look like a new edit. */
    const twice = recordEdit(once, { ...after, version: after.version + 1 });
    expect(twice.past).toHaveLength(once.past.length);
    expect(twice).toBe(once);
  });

  it("keeps the stack bounded, dropping the oldest rather than refusing the newest", () => {
    let h = newHistory(timeline());
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      h = recordEdit(h, edited(h.present, (t) => { t.durationSec = 10 + i; }));
    }
    expect(h.past.length).toBe(MAX_HISTORY);
    /** The newest edit is still the present — the cap trims history, never the current document. */
    expect(h.present.durationSec).toBe(10 + MAX_HISTORY + 9);
  });

  /** Determinism: the same sequence of edits always produces the same document. */
  it("the same sequence of operations is deterministic", () => {
    const run = () => {
      const before = timeline();
      let h = recordEdit(newHistory(before), edited(before, (t) => { t.look = { grade: "warm" }; }));
      h = recordEdit(h, edited(h.present, (t) => { t.durationSec = 12; }));
      h = undo(h);
      h = redo(h);
      h = undo(h);
      return timelineDigest(h.present);
    };
    const first = run();
    for (let i = 0; i < 4; i++) expect(run()).toBe(first);
  });

  /** History never mutates what it was given — an editor holding the old object keeps it. */
  it("does not mutate the documents it is handed", () => {
    const before = timeline();
    const snapshot = JSON.stringify(before);
    const after = edited(before, (t) => { t.look = { grade: "warm" }; });
    redo(undo(recordEdit(newHistory(before), after)));
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("the log line carries counts and a digest, never the document", () => {
    const line = formatHistory(newHistory(timeline()));
    expect(line).toContain("[Editor] history");
    expect(line).toContain("undo=0");
    expect(line).not.toContain("providerAssetId");
    expect(line).not.toMatch(/https?:/);
  });
});

/* ═══════════════════════ the digest bug this work found ═══════════════════════ */

/**
 * RONDE 166 — `timelineDigest` omitted the LOOK.
 *
 * Its own contract is "two timelines with the same digest must render to the same picture", and
 * RONDE 160 §8 measured that they did not: the same tracks graded `warm` and graded `cold` differ
 * in every pixel, and both hashed identically. Anything using the digest to decide "same edit, no
 * need to re-render" would have treated a colour change as no change at all.
 *
 * It surfaced here because the history recognises an edit BY its digest, so an edit that changed
 * only the look was recorded as "nothing changed" and could not be undone.
 */
describe("R166 — the digest covers everything that changes the picture", () => {
  it("a look change changes the digest", () => {
    const t = timeline();
    const warm: ProjectTimeline = { ...t, look: { grade: "warm" } };
    const cold: ProjectTimeline = { ...t, look: { grade: "cold" } };
    expect(timelineDigest(warm)).not.toBe(timelineDigest(t));
    expect(timelineDigest(cold)).not.toBe(timelineDigest(warm));
  });

  it("a grade STRENGTH change changes the digest too", () => {
    const t = timeline();
    const full: ProjectTimeline = { ...t, look: { grade: "documentary", strength: 1 } };
    const half: ProjectTimeline = { ...t, look: { grade: "documentary", strength: 0.5 } };
    expect(timelineDigest(half)).not.toBe(timelineDigest(full));
  });

  /** And an edit that only changes the look is a real, undoable edit. */
  it("an edit that only changes the look can be undone", () => {
    const before = timeline();
    const after: ProjectTimeline = { ...before, look: { grade: "cinematic" }, version: before.version + 1 };
    const h = recordEdit(newHistory(before), after);
    expect(canUndo(h), "a look-only edit was recorded as no edit at all").toBe(true);
    expect(sameEdit(undo(h).present, before)).toBe(true);
  });

  /** The exclusions stay excluded: bumping a version still does not change the picture. */
  it("version, createdAt and the rendered URL still do not change the digest", () => {
    const t = timeline();
    const same: ProjectTimeline = {
      ...t,
      version: t.version + 9,
      createdAt: new Date(Date.now() + 60_000).toISOString(),
      renderedVideoUrl: "https://example.invalid/out.mp4",
    };
    expect(timelineDigest(same)).toBe(timelineDigest(t));
  });
});
