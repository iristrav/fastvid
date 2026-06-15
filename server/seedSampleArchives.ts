import { SAMPLE_MEDIA_ARCHIVES } from "@shared/sampleMediaArchives";
import {
  createMediaArchiveUnique,
  getMediaArchiveBySlug,
  normalizeMediaTags,
  slugifyArchiveName,
} from "./db";

export async function seedSampleMediaArchives(
  createdByUserId?: number
): Promise<{ created: number; skipped: number; names: string[] }> {
  let created = 0;
  let skipped = 0;
  const names: string[] = [];

  for (const sample of SAMPLE_MEDIA_ARCHIVES) {
    const slug = slugifyArchiveName(sample.name);
    const existing = await getMediaArchiveBySlug(slug);
    if (existing) {
      skipped++;
      continue;
    }

    const id = await createMediaArchiveUnique({
      name: sample.name,
      slugBase: sample.name,
      description: sample.description,
      nicheTags: normalizeMediaTags(sample.nicheTags),
      createdByUserId: createdByUserId ?? null,
      isActive: 1,
    });

    if (id) {
      created++;
      names.push(sample.name);
    }
  }

  return { created, skipped, names };
}
