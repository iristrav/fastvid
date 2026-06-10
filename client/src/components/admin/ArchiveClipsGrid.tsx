/**
 * Browse, preview, multi-select and delete media archive clips.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import {
  Loader2, Trash2, Pencil, Search, Film, Image as ImageIcon, X, Play, ExternalLink, CheckSquare, Square, Sparkles,
} from "lucide-react";

const MIX_KINDS = [
  { value: "real_video", label: "Echte video" },
  { value: "photo", label: "Foto" },
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
};

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

function archiveClipMediaUrl(assetId: number): string {
  return `/api/admin/archive/media/${assetId}`;
}

function AssetPreviewModal({
  asset,
  onClose,
}: {
  asset: ArchiveAsset;
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
            <h3 className="text-white font-semibold truncate">{asset.title || "Naamloos"}</h3>
            {asset.sourceNote && (
              <p className="text-xs text-slate-400 truncate mt-0.5">{asset.sourceNote}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={archiveClipMediaUrl(asset.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-lg bg-white/10 text-slate-300 hover:text-white hover:bg-white/15"
              title="Open in nieuw tabblad"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            <button onClick={onClose} className="p-2 rounded-lg bg-white/10 text-slate-300 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="bg-black flex items-center justify-center max-h-[75vh]">
          {asset.mediaType === "video" ? (
            <video
              src={archiveClipMediaUrl(asset.id)}
              controls
              autoPlay
              playsInline
              className="w-full max-h-[75vh] object-contain"
            />
          ) : (
              <img src={archiveClipMediaUrl(asset.id)} alt={asset.title ?? ""} className="w-full max-h-[75vh] object-contain" />
          )}
        </div>
        {asset.durationSec != null && asset.durationSec > 0 && (
          <div className="px-4 py-2 text-xs text-slate-500 border-t border-white/10">
            Duur: {formatDuration(asset.durationSec)}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetCard({
  asset,
  selected,
  onToggleSelect,
  onDelete,
  onSave,
  saving,
}: {
  asset: ArchiveAsset;
  selected: boolean;
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

  return (
    <>
      {previewOpen && <AssetPreviewModal asset={asset} onClose={() => setPreviewOpen(false)} />}
      <div
        className={`glass-card border rounded-xl overflow-hidden transition-colors ${
          selected ? "border-purple-500/60 ring-1 ring-purple-500/40" : "border-white/8"
        }`}
      >
        <div className="relative">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="aspect-video bg-black/40 relative flex items-center justify-center w-full group cursor-pointer"
          >
            {asset.mediaType === "video" ? (
              <video
                src={archiveClipMediaUrl(asset.id)}
                className="w-full h-full object-cover"
                muted
                playsInline
                preload="metadata"
              />
            ) : (
              <img src={archiveClipMediaUrl(asset.id)} alt={asset.title ?? ""} className="w-full h-full object-cover" />
            )}
            <span className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <span className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/70 text-white text-xs font-medium">
                <Play className="w-4 h-4 fill-white" />
                Bekijken
              </span>
            </span>
            <span className="absolute top-2 left-2 flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-black/60 text-white">
              {asset.mediaType === "video" ? <Film className="w-3 h-3" /> : <ImageIcon className="w-3 h-3" />}
              {asset.mediaType}
            </span>
            {asset.durationSec != null && asset.durationSec > 0 && (
              <span className="absolute bottom-2 right-2 text-xs px-2 py-0.5 rounded bg-black/70 text-white">
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
            title={selected ? "Deselecteren" : "Selecteren"}
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
                placeholder="Titel"
              />
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white"
                placeholder="tags, komma-gescheiden"
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
                  Opslaan
                </button>
                <button onClick={() => setEditing(false)} className="px-2 py-1 text-xs text-slate-400">
                  <X className="w-3 h-3" />
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-white font-medium truncate">{asset.title || "Naamloos"}</p>
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
                  title="Bekijken"
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data: assets = [], isLoading } = trpc.mediaArchive.listAssets.useQuery(
    { archiveId: archiveId!, search: search || undefined },
    { enabled: archiveId != null }
  );

  const updateAsset = trpc.mediaArchive.updateAsset.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listAssets.invalidate();
      toast.success("Clip bijgewerkt!");
    },
    onError: (e) => toast.error("Opslaan mislukt", { description: toastErrorMessage(e) }),
  });

  const deleteAsset = trpc.mediaArchive.deleteAsset.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      toast.success("Clip verwijderd");
    },
    onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  });

  const deleteAssets = trpc.mediaArchive.deleteAssets.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      setSelectedIds(new Set());
      toast.success(`${data.deleted} clip(s) verwijderd`);
    },
    onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  });

  const deleteAllAssets = trpc.mediaArchive.deleteAllAssets.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      setSelectedIds(new Set());
      toast.success(`${data.deleted} clip(s) verwijderd`);
    },
    onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  });

  const autoTitleAssets = trpc.mediaArchive.autoTitleAssets.useMutation();
  const [autoTitleRunning, setAutoTitleRunning] = useState(false);
  const [autoTitleProgress, setAutoTitleProgress] = useState<{ done: number; total: number } | null>(null);

  async function runAutoTitleAll() {
    if (archiveId == null || assets.length === 0) return;

    const targetIds =
      selectedCount > 0
        ? [...selectedIds].filter((id) => visibleIds.has(id))
        : assets.map((a) => a.id);

    if (targetIds.length === 0) return;

    const label =
      selectedCount > 0
        ? `${targetIds.length} geselecteerde clip(s)`
        : search.trim()
          ? `${targetIds.length} zichtbare clip(s)`
          : `alle ${targetIds.length} clip(s)`;

    if (
      !confirm(
        `AI bekijkt ${label} en geeft elke clip een titel + zoek-tags op basis van wat er in beeld staat.\n\nBestaande tags worden aangevuld. Doorgaan?`
      )
    ) {
      return;
    }

    const CHUNK = 20;
    setAutoTitleRunning(true);
    setAutoTitleProgress({ done: 0, total: targetIds.length });
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    try {
      for (let i = 0; i < targetIds.length; i += CHUNK) {
        const chunk = targetIds.slice(i, i + CHUNK);
        const result = await autoTitleAssets.mutateAsync({ archiveId, ids: chunk });
        updated += result.updated;
        skipped += result.skipped;
        failed += result.failed;
        setAutoTitleProgress({ done: Math.min(i + chunk.length, targetIds.length), total: targetIds.length });
      }
      utils.mediaArchive.listAssets.invalidate();
      utils.mediaArchive.listArchives.invalidate();
      toast.success(`${updated} clip(s) getiteld`, {
        description:
          skipped + failed > 0
            ? `${skipped} overgeslagen, ${failed} mislukt`
            : "Titels en tags bijgewerkt voor betere filtering",
      });
    } catch (e) {
      toast.error("AI titels mislukt", { description: toastErrorMessage(e) });
    } finally {
      setAutoTitleRunning(false);
      setAutoTitleProgress(null);
    }
  }

  useEffect(() => {
    setSelectedIds(new Set());
  }, [archiveId, search]);

  const visibleIds = useMemo(() => new Set(assets.map((a) => a.id)), [assets]);
  const selectedCount = [...selectedIds].filter((id) => visibleIds.has(id)).length;
  const allSelected = assets.length > 0 && selectedCount === assets.length;

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
    if (!confirm(`${ids.length} clip(s) definitief verwijderen?`)) return;

    if (allSelected) {
      deleteAllAssets.mutate({ archiveId, search: search.trim() || undefined });
      return;
    }
    deleteAssets.mutate({ ids });
  }

  const deletePending = deleteAssets.isPending || deleteAllAssets.isPending;

  if (archiveId == null) {
    return (
      <div className="text-center py-8 text-slate-500 text-sm">
        Selecteer een archief om clips te bekijken.
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
            placeholder="Zoek clips op titel of tag..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
          />
        </div>
        {assets.length > 0 && (
          <button
            type="button"
            onClick={runAutoTitleAll}
            disabled={autoTitleRunning}
            title="AI bekijkt clips en geeft titels + tags op basis van beeldinhoud"
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
                ? `AI titels (${selectedCount})`
                : "AI titels & tags"}
          </button>
        )}
        {assets.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-white/10 text-slate-300 hover:bg-white/15"
          >
            {allSelected ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
            {allSelected ? "Deselecteer alles" : "Selecteer alles"}
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
            Verwijder ({selectedCount})
          </button>
        )}
      </div>

      {!compact && selectedCount > 0 && (
        <p className="text-xs text-purple-300">{selectedCount} clip(s) geselecteerd</p>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-purple-400" /></div>
      ) : assets.length === 0 ? (
        <div className="text-center py-12 text-slate-500 text-sm">Geen clips in dit archief.</div>
      ) : (
        <div className={`grid gap-4 ${compact ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
          {assets.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset as ArchiveAsset}
              selected={selectedIds.has(asset.id)}
              onToggleSelect={() => toggleSelect(asset.id)}
              onDelete={() => {
                if (confirm("Deze clip verwijderen?")) deleteAsset.mutate({ id: asset.id });
              }}
              onSave={(patch) => updateAsset.mutate({ id: asset.id, ...patch })}
              saving={updateAsset.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
