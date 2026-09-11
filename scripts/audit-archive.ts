/**
 * WHAT IS ACTUALLY IN THE ARCHIVE THE FILMS ARE MADE OF.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────
 *
 * A 76-second documentary about Berlin in 1945 spent 36.3 seconds — 47.6% — on a modern Brink's
 * armoured van, and the render's own report read:
 *
 *     [Quality] Video 577: score=43/100, clips=13 [ww2=13]
 *
 * Thirteen clips, every one from the archive named "WW2". The pipeline did nothing wrong: it was
 * told to use that archive and it did. The van is IN the archive.
 *
 * No gate, ranking, quota or budget in this codebase can repair that. A catalogue is the one
 * input the software cannot check for itself — it has no way to know that a security van is not
 * 1940s footage, because the archive is the definition of what the operator considers usable.
 *
 * So this does the only honest thing: it lays the archive out so a person can see it. Per asset —
 * id, title, media type, duration, tags, and where it came from — with a still extracted from the
 * middle of each video so the picture is visible rather than described.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────
 *
 * It deletes nothing and changes nothing. Deciding that a picture does not belong in a history
 * film is a judgement about the work, and this tool has no business making it. It produces a
 * contact sheet and a CSV; the operator marks what goes, and removes it through the admin.
 *
 *   npx tsx scripts/audit-archive.ts                 # every archive
 *   npx tsx scripts/audit-archive.ts --archive WW2   # one, by name
 *   npx tsx scripts/audit-archive.ts --out ./audit   # where the sheets land
 */
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { exec as execCb } from "child_process";

const exec = promisify(execCb);

type Row = {
  id: number;
  archive: string;
  title: string;
  mediaType: string;
  mixKind: string;
  durationSec: number | null;
  tags: string[];
  storageUrl: string;
  sourceNote: string | null;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** CSV that survives a title containing a comma, a quote or a newline. */
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main(): Promise<void> {
  const outDir = path.resolve(arg("out") ?? "archive-audit");
  const onlyArchive = arg("archive")?.trim().toLowerCase();
  fs.mkdirSync(outDir, { recursive: true });

  const { getDb } = await import("../server/db");
  const db = await getDb();
  if (!db) {
    console.error("[ArchiveAudit] no database connection — set the usual DB env and retry");
    process.exitCode = 1;
    return;
  }
  const { eq } = await import("drizzle-orm");
  const { mediaArchives, mediaArchiveAssets } = await import("../drizzle/schema");

  const joined = await db
    .select({
      id: mediaArchiveAssets.id,
      archive: mediaArchives.name,
      title: mediaArchiveAssets.title,
      mediaType: mediaArchiveAssets.mediaType,
      mixKind: mediaArchiveAssets.mixKind,
      tags: mediaArchiveAssets.tags,
      storageUrl: mediaArchiveAssets.storageUrl,
      sourceNote: mediaArchiveAssets.sourceNote,
    })
    .from(mediaArchiveAssets)
    .innerJoin(mediaArchives, eq(mediaArchiveAssets.archiveId, mediaArchives.id));

  const rows: Row[] = joined
    .filter((r) => !onlyArchive || (r.archive ?? "").toLowerCase() === onlyArchive)
    .map((r) => ({
      id: r.id,
      archive: r.archive ?? "",
      title: (r.title ?? "").trim(),
      mediaType: r.mediaType ?? "",
      mixKind: r.mixKind ?? "",
      durationSec: null,
      tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      storageUrl: r.storageUrl ?? "",
      sourceNote: r.sourceNote ?? null,
    }));

  if (rows.length === 0) {
    console.log("[ArchiveAudit] no assets matched");
    return;
  }
  console.log(`[ArchiveAudit] ${rows.length} asset(s) across ${new Set(rows.map((r) => r.archive)).size} archive(s)`);

  /**
   * One frame per asset, from the middle rather than the first frame: many clips open on black or
   * on a fade, and a contact sheet of black squares tells the reader nothing.
   */
  const shotDir = path.join(outDir, "frames");
  fs.mkdirSync(shotDir, { recursive: true });
  let grabbed = 0;
  for (const row of rows) {
    const out = path.join(shotDir, `a${row.id}.jpg`);
    if (fs.existsSync(out)) { grabbed++; continue; }
    try {
      if (row.mediaType === "image") {
        await exec(`ffmpeg -y -loglevel error -i "${row.storageUrl}" -vf scale=320:-1 -frames:v 1 "${out}"`, { timeout: 60_000 });
      } else {
        const probe = await exec(
          `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${row.storageUrl}"`,
          { timeout: 60_000 }
        );
        const dur = Number.parseFloat(String(probe.stdout).trim());
        row.durationSec = Number.isFinite(dur) ? Number(dur.toFixed(2)) : null;
        const at = Number.isFinite(dur) && dur > 2 ? (dur / 2).toFixed(2) : "0";
        await exec(
          `ffmpeg -y -loglevel error -ss ${at} -i "${row.storageUrl}" -vf scale=320:-1 -frames:v 1 "${out}"`,
          { timeout: 90_000 }
        );
      }
      grabbed++;
    } catch {
      /** An asset whose bytes cannot be read is itself worth seeing in the CSV — as a blank. */
    }
    if (grabbed % 25 === 0) console.log(`[ArchiveAudit] ${grabbed}/${rows.length} frames`);
  }

  const csvPath = path.join(outDir, "archive.csv");
  fs.writeFileSync(
    csvPath,
    ["id,archive,title,mediaType,mixKind,durationSec,tags,sourceNote,frame"]
      .concat(
        rows.map((r) =>
          [
            r.id, r.archive, r.title, r.mediaType, r.mixKind,
            r.durationSec ?? "", r.tags.join(" "), r.sourceNote ?? "",
            `frames/a${r.id}.jpg`,
          ].map(csvCell).join(",")
        )
      )
      .join("\n"),
    "utf8"
  );

  /** Contact sheets in blocks, so a thousand-asset archive is still openable. */
  const perSheet = 48;
  for (let i = 0; i < rows.length; i += perSheet) {
    const block = rows.slice(i, i + perSheet);
    const list = path.join(outDir, `sheet_${i / perSheet}.txt`);
    fs.writeFileSync(
      list,
      block
        .map((r) => `file '${path.join(shotDir, `a${r.id}.jpg`)}'`)
        .filter((_, n) => fs.existsSync(path.join(shotDir, `a${block[n]!.id}.jpg`)))
        .join("\n"),
      "utf8"
    );
    const sheet = path.join(outDir, `sheet_${i / perSheet}.jpg`);
    try {
      await exec(
        `ffmpeg -y -loglevel error -f concat -safe 0 -i "${list}" -vf "scale=320:180,tile=6x8" -frames:v 1 "${sheet}"`,
        { timeout: 120_000 }
      );
    } catch {
      /* a sheet that cannot be built is not worth failing the audit over */
    }
    fs.rmSync(list, { force: true });
  }

  console.log(`[ArchiveAudit] wrote ${csvPath}`);
  console.log(`[ArchiveAudit] contact sheets and ${grabbed} frame(s) in ${outDir}`);
  console.log(
    "[ArchiveAudit] nothing was changed. Open the sheets, note the ids that do not belong, " +
      "and remove those assets through the admin."
  );
}

main().catch((err) => {
  console.error("[ArchiveAudit] failed:", (err as Error).message);
  process.exitCode = 1;
});
