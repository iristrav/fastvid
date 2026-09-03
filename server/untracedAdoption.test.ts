/**
 * P11 — ONE LINEAGE RECORD PER ASSET, AND A LOUD LINE WHEN THERE IS MORE THAN ONE.
 *
 * ── What the ledger already does ────────────────────────────────────────────────────────────
 *
 * `resolve` is generous before it gives up. It tries the exact path, then walks the derivation
 * chain registered by `linkDerivedPath`, then falls back to the content key stamped into the
 * filename by `tagPathWithProviderAsset`. A trimmed, padded, overlaid or fair-use-transformed copy
 * normally lands on its original's record through one of those three.
 *
 * ── When it does not, and why that matters ──────────────────────────────────────────────────
 *
 * Reaching the hole-filling branch means all three missed. The usual cause is a file written from
 * another file by a site that registered neither — `linkDerivedPath`'s own contract is "call it at
 * every site that writes a new file from an existing one", and a contract kept by convention is a
 * contract that drifts. One asset then becomes several records: one for the original, and one for
 * each copy, every copy carrying NO provider and counting into the UNVERIFIED bucket.
 *
 * That bucket has always been visible in `[AssetLifecycleAudit]`. WHICH clip, on WHICH route, was
 * not — so the number could be watched every render and never diagnosed. Render 555's eighteen
 * unexplained assets cost a production log and a whole round to trace back to a single cause.
 *
 * ── What is NOT changed ─────────────────────────────────────────────────────────────────────
 *
 * The record is still opened, and still opened with NO provider. Guessing one from the adopt-route
 * label is the exact mistake RONDE 87 exists to prevent: "rescue_wikimedia" is a route, not a
 * source, and turning it into one would make every hole a confident, wrong answer.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const src = () => fs.readFileSync(path.join(__dirname, "clipAdoptAudit.ts"), "utf8");

describe("an adoption that cannot be traced says so", () => {
  it("warns, naming the clip, the beat and the route", () => {
    const s = src();
    expect(s).toContain("UNTRACED_ADOPTION");
    expect(s).toContain("route=${route}");
    expect(s).toContain("clip=${path.basename(clipPath)}");
  });

  /** The message has to say what was tried, or the reader cannot tell it from "no ledger at all". */
  it("says which three lookups missed", () => {
    const s = src();
    expect(s).toContain("derivation chain or its content key");
  });

  /**
   * A render whose lineage collapsed would otherwise emit one line per clip and bury everything
   * else in its own log. After the cap the count still grows and the audit's bucket stays the
   * authority on the total.
   */
  it("names a few and then only counts", () => {
    const s = src();
    expect(s).toContain("const UNTRACED_TO_NAME = 5;");
    expect(s).toContain("seen <= UNTRACED_TO_NAME");
    expect(s).toContain("seen === UNTRACED_TO_NAME + 1");
    expect(s).toContain("further occurrences are counted, not named");
  });

  /**
   * Scoped to the render, not the module. `MAX_CONCURRENT_RENDERS` can exceed one, and a counter on
   * the module would make two renders share a budget — the same seam this codebase keeps finding.
   */
  it("counts per render, not per process", () => {
    const s = src();
    expect(s).toContain("const untracedByAudit = new WeakMap<ClipAdoptEntry[], number>();");
    expect(s).toContain("untracedByAudit.get(audit)");
    expect(s).toContain("untracedByAudit.set(audit, seen)");
  });

  /**
   * The warning is an addition, not a replacement. The record still has to be opened or the clip
   * disappears from `reconcile()` entirely, which is worse than being unprovable.
   */
  it("still opens the record", () => {
    const s = src();
    const at = s.indexOf("UNTRACED_ADOPTION");
    const after = s.slice(at, s.indexOf("audit.push(entry)", at));
    expect(after).toContain("ledger.createLineage({");
    expect(after).toContain('"ADOPTED"');
  });

  /** And still without a provider. A route label is not a source. */
  it("does not invent a provider from the adopt route", () => {
    const s = src();
    const at = s.indexOf("const created = ledger.createLineage({");
    const call = s.slice(at, s.indexOf("});", at));
    expect(call).toContain("sourceLabel: source");
    expect(call).not.toContain("provider:");
  });

  /**
   * The warning must not fire for the ordinary case — a clip the ledger DOES know. That branch
   * returns before reaching it.
   */
  it("is on the branch where resolve found nothing", () => {
    const s = src();
    const resolved = s.indexOf("const record = ledger.resolve(clipPath);");
    const warn = s.indexOf("UNTRACED_ADOPTION");
    const elseAt = s.indexOf("} else {", resolved);
    expect(elseAt).toBeGreaterThan(resolved);
    expect(warn).toBeGreaterThan(elseAt);
  });
});
