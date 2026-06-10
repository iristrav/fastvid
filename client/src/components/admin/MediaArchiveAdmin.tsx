/**
 * Admin panel — curated media archives (videos + images with tags)
 */
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import {
  Archive, Plus, Loader2, Trash2, Pencil, Upload, Tag,
} from "lucide-react";
import { ArchiveClipsGrid } from "@/components/admin/ArchiveClipsGrid";

const MIX_KINDS = [
  { value: "real_video", label: "Echte video" },
  { value: "photo", label: "Foto" },
  { value: "stock", label: "Stock" },
  { value: "screenshot", label: "Screenshot" },
  { value: "motion_graphics", label: "Motion graphics" },
] as const;

type MixKind = typeof MIX_KINDS[number]["value"];

function parseTagsInput(raw: string): string[] {
  return raw.split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
}

function guessFileMime(file: File): string {
  if (file.type.startsWith("video/") || file.type.startsWith("image/")) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return ext ? (map[ext] ?? "") : "";
}

function tagsToInput(tags: string[] | null | undefined): string {
  return (tags ?? []).join(", ");
}

type ArchiveUploadResponse = {
  clipCount: number;
  split: boolean;
};

type ArchiveUploadProgress = {
  jobId: string;
  filename?: string;
  stage: string;
  message: string;
  percent: number;
  clipIndex?: number;
  clipTotal?: number;
  clipsSaved?: number;
  done: boolean;
  error?: string;
};

const STAGE_LABELS: Record<string, string> = {
  queued: "Wachtrij",
  validating: "Controleren",
  split_ffmpeg: "FFmpeg",
  split_probe: "Duur meten",
  split_detect: "Shots detecteren",
  split_rescan: "Extra cuts",
  split_extract: "Clips knippen",
  filter_overlay: "Tekstfilter",
  ai_tags: "AI-tags",
  save_clips: "Opslaan",
  done: "Klaar",
  error: "Fout",
};

function newUploadJobId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function pollArchiveUploadProgress(jobId: string): Promise<ArchiveUploadProgress | null> {
  const res = await fetch(`/api/admin/archive/upload/progress?jobId=${encodeURIComponent(jobId)}`, {
    credentials: "include",
  });
  if (!res.ok) return null;
  return res.json() as Promise<ArchiveUploadProgress>;
}

async function uploadArchiveFile(
  file: File,
  opts: {
    archiveId: number;
    mimeType: string;
    mixKind: MixKind;
    tags: string[];
    autoSplitScenes: boolean;
    autoGenerateTags: boolean;
    jobId: string;
    onProgress?: (progress: ArchiveUploadProgress) => void;
  }
): Promise<ArchiveUploadResponse> {
  const params = new URLSearchParams({
    jobId: opts.jobId,
    archiveId: String(opts.archiveId),
    filename: file.name,
    mimeType: opts.mimeType,
    mixKind: opts.mixKind,
    tags: opts.tags.join(","),
    autoSplitScenes: opts.autoSplitScenes ? "true" : "false",
    autoGenerateTags: opts.autoGenerateTags ? "true" : "false",
  });

  const pollTimer = window.setInterval(async () => {
    const progress = await pollArchiveUploadProgress(opts.jobId);
    if (progress) opts.onProgress?.(progress);
  }, 700);

  try {
    const res = await fetch(`/api/admin/archive/upload?${params}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": opts.mimeType || "application/octet-stream" },
      body: file,
    });

    const text = await res.text();
    let data: { error?: string; clipCount?: number; split?: boolean } | null = null;
    try {
      data = JSON.parse(text) as { error?: string; clipCount?: number; split?: boolean };
    } catch {
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        throw new Error(
          "Server stuurde een HTML-foutpagina (bestand te groot of timeout). Probeer een kleiner bestand of zet AI-tags uit."
        );
      }
      throw new Error(text.slice(0, 180) || "Upload mislukt");
    }

    if (!res.ok) {
      throw new Error(data?.error || "Upload mislukt");
    }

    const finalProgress = await pollArchiveUploadProgress(opts.jobId);
    if (finalProgress) opts.onProgress?.(finalProgress);

    return {
      clipCount: data?.clipCount ?? 1,
      split: Boolean(data?.split),
    };
  } finally {
    window.clearInterval(pollTimer);
  }
}

export function MediaArchiveAdmin() {
  const utils = trpc.useUtils();
  const { data: archives = [], isLoading: archivesLoading } = trpc.mediaArchive.listArchives.useQuery();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editArchiveId, setEditArchiveId] = useState<number | null>(null);
  const [uploadTags, setUploadTags] = useState("");
  const [uploadMixKind, setUploadMixKind] = useState<MixKind>("photo");
  const [autoSplitScenes, setAutoSplitScenes] = useState(true);
  const [autoGenerateTags, setAutoGenerateTags] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<ArchiveUploadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeArchiveId = selectedId ?? archives[0]?.id ?? null;

  const createArchive = trpc.mediaArchive.createArchive.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listArchives.invalidate();
      setShowCreateForm(false);
      if (data.archive?.id) setSelectedId(data.archive.id);
      toast.success("Archief aangemaakt!");
    },
    onError: (e) => toast.error("Archief aanmaken mislukt", { description: toastErrorMessage(e) }),
  });

  const updateArchive = trpc.mediaArchive.updateArchive.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listArchives.invalidate();
      setEditArchiveId(null);
      toast.success("Archief bijgewerkt!");
    },
    onError: (e) => toast.error("Opslaan mislukt", { description: toastErrorMessage(e) }),
  });

  const deleteArchive = trpc.mediaArchive.deleteArchive.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listArchives.invalidate();
      setSelectedId(null);
      toast.success("Archief verwijderd");
    },
    onError: (e) => toast.error("Verwijderen mislukt", { description: toastErrorMessage(e) }),
  });

  const selectedArchive = archives.find((a) => a.id === activeArchiveId);

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    if (!activeArchiveId) {
      toast.error("Maak eerst een archief aan");
      return;
    }
    setUploading(true);
    setUploadProgress(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > 600 * 1024 * 1024) {
          toast.error(`${file.name}: te groot (max 600MB / ~20 min video)`);
          continue;
        }
        const mimeType = guessFileMime(file);
        if (!mimeType.startsWith("video/") && !mimeType.startsWith("image/")) {
          toast.error(`${file.name}: alleen video of afbeelding (MP4, JPG, PNG, …)`);
          continue;
        }
        const isVideo = mimeType.startsWith("video/");
        const mixKind = isVideo ? "real_video" : uploadMixKind;
        const jobId = newUploadJobId();
        setUploadProgress({
          jobId,
          filename: file.name,
          stage: "queued",
          message: `${file.name}: uploaden…`,
          percent: 0,
          done: false,
        });
        const result = await uploadArchiveFile(file, {
          archiveId: activeArchiveId,
          mimeType,
          mixKind,
          tags: parseTagsInput(uploadTags),
          autoSplitScenes: isVideo ? autoSplitScenes : false,
          autoGenerateTags,
          jobId,
          onProgress: setUploadProgress,
        });
        utils.mediaArchive.listAssets.invalidate();
        utils.mediaArchive.listArchives.invalidate();
        if (isVideo && autoSplitScenes && result.clipCount > 1) {
          toast.success(`${file.name}: ${result.clipCount} clips aangemaakt (shot/scène-wisselingen)`);
        } else if (isVideo && autoSplitScenes) {
          toast.success(`${file.name}: 1 clip opgeslagen`);
        } else {
          toast.success(`${file.name} geüpload`);
        }
      }
      setUploadTags("");
    } catch (e) {
      toast.error("Upload mislukt", { description: toastErrorMessage(e) });
    } finally {
      setUploading(false);
      window.setTimeout(() => setUploadProgress(null), 8000);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
            Media <span className="gradient-text">Archief</span>
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Maak niche-archieven met video&apos;s en foto&apos;s. Lange video&apos;s worden geknipt op elke shot/scène-wisseling — geen vaste intervallen.
          </p>
        </div>
        <button
          onClick={() => { setShowCreateForm(true); setEditArchiveId(null); }}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="w-4 h-4" /> Nieuw archief
        </button>
      </div>

      {(showCreateForm || editArchiveId != null) && (
        <ArchiveForm
          initial={editArchiveId != null ? archives.find((a) => a.id === editArchiveId) : undefined}
          saving={createArchive.isPending || updateArchive.isPending}
          onCancel={() => { setShowCreateForm(false); setEditArchiveId(null); }}
          onSave={(data) => {
            if (editArchiveId != null) {
              updateArchive.mutate({ id: editArchiveId, ...data });
            } else {
              createArchive.mutate(data);
            }
          }}
        />
      )}

      <div className="grid lg:grid-cols-[240px_1fr] gap-6">
        {/* Archive list */}
        <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
          <div className="p-3 border-b border-white/8">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Archieven</p>
          </div>
          {archivesLoading ? (
            <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-purple-400" /></div>
          ) : archives.length === 0 ? (
            <div className="p-6 text-center text-slate-500 text-sm">Nog geen archieven</div>
          ) : (
            <ul className="divide-y divide-white/5">
              {archives.map((a) => (
                <li key={a.id}>
                  <button
                    onClick={() => setSelectedId(a.id)}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      activeArchiveId === a.id ? "bg-purple-600/15 text-white" : "text-slate-300 hover:bg-white/5"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Archive className="w-4 h-4 text-purple-400 shrink-0" />
                      <span className="font-medium text-sm truncate">{a.name}</span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 ml-6">{a.assetCount} bestanden</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Assets panel */}
        <div className="space-y-4">
          {!activeArchiveId ? (
            <div className="glass-card border border-white/8 rounded-xl p-12 text-center text-slate-500">
              Maak een archief om video&apos;s en afbeeldingen te uploaden.
            </div>
          ) : (
            <>
              <div className="glass-card border border-white/8 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white">{selectedArchive?.name}</h3>
                  {selectedArchive?.description && (
                    <p className="text-xs text-slate-400 mt-1">{selectedArchive.description}</p>
                  )}
                  {selectedArchive?.nicheTags && selectedArchive.nicheTags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {selectedArchive.nicheTags.map((t) => (
                        <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">{t}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setEditArchiveId(activeArchiveId)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-white/10 text-slate-300 hover:bg-white/15"
                  >
                    <Pencil className="w-3 h-3" /> Bewerken
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Archief "${selectedArchive?.name}" en alle bestanden verwijderen?`)) {
                        deleteArchive.mutate({ id: activeArchiveId });
                      }
                    }}
                    disabled={deleteArchive.isPending}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
                  >
                    <Trash2 className="w-3 h-3" /> Verwijderen
                  </button>
                </div>
              </div>

              {/* Upload zone */}
              <div className="glass-card border border-white/8 rounded-xl p-5 space-y-4">
                <h4 className="font-medium text-white flex items-center gap-2">
                  <Upload className="w-4 h-4 text-cyan-400" /> Uploaden
                </h4>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Tags voor nieuwe uploads (komma-gescheiden)</label>
                    <input
                      type="text"
                      value={uploadTags}
                      onChange={(e) => setUploadTags(e.target.value)}
                      placeholder="bijv. titanic, dek, 1912"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Type (voor foto&apos;s)</label>
                    <select
                      value={uploadMixKind}
                      onChange={(e) => setUploadMixKind(e.target.value as MixKind)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
                    >
                      {MIX_KINDS.map((k) => (
                        <option key={k.value} value={k.value} className="bg-slate-900">{k.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoGenerateTags}
                    onChange={(e) => setAutoGenerateTags(e.target.checked)}
                    className="rounded border-white/20 bg-white/5 text-purple-600 focus:ring-purple-500"
                  />
                  AI-tags en beschrijving uit beeld (LLM vision)
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoSplitScenes}
                    onChange={(e) => setAutoSplitScenes(e.target.checked)}
                    className="rounded border-white/20 bg-white/5 text-purple-600 focus:ring-purple-500"
                  />
                  Automatisch knippen op shot/scène-wisseling (scdet — detecteert echte beeldcuts)
                </label>

                {uploadProgress && (
                  <div className="rounded-xl border border-purple-500/25 bg-purple-500/5 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-white truncate max-w-[70%]">
                        {uploadProgress.filename ?? "Upload"}
                      </p>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-purple-200">
                        {STAGE_LABELS[uploadProgress.stage] ?? uploadProgress.stage}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          uploadProgress.stage === "error" ? "bg-red-500" : "bg-gradient-to-r from-purple-500 to-cyan-500"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, uploadProgress.percent))}%` }}
                      />
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">{uploadProgress.message}</p>
                    {uploadProgress.clipTotal != null && uploadProgress.clipTotal > 0 && (
                      <p className="text-[11px] text-slate-500">
                        Clip {uploadProgress.clipIndex ?? uploadProgress.clipsSaved ?? 0}/{uploadProgress.clipTotal}
                        {uploadProgress.clipsSaved != null ? ` · ${uploadProgress.clipsSaved} opgeslagen` : ""}
                      </p>
                    )}
                  </div>
                )}

                <label
                  className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-8 cursor-pointer transition-colors ${
                    uploading ? "border-purple-500/30 bg-purple-500/5" : "border-white/15 hover:border-purple-500/40 hover:bg-white/3"
                  }`}
                >
                  {uploading ? (
                    <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                  ) : (
                    <Upload className="w-8 h-8 text-slate-500" />
                  )}
                  <span className="text-sm text-slate-400">
                    Sleep bestanden hierheen of klik om te kiezen
                  </span>
                  <span className="text-xs text-slate-600">MP4, WebM, JPG, PNG — max 600MB (video tot ~20 min)</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="video/*,image/*,.mp4,.webm,.mov,.mkv,.jpg,.jpeg,.png,.gif,.webp"
                    className="hidden"
                    onChange={(e) => handleFiles(e.target.files)}
                  />
                </label>
              </div>

              <ArchiveClipsGrid archiveId={activeArchiveId} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ArchiveForm({
  initial,
  onSave,
  onCancel,
  saving,
}: {
  initial?: { name: string; description?: string | null; nicheTags?: string[] | null };
  onSave: (data: { name: string; description?: string; nicheTags: string[] }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [nicheTags, setNicheTags] = useState(tagsToInput(initial?.nicheTags));

  return (
    <div className="glass-card border border-purple-500/20 rounded-xl p-5 space-y-4">
      <h3 className="font-bold text-white">{initial ? "Archief bewerken" : "Nieuw archief"}</h3>
      <div>
        <label className="text-xs text-slate-400 mb-1 block">Naam *</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="bijv. Titanic / Maritiem"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 mb-1 block">Beschrijving</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Waar is dit archief voor?"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 mb-1 block flex items-center gap-1">
          <Tag className="w-3 h-3" /> Onderwerp-tags (komma-gescheiden)
        </label>
        <input
          value={nicheTags}
          onChange={(e) => setNicheTags(e.target.value)}
          placeholder="titanic, scheepsramp, maritiem"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Annuleren</button>
        <button
          onClick={() => {
            if (!name.trim()) { toast.error("Naam is verplicht"); return; }
            onSave({
              name: name.trim(),
              description: description.trim() || undefined,
              nicheTags: parseTagsInput(nicheTags),
            });
          }}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Opslaan
        </button>
      </div>
    </div>
  );
}
