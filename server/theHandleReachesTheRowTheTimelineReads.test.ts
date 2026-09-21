/**
 * THE HANDLE REACHES THE ROW THE TIMELINE READS.
 *
 * ── Render 595's unexplained clip ───────────────────────────────────────────────────────────
 *
 *     internet_archive:youtube-r6LB5toWr5I — clip vc_999c384232, 48.30s, the longest in the film
 *     archiveAssetId=null · rehydratable=true · NO ARCHIVE_STORE_START anywhere in the log
 *
 * Adopted, used, delivered to the planner — and never offered to the archive at all. Not refused:
 * never asked. `ensureArchiveBackedBeforePush` runs at the one boundary every picture crosses, so
 * "no ARCHIVE_STORE_START" means the gate took an exemption.
 *
 * ── The two rows ────────────────────────────────────────────────────────────────────────────
 *
 * The gate resolves the clip's record and then walks to its ROOT, because the provider identity
 * lives there — a trim, an extension or a fair-use transform inherits it from the file it was made
 * from. It reads `root.archiveAssetId != null` and answers `already_archived`.
 *
 * The cinematic planner does not walk. It reads the record AT THE PATH and builds the timeline
 * identity from that row's `archiveAssetId`.
 *
 *     gate     rootOf(record).archiveAssetId   → 57743, exempt, store nothing
 *     planner  resolve(clipPath).archiveAssetId → null,  timeline says the clip is unheld
 *
 * `linkDerivedPath` copies the parent's handle when the derived record is CREATED. A root archived
 * AFTER that — on an earlier beat's push, or reused by checksum — never reaches its children. The
 * answer was computed on one row and consumed from another: this codebase's signature defect,
 * arriving one more time.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { VisualSourceLedger } from "./visualSourceLineage";

const PIPE = readFileSync(join(__dirname, "videoPipeline.ts"), "utf8");

/** The body of one function, by brace matching from its declaration. */
function bodyOf(src: string, decl: string): string {
  const at = src.indexOf(decl);
  if (at < 0) return "";
  let depth = 0;
  for (let n = src.indexOf("{", at); n < src.length; n++) {
    if (src[n] === "{") depth++;
    else if (src[n] === "}" && --depth === 0) return src.slice(at, n + 1);
  }
  return src.slice(at);
}

/* ═══════════════════ THE LEDGER'S OWN BEHAVIOUR ═══════════════════ */

describe("a root archived after its child was made", () => {
  /** The shape render 595 produced: original downloaded, derived file written, THEN archived. */
  function ledgerWithLateArchive() {
    const lineage = new VisualSourceLedger({ renderId: "r596" });
    const original = "/w/ia_youtube-r6LB5toWr5I.mp4";
    const derived = "/w/extend_s2b3_ia.mp4";
    lineage.createLineage({
      sceneIndex: 2, beatIndex: 3,
      candidateId: "internet_archive:youtube-r6LB5toWr5I",
      contentKey: "ck_original",
      localPath: original,
      provider: "internet_archive",
      providerAssetId: "youtube-r6LB5toWr5I",
    });
    /** An EXTENSION, which is what `extend_s2b3_*` is, and both files stay live. */
    lineage.linkDerivedPath(derived, original, "PADDED", { supersedesParent: false });
    return { lineage, original, derived };
  }

  it("REPRODUCES THE GAP — the child's row is empty while the root's is filled", () => {
    const { lineage, original, derived } = ledgerWithLateArchive();
    const root = lineage.resolve(original)!;
    lineage.attachArchiveAsset(root, 57743);

    expect(lineage.resolve(original)?.archiveAssetId).toBe(57743);
    /**
     * This is the null the planner read and put on the timeline. The clip's bytes came from an
     * asset FastVid holds, and the film said it held nothing.
     */
    expect(lineage.resolve(derived)?.archiveAssetId).toBeUndefined();
  });

  it("and the child still carries the root's PROVIDER, which is why the two disagreed", () => {
    /**
     * The identity looked complete — `internet_archive` + the id, both inherited at creation — so
     * nothing downstream had any reason to doubt it. Only the handle was missing.
     */
    const { lineage, derived } = ledgerWithLateArchive();
    const record = lineage.resolve(derived);
    expect(record?.provider).toBe("internet_archive");
    expect(record?.providerAssetId).toBe("youtube-r6LB5toWr5I");
  });

  it("THE HANDLE THE GATE READS CAN BE WRITTEN WHERE THE TIMELINE READS IT", () => {
    const { lineage, original, derived } = ledgerWithLateArchive();
    lineage.attachArchiveAsset(lineage.resolve(original)!, 57743);

    const record = lineage.resolve(derived)!;
    const root = lineage.rootOf(record.lineageId)!;
    expect(root.archiveAssetId).toBe(57743);
    lineage.attachArchiveAsset(record, root.archiveAssetId!);

    expect(lineage.resolve(derived)?.archiveAssetId).toBe(57743);
  });

  it("A HANDLE ALREADY ON THE ROW IS NEVER OVERWRITTEN", () => {
    /**
     * `attachArchiveAsset` fills and never replaces. A clip stored in its own right keeps its own
     * asset rather than being relabelled with its parent's, which would make two different files
     * point at one row.
     */
    const { lineage, original, derived } = ledgerWithLateArchive();
    lineage.attachArchiveAsset(lineage.resolve(original)!, 57743);
    lineage.attachArchiveAsset(lineage.resolve(derived)!, 57770);
    lineage.attachArchiveAsset(lineage.resolve(derived)!, 57743);
    expect(lineage.resolve(derived)?.archiveAssetId).toBe(57770);
  });

  it("the ordinary case is unchanged — a child made AFTER the archiving inherits as it always did", () => {
    const lineage = new VisualSourceLedger({ renderId: "r596" });
    const original = "/w/ia_original.mp4";
    lineage.createLineage({
      sceneIndex: 0, beatIndex: 0,
      candidateId: "internet_archive:abc",
      contentKey: "ck_o2",
      localPath: original,
      provider: "internet_archive",
      providerAssetId: "abc",
    });
    lineage.attachArchiveAsset(lineage.resolve(original)!, 999);
    lineage.linkDerivedPath("/w/trim.mp4", original, "TRIMMED");
    expect(lineage.resolve("/w/trim.mp4")?.archiveAssetId).toBe(999);
  });
});

/* ═══════════════════ THE GATE DOES IT ═══════════════════ */

describe("the exemption carries the handle it read", () => {
  const FN = bodyOf(PIPE, "async function ensureArchiveBackedBeforePush(");

  it("THE ALREADY_ARCHIVED BRANCH WRITES THE ROOT'S HANDLE ONTO THE RECORD", () => {
    expect(FN, "ensureArchiveBackedBeforePush is gone").not.toBe("");
    /**
     * The exact conditional, not merely the name. A mutation proved that a presence check passes
     * while the branch is switched off.
     */
    expect(FN).toContain("if (record && record.archiveAssetId == null && ledger) {");
    expect(FN).toContain("const attached = ledger.attachArchiveAsset(record, root.archiveAssetId);");
    expect(FN).toContain("ARCHIVE_HANDLE_INHERITED");
  });

  it("IT IS THE RECORD AT THE PATH, NOT THE ROOT — that is the whole defect", () => {
    /**
     * Attaching to the root again would change nothing: the root already has the handle, and the
     * planner never reads it. The row that must be written is the one `lineage.resolve(clipPath,
     * clipContentKey(clipPath))` returns.
     */
    expect(FN).not.toContain("attachArchiveAsset(root,");
    expect(PIPE).toContain("const record = lineage.resolve(clipPath, clipContentKey(clipPath));");
  });

  it("AND NOTHING IS STORED ON THIS BRANCH — no second ingestion of the same footage", () => {
    /**
     * §14 deduplicates by checksum and by provider asset precisely so one piece of footage has one
     * row. Re-ingesting the trim would defeat that, and the exemption exists because the asset is
     * already held.
     */
    const branch = FN.slice(
      FN.indexOf("if (root.archiveAssetId != null) {"),
      FN.indexOf('return { ok: true, reason: "already_archived" };')
    );
    expect(branch).not.toContain("storeExternalClipForTimeline");
    expect(branch).not.toContain("deps.ingest");
  });

  it("the four exemptions and the refusal are otherwise exactly as they were", () => {
    /** §11 — the archive-first invariant itself was not reopened by this round. */
    expect(FN).toContain('if (!root || !provider) return { ok: true, reason: "not_external" };');
    expect(FN).toContain(
      'if (!sourceMayEnterCuratedArchive(provider)) return { ok: true, reason: "exempt_source" };'
    );
    expect(FN).toContain(
      'if (!externalAssetIngestionEnabled()) return { ok: true, reason: "ingestion_stopped" };'
    );
    expect(FN).toContain('if (stored.status === "stored") return { ok: true, reason: "stored" };');
    expect(FN).toContain("return { ok: false, reason: `${stored.code}:${stored.mediaStatus}` };");
  });

  it("and a STORED clip still writes its handle to the same row", () => {
    /**
     * The other half of the same rule, which was already right: `storeExternalClipForTimeline`
     * attaches BY PATH. Asserted here so the two halves cannot drift apart.
     */
    expect(PIPE).toContain(
      "const attached = params.lineage?.attachArchiveAssetToPath(\n      clipPath, stored.archiveAssetId, clipContentKey(clipPath)\n    );"
    );
  });
});
