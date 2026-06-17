/**
 * Browse, preview, multi-select and delete media archive clips.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import {
  Loader2, Trash2, Pencil, Search, Film, Image as ImageIcon, X, Play, ExternalLink, CheckSquare, Square, Sparkles, Copy, AlertTriangle, ChevronLeft, ChevronRight, ScanSearch,
} from "lucide-react";

const CLIPS_PAGE_SIZE = 48;

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

  useEffect(() => {
    setLoadError(false);
    if (!canLoad) {
      setSrc(null);
      return;
    }
    if (mode === "preview") {
      setSrc(archiveClipMediaUrl(asset.id));
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSrc(archiveClipMediaUrl(asset.id));
          obs.disconnect();
        }
      },
      { rootMargin: "240px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [asset.id, canLoad, mode]);

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
          className={`w-full h-full ${mode === "preview" ? "object-contain max-h-[75vh]" : "object-cover"}`}
          muted
          playsInline
          preload={mode === "preview" ? "auto" : "metadata"}
          controls={mode === "preview"}
          autoPlay={mode === "preview"}
          onError={() => setLoadError(true)}
        />
      </div>
    );
  }

  return (
    <div ref={containerRef} className={className}>
      <img
        src={src ?? undefined}
        alt={asset.title ?? ""}
        className="w-full h-full object-cover"
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
}: {
  asset: ArchiveAsset;
  sceneAudit?: SceneAuditEntry;
  onClose: () => void;
}) {
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
            <h3 className="text-white font-semibold truncate">{asset.title || "Untitled"}</h3>
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
        <div className="bg-black flex items-center justify-center max-h-[75vh] min-h-[200px]">
          <LazyArchiveMedia
            asset={asset}
            mode="preview"
            className="w-full max-h-[75vh] flex items-center justify-center"
          />
        </div>
        {asset.durationSec != null && asset.durationSec > 0 && (
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
  selected,
  sceneAudit,
  onToggleSelect,
  onDelete,
  onSave,
  saving,
}: {
  asset: ArchiveAsset;
  selected: boolean;
  sceneAudit?: SceneAuditEntry;
  onToggleSelect: () => void;
  onDelete: () => void;
  onSave: (patch: { title?: string; tags?: string[]; mixKind?: MixKind; sourceNote?: string }) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [title, setTitle] = useState(asset.title ?? "");
  const [tags, setTags] = useState(tagsToInput(asset.tags));
  const [mixKind, setMixKind] = useState<MixKind>(asset.mixKind);
  const [sourceNote, setSourceNote] = useState(asset.sourceNote ?? "");

  useEffect(() => {
    setTitle(asset.title ?? "");
    setTags(tagsToInput(asset.tags));
    setMixKind(asset.mixKind);
    setSourceNote(asset.sourceNote ?? "");
  }, [asset.id, asset.title, asset.tags, asset.mixKind, asset.sourceNote]);

  return (
    <>
      {previewOpen && (
        <AssetPreviewModal asset={asset} sceneAudit={sceneAudit} onClose={() => setPreviewOpen(false)} />
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
            className={`absolute top-2 right-2 p-1.5 rounded-md border transition-colors ${
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
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white"
                placeholder="Title"
              />
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
                      title: title.trim(),
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
              <p className="text-sm text-white font-medium truncate">{asset.title || "Untitled"}</p>
              {asset.sourceNote && (
                <p className="text-xs text-slate-500 line-clamp-2">{asset.sourceNote}</p>
              )}
              {asset.tags && asset.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {asset.tags.map((t) => (
                    <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-slate-300">{t}</span>
                  ))}
                </div>
              )}
              <div className="flex gap-1 pt-1">
                <button
                  onClick={() => setPreviewOpen(true)}
                  className="text-xs px-2 py-1 rounded bg-cyan-500/15 text-cyan-300 hover:bg-cyan-500/25"
                  title="View"
                >
                  <Play className="w-3 h-3 inline" />
                </button>
                <button onClick={() => setEditing(true)} className="text-xs px-2 py-1 rounded bg-white/10 text-slate-300 hover:bg-white/15">
                  <Pencil className="w-3 h-3 inline" />
                </button>
                <button onClick={onDelete} className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20">
                  <Trash2 className="w-3 h-3 inline" />
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
  const [showMultiSceneOnly, setShowMultiSceneOnly] = useState(false);
  const [sceneAuditRunning, setSceneAuditRunning] = useState(false);
  const [sceneAuditProgress, setSceneAuditProgress] = useState<{ done: number; total: number } | null>(null);
  const [sceneAuditReport, setSceneAuditReport] = useState<{
    kind: "running" | "done" | "error";
    message: string;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    setPage(0);
    setSceneAuditMap({});
    setShowMultiSceneOnly(false);
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
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      setSelectedIds(new Set());
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

  const autoTitleAssets = trpc.mediaArchive.autoTitleAssets.useMutation();
  const auditScenes = trpc.mediaArchive.auditScenes.useMutation();
  const dedupeDuplicates = trpc.mediaArchive.dedupeDuplicateAssets.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      if (data.deleted === 0) {
        toast.info("No duplicates found", { description: `${data.scanned} clip(s) scanned` });
      } else {
        toast.success(`${data.deleted} duplicate(s) removed`, {
          description: `${data.kept} unique clip(s) remaining`,
        });
      }
    },
    onError: (e) => toast.error("Failed to remove duplicates", { description: toastErrorMessage(e) }),
  });
  const [autoTitleRunning, setAutoTitleRunning] = useState(false);
  const [autoTitleProgress, setAutoTitleProgress] = useState<{ done: number; total: number } | null>(null);
  const [autoTitleReport, setAutoTitleReport] = useState<{
    kind: "running" | "done" | "error";
    message: string;
    detail?: string;
  } | null>(null);
  const [probeRunning, setProbeRunning] = useState(false);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [archiveId, search, page]);

  const visibleIds = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const selectedCount = [...selectedIds].filter((id) => visibleIds.has(id)).length;
  const allSelected = assets.length > 0 && selectedCount === assets.length;

  const multiSceneCount = useMemo(
    () => Object.values(sceneAuditMap).filter((e) => e.status === "multi_scene").length,
    [sceneAuditMap]
  );

  const displayedAssets = useMemo(() => {
    if (!showMultiSceneOnly) return assets;
    return assets.filter((a) => sceneAuditMap[a.id]?.status === "multi_scene");
  }, [assets, sceneAuditMap, showMultiSceneOnly]);

  const runSceneAudit = useCallback(async () => {
    if (archiveId == null || total === 0) {
      toast.error("Geen clips om te scannen");
      return;
    }

    let targetIds: number[];
    if (selectedCount > 0) {
      targetIds = [...selectedIds].filter((id) => visibleIds.has(id));
    } else {
      const full = await utils.mediaArchive.listAssets.fetch({
        archiveId,
        search: search || undefined,
        limit: 10000,
        offset: 0,
      });
      targetIds = full.items.filter((a) => a.mediaType === "video").map((a) => a.id);
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
            ? `${failed} clip(s) niet geanalyseerd (bestand ontbreekt of FFmpeg-fout). Filter op multi-scene om ze te vinden.`
            : multiScene > 0
              ? "Gebruik filter “Alleen multi-scene” of verwijder/herupload die clips."
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
    visibleIds,
  ]);

  const runAutoTitleAll = useCallback(async () => {
    if (archiveId == null || total === 0) {
      toast.error("No clips to process");
      return;
    }

    const targetIds =
      selectedCount > 0
        ? [...selectedIds].filter((id) => visibleIds.has(id))
        : undefined;

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
      const full = await utils.mediaArchive.listAssets.fetch({
        archiveId: archiveId!,
        search: search || undefined,
        limit: 10000,
        offset: 0,
      });
      resolvedIds = full.items.map((a) => a.id);
    }

    if (resolvedIds.length === 0) {
      toast.error("No clips to process");
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
    let lastSkipReasons:
      | {
          missingAsset: number;
          fileMissing: number;
          downloadFailed: number;
          noFrames: number;
          noVision: number;
          llmFailed: number;
        }
      | undefined;
    let lastSampleError: string | undefined;
    let lastSampleUpdate: { assetId: number; title: string; tags: string[] } | undefined;

    try {
      for (let i = 0; i < resolvedIds.length; i += CHUNK) {
        const chunk = resolvedIds.slice(i, i + CHUNK);
        const result = await autoTitleAssets.mutateAsync({ archiveId, ids: chunk });
        updated += result.updated;
        skipped += result.skipped;
        failed += result.failed;
        if (result.skipReasons) lastSkipReasons = result.skipReasons;
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
        skipReasons: lastSkipReasons,
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
    visibleIds,
  ]);

  const runProbeFirstClip = useCallback(async () => {
    if (archiveId == null || assets.length === 0) {
      toast.error("Geen clips om te testen");
      return;
    }
    const assetId =
      selectedCount > 0
        ? [...selectedIds].find((id) => visibleIds.has(id)) ?? assets[0]!.id
        : assets[0]!.id;
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
  }, [archiveId, assets, selectedCount, selectedIds, utils.mediaArchive.probeAiTag, visibleIds]);

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(assets.map((a) => a.id)));
    }
  }

  function deleteSelected() {
    const ids = [...selectedIds].filter((id) => visibleIds.has(id));
    if (ids.length === 0 || archiveId == null) return;
    if (!confirm(`Permanently delete ${ids.length} clip(s)?`)) return;

    if (allSelected) {
      deleteAllAssets.mutate({ archiveId, search: search.trim() || undefined });
      return;
    }
    deleteAssets.mutate({ ids });
  }

  const deletePending = deleteAssets.isPending || deleteAllAssets.isPending;

  function dedupeVisualDuplicates() {
    if (archiveId == null || total < 2) return;
    const targetIds =
      selectedCount > 0
        ? [...selectedIds].filter((id) => visibleIds.has(id))
        : assets.map((a) => a.id);
    const label =
      selectedCount > 0 ? `${targetIds.length} selected clip(s)` : `all ${targetIds.length} clip(s)`;
    if (
      !confirm(
        `Remove visual duplicates from ${label}?\n\nClips with (nearly) identical visuals will be deleted — the oldest clip is kept.`
      )
    ) {
      return;
    }
    dedupeDuplicates.mutate({
      archiveId,
      ids: selectedCount > 0 ? targetIds : undefined,
    });
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
          <button
            type="button"
            onClick={() => setShowMultiSceneOnly((v) => !v)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border transition-colors ${
              showMultiSceneOnly
                ? "bg-red-500/25 text-red-200 border-red-500/40"
                : "bg-red-500/10 text-red-300 border-red-500/25 hover:bg-red-500/20"
            }`}
          >
            Alleen multi-scene ({multiSceneCount})
          </button>
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
        {assets.length > 1 && (
          <button
            type="button"
            onClick={dedupeVisualDuplicates}
            disabled={dedupeDuplicates.isPending || autoTitleRunning}
            title="Remove clips with (nearly) identical visuals"
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/25 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {dedupeDuplicates.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {dedupeDuplicates.isPending ? "Duplicates…" : "Remove duplicates"}
          </button>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 text-slate-300 hover:bg-white/15"
          >
            {allSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            {allSelected ? "Deselect all" : "Select all"}
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
      ) : displayedAssets.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">
          {showMultiSceneOnly
            ? "Geen multi-scene clips op deze pagina — run scène-check op alle clips."
            : "No clips in this archive."}
        </div>
      ) : (
        <>
        <div className={`grid gap-4 ${compact ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
          {displayedAssets.map((asset) => (
            <AssetCard
              key={`${asset.id}-${(asset.tags ?? []).join("|")}`}
              asset={asset as ArchiveAsset}
              sceneAudit={sceneAuditMap[asset.id]}
              selected={selectedIds.has(asset.id)}
              onToggleSelect={() => toggleSelect(asset.id)}
              onDelete={() => {
                if (confirm("Delete this clip?")) deleteAsset.mutate({ id: asset.id });
              }}
              onSave={(patch) => updateAsset.mutate({ id: asset.id, ...patch })}
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
            </div>
          </div>
        )}
        </>
      )}
    </div>
  );
}
