/**
 * VIDEO 659 (fix F) — A FREESOUND SOUND THAT CANNOT BE HAD: ITS CATALOGUE ALTERNATIVE, OR ONLY THAT SOUND SKIPPED.
 *
 * Job 66 planned the background wind `freesound:459931` ("Gentle wind" / "Wind drone footage");
 * Freesound removed that recording, and every render since job 27 logged it UNRESOLVED and played the
 * moment without it. The catalogue (`cinematicAudio/catalog.ts`) holds other recordings of the same
 * category, in the order the planner already chooses from. So: the planned sound first; when it
 * cannot be resolved or downloaded, the other recordings of ITS category, in catalogue order, minus
 * any Freesound already said is gone; when none works, only this one sound is left out. The picture,
 * the voice, the music and every other sound go on untouched, and nothing waits on a sound known gone.
 */
import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import type { AssetSourceIdentity } from "./projectTimeline";

export type FreesoundAlternative = { freesoundId: number; label: string; category: string };

/**
 * The other recordings for this sound, in catalogue order. The category whose label matches the
 * clip's title comes first (459931 is both "Gentle wind" in `wind` and "Wind drone footage" in
 * `drone_wind`); then every other category that lists the same recording.
 */
export function freesoundAlternatives(freesoundId: number, title?: string | null): FreesoundAlternative[] {
  const owning = Object.entries(SOUND_CATALOG).filter(([, variants]) => variants.some((v) => v.freesoundId === freesoundId));
  const byTitle = (variants: (typeof owning)[number][1]) => (title ? variants.some((v) => v.freesoundId === freesoundId && v.label === title) : false);
  const ordered = [...owning.filter(([, v]) => byTitle(v)), ...owning.filter(([, v]) => !byTitle(v))];
  const out: FreesoundAlternative[] = [];
  for (const [category, variants] of ordered) {
    for (const v of variants) {
      if (v.freesoundId === freesoundId || out.some((o) => o.freesoundId === v.freesoundId)) continue;
      out.push({ freesoundId: v.freesoundId, label: v.label, category });
    }
  }
  return out;
}

export type FreesoundFetchDeps = {
  /** The render's own resolver (`providerResolver`): identity → preview URL, or a refusal. */
  resolve: (source: AssetSourceIdentity) => Promise<{ ok: true; url: string } | { ok: false; code: string; message?: string } | boolean | null | undefined>;
  download: (url: string, dest: string) => Promise<boolean>;
  isGone: (freesoundId: number) => boolean;
  log: (line: string) => void;
};

/**
 * The file for one Freesound clip: the planned recording, else the first alternative that resolves
 * and downloads, else null (this sound only is skipped). Every step is logged with its outcome.
 */
export async function fetchFreesoundClip(
  clip: { id: string; source: AssetSourceIdentity },
  dest: string,
  deps: FreesoundFetchDeps,
  jobId: number | string
): Promise<{ file: string; freesoundId: number; substituted: boolean } | null> {
  const planned = Number(clip.source.providerAssetId);
  const attempt = async (id: number): Promise<string> => {
    if (deps.isGone(id)) return "gone (Freesound removed it; not asked again)";
    const resolved = await deps.resolve({ ...clip.source, provider: "freesound", providerAssetId: String(id) }).catch(() => null);
    if (!resolved || typeof resolved === "boolean" || !resolved.ok) {
      return `unresolved (${resolved && typeof resolved === "object" && !resolved.ok ? resolved.code : "no_resolver"})`;
    }
    if (!(await deps.download(resolved.url, dest).catch(() => false))) return "download failed";
    return "ok";
  };
  const first = await attempt(planned);
  if (first === "ok") return { file: dest, freesoundId: planned, substituted: false };
  deps.log(`[Audio] job=${jobId} clip=${clip.id} status=UNRESOLVED provider=freesound asset=${planned} reason=${first}`);
  for (const alt of freesoundAlternatives(planned, clip.source.title)) {
    const got = await attempt(alt.freesoundId);
    if (got === "ok") {
      deps.log(
        `[Audio] job=${jobId} clip=${clip.id} freesound=${planned} → alternative ${alt.freesoundId} ` +
          `("${alt.label}", category ${alt.category}, catalogue order)`
      );
      return { file: dest, freesoundId: alt.freesoundId, substituted: true };
    }
    deps.log(`[Audio] job=${jobId} clip=${clip.id} alternative ${alt.freesoundId} ("${alt.label}") — ${got}`);
  }
  deps.log(`[Audio] job=${jobId} clip=${clip.id} status=SKIPPED asset=${planned} — no working recording; only this sound is left out`);
  return null;
}
