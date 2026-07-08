/**
 * Clip Annotation Backfill — standalone script.
 *
 * Analyseert alle actieve archive-assets zonder (of met verouderde) annotatie.
 * Resumable via backfill_cursors tabel — veilig te herstarten na crash.
 *
 * Activeren:
 *   CLIP_ANNOTATION_BACKFILL=true npx tsx server/clipAnnotationBackfill.ts
 *
 * Of via package.json script (toe te voegen):
 *   "annotate-archive": "CLIP_ANNOTATION_BACKFILL=true tsx server/clipAnnotationBackfill.ts"
 *
 * Aanpak:
 *  - Pagineren over media_archive_assets (isActive=1) op id asc
 *  - Sla assets over met annotationVersion === huidige versie
 *  - Max CONCURRENCY parallelle LLM-aanroepen tegelijk
 *  - Schrijft annotationJson + editorialScore + annotationVersion terug
 *  - Cursor wordt na elke batch opgeslagen → herstart begint na laatste verwerkte id
 */

import pLimit from "p-limit";
import { listActiveMediaArchiveAssetsBatch, getBackfillCursor, setBackfillCursor, getDb } from "./db";
import { annotateAsset, ANNOTATION_VERSION } from "./clipAnnotator";
import { mediaArchiveAssets } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const PAGE_SIZE = 50;
const CONCURRENCY = 4;
const JOB_NAME = "clip_annotation_backfill";
const PROVIDER = "llm";
const MODEL = "groq";

function requireEnabled(): void {
  if (process.env.CLIP_ANNOTATION_BACKFILL !== "true") {
    console.error(
      "[AnnotationBackfill] Geweigerd: CLIP_ANNOTATION_BACKFILL is niet 'true'.\n" +
        "Dit is een standalone script — nooit automatisch starten vanuit workers.\n" +
        "Activeer expliciet:\n" +
        "  CLIP_ANNOTATION_BACKFILL=true npx tsx server/clipAnnotationBackfill.ts"
    );
    process.exitCode = 1;
    throw new Error("annotation-backfill: uitgeschakeld. Stel CLIP_ANNOTATION_BACKFILL=true in.");
  }
}

async function saveAnnotation(assetId: number, annotation: Awaited<ReturnType<typeof annotateAsset>>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB niet beschikbaar");
  await db
    .update(mediaArchiveAssets)
    .set({
      annotationJson: annotation,
      editorialScore: annotation.editorialScore.total,
      annotationVersion: ANNOTATION_VERSION,
    })
    .where(eq(mediaArchiveAssets.id, assetId));
}

async function run(): Promise<void> {
  requireEnabled();

  const cursor = await getBackfillCursor(JOB_NAME, PROVIDER, MODEL, ANNOTATION_VERSION);
  console.log(
    `[AnnotationBackfill] Start — versie ${ANNOTATION_VERSION}, cursor ${cursor}, concurrency ${CONCURRENCY}`
  );

  const limit = pLimit(CONCURRENCY);
  let afterId = cursor;
  let totalProcessed = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  const startMs = Date.now();

  while (true) {
    const batch = await listActiveMediaArchiveAssetsBatch(afterId, PAGE_SIZE);
    if (batch.length === 0) break;

    const tasks = batch.map((asset) =>
      limit(async () => {
        // Skip als al geannoteerd met huidige versie
        if (asset.annotationVersion === ANNOTATION_VERSION) {
          totalSkipped++;
          return;
        }

        try {
          const annotation = await annotateAsset(asset);
          await saveAnnotation(asset.id, annotation);
          totalProcessed++;
          if (totalProcessed % 10 === 0) {
            console.log(
              `[AnnotationBackfill] ${totalProcessed} verwerkt, ${totalSkipped} overgeslagen, ` +
                `${totalFailed} mislukt — laatste id ${asset.id}`
            );
          }
        } catch (err) {
          totalFailed++;
          console.warn(
            `[AnnotationBackfill] Asset ${asset.id} mislukt:`,
            (err as Error).message?.slice(0, 80)
          );
        }
      })
    );

    await Promise.all(tasks);

    const lastId = batch[batch.length - 1]!.id;
    afterId = lastId;
    await setBackfillCursor(JOB_NAME, PROVIDER, MODEL, ANNOTATION_VERSION, lastId);

    if (batch.length < PAGE_SIZE) break;
  }

  const elapsedSec = Math.round((Date.now() - startMs) / 1000);
  console.log(
    `[AnnotationBackfill] Klaar in ${elapsedSec}s — ` +
      `${totalProcessed} geannoteerd, ${totalSkipped} overgeslagen, ${totalFailed} mislukt`
  );
}

run().catch((err) => {
  console.error("[AnnotationBackfill] Fatale fout:", err);
  process.exitCode = 1;
});
