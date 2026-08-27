/**
 * Browse, preview, multi-select and delete media archive clips.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import {
  Loader2, Trash2, Pencil, Search, Film, Image as ImageIcon, X, Play, ExternalLink, CheckSquare, Square, Sparkles, Copy, AlertTriangle, ChevronLeft, ChevronRight, ScanSearch, Ban, Scissors,
} from "lucide-react";

const CLIPS_PAGE_SIZE = 48;
const LIST_ASSETS_PAGE = 200;

async function fetchAllArchiveAssetIds(
  fetchPage: (input: {
    archiveId: number;
    search?: string;
    limit: number;
    offset: number;
  }) => Promise<{ items: { id: number; mediaType?: string }[]; total: number }>,
  archiveId: number,
  search?: string,
  filter?: (item: { id: number; mediaType?: string }) => boolean,
): Promise<number[]> {
  const ids: number[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const batch = await fetchPage({
      archiveId,
      search: search || undefined,
      limit: LIST_ASSETS_PAGE,
      offset,
    });
    total = batch.total;
    for (const item of batch.items) {
      if (!filter || filter(item)) ids.push(item.id);
    }
    offset += batch.items.length;
    if (batch.items.length === 0) break;
  }
  return ids;
}

const MIX_KINDS = [
  { value: "real_video", label: "Real video" },
  { value: "photo", label: "Photo" },
  { value: "stock", label: "Stock" },
  { value: "screenshot", label: "Screenshot" },
  { value: "motion_graphics", label: "Motion graphics" },
] as const;

type MixKind = typeof MIX_KINDS[number]["value"];

type ArchiveAsset = {
  id: number;
  title?: string | null;
  mediaType: "video" | "image";
  mixKind: MixKind;
  storageUrl: string;
  tags?: string[] | null;
  sourceNote?: string | null;
  durationSec?: number | null;
  mediaAvailable?: boolean;
  browserPlayable?: boolean;
  mediaIssue?: "missing" | "unsupported_format" | null;
};

type SceneAuditEntry = {
  assetId: number;
  status:
    | "single_scene"
    | "multi_scene"
    | "skipped_image"
    | "file_missing"
    | "download_failed"
    | "analyze_failed";
  sceneCount: number;
  interiorCutCount: number;
  durationSec?: number;
  cutTimesSec?: number[];
};

function sceneAuditLabel(entry?: SceneAuditEntry): string | null {
  if (!entry) return null;
  if (entry.status === "single_scene") return "1 scène";
  if (entry.status === "multi_scene") return `${entry.sceneCount} scènes`;
  if (entry.status === "file_missing") return "Bestand ontbreekt";
  if (entry.status === "download_failed") return "Download mislukt";
  if (entry.status === "analyze_failed") return "Check mislukt";
  return null;
}

function parseTagsInput(raw: string): string[] {
  return raw.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
}

function tagsToInput(tags: string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}

function formatDuration(sec?: number | null): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function describeAutoTitleOutcome(result: {
  updated: number;
  skipped: number;
  failed: number;
  skipReasons?: {
    missingAsset: number;
    fileMissing: number;
    downloadFailed: number;
    noFrames: number;
    noVision: number;
    llmFailed: number;
  };
  sampleError?: string;
  sampleUpdate?: { assetId: number; title: string; tags: string[] };
}): string {
  const { skipReasons } = result;
  if (!skipReasons) {
    return result.skipped + result.failed > 0
      ? `${result.skipped} skipped, ${result.failed} failed`
      : "";
  }

  const parts: string[] = [];
  if (skipReasons.fileMissing > 0) {
    parts.push(
      `${skipReasons.fileMissing} clip file(s) missing on the server — attach a Railway volume, migrate to S3/R2, or re-upload`
    );
  }
  if (skipReasons.downloadFailed > 0) {
    parts.push(`${skipReasons.downloadFailed} could not be downloaded from object storage — check S3_* credentials`);
  }
  if (skipReasons.noFrames > 0) {
    parts.push(`${skipReasons.noFrames} clip(s) — FFmpeg could not extract preview frames`);
  }
  if (skipReasons.llmFailed > 0) {
    const quotaHint =
      result.sampleError?.toLowerCase().includes("quota") ||
      result.sampleError?.includes("429")
        ? " — OpenAI quota exceeded: add billing/credits at platform.openai.com"
        : result.sampleError
          ? `: ${result.sampleError}`
          : " (check LLM_API_KEY / OpenAI quota)";
    parts.push(`${skipReasons.llmFailed} clip(s) — vision AI failed${quotaHint}`);
  }
  if (skipReasons.noVision > 0) {
    parts.push(`${skipReasons.noVision} could not be analyzed — verify LLM_API_KEY and FFmpeg`);
  }
  if (skipReasons.missingAsset > 0) {
    parts.push(`${skipReasons.missingAsset} clip record(s) not found`);
  }
  if (result.failed > 0) parts.push(`${result.failed} failed unexpectedly`);
  if (result.sampleUpdate) {
    parts.push(
      `Example clip #${result.sampleUpdate.assetId}: "${result.sampleUpdate.title}" → [${result.sampleUpdate.tags.join(", ")}]`
    );
  }
  return parts.join(". ");
}

function archiveClipMediaUrl(assetId: number): string {
  return `/api/admin/archive/media/${assetId}`;
}

function mediaIssueLabel(issue?: ArchiveAsset["mediaIssue"]): string | null {
  if (issue === "missing") return "Bestand ontbreekt op server";
  if (issue === "unsupported_format") return "Formaat werkt niet in browser (upload MP4/WebM)";
  return null;
}

function LazyArchiveMedia({
  asset,
  className,
  mode,
}: {
  asset: ArchiveAsset;
  className?: string;
  mode: "thumb" | "preview";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const canLoad = asset.mediaAvailable !== false;

  // Images can be served directly from their storage URL (storage proxy or local-storage
  // static), avoiding the extra server hop through the media streaming endpoint.
  const mediaSrc = asset.mediaType === "image" ? asset.storageUrl : archiveClipMediaUrl(asset.id);

  useEffect(() => {
    setLoadError(false);
    if (!canLoad) {
      setSrc(null);
      return;
    }
    if (mode === "preview") {
      setSrc(mediaSrc);
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSrc(mediaSrc);
          obs.disconnect();
        }
      },
      { rootMargin: "240px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [asset.id, canLoad, mediaSrc, mode]);

  const issue = mediaIssueLabel(asset.mediaIssue ?? undefined);

  if (!canLoad || loadError) {
    return (
      <div
        ref={containerRef}
        className={`flex flex-col items-center justify-center gap-2 bg-black/50 text-slate-400 ${className ?? ""}`}
      >
        <AlertTriangle className="w-8 h-8 text-amber-400/80" />
        <p className="text-xs text-center px-3 leading-snug">
          {loadError ? "Preview mislukt — bestand ontbreekt of is corrupt" : issue ?? "Media niet beschikbaar"}
        </p>
      </div>
    );
  }

  if (asset.mediaType === "video") {
    return (
      <div ref={containerRef} className={className}>
        <video
          src={src ?? undefined}
          className={`w-full h-full ${mode === "preview" ? "object-contain" : "object-cover object-[center_20%]"}`}
          muted
          playsInline
          preload={mode === "preview" ? "auto" : "metadata"}
          controls={mode === "preview"}
          autoPlay={mode === "preview"}
          onError={() => setLoadError(true)}
          onLoadedData={(e) => {
            // iOS Safari never paints a video element's first frame on its own — not even with
            // preload="metadata"/"auto" — until it has actually played at least once. A muted,
            // playsInline, near-instant play+pause forces it to decode and show that frame as a
            // static thumbnail without ever visibly autoplaying. Desktop browsers already paint
            // the frame on load, so this is a no-op there — pausing at time 0 changes nothing.
            if (mode !== "thumb") return;
            const el = e.currentTarget;
            el.play()
              .then(() => el.pause())
              .catch(() => { /* autoplay blocked — falls back to the old blank-frame behavior */ });
          }}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={className}>
      <img
        src={src ?? undefined}
        alt={asset.title ?? ""}
        className="w-full h-full object-cover object-[center_20%]"
        loading="lazy"
        onError={() => setLoadError(true)}
      />
    </div>
  );
}

function AssetPreviewModal({
  asset,
  sceneAudit,
  onClose,
  onTrimmed,
}: {
  asset: ArchiveAsset;
  sceneAudit?: SceneAuditEntry;
  onClose: () => void;
  onTrimmed?: (newDurationSec: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number>(asset.durationSec ?? 0);
  /**
   * RONDE 98 — a start AND an end.
   *
   * There was one marker, `trimAt`, and it only ever meant "cut everything after this". A clip
   * whose usable footage began three seconds in could not be fixed at all.
   */
  const [trimStart, setTrimStart] = useState<number | null>(null);
  const [trimEnd, setTrimEnd] = useState<number | null>(null);
  const [trimming, setTrimming] = useState(false);
  const trimMutation = trpc.mediaArchive.trimToSingleScene.useMutation();
  // Use live video duration; fall back to DB value while video hasn't loaded yet.
  const duration = videoDuration > 0 ? videoDuration : (asset.durationSec ?? 0);

  function getVideo(): HTMLVideoElement | null {
    return containerRef.current?.querySelector("video") ?? null;
  }

  useEffect(() => {
    // Attach timeupdate + durationchange listener to the video rendered by LazyArchiveMedia.
    // setInterval's callback return value is ignored by the runtime (unlike useEffect), so the
    // attached listeners must be tracked here and removed by THIS effect's own cleanup —
    // otherwise they silently accumulate on the video element across asset switches.
    let attachedVideo: HTMLVideoElement | null = null;
    let onTime: (() => void) | null = null;
    let onDur: (() => void) | null = null;
    const interval = setInterval(() => {
      const v = getVideo();
      if (v) {
        onTime = () => setCurrentTime(v.currentTime);
        onDur = () => { if (v.duration && isFinite(v.duration)) setVideoDuration(v.duration); };
        v.addEventListener("timeupdate", onTime);
        v.addEventListener("durationchange", onDur);
        if (v.duration && isFinite(v.duration)) setVideoDuration(v.duration);
        attachedVideo = v;
        clearInterval(interval);
      }
    }, 100);
    return () => {
      clearInterval(interval);
      if (attachedVideo && onTime && onDur) {
        attachedVideo.removeEventListener("timeupdate", onTime);
        attachedVideo.removeEventListener("durationchange", onDur);
      }
    };
  }, [asset.id]);

  /** The player's current position, or null when it cannot be read. */
  function playheadSec(): number | null {
    const v = getVideo();
    if (!v) return null;
    const t = v.currentTime;
    const dur = v.duration && isFinite(v.duration) ? v.duration : duration;
    if (t < 0 || (dur > 0 && t > dur)) return null;
    return t;
  }

  function markStart() {
    const t = playheadSec();
    if (t == null) return;
    if (trimEnd != null && t >= trimEnd - 0.5) {
      toast.error("Startpunt moet minstens een halve seconde vóór het eindpunt liggen");
      return;
    }
    setTrimStart(t);
  }

  function markEnd() {
    const t = playheadSec();
    if (t == null) return;
    if (t <= (trimStart ?? 0) + 0.5) {
      toast.error("Eindpunt moet minstens een halve seconde ná het startpunt liggen");
      return;
    }
    setTrimEnd(t);
  }

  const hasTrimRange = trimStart != null || trimEnd != null;

  async function applyTrim() {
    if (!hasTrimRange) return;
    const from = trimStart ?? 0;
    const to = trimEnd ?? duration;
    if (!confirm(`Clip bijknippen naar ${from.toFixed(2)}s – ${to.toFixed(2)}s? Dit overschrijft het origineel.`)) {
      return;
    }
    setTrimming(true);
    try {
      const result = await trimMutation.mutateAsync({
        assetId: asset.id,
        startSec: trimStart ?? 0,
        ...(trimEnd != null ? { endSec: trimEnd } : {}),
      });
      if (!result.trimmed) {
        toast.error("Bijknippen mislukt", { description: result.reason ?? "Onbekende fout" });
        return;
      }
      toast.success(`Bijgeknipt naar ${result.newDurationSec?.toFixed(2)}s`);
      onTrimmed?.(result.newDurationSec!);
      onClose();
    } catch (e) {
      toast.error("Bijknippen mislukt", { description: toastErrorMessage(e) });
    } finally {
      setTrimming(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl glass-card border border-white/15 rounded-xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="min-w-0">
            {asset.sourceNote && (
              <p className="text-xs text-slate-400 truncate mt-0.5">{asset.sourceNote}</p>
            )}
            {mediaIssueLabel(asset.mediaIssue ?? undefined) && (
              <p className="text-xs text-amber-300 mt-1">{mediaIssueLabel(asset.mediaIssue ?? undefined)}</p>
            )}
            {sceneAuditLabel(sceneAudit) && (
              <p
                className={`text-xs mt-1 ${
                  sceneAudit?.status === "multi_scene" ? "text-red-300" : "text-emerald-300"
                }`}
              >
                Scène-check: {sceneAuditLabel(sceneAudit)}
                {sceneAudit?.cutTimesSec?.length
                  ? ` (cuts @ ${sceneAudit.cutTimesSec.map((t) => t.toFixed(1)).join("s, ")}s)`
                  : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {asset.mediaAvailable !== false && (
              <a
                href={archiveClipMediaUrl(asset.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="p-2 rounded-lg bg-white/10 text-slate-300 hover:text-white hover:bg-white/15"
                title="Open in new tab"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button onClick={onClose} className="p-2 rounded-lg bg-white/10 text-slate-300 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div ref={containerRef} className="bg-black flex items-center justify-center" style={{ height: "60vh" }}>
          <LazyArchiveMedia asset={asset} mode="preview" className="w-full h-full overflow-hidden" />
        </div>

        {asset.mediaType === "video" && (
          <div className="px-4 py-3 border-t border-white/10 space-y-2">
            {/* RONDE 98: the bar shows the KEPT range, shaded between the two markers, so what the
                operator is about to save is visible before they save it. */}
            {duration > 0 && <div className="relative h-2 bg-white/10 rounded-full cursor-pointer"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                const t = frac * duration;
                const v = getVideo();
                if (v) v.currentTime = t;
              }}
              title="Klik om naar dit punt te springen"
            >
              {/* kept range */}
              <div
                className="absolute top-0 h-full bg-emerald-500/40 rounded-full"
                style={{
                  left: `${((trimStart ?? 0) / duration) * 100}%`,
                  width: `${(((trimEnd ?? duration) - (trimStart ?? 0)) / duration) * 100}%`,
                }}
              />
              {/* playhead */}
              <div
                className="absolute top-0 h-full bg-white/30 rounded-full"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
              {trimStart != null && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-1 h-4 bg-emerald-300 rounded-full"
                  style={{ left: `${(trimStart / duration) * 100}%` }}
                />
              )}
              {trimEnd != null && (
                <div
                  className="absolute top-1/2 -translate-y-1/2 w-1 h-4 bg-red-400 rounded-full"
                  style={{ left: `${(trimEnd / duration) * 100}%` }}
                />
              )}
            </div>}

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500 tabular-nums w-24">
                {currentTime.toFixed(2)}s / {duration > 0 ? `${duration.toFixed(1)}s` : "?"}
              </span>
              <button
                onClick={markStart}
                className="px-3 py-1.5 text-xs rounded-lg bg-white/10 hover:bg-white/15 text-slate-300 hover:text-white flex items-center gap-1.5"
                title="Begin van de bewaarde clip op de huidige positie"
              >
                <Scissors className="w-3 h-3" /> Begin hier
              </button>
              <button
                onClick={markEnd}
                className="px-3 py-1.5 text-xs rounded-lg bg-white/10 hover:bg-white/15 text-slate-300 hover:text-white flex items-center gap-1.5"
                title="Einde van de bewaarde clip op de huidige positie"
              >
                <Scissors className="w-3 h-3" /> Einde hier
              </button>
              {hasTrimRange && (
                <>
                  <span className="text-xs text-emerald-300 tabular-nums">
                    bewaar {(trimStart ?? 0).toFixed(2)}s – {(trimEnd ?? duration).toFixed(2)}s
                    {duration > 0 && ` (${((trimEnd ?? duration) - (trimStart ?? 0)).toFixed(2)}s)`}
                  </span>
                  <button
                    onClick={applyTrim}
                    disabled={trimming}
                    className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {trimming ? <Loader2 className="w-3 h-3 animate-spin" /> : <Scissors className="w-3 h-3" />}
                    Bijknippen toepassen
                  </button>
                  <button
                    onClick={() => { setTrimStart(null); setTrimEnd(null); }}
                    className="text-xs text-slate-500 hover:text-slate-300"
                  >
                    Annuleren
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {(asset.mediaType !== "video" || duration <= 0) && asset.durationSec != null && asset.durationSec > 0 && (
          <div className="px-4 py-2 text-xs text-slate-500 border-t border-white/10">
            Duration: {formatDuration(asset.durationSec)}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetCard({
  asset,
  archiveId,
  selected,
  sceneAudit,
  onToggleSelect,
  onDelete,
  onSave,
  onTrimmed,
  onRefresh,
  saving,
}: {
  asset: ArchiveAsset;
  archiveId: number;
  selected: boolean;
  sceneAudit?: SceneAuditEntry;
  onToggleSelect: () => void;
  onDelete: () => void;
  onSave: (patch: { title?: string; tags?: string[]; mixKind?: MixKind; sourceNote?: string }) => void;
  onTrimmed: (assetId: number, newDurationSec: number) => void;
  onRefresh: () => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [tagEditing, setTagEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [title, setTitle] = useState(asset.title ?? "");
  const [tags, setTags] = useState(tagsToInput(asset.tags));
  const [mixKind, setMixKind] = useState<MixKind>(asset.mixKind);
  const [sourceNote, setSourceNote] = useState(asset.sourceNote ?? "");
  const trimMutation = trpc.mediaArchive.trimToSingleScene.useMutation();
  const rekognitionMutation = trpc.mediaArchive.recognizeCelebrities.useMutation();
  const aiTagMutation = trpc.mediaArchive.autoTitleAssets.useMutation();

  useEffect(() => {
    setTitle(asset.title ?? "");
    setTags(tagsToInput(asset.tags));
    setMixKind(asset.mixKind);
    setSourceNote(asset.sourceNote ?? "");
    setTagEditing(false);
  }, [asset.id, asset.title, asset.tags, asset.mixKind, asset.sourceNote]);

  return (
    <>
      {previewOpen && (
        <AssetPreviewModal
          asset={asset}
          sceneAudit={sceneAudit}
          onClose={() => setPreviewOpen(false)}
          onTrimmed={() => onRefresh()}
        />
      )}
      <div
        className={`glass-card border rounded-xl overflow-hidden transition-colors ${
          selected ? "border-purple-500/60 ring-1 ring-purple-500/40" : "border-white/8"
        }`}
      >
        <div className="relative">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="aspect-video bg-black/40 relative flex items-center justify-center w-full group cursor-pointer overflow-hidden"
          >
            <LazyArchiveMedia asset={asset} mode="thumb" className="absolute inset-0 w-full h-full" />
            {asset.mediaIssue && (
              <span className="absolute top-2 right-10 text-[10px] px-2 py-0.5 rounded bg-amber-500/90 text-black font-medium z-10">
                {asset.mediaIssue === "missing" ? "Ontbreekt" : "MP4 nodig"}
              </span>
            )}
            {sceneAudit && sceneAuditLabel(sceneAudit) && (
              <span
                className={`absolute bottom-2 left-2 text-[10px] px-2 py-0.5 rounded font-medium z-10 ${
                  sceneAudit.status === "multi_scene"
                    ? "bg-red-600/95 text-white"
                    : sceneAudit.status === "single_scene"
                      ? "bg-emerald-600/90 text-white"
                      : "bg-slate-600/90 text-white"
                }`}
              >
                {sceneAuditLabel(sceneAudit)}
              </span>
            )}
            <span className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center z-[1]">
              <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/70 text-white text-xs font-medium">
                <Play className="w-4 h-4 fill-white" />
                View
              </span>
            </span>
            <span className="absolute top-2 left-2 flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-black/60 text-white z-[1]">
              {asset.mediaType === "video" ? <Film className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
              {asset.mediaType}
            </span>
            {asset.durationSec != null && asset.durationSec > 0 && (
              <span className="absolute bottom-2 right-2 text-xs px-2 py-0.5 rounded bg-black/70 text-white z-[1]">
                {formatDuration(asset.durationSec)}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
            className={`absolute top-2 right-2 z-20 p-1.5 rounded-md border transition-colors ${
              selected
                ? "bg-purple-600 border-purple-400 text-white"
                : "bg-black/60 border-white/20 text-slate-300 hover:bg-black/80"
            }`}
            title={selected ? "Deselect" : "Select"}
          >
            {selected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
          </button>
        </div>
        <div className="p-3 space-y-2">
          {editing ? (
            <>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white"
                placeholder="berlin, metro, skyline, modern city, transit, architecture"
              />
              <select
                value={mixKind}
                onChange={(e) => setMixKind(e.target.value as MixKind)}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white"
              >
                {MIX_KINDS.map((k) => (
                  <option key={k.value} value={k.value} className="bg-slate-900">{k.label}</option>
                ))}
              </select>
              <div className="flex gap-1">
                <button
                  onClick={() => {
                    onSave({
                      title: "",
                      tags: parseTagsInput(tags),
                      mixKind,
                      sourceNote: sourceNote.trim() || undefined,
                    });
                    setEditing(false);
                  }}
                  disabled={saving}
                  className="flex-1 text-xs py-1 rounded bg-purple-600/30 text-purple-200"
                >
                  Save
                </button>
                <button onClick={() => setEditing(false)} className="px-2 py-1 text-xs text-slate-400">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </>
          ) : (
            <>
              {asset.sourceNote && (
                <p className="text-xs text-slate-500 line-clamp-2">{asset.sourceNote}</p>
              )}
              {tagEditing ? (
                <div className="flex gap-1">
                  <input
                    autoFocus
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        onSave({ tags: parseTagsInput(tags) });
                        setTagEditing(false);
                      } else if (e.key === "Escape") {
                        setTags(tagsToInput(asset.tags));
                        setTagEditing(false);
                      }
                    }}
                    className="flex-1 bg-white/5 border border-purple-500/50 rounded px-2 py-1 text-xs text-white"
                    placeholder="napoleon, wereldoorlog, 1940 …"
                  />
                  <button
                    onClick={() => { onSave({ tags: parseTagsInput(tags) }); setTagEditing(false); }}
                    disabled={saving}
                    className="text-xs px-2 py-1 rounded bg-purple-600/30 text-purple-200 hover:bg-purple-600/50"
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => { setTags(tagsToInput(asset.tags)); setTagEditing(false); }}
                    className="text-xs px-2 py-1 rounded bg-white/5 text-slate-400 hover:bg-white/10"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <div
                  className="flex flex-wrap gap-1 cursor-pointer group/tags min-h-[22px] items-center"
                  onClick={() => { setTagEditing(true); }}
                  title="Klik om tags te bewerken"
                >
                  {asset.tags && asset.tags.length > 0 ? (
                    <>
                      {asset.tags.map((t) => (
                        <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-slate-300 group-hover/tags:bg-white/15">{t}</span>
                      ))}
                      <span className="text-[10px] px-1 text-slate-600 group-hover/tags:text-slate-400">✎</span>
                    </>
                  ) : (
                    <span className="text-[10px] text-slate-600 group-hover/tags:text-slate-400 italic">+ tag toevoegen</span>
                  )}
                </div>
              )}
              <div className="flex gap-1 pt-1">
                <button onClick={() => setPreviewOpen(true)} className="text-xs px-2 py-1 rounded bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25" title="View">
                  <Play className="w-3 h-3 inline" />
                </button>
                <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 rounded bg-white/10 text-slate-300 hover:bg-white/15">
                  <Pencil className="w-3 h-3 inline" />
                </button>
                <button onClick={onDelete} className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20">
                  <Trash2 className="w-3 h-3 inline" />
                </button>
                {sceneAudit?.status === "multi_scene" && (sceneAudit.cutTimesSec?.length ?? 0) > 0 && (
                  <button
                    onClick={async () => {
                      const cut = sceneAudit.cutTimesSec![0];
                      if (!confirm(`Clip bijknippen naar eerste scène (0–${cut.toFixed(1)}s)?`)) return;
                      try {
                        const result = await trimMutation.mutateAsync({ assetId: asset.id, cutTimeSec: cut });
                        if (!result.trimmed) {
                          toast.error("Bijknippen mislukt", { description: result.reason ?? "Onbekende fout" });
                          return;
                        }
                        onRefresh();
                        toast.success(`Bijgeknipt naar ${result.newDurationSec}s`);
                      } catch (e) {
                        toast.error("Bijknippen mislukt", { description: toastErrorMessage(e) });
                      }
                    }}
                    disabled={trimMutation.isPending}
                    className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                    title={`Bijknippen naar eerste scène (tot ${sceneAudit.cutTimesSec![0].toFixed(1)}s)`}
                  >
                    {trimMutation.isPending ? <Loader2 className="w-3 h-3 inline animate-spin" /> : <Scissors className="w-3 h-3 inline" />}
                  </button>
                )}
                <button
                  onClick={async () => {
                    try {
                      const result = await rekognitionMutation.mutateAsync({ assetId: asset.id });
                      if (result.persons.length === 0) {
                        toast.info("Geen bekende personen herkend in deze clip");
                      } else {
                        const names = result.persons.map((p) => `${p.name} (${p.confidence}%)`).join(", ");
                        toast.success(`Herkend: ${names}`, { description: "Tags opgeslagen" });
                        onRefresh();
                      }
                    } catch (e) {
                      toast.error("Herkenning mislukt", { description: toastErrorMessage(e) });
                    }
                  }}
                  disabled={rekognitionMutation.isPending}
                  className="text-xs px-2 py-1 rounded bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 disabled:opacity-50"
                  title="AWS Rekognition — herkent bekende personen"
                >
                  {rekognitionMutation.isPending ? <Loader2 className="w-3 h-3 inline animate-spin" /> : <ScanSearch className="w-3 h-3 inline" />}
                </button>
                <button
                  onClick={async () => {
                    try {
                      const result = await aiTagMutation.mutateAsync({ archiveId, ids: [asset.id], force: true });
                      if (result.updated > 0 && result.sampleUpdate?.tags?.length) {
                        toast.success(`AI tags: ${result.sampleUpdate.tags.slice(0, 5).join(", ")}`, { description: "Tags opgeslagen" });
                        onRefresh();
                      } else if ((result.skipReasons?.hasTags ?? 0) > 0) {
                        onRefresh();
                      } else if ((result.skipReasons?.fileMissing ?? 0) > 0 || (result.skipReasons?.downloadFailed ?? 0) > 0) {
                        toast.error("Videobestand niet beschikbaar", { description: "Controleer of de clip correct is geüpload" });
                      } else if ((result.skipReasons?.noFrames ?? 0) > 0) {
                        toast.error("Geen frames extraheerbaar", { description: "Het videobestand is mogelijk leeg of beschadigd" });
                      } else {
                        toast.info("AI kon geen tags genereren", { description: result.sampleError ?? "Onbekende reden" });
                      }
                    } catch (e) {
                      toast.error("AI tagging mislukt", { description: toastErrorMessage(e) });
                    }
                  }}
                  disabled={aiTagMutation.isPending}
                  className="text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                  title="AI — genereert automatisch tags"
                >
                  {aiTagMutation.isPending ? <Loader2 className="w-3 h-3 inline animate-spin" /> : <Sparkles className="w-3 h-3 inline" />}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function ArchiveClipsGrid({
  archiveId,
  compact = false,
}: {
  archiveId: number | null;
  compact?: boolean;
}) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sceneAuditMap, setSceneAuditMap] = useState<Record<number, SceneAuditEntry>>({});
  const [sceneAuditRunning, setSceneAuditRunning] = useState(false);
  const [sceneAuditProgress, setSceneAuditProgress] = useState<{ done: number; total: number } | null>(null);
  const [sceneAuditReport, setSceneAuditReport] = useState<{
    kind: "running" | "done" | "error";
    message: string;
    detail?: string;
  } | null>(null);
  const [trimRunning, setTrimRunning] = useState(false);
  const [trimProgress, setTrimProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    setPage(0);
    setSceneAuditMap({});
    setSceneAuditReport(null);
  }, [archiveId]);

  useEffect(() => {
    setPage(0);
  }, [search]);

  const listInput = {
    archiveId: archiveId!,
    search: search || undefined,
    limit: CLIPS_PAGE_SIZE,
    offset: page * CLIPS_PAGE_SIZE,
  };

  const { data: listData, isLoading } = trpc.mediaArchive.listAssets.useQuery(listInput, {
    enabled: archiveId != null,
  });

  const assets = listData?.items ?? [];
  const total = listData?.total ?? 0;
  const unavailableCount = listData?.unavailableCount ?? 0;
  const unsupportedCount = listData?.unsupportedCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / CLIPS_PAGE_SIZE));
  const pageStart = total === 0 ? 0 : page * CLIPS_PAGE_SIZE + 1;
  const pageEnd = Math.min(total, (page + 1) * CLIPS_PAGE_SIZE);

  const updateAsset = trpc.mediaArchive.updateAsset.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listAssets.invalidate();
      toast.success("Clip updated!");
    },
    onError: (e) => toast.error("Save failed", { description: toastErrorMessage(e) }),
  });

  const deleteAsset = trpc.mediaArchive.deleteAsset.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      toast.success("Clip deleted");
    },
    onError: (e) => toast.error("Delete failed", { description: toastErrorMessage(e) }),
  });

  const deleteAssets = trpc.mediaArchive.deleteAssets.useMutation({
    onSuccess: (data, variables) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      setSelectedIds(new Set());
      setSceneAuditMap((prev) => {
        const next = { ...prev };
        for (const id of variables.ids) delete next[id];
        return next;
      });
      toast.success(`${data.deleted} clip(s) deleted`);
    },
    onError: (e) => toast.error("Delete failed", { description: toastErrorMessage(e) }),
  });

  const deleteAllAssets = trpc.mediaArchive.deleteAllAssets.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      setSelectedIds(new Set());
      toast.success(`${data.deleted} clip(s) deleted`);
    },
    onError: (e) => toast.error("Delete failed", { description: toastErrorMessage(e) }),
  });

  const deleteLogoClips = trpc.mediaArchive.deleteLogoClips.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      if (data.deleted === 0) {
        toast.info(`Geen logo-clips gevonden (${data.scanned} gescand)`);
      } else {
        toast.success(`${data.deleted} logo-clip(s) verwijderd (van ${data.scanned} gescand)`);
      }
    },
    onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  });

  // deleteZeroDurationClips: server procedure mediaArchive.deleteZeroDurationClips was never
  // implemented — this hook (and its button below) is disabled rather than removed so the
  // intended shape/behavior is preserved for whoever builds it. Do not re-enable without adding
  // the matching adminProcedure in routers.ts first.
  // const deleteZeroDurationClips = trpc.mediaArchive.deleteZeroDurationClips.useMutation({
  //   onSuccess: (data) => {
  //     utils.mediaArchive.listAssets.invalidate();
  //     utils.mediaArchive.listArchives.invalidate();
  //     if (data.confirmed === 0) {
  //       toast.info(`Geen clips korter dan 1 seconde gevonden (${data.scanned} gescand)`);
  //     } else {
  //       const parts: string[] = [];
  //       if (data.deleted > 0) parts.push(`${data.deleted} echt lege clip(s) verwijderd`);
  //       if ((data.fixed ?? 0) > 0) parts.push(`${data.fixed} clip(s) hadden wel beelden — duur gecorrigeerd in database`);
  //       toast.success(parts.join(", ") || "Klaar", {
  //         description: `${data.confirmed} van ${data.scanned} clips gecontroleerd via ffprobe`,
  //       });
  //     }
  //   },
  //   onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  // });

  const autoTitleAssets = trpc.mediaArchive.autoTitleAssets.useMutation();
  const auditScenes = trpc.mediaArchive.auditScenes.useMutation();
  const deleteShortAssets = trpc.mediaArchive.deleteShortAssets.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      if (data.deleted === 0) {
        toast.info("Geen korte clips gevonden");
      } else {
        toast.success(`${data.deleted} korte clip(s) verwijderd`);
      }
    },
    onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  });
  const repairDurations = trpc.mediaArchive.repairDurations.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      toast.success(`Duration repair: ${data.updated} updated`, {
        description:
          data.deactivated > 0
            ? `${data.deactivated} sub-3s clip(s) deactivated, ${data.skipped} skipped`
            : data.skipped > 0
              ? `${data.skipped} skipped`
              : undefined,
      });
    },
    onError: (e) => toast.error("Duration repair failed", { description: toastErrorMessage(e) }),
  });
  // reindexOrphanedClips / restoreFromS3: same as deleteZeroDurationClips above — server
  // procedures were never implemented, so these are disabled (not deleted) along with their
  // buttons below.
  // const reindexOrphans = trpc.mediaArchive.reindexOrphanedClips.useMutation({
  //   onSuccess: (data) => {
  //     utils.mediaArchive.listAssets.invalidate();
  //     utils.mediaArchive.listArchives.invalidate();
  //     if (data.inserted === 0 && data.remaining === 0) {
  //       toast.info("Geen ontbrekende clips gevonden op schijf");
  //     } else {
  //       toast.success(`${data.inserted} clip(s) teruggehaald`, {
  //         description: (data.remaining ?? 0) > 0
  //           ? `Nog ${data.remaining ?? 0} te gaan — klik opnieuw om door te gaan`
  //           : `Alle ontbrekende clips zijn hersteld`,
  //       });
  //     }
  //   },
  //   onError: (e) => toast.error("Herindexering mislukt", { description: toastErrorMessage(e) }),
  // });
  // const restoreFromS3 = trpc.mediaArchive.restoreFromS3.useMutation({
  //   onSuccess: (data) => {
  //     utils.mediaArchive.listAssets.invalidate();
  //     utils.mediaArchive.listArchives.invalidate();
  //     if (data.restored === 0) {
  //       toast.info("Geen ontbrekende clips gevonden in R2");
  //     } else {
  //       toast.success(`${data.restored} clip(s) hersteld uit R2`, {
  //         description: `${data.skipped} bestand(en) overgeslagen`,
  //       });
  //     }
  //   },
  //   onError: (e) => toast.error("Herstel mislukt", { description: toastErrorMessage(e) }),
  // });
  const dedupeDuplicates = trpc.mediaArchive.dedupeDuplicateAssets.useMutation();
  const [dedupeProgress, setDedupeProgress] = useState<{ scanned: number; deleted: number; total: number } | null>(null);
  const rekognitionBulk = trpc.mediaArchive.recognizeCelebritiesBulk.useMutation();
  const [rekognitionProgress, setRekognitionProgress] = useState<{ scanned: number; identified: number; total: number } | null>(null);
  const [autoTitleRunning, setAutoTitleRunning] = useState(false);
  const [autoTitleProgress, setAutoTitleProgress] = useState<{ done: number; total: number } | null>(null);
  const [autoTitleReport, setAutoTitleReport] = useState<{
    kind: "running" | "done" | "error";
    message: string;
    detail?: string;
  } | null>(null);
  const [probeRunning, setProbeRunning] = useState(false);
  const [selectAllLoading, setSelectAllLoading] = useState(false);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [archiveId, search]);

  const selectedCount = selectedIds.size;
  const allArchiveSelected = total > 0 && selectedCount === total;
  const pageAssetIds = useMemo(() => assets.map((a) => a.id), [assets]);
  const allPageSelected = pageAssetIds.length > 0 && pageAssetIds.every((id) => selectedIds.has(id));

  function toggleSelectPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPageSelected) {
        pageAssetIds.forEach((id) => next.delete(id));
      } else {
        pageAssetIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  const multiSceneCount = useMemo(
    () => Object.values(sceneAuditMap).filter((e) => e.status === "multi_scene").length,
    [sceneAuditMap]
  );

  const runSceneAudit = useCallback(async () => {
    if (archiveId == null || total === 0) {
      toast.error("Geen clips om te scannen");
      return;
    }

    let targetIds: number[];
    if (selectedCount > 0) {
      targetIds = [...selectedIds];
    } else {
      targetIds = await fetchAllArchiveAssetIds(
        (input) => utils.mediaArchive.listAssets.fetch(input),
        archiveId,
        search,
        (a) => a.mediaType === "video",
      );
    }

    if (targetIds.length === 0) {
      toast.error("Geen video-clips geselecteerd");
      return;
    }

    const label =
      selectedCount > 0 ? `${targetIds.length} geselecteerde clip(s)` : `${targetIds.length} video-clips`;

    const CHUNK = 20;
    setSceneAuditRunning(true);
    setSceneAuditProgress({ done: 0, total: targetIds.length });
    setSceneAuditReport({
      kind: "running",
      message: `Scène-check bezig voor ${label}…`,
      detail: "FFmpeg scdet — ~5–20 seconden per clip.",
    });
    const loadingToast = toast.loading(`Scène-check (0/${targetIds.length})…`);

    let singleScene = 0;
    let multiScene = 0;
    let failed = 0;
    const nextMap: Record<number, SceneAuditEntry> = { ...sceneAuditMap };

    try {
      for (let i = 0; i < targetIds.length; i += CHUNK) {
        const chunk = targetIds.slice(i, i + CHUNK);
        const result = await auditScenes.mutateAsync({ archiveId, ids: chunk });
        singleScene += result.singleScene;
        multiScene += result.multiScene;
        failed += result.fileMissing + result.downloadFailed + result.analyzeFailed;
        for (const entry of result.results) {
          nextMap[entry.assetId] = entry as SceneAuditEntry;
        }
        const done = Math.min(i + chunk.length, targetIds.length);
        setSceneAuditProgress({ done, total: targetIds.length });
        setSceneAuditMap({ ...nextMap });
        setSceneAuditReport({
          kind: "running",
          message: `Bezig: ${done}/${targetIds.length} — ${multiScene} multi-scene tot nu toe`,
          detail: `${singleScene} ok (1 scène), ${failed} mislukt/overgeslagen`,
        });
        toast.loading(`Scène-check (${done}/${targetIds.length})…`, { id: loadingToast });
      }

      toast.dismiss(loadingToast);
      setSceneAuditReport({
        kind: "done",
        message: `Klaar: ${multiScene} multi-scene, ${singleScene} enkele scène`,
        detail:
          failed > 0
            ? `${failed} clip(s) niet geanalyseerd (bestand ontbreekt of FFmpeg-fout).`
            : multiScene > 0
              ? "Gebruik “Verwijder alleen multi scenes” of upload opnieuw."
              : "Alle gecontroleerde clips zijn één scène.",
      });
      if (multiScene > 0) {
        toast.warning(`${multiScene} clip(s) met meerdere scènes`, {
          description: `${singleScene} clip(s) zijn OK (1 scène)`,
        });
      } else {
        toast.success("Alle clips zijn 1 scène", {
          description: `${singleScene} video-clips gecontroleerd`,
        });
      }
    } catch (e) {
      toast.dismiss(loadingToast);
      const msg = toastErrorMessage(e);
      setSceneAuditReport({ kind: "error", message: "Scène-check mislukt", detail: msg });
      toast.error("Scène-check mislukt", { description: msg });
    } finally {
      setSceneAuditRunning(false);
      setSceneAuditProgress(null);
    }
  }, [
    archiveId,
    auditScenes,
    sceneAuditMap,
    search,
    selectedCount,
    selectedIds,
    total,
    utils.mediaArchive.listAssets,
  ]);

  const runRepairDurations = useCallback(() => {
    if (archiveId == null || total === 0) {
      toast.error("Geen clips om te repareren");
      return;
    }
    const targetIds = selectedCount > 0 ? [...selectedIds] : undefined;
    const scopeLabel = targetIds ? `${targetIds.length} geselecteerde clip(s)` : `${total} clip(s)`;
    const loadingToast = toast.loading(`Duur repareren voor ${scopeLabel}…`);
    repairDurations.mutate(
      { archiveId, ids: targetIds },
      {
        onSettled: () => toast.dismiss(loadingToast),
      }
    );
  }, [archiveId, repairDurations, selectedCount, selectedIds, total]);

  const runAutoTitleAll = useCallback(async () => {
    if (archiveId == null || total === 0) {
      toast.error("No clips to process");
      return;
    }

    const targetIds = selectedCount > 0 ? [...selectedIds] : undefined;

    if (selectedCount > 0 && (!targetIds || targetIds.length === 0)) {
      toast.error("No clips selected");
      return;
    }

    const label =
      selectedCount > 0
        ? `${targetIds!.length} selected clip(s)`
        : search.trim()
          ? `${total} matching clip(s)`
          : `all ${total} clip(s)`;

    const CHUNK = 8;
    let resolvedIds = targetIds;
    if (!resolvedIds) {
      resolvedIds = await fetchAllArchiveAssetIds(
        (input) => utils.mediaArchive.listAssets.fetch(input),
        archiveId!,
        search,
      );
    }

    // Filter out clips that already have 4+ tags — skip them client-side. Must match the
    // server's own skip threshold (autoTitleSingleAsset skips at >=4, not >0) — clips with
    // 1-3 tags should still go through so the server can top them up to 4.
    const taggedIds = new Set(assets.filter((a) => Array.isArray(a.tags) && (a.tags as string[]).length >= 4).map((a) => a.id));
    resolvedIds = resolvedIds.filter((id) => !taggedIds.has(id));

    if (resolvedIds.length === 0) {
      toast.info("Alle geselecteerde clips hebben al tags — niets te doen");
      return;
    }

    setAutoTitleRunning(true);
    setAutoTitleProgress({ done: 0, total: resolvedIds.length });
    setAutoTitleReport({
      kind: "running",
      message: `AI titles + 4 tags bezig voor ${label}…`,
      detail: "Dit duurt ~30–60 seconden per clip. Bestaande tags worden vervangen.",
    });
    const loadingToast = toast.loading(`AI titles + 4 tags (${resolvedIds.length} clips)…`);
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    // Summed across every chunk — a single chunk's counts (previously kept as "last") could
    // easily be all-zero even when earlier chunks hit real, informative failures, hiding the
    // actual reason behind a generic "AI couldn't generate" message.
    const totalSkipReasons = {
      missingAsset: 0,
      fileMissing: 0,
      downloadFailed: 0,
      noFrames: 0,
      noVision: 0,
      llmFailed: 0,
    };
    let lastSampleError: string | undefined;
    let lastSampleUpdate: { assetId: number; title: string; tags: string[] } | undefined;

    try {
      for (let i = 0; i < resolvedIds.length; i += CHUNK) {
        const chunk = resolvedIds.slice(i, i + CHUNK);
        const result = await autoTitleAssets.mutateAsync({ archiveId, ids: chunk });
        updated += result.updated;
        skipped += result.skipped;
        failed += result.failed;
        if (result.skipReasons) {
          totalSkipReasons.missingAsset += result.skipReasons.missingAsset;
          totalSkipReasons.fileMissing += result.skipReasons.fileMissing;
          totalSkipReasons.downloadFailed += result.skipReasons.downloadFailed;
          totalSkipReasons.noFrames += result.skipReasons.noFrames;
          totalSkipReasons.noVision += result.skipReasons.noVision;
          totalSkipReasons.llmFailed += result.skipReasons.llmFailed;
        }
        if (result.sampleError) lastSampleError = result.sampleError;
        if (result.sampleUpdate) lastSampleUpdate = result.sampleUpdate;
        const done = Math.min(i + chunk.length, resolvedIds.length);
        setAutoTitleProgress({ done, total: resolvedIds.length });
        setAutoTitleReport({
          kind: "running",
          message: `Bezig: ${done}/${resolvedIds.length} clips verwerkt (${updated} bijgewerkt)`,
          detail: lastSampleUpdate
            ? `Laatste save: #${lastSampleUpdate.assetId} → [${lastSampleUpdate.tags.join(", ")}]`
            : lastSampleError
              ? `Fout: ${lastSampleError}`
              : undefined,
        });
      }
      await utils.mediaArchive.listAssets.refetch(listInput);
      utils.mediaArchive.listArchives.invalidate();
      toast.dismiss(loadingToast);
      const outcomeDetail = describeAutoTitleOutcome({
        updated,
        skipped,
        failed,
        skipReasons: totalSkipReasons,
        sampleError: lastSampleError,
        sampleUpdate: lastSampleUpdate,
      });
      if (updated === 0) {
        setAutoTitleReport({
          kind: "done",
          message: `Klaar: 0 van ${resolvedIds.length} clips bijgewerkt`,
          detail: outcomeDetail || "AI kon geen titels/tags genereren voor deze clips",
        });
        toast.warning("Geen clips bijgewerkt", {
          description: outcomeDetail || "AI kon geen titels/tags genereren",
        });
      } else {
        setAutoTitleReport({
          kind: "done",
          message: `${updated} clip(s) bijgewerkt (titel + max 4 tags)`,
          detail: outcomeDetail || "Titels en tags zijn opgeslagen",
        });
        toast.success(`${updated} clip(s) bijgewerkt`, {
          description: outcomeDetail || "Titels en tags bijgewerkt",
        });
      }
    } catch (e) {
      toast.dismiss(loadingToast);
      const msg = toastErrorMessage(e);
      setAutoTitleReport({ kind: "error", message: "AI titles mislukt", detail: msg });
      toast.error("AI titles mislukt", { description: msg });
    } finally {
      setAutoTitleRunning(false);
      setAutoTitleProgress(null);
    }
  }, [
    archiveId,
    autoTitleAssets,
    listInput,
    search,
    selectedCount,
    selectedIds,
    total,
    utils.mediaArchive.listArchives,
    utils.mediaArchive.listAssets,
  ]);

  const runProbeFirstClip = useCallback(async () => {
    if (archiveId == null || assets.length === 0) {
      toast.error("Geen clips om te testen");
      return;
    }
    const assetId =
      selectedCount > 0 ? [...selectedIds][0] ?? assets[0]!.id : assets[0]!.id;
    setProbeRunning(true);
    setAutoTitleReport({
      kind: "running",
      message: `Test AI op clip #${assetId}…`,
      detail: "Vision + LLM — duurt ~30–60 seconden",
    });
    try {
      const data = await utils.mediaArchive.probeAiTag.fetch({ archiveId, assetId });
      if (!data?.ok) {
        const detail = data?.error
          ? `${data.stage}: ${data.error}`
          : "Onbekende fout — check LLM_API_KEY en OpenAI credits";
        setAutoTitleReport({ kind: "error", message: "AI test mislukt", detail });
        toast.error("AI test mislukt", { description: detail });
        return;
      }
      const detail = `"${data.title ?? "?"}" — ${data.tagCount ?? 0} tags (${data.frameCount ?? 0} frames)`;
      setAutoTitleReport({ kind: "done", message: `AI test OK voor clip #${assetId}`, detail });
      toast.success("AI test OK", { description: detail });
    } catch (e) {
      const msg = toastErrorMessage(e);
      setAutoTitleReport({ kind: "error", message: "AI test mislukt", detail: msg });
      toast.error("AI test mislukt", { description: msg });
    } finally {
      setProbeRunning(false);
    }
  }, [archiveId, assets, selectedCount, selectedIds, utils.mediaArchive.probeAiTag]);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function toggleSelectAll() {
    if (archiveId == null || total === 0) return;
    if (allArchiveSelected) {
      setSelectedIds(new Set());
      return;
    }
    setSelectAllLoading(true);
    try {
      const ids = await fetchAllArchiveAssetIds(
        (input) => utils.mediaArchive.listAssets.fetch(input),
        archiveId,
        search,
      );
      setSelectedIds(new Set(ids));
    } catch (e) {
      toast.error("Select all failed", { description: toastErrorMessage(e) });
    } finally {
      setSelectAllLoading(false);
    }
  }

  function deleteMultiSceneClips() {
    const ids = Object.entries(sceneAuditMap)
      .filter(([, entry]) => entry.status === "multi_scene")
      .map(([id]) => Number(id));
    if (ids.length === 0) return;
    if (
      !confirm(
        `${ids.length} multi-scene clip(s) permanent verwijderen?\n\nAlleen clips die als multi-scene zijn gemarkeerd (na scène-check) worden verwijderd.`
      )
    ) {
      return;
    }
    deleteAssets.mutate({ ids });
  }

  const trimToScene = trpc.mediaArchive.trimToSingleScene.useMutation();

  async function trimAllMultiScene() {
    const targets = Object.entries(sceneAuditMap)
      .filter(([, e]) => e.status === "multi_scene" && (e.cutTimesSec?.length ?? 0) > 0)
      .map(([id, e]) => ({ assetId: Number(id), cutTimeSec: e.cutTimesSec![0] }));
    if (targets.length === 0) {
      toast.error("Geen multi-scene clips met snijpunt gevonden. Voer eerst de scène-check uit.");
      return;
    }
    if (!confirm(`${targets.length} clips bijknippen naar de eerste scène?\n\nElke clip wordt herschreven tot het eerste snijpunt.`)) return;

    setTrimRunning(true);
    setTrimProgress({ done: 0, total: targets.length });
    let done = 0;
    let failed = 0;
    for (const { assetId, cutTimeSec } of targets) {
      try {
        const result = await trimToScene.mutateAsync({ assetId, cutTimeSec });
        setSceneAuditMap((prev) => {
          const entry = prev[assetId];
          if (!entry) return prev;
          return { ...prev, [assetId]: { ...entry, status: "single_scene", sceneCount: 1, interiorCutCount: 0, cutTimesSec: [], durationSec: result.newDurationSec } };
        });
      } catch {
        failed++;
      }
      done++;
      setTrimProgress({ done, total: targets.length });
    }
    setTrimRunning(false);
    setTrimProgress(null);
    utils.mediaArchive.listAssets.invalidate({ archiveId: archiveId! });
    if (failed === 0) {
      toast.success(`${done} clip(s) bijgeknipt naar eerste scène`);
    } else {
      toast.warning(`${done - failed} bijgeknipt, ${failed} mislukt`);
    }
  }

  function deleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0 || archiveId == null) return;
    if (!confirm(`Permanently delete ${ids.length} clip(s)?`)) return;

    if (allArchiveSelected) {
      deleteAllAssets.mutate({ archiveId, search: search.trim() || undefined });
      return;
    }
    deleteAssets.mutate({ ids });
  }

  function deleteClipsWithLogo() {
    if (archiveId == null) return;
    if (
      !confirm(
        "Alle clips met een logo of watermerk permanent verwijderen?\n\nClips worden herkend via hun tags en titel (logo, watermark, branded, tv-logo, etc.)."
      )
    ) return;
    deleteLogoClips.mutate({ archiveId });
  }

  const deletePending = deleteAssets.isPending || deleteAllAssets.isPending;

  async function runRekognitionBulk() {
    if (archiveId == null) return;
    const selectedArr = selectedCount > 0 ? [...selectedIds] : undefined;
    const label = selectedArr ? `${selectedArr.length} geselecteerde clip(s)` : `alle clips`;
    if (!confirm(`AWS Rekognition starten voor ${label}?\n\nHet systeem herkent bekende personen en slaat hun namen op als tags. Clips met bestaande tags worden overgeslagen.\n\nKosten: ~€0.001 per clip.`)) return;

    setRekognitionProgress({ scanned: 0, identified: 0, total: selectedArr?.length ?? total });
    let offset = 0;
    let totalIdentified = 0;
    let totalScanned = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const result = await rekognitionBulk.mutateAsync({
          archiveId,
          limit: 20,
          offset,
          onlyUntagged: true,
          ...(selectedArr ? { ids: selectedArr } : {}),
        });
        totalScanned += result.scanned;
        totalIdentified += result.identified;
        hasMore = result.hasMore;
        offset = result.nextOffset ?? offset + 20;
        setRekognitionProgress({ scanned: totalScanned, identified: totalIdentified, total: result.total });
      } catch {
        break;
      }
    }

    setRekognitionProgress(null);
    utils.mediaArchive.listAssets.invalidate({ archiveId });
    toast.success(`Rekognition klaar: ${totalIdentified} clip(s) voorzien van namen`, {
      description: `${totalScanned} clips gescand`,
    });
  }

  async function dedupeVisualDuplicates() {
    if (archiveId == null || total < 2) return;
    const targetIds = selectedCount > 0 ? [...selectedIds] : undefined;
    const label =
      selectedCount > 0 ? `${selectedCount} selected clip(s)` : `all ${total} clip(s)`;
    if (
      !confirm(
        `Remove visual duplicates from ${label}?\n\nClips with (nearly) identical visuals will be deleted — the oldest clip is kept.`
      )
    ) {
      return;
    }

    // dedupeDuplicateAssets processes the whole archive (or the given ids) server-side in a
    // single call — there's no limit/offset pagination on this procedure, so this no longer
    // loops in batches. grandTotal starts as an estimate for the initial progress display and
    // is replaced with the real scanned count once the single call resolves.
    let grandTotal = targetIds ? targetIds.length : total;
    setDedupeProgress({ scanned: 0, deleted: 0, total: grandTotal });

    try {
      const result = await dedupeDuplicates.mutateAsync({ archiveId, ids: targetIds });
      const totalScanned = result.scanned;
      const totalDeleted = result.deleted;
      setDedupeProgress({ scanned: totalScanned, deleted: totalDeleted, total: totalScanned });

      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();

      if (totalDeleted === 0) {
        toast.info("No duplicates found", { description: `${totalScanned} clip(s) scanned` });
      } else {
        toast.success(`${totalDeleted} duplicate(s) removed`, {
          description: `${totalScanned} clip(s) scanned`,
        });
      }
    } catch (e: unknown) {
      toast.error("Failed to remove duplicates", {
        description: toastErrorMessage(e as Parameters<typeof toastErrorMessage>[0]),
      });
    } finally {
      setDedupeProgress(null);
    }
  }

  if (archiveId == null) {
    return (
      <div className="text-center py-8 text-slate-500 text-sm">
        Select an archive to browse clips.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clips by title or tag..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
          />
        </div>
        {total > 0 && (
          <button
            type="button"
            onClick={runSceneAudit}
            disabled={sceneAuditRunning || autoTitleRunning}
            title="Scan clips: één scène of meerdere shots in één bestand?"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-violet-500/15 text-violet-200 border border-violet-500/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {sceneAuditRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ScanSearch className="w-3.5 h-3.5" />
            )}
            {sceneAuditRunning && sceneAuditProgress
              ? `Scène ${sceneAuditProgress.done}/${sceneAuditProgress.total}`
              : selectedCount > 0
                ? `Scène-check (${selectedCount})`
                : "Scène-check"}
          </button>
        )}
        {multiSceneCount > 0 && (
          <>
            <button
              type="button"
              onClick={trimAllMultiScene}
              disabled={trimRunning || sceneAuditRunning || deletePending}
              title="Knip alle multi-scene clips bij tot de eerste scène"
              className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border transition-colors bg-amber-500/10 text-amber-300 border-amber-500/25 hover:bg-amber-500/20 disabled:opacity-50"
            >
              {trimRunning ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Scissors className="w-3.5 h-3.5" />
              )}
              {trimRunning && trimProgress
                ? `Bijknippen ${trimProgress.done}/${trimProgress.total}`
                : `Knip bij naar 1 scène (${multiSceneCount})`}
            </button>
            <button
              type="button"
              onClick={deleteMultiSceneClips}
              disabled={deletePending || sceneAuditRunning || trimRunning}
              title="Verwijder alle clips die als multi-scene zijn gemarkeerd (na scène-check)"
              className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border transition-colors bg-red-500/10 text-red-300 border-red-500/25 hover:bg-red-500/20 disabled:opacity-50"
            >
              {deletePending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              Verwijder alleen multi scenes ({multiSceneCount})
            </button>
          </>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={runProbeFirstClip}
            disabled={autoTitleRunning || probeRunning || sceneAuditRunning}
            title="Test vision AI on one clip (no save)"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 text-slate-300 border border-white/10 hover:bg-white/15 disabled:opacity-50"
          >
            {probeRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            Test AI (1 clip)
          </button>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={runAutoTitleAll}
            disabled={autoTitleRunning}
            title="AI title + up to 4 English search tags per clip (replaces existing tags)"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 hover:bg-cyan-500/25 disabled:opacity-50"
          >
            {autoTitleRunning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {autoTitleRunning && autoTitleProgress
              ? `AI ${autoTitleProgress.done}/${autoTitleProgress.total}`
              : selectedCount > 0
                ? `AI titles + 4 tags (${selectedCount})`
                : "AI titles + 4 tags"}
          </button>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!confirm("Verwijder alle clips korter dan 1,5s én clips zonder bekende duur?")) return;
              deleteShortAssets.mutate({ archiveId });
            }}
            disabled={deleteShortAssets.isPending || autoTitleRunning}
            title="Verwijdert alle clips onder 1,5 sec en clips zonder bekende duur — geen download nodig"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-300 border border-red-500/25 hover:bg-red-500/25 disabled:opacity-50"
          >
            {deleteShortAssets.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            {deleteShortAssets.isPending ? "Verwijderen…" : "Verwijder korte clips (<1,5s)"}
          </button>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={runRepairDurations}
            disabled={repairDurations.isPending || autoTitleRunning}
            title={
              selectedCount > 0
                ? `Zet 0s / ontbrekende duur op min. 3s voor ${selectedCount} geselecteerde clip(s) (video's via ffprobe; korter dan 3s wordt gedeactiveerd)`
                : "Zet 0s / ontbrekende duur op min. 3s voor het hele archief (video's via ffprobe; korter dan 3s wordt gedeactiveerd)"
            }
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-violet-500/15 text-violet-300 border border-violet-500/25 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {repairDurations.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ScanSearch className="w-3.5 h-3.5" />
            )}
            {repairDurations.isPending
              ? "Duur repareren…"
              : selectedCount > 0
                ? `Fix duur (${selectedCount} geselecteerd)`
                : "Fix 0s duur (hele archief)"}
          </button>
        )}
        {assets.length > 1 && (
          <button
            type="button"
            onClick={dedupeVisualDuplicates}
            disabled={dedupeProgress !== null || autoTitleRunning}
            title="Remove clips with (nearly) identical visuals"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/25 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {dedupeProgress !== null ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {dedupeProgress
              ? `Scanning ${dedupeProgress.scanned}/${dedupeProgress.total}${dedupeProgress.deleted > 0 ? ` (${dedupeProgress.deleted} removed)` : ""}…`
              : "Remove duplicates"}
          </button>
        )}
        {assets.length > 0 && (
          <>
            <button
              type="button"
              onClick={deleteClipsWithLogo}
              disabled={deleteLogoClips.isPending || autoTitleRunning}
              title="Verwijder alle clips met een logo of watermerk (herkend via tags/titel)"
              className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-300 border border-red-500/25 hover:bg-red-500/25 disabled:opacity-50"
            >
              {deleteLogoClips.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Ban className="w-3.5 h-3.5" />
              )}
              {deleteLogoClips.isPending ? "Logo's verwijderen…" : "Verwijder logo-clips"}
            </button>
            {/* "Verwijder 0s clips" hidden — backing server procedure was never implemented
                (see disabled deleteZeroDurationClips hook above). */}
          </>
        )}
        {/* "Herstel verwijderde clips" / "Herstel uit R2" hidden — backing server procedures
            (reindexOrphanedClips, restoreFromS3) were never implemented (see disabled hooks
            above). */}
        <button
          type="button"
          onClick={runRekognitionBulk}
          disabled={rekognitionProgress !== null || autoTitleRunning}
          title="Gebruik AWS Rekognition om bekende personen in clips te herkennen en als tag op te slaan"
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border transition-colors bg-violet-500/10 text-violet-300 border-violet-500/25 hover:bg-violet-500/20 disabled:opacity-50"
        >
          {rekognitionProgress !== null ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ScanSearch className="w-3.5 h-3.5" />
          )}
          {rekognitionProgress !== null
            ? `Rekognition ${rekognitionProgress.scanned}/${rekognitionProgress.total} (${rekognitionProgress.identified} herkend)`
            : "Herken personen (AWS)"}
        </button>
        {assets.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectPage}
            title={`${allPageSelected ? "Deselecteer" : "Selecteer"} de ${pageAssetIds.length} clips op deze pagina`}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 text-slate-300 hover:bg-white/15"
          >
            {allPageSelected ? (
              <CheckSquare className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            {allPageSelected ? "Deselect pagina" : "Selecteer pagina"}
          </button>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            disabled={selectAllLoading}
            title={total > CLIPS_PAGE_SIZE ? `Select all ${total} clips (all pages)` : undefined}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 text-slate-300 hover:bg-white/15 disabled:opacity-50"
          >
            {selectAllLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : allArchiveSelected ? (
              <CheckSquare className="w-3.5 h-3.5" />
            ) : (
              <Square className="w-3.5 h-3.5" />
            )}
            {selectAllLoading
              ? "Selecting…"
              : allArchiveSelected
                ? "Deselect all"
                : total > CLIPS_PAGE_SIZE
                  ? `Select all (${total})`
                  : "Select all"}
          </button>
        )}
        {selectedCount > 0 && (
          <button
            type="button"
            onClick={deleteSelected}
            disabled={deletePending}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/25 disabled:opacity-50"
          >
            {deletePending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Delete ({selectedCount})
          </button>
        )}
      </div>

      {total > 0 && (unavailableCount > 0 || unsupportedCount > 0) && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          {unavailableCount > 0 && (
            <p>
              <strong>{unavailableCount}</strong> clip(s) missen het bestand op de server (vaak na deploy zonder Railway volume) — upload opnieuw of koppel S3.
            </p>
          )}
          {unsupportedCount > 0 && (
            <p className={unavailableCount > 0 ? "mt-1" : ""}>
              <strong>{unsupportedCount}</strong> clip(s) zijn geen MP4/WebM — preview werkt niet in de browser.
            </p>
          )}
        </div>
      )}

      {total > CLIPS_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
          <span>
            Clip {pageStart}–{pageEnd} van {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 0}
              onClick={() => setPage(0)}
              className="px-2 py-1 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15 text-xs"
            >
              «
            </button>
            <button
              type="button"
              disabled={page <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="flex items-center gap-1 px-2 py-1 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Vorige
            </button>
            <span>
              Pagina {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="flex items-center gap-1 px-2 py-1 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15"
            >
              Volgende <ChevronRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={page >= pageCount - 1}
              onClick={() => setPage(pageCount - 1)}
              className="px-2 py-1 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15 text-xs"
            >
              »
            </button>
          </div>
        </div>
      )}

      {sceneAuditReport && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            sceneAuditReport.kind === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-200"
              : sceneAuditReport.kind === "running"
                ? "border-violet-500/30 bg-violet-500/10 text-violet-100"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">{sceneAuditReport.message}</p>
              {sceneAuditReport.detail && (
                <p className="text-xs mt-1 opacity-90 break-words">{sceneAuditReport.detail}</p>
              )}
            </div>
            {sceneAuditReport.kind !== "running" && (
              <button
                type="button"
                onClick={() => setSceneAuditReport(null)}
                className="shrink-0 p-1 rounded hover:bg-white/10 text-slate-400"
                aria-label="Sluiten"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {autoTitleReport && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            autoTitleReport.kind === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-200"
              : autoTitleReport.kind === "running"
                ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-100"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">{autoTitleReport.message}</p>
              {autoTitleReport.detail && (
                <p className="text-xs mt-1 opacity-90 break-words">{autoTitleReport.detail}</p>
              )}
            </div>
            {autoTitleReport.kind !== "running" && (
              <button
                type="button"
                onClick={() => setAutoTitleReport(null)}
                className="shrink-0 p-1 rounded hover:bg-white/10 text-slate-400"
                aria-label="Sluiten"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {!compact && selectedCount > 0 && (
        <p className="text-xs text-purple-300">{selectedCount} clip(s) selected</p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-purple-400" /></div>
      ) : assets.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          No clips in this archive.
        </div>
      ) : (
        <>
        <div className={`grid gap-4 ${compact ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
          {assets.map((asset) => (
            <AssetCard
              key={`${asset.id}-${(asset.tags ?? []).join("|")}`}
              asset={asset as ArchiveAsset}
              archiveId={archiveId!}
              sceneAudit={sceneAuditMap[asset.id]}
              selected={selectedIds.has(asset.id)}
              onToggleSelect={() => toggleSelect(asset.id)}
              onDelete={() => {
                if (confirm("Delete this clip?")) deleteAsset.mutate({ id: asset.id });
              }}
              onSave={(patch) => updateAsset.mutate({ id: asset.id, ...patch })}
              onTrimmed={(assetId, newDurationSec) => {
                utils.mediaArchive.listAssets.invalidate({ archiveId: archiveId! });
                setSceneAuditMap((prev) => {
                  const entry = prev[assetId];
                  if (!entry) return prev;
                  return { ...prev, [assetId]: { ...entry, status: "single_scene", sceneCount: 1, interiorCutCount: 0, cutTimesSec: [], durationSec: newDurationSec } };
                });
              }}
              onRefresh={() => utils.mediaArchive.listAssets.invalidate({ archiveId: archiveId! })}
              saving={updateAsset.isPending}
            />
          ))}
        </div>
        {total > CLIPS_PAGE_SIZE && (
          <div className="flex justify-center pt-2">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <button
                type="button"
                disabled={page <= 0}
                onClick={() => setPage(0)}
                className="px-2 py-1.5 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15"
              >
                «
              </button>
              <button
                type="button"
                disabled={page <= 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="px-3 py-1.5 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15"
              >
                Vorige
              </button>
              <span>Pagina {page + 1} / {pageCount}</span>
              <button
                type="button"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                className="px-3 py-1.5 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15"
              >
                Volgende
              </button>
              <button
                type="button"
                disabled={page >= pageCount - 1}
                onClick={() => setPage(pageCount - 1)}
                className="px-2 py-1.5 rounded bg-white/10 disabled:opacity-40 hover:bg-white/15"
              >
                »
              </button>
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
