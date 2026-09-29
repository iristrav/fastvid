/**
 * Video 618 — the archive prepared every eligible candidate for a beat (download, trim, transcode)
 * and then kept only the best-scoring success: 22 clips were prepared and never looked at
 * (`DOWNLOADED_ASSET_NEVER_JUDGED`), six to eight per beat, in beats that then ran out of time.
 * Candidates are now prepared best-first in groups, stopping at the first group that yields a clip.
 * The winner — the best-scoring candidate that prepares — is the same as before.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { prepareInScoreOrder } from "./curatedMediaSourcing";

const pick = (id: number, score: number) => ({ id, score });

describe("Video 618 — archive candidates are prepared best-first, and only as far as needed", () => {
  it("the first group succeeds: the rest is never prepared", async () => {
    const tried: number[] = [];
    const eligible = [pick(1, 400), pick(2, 399), pick(3, 391), pick(4, 388), pick(5, 386), pick(6, 386), pick(7, 386), pick(8, 378)];
    const out = await prepareInScoreOrder(eligible, 4, async (p) => {
      tried.push(p.id);
      return `/w/a${p.id}.mp4`;
    });
    expect(tried.sort()).toEqual([1, 2, 3, 4]);
    /** The caller keeps the best of these, exactly as before. */
    expect(out.map((o) => o.picked.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it("a group that fails entirely moves on to the next — nothing that could win is skipped", async () => {
    const tried: number[] = [];
    const eligible = [pick(1, 400), pick(2, 399), pick(3, 391), pick(4, 388), pick(5, 386), pick(6, 380)];
    const out = await prepareInScoreOrder(eligible, 2, async (p) => {
      tried.push(p.id);
      return p.id >= 4 ? `/w/a${p.id}.mp4` : null;
    });
    expect(tried.sort()).toEqual([1, 2, 3, 4]);
    expect(out.map((o) => o.picked.id)).toEqual([4]);
  });

  it("the winner is the same as preparing everything: the best-scoring success", async () => {
    const eligible = [pick(1, 250), pick(2, 400), pick(3, 300), pick(4, 390), pick(5, 380), pick(6, 200)];
    const ok = (id: number) => id !== 2;
    const all = eligible.filter((p) => ok(p.id)).sort((a, b) => b.score - a.score)[0]!;
    const out = await prepareInScoreOrder(eligible, 2, async (p) => (ok(p.id) ? `/w/a${p.id}.mp4` : null));
    const best = [...out].sort((a, b) => b.picked.score - a.picked.score)[0]!;
    expect(best.picked.id).toBe(all.id);
  });

  it("nothing prepares: nothing is returned, and every candidate was tried", async () => {
    const tried: number[] = [];
    const out = await prepareInScoreOrder([pick(1, 3), pick(2, 2), pick(3, 1)], 2, async (p) => {
      tried.push(p.id);
      return null;
    });
    expect(out).toEqual([]);
    expect(tried.sort()).toEqual([1, 2, 3]);
  });

  it("wiring: the curated beat route uses it, and still keeps the best success and deletes the others", () => {
    const src = fs.readFileSync(path.join(__dirname, "curatedMediaSourcing.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function fetchCuratedArchiveBeatClip("), src.indexOf("export async function prepareInScoreOrder<"));
    expect(fn).toContain("const successes = await prepareInScoreOrder(eligible, parallelTries, tryPrepare);");
    expect(fn).toContain("successes.sort((a, b) => b.picked.score - a.picked.score);");
    expect(fn).toContain("if (fs.existsSync(alt.clipPath)) fs.unlinkSync(alt.clipPath);");
    expect(fn).not.toContain("eligible.map((picked) => parallelLimit(() => tryPrepare(picked)))");
  });
});
