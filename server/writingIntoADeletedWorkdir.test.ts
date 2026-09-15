/**
 * THE ENOENT WAS A WRITE INTO A DIRECTORY THE RENDER HAD ALREADY DELETED.
 *
 * Thirteen times across the production logs:
 *
 *     ENOENT: no such file or directory, open
 *       '/var/tmp/fastvid_<id>_<ts>/scene_2_webwide_0_tmp.jpg'
 *
 * That path is the render's own workDir, removed in the `finally` that ends a render. Nothing was
 * corrupt and no disk was full: the web-wide discovery loop was still running after the render it
 * belonged to had finished and cleaned up after itself.
 *
 * ── The two holes ───────────────────────────────────────────────────────────────────────────
 *
 * `withTimeout(fetch(...))` only RACES. `fetchWithTimeout`'s own comment says so, and records this
 * exact ENOENT as the failure it was written to stop: the caller moves on when the timer fires,
 * the fetch keeps running fully detached, and the write that follows it lands in a directory that
 * no longer exists.
 *
 * And the loop's `cancelled()` answers only "did the operator press cancel". A scope that timed
 * out, or a render that simply finished, is invisible to it — and that is the common case.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The web-wide discovery download, from the temp path it writes to the still it makes. */
const block = (): string => {
  const at = PIPE.indexOf("_webwide_${results.length}_tmp.jpg`)");
  expect(at, "the web-wide discovery download is gone").toBeGreaterThan(0);
  return PIPE.slice(at, PIPE.indexOf("stillImageToVideo(", at));
};

describe("1. the transfer can actually be cancelled", () => {
  /**
   * THE MECHANISM, not a new one. `fetchWithTimeout` joins the enclosing scene scope's
   * AbortController — the same signal `hardAbortScope()` already uses to kill orphaned children.
   */
  it("uses the scope-aware fetch, not a bare race", () => {
    const src = block();
    expect(src).toContain("await fetchWithTimeout(item.url,");
    expect(src, "a race leaves the transfer running after the caller has moved on")
      .not.toContain("withTimeout(fetch(item.url)");
  });

  /** The timeout it asks for is unchanged; this round changes what happens when it fires. */
  it("with the same ten seconds it always had", () => {
    expect(block()).toContain("10_000");
  });
});

describe("2. nothing is written to a directory that is gone", () => {
  /**
   * The check is the DIRECTORY, not a flag. `cancelled()` above reports operator cancellation and
   * nothing else — a scope that timed out and a render that finished normally both read as "not
   * cancelled", and both delete the workDir. The only question that matters here is whether there
   * is still somewhere to write to.
   */
  it("the workDir is checked before the write", () => {
    const src = block();
    const guardAt = src.indexOf("if (!fs.existsSync(workDir))");
    const writeAt = src.indexOf("fs.writeFileSync(tmpPath");
    expect(guardAt, "no workDir check before writing").toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(guardAt, "the check must come BEFORE the write").toBeLessThan(writeAt);
  });

  /**
   * AFTER the awaits, which is the whole point — a check taken before the network call proves
   * nothing about the directory ten seconds later, and ten seconds is exactly the window.
   */
  it("and after the awaits, not before them", () => {
    const src = block();
    expect(src.indexOf("if (!fs.existsSync(workDir))")).toBeGreaterThan(
      src.indexOf("await imgResp.arrayBuffer()")
    );
  });

  /** It stops the loop rather than skipping one item: the directory will not come back. */
  it("it breaks out rather than trying the next candidate", () => {
    const src = block();
    const at = src.indexOf("if (!fs.existsSync(workDir))");
    expect(src.slice(at, at + 400)).toContain("break;");
  });

  /** And says so, so an orphaned search is visible rather than merely absent from the output. */
  it("and says why it stopped", () => {
    const src = block();
    expect(src).toContain("outlived the render it belonged to");
  });
});
