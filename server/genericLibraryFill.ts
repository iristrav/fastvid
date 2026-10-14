/**
 * VIDEO 656 — THE GENERIC LIBRARY FILLS ITSELF.
 *
 * Render 655 put a 7.5 s colour field under a sentence because the rung above it — real generic
 * footage in the archive under the tag `generic` (genericFootageFallback.ts) — held nothing: the
 * docs asked an operator to upload a set by hand, and nobody had. The owner's choice (14 October):
 * fill it from Pexels and Pixabay.
 *
 * ── What goes in ────────────────────────────────────────────────────────────────────────────
 *
 * Rights-clear, non-specific moving pictures found with a fixed list of neutral searches (skies,
 * water, light, landscapes — never a person, place name or subject), landscape, HD, 8–40 s. Each
 * download is cut where the picture changes and only its longest single shot is kept, at least
 * `GENERIC_MIN_SHOT_SEC` long; it must move (freezedetect), and the archive's own intake then reads
 * it for on-screen text, decodability and storage read-back before the row is READY.
 *
 * It is stored ACTIVE in the "Generieke beelden" archive under the one tag `generic`, as
 * `mixKind: "stock"`, and the curated sourcing never reads that archive: these clips are offered
 * ONLY to a sentence nothing else could picture, just before the colour field. Pexels' and
 * Pixabay's licences allow commercial use without attribution; the licence and the page of every
 * clip are kept on its row.
 *
 * ── When ────────────────────────────────────────────────────────────────────────────────────
 *
 * In the worker, only while nothing renders, a few clips per round, until the library holds
 * `GENERIC_LIBRARY_TARGET` usable clips. Then each round is one count query and nothing else.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { GENERIC_ARCHIVE_TAG } from "./genericFootageFallback";

/** Enough to rotate through: one film rarely needs more than a few, and two films should differ. */
export const GENERIC_LIBRARY_TARGET = 15;
/** The shortest kept shot: a sentence typically needs 4–7 s and a shorter clip is passed over. */
export const GENERIC_MIN_SHOT_SEC = 6;
/** The source lengths asked for: long enough to hold one 6 s shot, short enough to download fast. */
export const GENERIC_SOURCE_MIN_SEC = 8;
export const GENERIC_SOURCE_MAX_SEC = 40;
/** Clips added per round, so a round never competes with a render that starts meanwhile. */
export const GENERIC_PER_ROUND = 3;
/** Never a download bigger than this. */
export const GENERIC_MAX_BYTES = 80 * 1024 * 1024;

/**
 * Neutral searches: nothing here names a person, a place, a brand, an event or a period, so no
 * result can contradict a sentence. Each is a picture that moves on its own.
 */
export const GENERIC_QUERIES: readonly string[] = [
  "clouds timelapse",
  "ocean waves",
  "forest aerial",
  "river flowing",
  "rain on window",
  "sunset sky",
  "city lights night bokeh",
  "snow falling",
  "fog landscape",
  "starry night sky",
  "wheat field wind",
  "desert sand dunes",
  "waterfall",
  "abstract light particles",
  "smoke slow motion",
  "mountain lake",
  "candle flame",
  "ink in water",
];

export type GenericProvider = "pexels" | "pixabay";

export type GenericStockCandidate = {
  provider: GenericProvider;
  id: string;
  pageUrl: string;
  downloadUrl: string;
  width: number;
  height: number;
  durationSec: number;
  creator?: string;
  query: string;
};

const LICENSE: Record<GenericProvider, { note: string; url: string }> = {
  pexels: { note: "Pexels License — free for commercial use, no attribution required", url: "https://www.pexels.com/license/" },
  pixabay: { note: "Pixabay Content License — free for commercial use, no attribution required", url: "https://pixabay.com/service/license-summary/" },
};

const usableShape = (w: number, h: number) => w >= 1280 && w > h;
const usableLength = (sec: number) => sec >= GENERIC_SOURCE_MIN_SEC && sec <= GENERIC_SOURCE_MAX_SEC;

type PexelsVideo = {
  id: number;
  url: string;
  duration: number;
  width: number;
  height: number;
  user?: { name?: string };
  video_files?: Array<{ width?: number | null; height?: number | null; link: string; file_type?: string }>;
};

/** Pexels search JSON → candidates: landscape, HD, 8–40 s, the mp4 file closest to 1920 wide. */
export function pexelsCandidates(json: { videos?: PexelsVideo[] } | null, query: string): GenericStockCandidate[] {
  const out: GenericStockCandidate[] = [];
  for (const v of json?.videos ?? []) {
    if (!usableLength(v.duration) || !usableShape(v.width, v.height)) continue;
    const files = (v.video_files ?? [])
      .filter((f) => (f.file_type ?? "video/mp4") === "video/mp4" && (f.width ?? 0) >= 1280 && (f.width ?? 0) <= 1920)
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const file = files[0];
    if (!file) continue;
    out.push({
      provider: "pexels",
      id: String(v.id),
      pageUrl: v.url,
      downloadUrl: file.link,
      width: file.width ?? v.width,
      height: file.height ?? v.height,
      durationSec: v.duration,
      ...(v.user?.name ? { creator: v.user.name } : {}),
      query,
    });
  }
  return out;
}

type PixabayHit = {
  id: number;
  pageURL: string;
  duration: number;
  user?: string;
  videos?: Partial<Record<"large" | "medium", { url?: string; width?: number; height?: number }>>;
};

/** Pixabay search JSON → candidates: landscape, HD, 8–40 s, the large file, else the medium one. */
export function pixabayCandidates(json: { hits?: PixabayHit[] } | null, query: string): GenericStockCandidate[] {
  const out: GenericStockCandidate[] = [];
  for (const h of json?.hits ?? []) {
    if (!usableLength(h.duration)) continue;
    const file = [h.videos?.large, h.videos?.medium].find(
      (f) => f?.url && usableShape(f.width ?? 0, f.height ?? 0) && (f.width ?? 0) <= 1920
    );
    if (!file?.url) continue;
    out.push({
      provider: "pixabay",
      id: String(h.id),
      pageUrl: h.pageURL,
      downloadUrl: file.url,
      width: file.width ?? 0,
      height: file.height ?? 0,
      durationSec: h.duration,
      ...(h.user ? { creator: h.user } : {}),
      query,
    });
  }
  return out;
}

/** The searches of one round, starting where `seed` points, so two workers do not ask the same. */
export function roundQueries(seed: number, count: number): string[] {
  const n = GENERIC_QUERIES.length;
  const start = ((Math.trunc(seed) % n) + n) % n;
  return Array.from({ length: Math.min(count, n) }, (_, i) => GENERIC_QUERIES[(start + i) % n]!);
}

/** The archive row for a kept shot. Its only tag is `generic`. */
export function genericClipMetadata(c: GenericStockCandidate, shotSec: number) {
  return {
    title: `Generiek beeld: ${c.query} (${c.provider} ${c.id})`,
    tags: [GENERIC_ARCHIVE_TAG],
    sourceNote: `${c.provider}:${c.id}`,
    mediaType: "video" as const,
    mimeType: "video/mp4",
    durationSec: Number(shotSec.toFixed(2)),
    licenseNote: LICENSE[c.provider].note,
    licenseUrl: LICENSE[c.provider].url,
    sourceUrl: c.pageUrl,
    sourcePlatform: c.provider,
    ...(c.creator ? { sourceCreator: c.creator } : {}),
    originalQuery: c.query,
    genericArchive: true,
    alreadyOneShot: true,
  };
}

export type GenericFillDeps = {
  /** Usable clips the library holds now (active, video, READY, tagged `generic`). */
  countLibrary: () => Promise<number>;
  /** Whether a provider asset is already in the archive (any status), so it is not fetched again. */
  known: (provider: GenericProvider, id: string) => Promise<boolean>;
  search: (provider: GenericProvider, query: string) => Promise<GenericStockCandidate[]>;
  download: (url: string, destPath: string) => Promise<boolean>;
  /** The longest single shot of at least `minSec`, written to `outPath`, or null with the reason. */
  bestShot: (inPath: string, outPath: string, minSec: number) => Promise<{ sec: number } | { refused: string }>;
  moving: (filePath: string) => Promise<boolean>;
  /** The archive intake (text, decodability, storage read-back, READY). Null asset id = refused. */
  store: (filePath: string, c: GenericStockCandidate, shotSec: number) => Promise<{ assetId: number | null; reason?: string }>;
  providers: GenericProvider[];
  isIdle: () => boolean;
  log?: (line: string) => void;
};

/** One round. Returns how many clips were added. Never throws. */
export async function fillGenericLibraryRound(deps: GenericFillDeps, seed: number): Promise<number> {
  const say = deps.log ?? ((l: string) => console.log(l));
  if (deps.providers.length === 0 || !deps.isIdle()) return 0;
  let have: number;
  try {
    have = await deps.countLibrary();
  } catch {
    return 0;
  }
  if (have >= GENERIC_LIBRARY_TARGET) return 0;
  const want = Math.min(GENERIC_PER_ROUND, GENERIC_LIBRARY_TARGET - have);
  say(`[GenericLibrary] ${have}/${GENERIC_LIBRARY_TARGET} usable generic clip(s) — adding up to ${want} from ${deps.providers.join(" + ")}`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-library-"));
  let added = 0;
  try {
    for (const query of roundQueries(seed, 3)) {
      for (const provider of deps.providers) {
        if (added >= want || !deps.isIdle()) return added;
        let candidates: GenericStockCandidate[] = [];
        try {
          candidates = await deps.search(provider, query);
        } catch (err) {
          say(`[GenericLibrary] ${provider} search "${query}" failed: ${(err as Error)?.message?.slice(0, 120)}`);
          continue;
        }
        for (const c of candidates) {
          if (added >= want || !deps.isIdle()) return added;
          if (await deps.known(c.provider, c.id).catch(() => true)) continue;
          const src = path.join(workDir, `${c.provider}_${c.id}.mp4`);
          const shot = path.join(workDir, `${c.provider}_${c.id}_shot.mp4`);
          const tag = `${c.provider} ${c.id} ("${c.query}")`;
          if (!(await deps.download(c.downloadUrl, src).catch(() => false))) {
            say(`[GenericLibrary] skipped ${tag} — download failed`);
            continue;
          }
          const best = await deps.bestShot(src, shot, GENERIC_MIN_SHOT_SEC).catch((e) => ({ refused: String(e).slice(0, 120) }));
          if ("refused" in best) {
            say(`[GenericLibrary] skipped ${tag} — ${best.refused}`);
            continue;
          }
          if (!(await deps.moving(shot).catch(() => false))) {
            say(`[GenericLibrary] skipped ${tag} — the picture does not move`);
            continue;
          }
          const stored = await deps.store(shot, c, best.sec).catch((e) => ({ assetId: null, reason: String(e).slice(0, 120) }));
          if (stored.assetId == null) {
            say(`[GenericLibrary] skipped ${tag} — the archive refused it: ${stored.reason ?? "no reason given"}`);
            continue;
          }
          added++;
          say(`[GenericLibrary] added ${tag} → archive asset ${stored.assetId}, ${best.sec.toFixed(1)}s, tag "${GENERIC_ARCHIVE_TAG}"`);
          for (const f of [src, shot]) fs.rmSync(f, { force: true });
        }
      }
    }
    return added;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/* ═══════════════════════ production wiring ═══════════════════════ */

/** The archive's shot rule: a stored shot is at most eleven seconds (archiveShotPieces.ts). */
const MAX_SHOT_SEC = 11;
/** How far a kept shot stays from a cut, so neither end holds the frame of another shot. */
const CUT_MARGIN_SEC = 0.25;

/** The longest stretch between cuts, clear of them, capped at the shot rule. Pure; tested. */
export function longestShot(
  durationSec: number,
  cutsSec: readonly number[]
): { startSec: number; endSec: number } | null {
  if (!(durationSec > 0)) return null;
  const cuts = [...new Set(cutsSec)].filter((c) => c > 0 && c < durationSec).sort((a, b) => a - b);
  const bounds = [0, ...cuts, durationSec];
  let best: { startSec: number; endSec: number } | null = null;
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]! > 0 ? bounds[i]! + CUT_MARGIN_SEC : 0;
    const end = bounds[i + 1]! < durationSec ? bounds[i + 1]! - CUT_MARGIN_SEC : durationSec;
    if (end - start > (best ? best.endSec - best.startSec : 0)) best = { startSec: start, endSec: end };
  }
  if (!best) return null;
  return { startSec: best.startSec, endSec: Math.min(best.endSec, best.startSec + MAX_SHOT_SEC) };
}

/** Provider assets this process already tried and could not use: not downloaded again until restart. */
const triedThisProcess = new Set<string>();

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  /** The status only: the URL carries the Pixabay key and is never printed. */
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function productionGenericFillDeps(isIdle: () => boolean): GenericFillDeps {
  const pexelsKey = process.env.PEXELS_API_KEY?.trim() ?? "";
  const pixabayKey = process.env.PIXABAY_API_KEY?.trim() ?? "";
  const download = async (url: string, destPath: string): Promise<boolean> => {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) return false;
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > GENERIC_MAX_BYTES) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > GENERIC_MAX_BYTES) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  };
  return {
    providers: [...(pexelsKey ? (["pexels"] as const) : []), ...(pixabayKey ? (["pixabay"] as const) : [])],
    isIdle,
    countLibrary: async () => {
      const { listActiveVideoArchiveAssetsByTag } = await import("./db");
      const rows = await listActiveVideoArchiveAssetsByTag(GENERIC_ARCHIVE_TAG, 200);
      return rows.filter((r) => (r.durationSec ?? 0) >= GENERIC_MIN_SHOT_SEC).length;
    },
    known: async (provider, id) => {
      if (triedThisProcess.has(`${provider}:${id}`)) return true;
      triedThisProcess.add(`${provider}:${id}`);
      const { findMediaArchiveAssetByProviderAsset } = await import("./db");
      return (await findMediaArchiveAssetByProviderAsset(provider, id)) != null;
    },
    search: async (provider, query) => {
      if (provider === "pexels") {
        const url =
          `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
          `&per_page=15&size=large&orientation=landscape`;
        return pexelsCandidates((await fetchJson(url, { Authorization: pexelsKey })) as never, query);
      }
      const url =
        `https://pixabay.com/api/videos/?key=${encodeURIComponent(pixabayKey)}&q=${encodeURIComponent(query)}` +
        `&per_page=20&video_type=film&min_width=1280&safesearch=true`;
      return pixabayCandidates((await fetchJson(url)) as never, query);
    },
    download,
    bestShot: async (inPath, outPath, minSec) => {
      const { productionLocalShotCutter } = await import("./archiveShotPieces");
      const cutter = await productionLocalShotCutter();
      const found = await cutter.detect(inPath);
      if (found.incomplete) return { refused: `the cut scan did not finish (${found.incomplete})` };
      const shot = longestShot(found.durationSec, found.cutsSec);
      if (!shot || shot.endSec - shot.startSec < minSec) {
        return { refused: `no single shot of ${minSec}s (${found.cutsSec.length} cut(s) in ${found.durationSec.toFixed(1)}s)` };
      }
      await cutter.extract(inPath, outPath, shot.startSec, shot.endSec);
      if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return { refused: "the shot could not be cut out" };
      return { sec: shot.endSec - shot.startSec };
    },
    moving: async (filePath) => {
      const [{ clipHasMotion }, { resolveFFmpegBin }] = await Promise.all([
        import("./genericFootageFallback"),
        import("./ffmpegBinary"),
      ]);
      return (await clipHasMotion(resolveFFmpegBin(), filePath)).moving;
    },
    store: async (filePath, c, shotSec) => {
      const { storeForProduction, productionArchiveDeps } = await import("./productionMediaArchive");
      const { ingestExternalClipToArchiveWithReason } = await import("./archiveIngestion");
      const deps = productionArchiveDeps({ download });
      const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "generic-verify-"));
      try {
        const outcome = await storeForProduction({
          localPath: filePath,
          provider: c.provider,
          providerAssetId: c.id,
          metadata: genericClipMetadata(c, shotSec),
          deps: {
            ...deps,
            /** Not a film's record: an ACTIVE row in the generic archive, stored as the one shot it is. */
            ingest: async (localPath, metadata) => {
              const o = await ingestExternalClipToArchiveWithReason(localPath, metadata);
              if (o.status !== "ingested") {
                const { status: _s, ...refusal } = o;
                return { refusal };
              }
              return { assetId: o.assetId, storageKey: o.storageKey, reused: o.reused };
            },
          },
          ctx: { provider: c.provider, providerAssetId: c.id },
          verifyDir,
        });
        return outcome.status === "stored"
          ? { assetId: outcome.archiveAssetId }
          : { assetId: null, reason: `${outcome.code}: ${outcome.message}` };
      } finally {
        fs.rmSync(verifyDir, { recursive: true, force: true });
      }
    },
  };
}

/** Every `everyMs`, while idle, one round. The first round waits `firstMs` so the worker can settle. */
export function startGenericLibraryFill(
  isIdle: () => boolean,
  opts: { everyMs?: number; firstMs?: number } = {}
): NodeJS.Timeout | null {
  const deps = productionGenericFillDeps(isIdle);
  if (deps.providers.length === 0) {
    console.log("[GenericLibrary] OFF — neither PEXELS_API_KEY nor PIXABAY_API_KEY is set");
    return null;
  }
  const everyMs = opts.everyMs ?? 5 * 60_000;
  let running = false;
  const round = async () => {
    if (running) return;
    running = true;
    try {
      const budget = await import("./_core/llmBudget");
      /** The archive's text check is background LLM work; it waits for the share like every sweep. */
      if ((await budget.isBackgroundLlmShareSpent()) || (await budget.isLlmBudgetExceeded())) return;
      await fillGenericLibraryRound(deps, process.pid + Math.floor(Date.now() / everyMs));
    } catch (err) {
      console.warn("[GenericLibrary] round failed:", (err as Error)?.message?.slice(0, 160));
    } finally {
      running = false;
    }
  };
  setTimeout(() => void round(), opts.firstMs ?? 2 * 60_000);
  console.log(
    `[GenericLibrary] ON — while idle, up to ${GENERIC_PER_ROUND} clip(s) every ${Math.round(everyMs / 60_000)} min ` +
      `from ${deps.providers.join(" + ")}, until ${GENERIC_LIBRARY_TARGET} usable generic clips`
  );
  return setInterval(() => void round(), everyMs);
}
