/**
 * Admin panel — curated media archives (videos + images with tags)
 */
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage, ARCHIVE_MAX_UPLOAD_BYTES, ARCHIVE_MAX_UPLOAD_MB } from "@/const";
import { toast } from "sonner";
import {
  Archive, Plus, Loader2, Trash2, Pencil, Upload, Tag, X, Sparkles,
} from "lucide-react";
import { ArchiveClipsGrid } from "@/components/admin/ArchiveClipsGrid";

const MIX_KINDS = [
  { value: "real_video", label: "Real video" },
  { value: "photo", label: "Photo" },
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
  resultClipCount?: number;
  resultSplit?: boolean;
  done: boolean;
  error?: string;
  cancelled?: boolean;
};

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  validating: "Validating",
  split_ffmpeg: "FFmpeg",
  split_probe: "Measuring duration",
  split_detect: "Detecting shots",
  split_rescan: "Extra cuts",
  split_filter: "Subject filter",
  split_extract: "Extracting clips",
  filter_overlay: "Text filter",
  filter_subject: "Subject filter",
  ai_tags: "AI tags",
  save_clips: "Saving",
  done: "Done",
  cancelled: "Cancelled",
  error: "Error",
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

async function requestArchiveUploadCancel(jobId: string): Promise<void> {
  await fetch(`/api/admin/archive/upload/cancel?jobId=${encodeURIComponent(jobId)}`, {
    method: "POST",
    credentials: "include",
  });
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
    signal?: AbortSignal;
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

  const waitForJobDone = async (): Promise<ArchiveUploadProgress> => {
    for (let i = 0; i < 7200; i++) {
      if (opts.signal?.aborted) throw new UploadCancelledError();
      const progress = await pollArchiveUploadProgress(opts.jobId);
      if (progress) opts.onProgress?.(progress);
      if (progress?.done) {
        if (progress.cancelled) throw new UploadCancelledError();
        if (progress.error) throw new Error(progress.error);
        return progress;
      }
      await new Promise((r) => window.setTimeout(r, 700));
    }
    throw new Error("Processing took too long — check the archive later or try again.");
  };

  try {
    const res = await fetch(`/api/admin/archive/upload?${params}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": opts.mimeType || "application/octet-stream" },
      body: file,
      signal: opts.signal,
    });

    const text = await res.text();
    let data: {
      error?: string;
      accepted?: boolean;
      clipCount?: number;
      split?: boolean;
      cancelled?: boolean;
    } | null = null;
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      if (text.trimStart().startsWith("<!DOCTYPE") || text.trimStart().startsWith("<html")) {
        const lower = text.toLowerCase();
        if (lower.includes("upstream")) {
          throw new Error(
            "Server timeout during upload (upstream error). Processing may continue — refresh the page in a minute."
          );
        }
        throw new Error(
          "Server returned an HTML error page (file too large or timeout). Try a smaller file."
        );
      }
      throw new Error(text.slice(0, 180) || "Upload failed");
    }

    if (res.status === 202 || data?.accepted) {
      const finalProgress = await waitForJobDone();
      return {
        clipCount: finalProgress.resultClipCount ?? finalProgress.clipsSaved ?? 1,
        split: Boolean(finalProgress.resultSplit ?? (finalProgress.clipsSaved ?? 0) > 1),
      };
    }

    if (!res.ok) {
      const cancelled = Boolean(data?.cancelled)
        || (data?.error?.toLowerCase().includes("cancelled") ?? false);
      if (cancelled) throw new UploadCancelledError();
      throw new Error(data?.error || "Upload failed");
    }

    const finalProgress = await pollArchiveUploadProgress(opts.jobId);
    if (finalProgress) opts.onProgress?.(finalProgress);

    return {
      clipCount: data?.clipCount ?? finalProgress?.clipsSaved ?? 1,
      split: Boolean(data?.split ?? (finalProgress?.clipsSaved ?? 0) > 1),
    };
  } finally {
    window.clearInterval(pollTimer);
  }
}

class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
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
  const uploadAbortRef = useRef<AbortController | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const cancelRequestedRef = useRef(false);

  const activeArchiveId = selectedId ?? archives[0]?.id ?? null;

  const createArchive = trpc.mediaArchive.createArchive.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listArchives.invalidate();
      setShowCreateForm(false);
      if (data.archive?.id) setSelectedId(data.archive.id);
      toast.success("Archive created!");
    },
    onError: (e) => toast.error("Failed to create archive", { description: toastErrorMessage(e) }),
  });

  const updateArchive = trpc.mediaArchive.updateArchive.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listArchives.invalidate();
      setEditArchiveId(null);
      toast.success("Archive updated!");
    },
    onError: (e) => toast.error("Save failed", { description: toastErrorMessage(e) }),
  });

  const seedSamples = trpc.mediaArchive.seedSampleArchives.useMutation({
    onSuccess: (data) => {
      utils.mediaArchive.listArchives.invalidate();
      if (data.created === 0) {
        toast.info("Sample niches already exist", {
          description: `${data.skipped} archive${data.skipped === 1 ? "" : "s"} skipped.`,
        });
      } else {
        toast.success(`Added ${data.created} sample niche${data.created === 1 ? "" : "s"}`, {
          description: data.names.slice(0, 3).join(", ") + (data.names.length > 3 ? "…" : ""),
        });
      }
    },
    onError: (err) => toast.error("Could not add sample niches", { description: toastErrorMessage(err) }),
  });

  const deleteArchive = trpc.mediaArchive.deleteArchive.useMutation({
    onSuccess: () => {
      utils.mediaArchive.listArchives.invalidate();
      setSelectedId(null);
      toast.success("Archive deleted");
    },
    onError: (e) => toast.error("Delete failed", { description: toastErrorMessage(e) }),
  });

  const selectedArchive = archives.find((a) => a.id === activeArchiveId);

  async function handleCancelUpload() {
    const jobId = activeJobIdRef.current;
    if (!jobId || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    try {
      await requestArchiveUploadCancel(jobId);
    } catch {
      /* server may already be done */
    }
    uploadAbortRef.current?.abort();
    setUploadProgress((prev) =>
      prev
        ? { ...prev, stage: "cancelled", message: "Upload cancelled", done: true, cancelled: true }
        : prev
    );
    toast.info("Upload stopped");
  }

  async function handleFiles(files: FileList | null) {
    if (!files?.length) return;
    if (!activeArchiveId) {
      toast.error("Create an archive first");
      return;
    }
    setUploading(true);
    setUploadProgress(null);
    try {
      for (const file of Array.from(files)) {
        if (file.size > ARCHIVE_MAX_UPLOAD_BYTES) {
          toast.error(`${file.name}: too large (max ${ARCHIVE_MAX_UPLOAD_MB}MB / video up to 2 hours)`);
          continue;
        }
        const mimeType = guessFileMime(file);
        if (!mimeType.startsWith("video/") && !mimeType.startsWith("image/")) {
          toast.error(`${file.name}: video or image only (MP4, JPG, PNG, …)`);
          continue;
        }
        const isVideo = mimeType.startsWith("video/");
        const mixKind = isVideo ? "real_video" : uploadMixKind;
        const jobId = newUploadJobId();
        activeJobIdRef.current = jobId;
        cancelRequestedRef.current = false;
        uploadAbortRef.current = new AbortController();
        setUploadProgress({
          jobId,
          filename: file.name,
          stage: "queued",
          message: `${file.name}: uploading…`,
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
          signal: uploadAbortRef.current.signal,
          onProgress: setUploadProgress,
        });
        utils.mediaArchive.listAssets.invalidate();
        utils.mediaArchive.listArchives.invalidate();
        if (isVideo && autoSplitScenes && result.clipCount > 1) {
          toast.success(`${file.name}: ${result.clipCount} clips created (shot/scene changes)`);
        } else if (isVideo && autoSplitScenes) {
          toast.success(`${file.name}: 1 clip saved`);
        } else {
          toast.success(`${file.name} uploaded`);
        }
      }
      setUploadTags("");
    } catch (e) {
      if (e instanceof UploadCancelledError || (e instanceof DOMException && e.name === "AbortError")) {
        toast.info("Upload cancelled");
      } else {
        toast.error("Upload failed", { description: toastErrorMessage(e) });
      }
    } finally {
      setUploading(false);
      activeJobIdRef.current = null;
      cancelRequestedRef.current = false;
      uploadAbortRef.current = null;
      window.setTimeout(() => setUploadProgress(null), 8000);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
            Media <span className="gradient-text">Archive</span>
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Create niche archives with videos and photos. Long videos are split at each shot/scene change — no fixed intervals.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => seedSamples.mutate()}
            disabled={seedSamples.isPending}
            className="flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 hover:bg-white/10 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {seedSamples.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-cyan-400" />}
            Add sample niches
          </button>
          <button
            onClick={() => { setShowCreateForm(true); setEditArchiveId(null); }}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" /> New archive
          </button>
        </div>
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
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">Archives</p>
          </div>
          {archivesLoading ? (
            <div className="p-6 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-purple-400" /></div>
          ) : archives.length === 0 ? (
            <div className="p-6 text-center text-slate-500 text-sm">No archives yet</div>
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
                    <p className="text-xs text-slate-500 mt-0.5 ml-6">{a.assetCount} files</p>
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
              Create an archive to upload videos and images.
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
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete archive "${selectedArchive?.name}" and all files?`)) {
                        deleteArchive.mutate({ id: activeArchiveId });
                      }
                    }}
                    disabled={deleteArchive.isPending}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
                  >
                    <Trash2 className="w-3 h-3" /> Delete
                  </button>
                </div>
              </div>

              {/* Upload zone */}
              <div className="glass-card border border-white/8 rounded-xl p-5 space-y-4">
                <h4 className="font-medium text-white flex items-center gap-2">
                  <Upload className="w-4 h-4 text-cyan-400" /> Upload
                </h4>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Tags for new uploads (comma-separated)</label>
                    <input
                      type="text"
                      value={uploadTags}
                      onChange={(e) => setUploadTags(e.target.value)}
                      placeholder="e.g. berlin, metro, skyline, modern city, transit"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">
                      Tip: AI vision adds a title, description, and exactly 4 high-quality English search tags per clip.
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-slate-400 mb-1 block">Type (for photos)</label>
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
                  AI title + 4 search tags from image (LLM vision)
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoSplitScenes}
                    onChange={(e) => setAutoSplitScenes(e.target.checked)}
                    className="rounded border-white/20 bg-white/5 text-purple-600 focus:ring-purple-500"
                  />
                    Auto-split on shot/scene change (scdet — detects real visual cuts). Each saved clip is one scene only.
                </label>

                {uploadProgress && (
                  <div className="rounded-xl border border-purple-500/25 bg-purple-500/5 p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-white truncate max-w-[70%]">
                        {uploadProgress.filename ?? "Upload"}
                      </p>
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-purple-200">
                          {STAGE_LABELS[uploadProgress.stage] ?? uploadProgress.stage}
                        </span>
                        {uploading && !uploadProgress.done && (
                          <button
                            type="button"
                            onClick={handleCancelUpload}
                            className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 transition-colors"
                          >
                            <X className="w-3 h-3" />
                            Stop
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          uploadProgress.stage === "error"
                            ? "bg-red-500"
                            : uploadProgress.stage === "cancelled"
                              ? "bg-slate-500"
                              : "bg-gradient-to-r from-purple-500 to-cyan-500"
                        }`}
                        style={{ width: `${Math.min(100, Math.max(0, uploadProgress.percent))}%` }}
                      />
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed">{uploadProgress.message}</p>
                    {uploadProgress.clipTotal != null && uploadProgress.clipTotal > 0 && (
                      <p className="text-[11px] text-slate-500">
                        Clip {uploadProgress.clipIndex ?? uploadProgress.clipsSaved ?? 0}/{uploadProgress.clipTotal}
                        {uploadProgress.clipsSaved != null ? ` · ${uploadProgress.clipsSaved} saved` : ""}
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
                    Drag files here or click to choose
                  </span>
                  <span className="text-xs text-slate-600">MP4, WebM, JPG, PNG — max {ARCHIVE_MAX_UPLOAD_MB}MB (video up to 2 hours)</span>
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
      <h3 className="font-bold text-white">{initial ? "Edit archive" : "New archive"}</h3>
      <div>
        <label className="text-xs text-slate-400 mb-1 block">Name *</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Titanic / Maritime"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 mb-1 block">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="What is this archive for?"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-slate-400 mb-1 block flex items-center gap-1">
          <Tag className="w-3 h-3" /> Topic tags (comma-separated)
        </label>
        <input
          value={nicheTags}
          onChange={(e) => setNicheTags(e.target.value)}
          placeholder="titanic, shipwreck, maritime"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
        <p className="text-[11px] text-slate-500 mt-1">
          Optional — videos automatically pick the right archive based on title, tags, and clip content.
          Tags also help with upload filtering.
        </p>
      </div>
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Cancel</button>
        <button
          onClick={() => {
            if (!name.trim()) { toast.error("Name is required"); return; }
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
          Save
        </button>
      </div>
    </div>
  );
}
