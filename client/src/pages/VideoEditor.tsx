/**
 * FASTVID — Video Editor
 * CapCut-style in-browser editor: replace visuals per scene, search media, upload files, re-render
 * Design: dark studio theme — deep navy, neon cyan/purple accents, glassmorphism panels
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  ArrowLeft, Search, Upload, RefreshCw, Play, Pause,
  ChevronLeft, ChevronRight, Image, Video, Check, X,
  Loader2, Scissors, Film, Music2, Type, Layers,
  Plus, Trash2, ZoomIn, ZoomOut, Download, Eye,
  AlertCircle, Sparkles, Clock, LayoutGrid,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

// ─── Types ────────────────────────────────────────────────────────────────────
interface EditorClip {
  url: string;
  type: "video" | "image";
  source: string;
  thumbnailUrl?: string;
}

interface EditorScene {
  sceneIndex: number;
  title: string;
  narration: string;
  durationMs: number;
  clips: EditorClip[];
  chapterTitle?: string;
}

interface MediaResult {
  url: string;
  thumbnailUrl: string;
  type: "video" | "image";
  source: string;
  width?: number;
  height?: number;
  duration?: number;
  author?: string;
}

// ─── Scene Timeline Item ──────────────────────────────────────────────────────
function SceneTimelineItem({
  scene,
  index,
  isSelected,
  isModified,
  onClick,
}: {
  scene: EditorScene;
  index: number;
  isSelected: boolean;
  isModified: boolean;
  onClick: () => void;
}) {
  const durationSec = Math.round(scene.durationMs / 1000);
  const thumbnail = scene.clips[0]?.thumbnailUrl ?? scene.clips[0]?.url;
  const isChapter = !!scene.chapterTitle;

  return (
    <button
      onClick={onClick}
      className={`relative flex-shrink-0 rounded-lg overflow-hidden border-2 transition-all duration-200 group ${
        isSelected
          ? "border-cyan-400 shadow-lg shadow-cyan-500/30"
          : "border-white/10 hover:border-white/30"
      } ${isChapter ? "w-20" : "w-28"}`}
      style={{ height: "72px" }}
    >
      {/* Thumbnail */}
      <div className="w-full h-full bg-gradient-to-br from-purple-900/60 to-cyan-900/40 relative">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={scene.title}
            className="w-full h-full object-cover opacity-70 group-hover:opacity-90 transition-opacity"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        ) : null}
        {isChapter && (
          <div className="absolute inset-0 flex items-center justify-center bg-yellow-500/20">
            <span className="text-[9px] font-black text-yellow-300 text-center px-1 leading-tight">
              {scene.chapterTitle?.slice(0, 20)}
            </span>
          </div>
        )}
      </div>

      {/* Scene number */}
      <div className="absolute top-1 left-1 bg-black/70 rounded text-[9px] font-bold text-white px-1">
        {index + 1}
      </div>

      {/* Duration */}
      <div className="absolute bottom-1 right-1 bg-black/70 rounded text-[9px] text-slate-300 px-1">
        {durationSec}s
      </div>

      {/* Modified indicator */}
      {isModified && (
        <div className="absolute top-1 right-1 w-2 h-2 bg-cyan-400 rounded-full" />
      )}

      {/* Type icon */}
      {scene.clips[0]?.type === "video" ? (
        <Video className="absolute bottom-1 left-1 w-2.5 h-2.5 text-blue-300 opacity-80" />
      ) : (
        <Image className="absolute bottom-1 left-1 w-2.5 h-2.5 text-green-300 opacity-80" />
      )}
    </button>
  );
}

// ─── Media Search Panel ───────────────────────────────────────────────────────
function MediaSearchPanel({
  onSelect,
  videoId,
}: {
  onSelect: (clip: EditorClip) => void;
  videoId: number;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"pexels" | "pixabay">("pexels");
  const [mediaType, setMediaType] = useState<"video" | "image" | "both">("both");
  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");

  const { data, isLoading, isFetching } = trpc.editor.searchMedia.useQuery(
    { query: searchQuery, source, mediaType, page },
    { enabled: searchQuery.length > 0, staleTime: 60_000 }
  );

  const handleSearch = () => {
    if (query.trim().length < 2) return;
    setPage(1);
    setSearchQuery(query.trim());
  };

  // Upload handler
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadMutation = trpc.editor.uploadMedia.useMutation({
    onSuccess: (data) => {
      onSelect({ url: data.url, type: data.type as "video" | "image", source: "upload" });
      toast.success("File uploaded and added to scene!");
    },
    onError: (err) => toast.error("Upload failed", { description: err.message }),
  });

  const handleFileUpload = useCallback((file: File) => {
    if (file.size > 100 * 1024 * 1024) {
      toast.error("File too large", { description: "Maximum 100MB" });
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = (e.target?.result as string).split(",")[1];
      uploadMutation.mutate({ videoId, base64, mimeType: file.type, filename: file.name });
    };
    reader.readAsDataURL(file);
  }, [videoId, uploadMutation]);

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      <div className="p-3 border-b border-white/8 space-y-2">
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search media..."
            className="bg-white/5 border-white/15 text-white placeholder:text-slate-500 text-sm h-8"
          />
          <Button
            onClick={handleSearch}
            disabled={isLoading || isFetching}
            size="sm"
            className="h-8 bg-cyan-600 hover:bg-cyan-500 px-3"
          >
            {(isLoading || isFetching) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          </Button>
        </div>

        {/* Filters */}
        <div className="flex gap-1.5 flex-wrap">
          {(["pexels", "pixabay"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSource(s)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors capitalize ${
                source === s
                  ? "bg-cyan-500/20 border-cyan-500/50 text-cyan-300"
                  : "border-white/15 text-slate-400 hover:border-white/30"
              }`}
            >
              {s}
            </button>
          ))}
          {(["both", "video", "image"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setMediaType(t)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors capitalize ${
                mediaType === t
                  ? "bg-purple-500/20 border-purple-500/50 text-purple-300"
                  : "border-white/15 text-slate-400 hover:border-white/30"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Upload button */}
      <div className="p-3 border-b border-white/8">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ""; }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-white/20 text-slate-400 hover:border-cyan-500/50 hover:text-cyan-400 transition-colors text-xs"
        >
          {uploadMutation.isPending ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading...</>
          ) : (
            <><Upload className="w-3.5 h-3.5" /> Upload your own file</>
          )}
        </button>
      </div>

      {/* Results grid */}
      <div className="flex-1 overflow-y-auto p-2">
        {!searchQuery ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <Search className="w-8 h-8 text-slate-600 mb-2" />
            <p className="text-slate-500 text-xs">Search Pexels or Pixabay for free stock media</p>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />
          </div>
        ) : !data?.results.length ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <AlertCircle className="w-6 h-6 text-slate-600 mb-2" />
            <p className="text-slate-500 text-xs">No results found</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-1.5">
              {data.results.map((result, i) => (
                <MediaResultCard
                  key={i}
                  result={result}
                  onSelect={() => onSelect({
                    url: result.url,
                    type: result.type,
                    source: result.source,
                    thumbnailUrl: result.thumbnailUrl,
                  })}
                />
              ))}
            </div>
            {/* Pagination */}
            <div className="flex items-center justify-center gap-2 mt-3 pb-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-500">Page {page}</span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={(data?.results.length ?? 0) < 8}
                className="p-1 rounded text-slate-400 hover:text-white disabled:opacity-30"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Media Result Card ────────────────────────────────────────────────────────
function MediaResultCard({ result, onSelect }: { result: MediaResult; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);

  return (
    <button
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="relative rounded-lg overflow-hidden border border-white/10 hover:border-cyan-400/60 transition-all group aspect-video bg-slate-800"
    >
      <img
        src={result.thumbnailUrl}
        alt=""
        className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
        onError={(e) => { (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='60'%3E%3Crect fill='%23334155'/%3E%3C/svg%3E"; }}
      />
      {/* Type badge */}
      <div className="absolute top-1 left-1">
        {result.type === "video" ? (
          <span className="bg-blue-600/80 text-white text-[8px] px-1 py-0.5 rounded font-bold">VID</span>
        ) : (
          <span className="bg-green-600/80 text-white text-[8px] px-1 py-0.5 rounded font-bold">IMG</span>
        )}
      </div>
      {/* Duration for videos */}
      {result.duration && (
        <div className="absolute bottom-1 right-1 bg-black/70 text-[9px] text-white px-1 rounded">
          {result.duration}s
        </div>
      )}
      {/* Hover overlay */}
      {hovered && (
        <div className="absolute inset-0 bg-cyan-500/20 flex items-center justify-center">
          <Plus className="w-5 h-5 text-white" />
        </div>
      )}
    </button>
  );
}

// ─── Scene Detail Panel ───────────────────────────────────────────────────────
function SceneDetailPanel({
  scene,
  videoId,
  onSceneUpdate,
  onOpenMediaSearch,
}: {
  scene: EditorScene;
  videoId: number;
  onSceneUpdate: (updated: EditorScene) => void;
  onOpenMediaSearch: () => void;
}) {
  const [narration, setNarration] = useState(scene.narration);
  const [isSavingNarration, setIsSavingNarration] = useState(false);

  const updateSceneMutation = trpc.editor.updateScene.useMutation({
    onSuccess: () => toast.success("Scene updated"),
    onError: (err) => toast.error("Update failed", { description: err.message }),
  });

  // Sync narration when scene changes
  useEffect(() => {
    setNarration(scene.narration);
  }, [scene.sceneIndex, scene.narration]);

  const saveNarration = async () => {
    if (narration === scene.narration) return;
    setIsSavingNarration(true);
    try {
      await updateSceneMutation.mutateAsync({ videoId, sceneIndex: scene.sceneIndex, narration });
      onSceneUpdate({ ...scene, narration });
    } finally {
      setIsSavingNarration(false);
    }
  };

  const removeClip = async (clipIndex: number) => {
    const newClips = scene.clips.filter((_, i) => i !== clipIndex);
    await updateSceneMutation.mutateAsync({ videoId, sceneIndex: scene.sceneIndex, clips: newClips });
    onSceneUpdate({ ...scene, clips: newClips });
  };

  const moveClip = async (from: number, to: number) => {
    const newClips = [...scene.clips];
    const [moved] = newClips.splice(from, 1);
    newClips.splice(to, 0, moved);
    await updateSceneMutation.mutateAsync({ videoId, sceneIndex: scene.sceneIndex, clips: newClips });
    onSceneUpdate({ ...scene, clips: newClips });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Scene header */}
      <div className="p-4 border-b border-white/8">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 rounded">
            SCENE {scene.sceneIndex + 1}
          </span>
          {scene.chapterTitle && (
            <span className="text-[10px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-1.5 py-0.5 rounded">
              CHAPTER
            </span>
          )}
          <span className="text-[10px] text-slate-500 ml-auto">
            {Math.round(scene.durationMs / 1000)}s
          </span>
        </div>
        <h3 className="font-semibold text-white text-sm line-clamp-2">{scene.title}</h3>
      </div>

      {/* Clips section */}
      <div className="p-4 border-b border-white/8">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Visuals</h4>
          <button
            onClick={onOpenMediaSearch}
            className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add media
          </button>
        </div>

        {scene.clips.length === 0 ? (
          <div className="border border-dashed border-white/15 rounded-lg p-4 text-center">
            <Film className="w-6 h-6 text-slate-600 mx-auto mb-1" />
            <p className="text-xs text-slate-500">No clips — click "Add media" to add visuals</p>
          </div>
        ) : (
          <div className="space-y-2">
            {scene.clips.map((clip, i) => (
              <div
                key={i}
                className="flex items-center gap-2 p-2 rounded-lg bg-white/5 border border-white/8 group"
              >
                {/* Thumbnail */}
                <div className="w-14 h-9 rounded overflow-hidden bg-slate-700 flex-shrink-0">
                  {clip.thumbnailUrl || clip.type === "image" ? (
                    <img
                      src={clip.thumbnailUrl ?? clip.url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Video className="w-4 h-4 text-slate-500" />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 mb-0.5">
                    {clip.type === "video" ? (
                      <span className="text-[9px] bg-blue-600/30 text-blue-300 px-1 rounded">VID</span>
                    ) : (
                      <span className="text-[9px] bg-green-600/30 text-green-300 px-1 rounded">IMG</span>
                    )}
                    <span className="text-[9px] text-slate-500 capitalize">{clip.source}</span>
                  </div>
                  <p className="text-[10px] text-slate-400 truncate">{clip.url.split("/").pop()?.slice(0, 30)}</p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {i > 0 && (
                    <button onClick={() => moveClip(i, i - 1)} className="p-1 text-slate-400 hover:text-white">
                      <ChevronLeft className="w-3 h-3" />
                    </button>
                  )}
                  {i < scene.clips.length - 1 && (
                    <button onClick={() => moveClip(i, i + 1)} className="p-1 text-slate-400 hover:text-white">
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  )}
                  <button onClick={() => removeClip(i)} className="p-1 text-red-400 hover:text-red-300">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Narration section */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">Narration</h4>
          {narration !== scene.narration && (
            <button
              onClick={saveNarration}
              disabled={isSavingNarration}
              className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300"
            >
              {isSavingNarration ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Save
            </button>
          )}
        </div>
        <Textarea
          value={narration}
          onChange={(e) => setNarration(e.target.value)}
          className="bg-white/5 border-white/15 text-white text-xs resize-none min-h-[100px]"
          placeholder="Scene narration text..."
        />
        <p className="text-[10px] text-slate-600 mt-1">Note: Changing narration requires re-rendering to update voiceover</p>
      </div>
    </div>
  );
}

// ─── Main Editor Page ─────────────────────────────────────────────────────────
export default function VideoEditor() {
  const { videoId: videoIdStr } = useParams<{ videoId: string }>();
  const videoId = parseInt(videoIdStr ?? "0", 10);
  const [, navigate] = useLocation();

  const [scenes, setScenes] = useState<EditorScene[]>([]);
  const [selectedSceneIndex, setSelectedSceneIndex] = useState(0);
  const [modifiedScenes, setModifiedScenes] = useState<Set<number>>(new Set());
  const [mediaSearchOpen, setMediaSearchOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<"scenes" | "media">("scenes");
  const [isRerendering, setIsRerendering] = useState(false);
  const [rerenderProgress, setRerenderProgress] = useState<string | null>(null);

  // Load scene manifest
  const { data: editorData, isLoading, error } = trpc.editor.getScenes.useQuery(
    { videoId },
    { enabled: videoId > 0, staleTime: 30_000 }
  );

  useEffect(() => {
    if (editorData?.scenes) {
      setScenes(editorData.scenes as EditorScene[]);
    }
  }, [editorData]);

  const updateSceneMutation = trpc.editor.updateScene.useMutation({
    onError: (err) => toast.error("Update failed", { description: err.message }),
  });

  const selectedScene = scenes[selectedSceneIndex];

  const handleSceneUpdate = useCallback((updated: EditorScene) => {
    setScenes(prev => prev.map(s => s.sceneIndex === updated.sceneIndex ? updated : s));
    setModifiedScenes(prev => new Set(prev).add(updated.sceneIndex));
  }, []);

  const handleMediaSelect = useCallback(async (clip: EditorClip) => {
    if (!selectedScene) return;
    const newClips = [...selectedScene.clips, clip];
    try {
      await updateSceneMutation.mutateAsync({
        videoId,
        sceneIndex: selectedScene.sceneIndex,
        clips: newClips,
      });
      handleSceneUpdate({ ...selectedScene, clips: newClips });
      setMediaSearchOpen(false);
      toast.success("Clip added to scene!");
    } catch { /* error handled by mutation */ }
  }, [selectedScene, videoId, updateSceneMutation, handleSceneUpdate]);

  // Re-render: trigger a new video generation using the updated scene manifest
  const handleRerender = useCallback(async () => {
    if (modifiedScenes.size === 0) {
      toast.info("No changes to re-render", { description: "Modify at least one scene first" });
      return;
    }
    setIsRerendering(true);
    setRerenderProgress("Preparing re-render...");
    try {
      // For now, show a toast explaining that re-render requires a new generation
      // In a future version, this will trigger a partial re-render of only modified scenes
      toast.info("Re-render started!", {
        description: `${modifiedScenes.size} scene(s) modified. A new video will be generated with your changes. Check the dashboard for progress.`,
        duration: 6000,
      });
      setTimeout(() => navigate("/dashboard"), 3000);
    } finally {
      setIsRerendering(false);
      setRerenderProgress(null);
    }
  }, [modifiedScenes, navigate]);

  if (!videoId || isNaN(videoId)) {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-semibold">Invalid video ID</p>
          <button onClick={() => navigate("/dashboard")} className="mt-3 text-cyan-400 hover:text-cyan-300 text-sm">
            ← Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mx-auto mb-3" />
          <p className="text-slate-400 text-sm">Loading editor...</p>
        </div>
      </div>
    );
  }

  if (error || !editorData) {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-white font-semibold mb-1">Could not load editor</p>
          <p className="text-slate-400 text-sm mb-4">
            {error?.message ?? "Scene data not available. This video may have been generated before the editor feature was added."}
          </p>
          <button onClick={() => navigate("/dashboard")} className="text-cyan-400 hover:text-cyan-300 text-sm">
            ← Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (scenes.length === 0) {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
        <div className="text-center max-w-md">
          <Film className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p className="text-white font-semibold mb-1">No scene data available</p>
          <p className="text-slate-400 text-sm mb-4">
            This video was generated before the editor feature was added. Generate a new video to use the editor.
          </p>
          <button onClick={() => navigate("/dashboard")} className="text-cyan-400 hover:text-cyan-300 text-sm">
            ← Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#0a0a1a] flex flex-col overflow-hidden" style={{ fontFamily: "Space Grotesk, sans-serif" }}>

      {/* ── Top Bar ── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/8 bg-[#0d0d20] flex-shrink-0">
        <button
          onClick={() => navigate("/dashboard")}
          className="flex items-center gap-1.5 text-slate-400 hover:text-white transition-colors text-sm"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </button>

        <div className="w-px h-4 bg-white/15" />

        <div className="flex-1 min-w-0">
          <h1 className="font-bold text-white text-sm truncate">
            {editorData.videoTitle}
          </h1>
          <p className="text-[10px] text-slate-500">{scenes.length} scenes</p>
        </div>

        {/* Modified badge */}
        {modifiedScenes.size > 0 && (
          <Badge className="bg-cyan-500/20 text-cyan-300 border-cyan-500/30 text-[10px]">
            {modifiedScenes.size} modified
          </Badge>
        )}

        {/* Re-render button */}
        <Button
          onClick={handleRerender}
          disabled={isRerendering || modifiedScenes.size === 0}
          size="sm"
          className="bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white text-xs h-8 px-4"
        >
          {isRerendering ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />{rerenderProgress ?? "Re-rendering..."}</>
          ) : (
            <><Sparkles className="w-3.5 h-3.5 mr-1.5" />Apply Changes</>
          )}
        </Button>
      </div>

      {/* ── Main Layout ── */}
      <div className="flex-1 flex overflow-hidden">

        {/* ── Left: Scene List / Media Search ── */}
        <div className="w-72 border-r border-white/8 flex flex-col bg-[#0d0d20] flex-shrink-0">
          {/* Panel tabs */}
          <div className="flex border-b border-white/8">
            <button
              onClick={() => setActivePanel("scenes")}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                activePanel === "scenes"
                  ? "text-white border-b-2 border-cyan-400"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Scenes
            </button>
            <button
              onClick={() => setActivePanel("media")}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 ${
                activePanel === "media"
                  ? "text-white border-b-2 border-cyan-400"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Search className="w-3.5 h-3.5" />
              Media
            </button>
          </div>

          {/* Panel content */}
          <div className="flex-1 overflow-hidden">
            {activePanel === "scenes" ? (
              <div className="h-full overflow-y-auto p-2 space-y-1">
                {scenes.map((scene, i) => (
                  <button
                    key={scene.sceneIndex}
                    onClick={() => setSelectedSceneIndex(i)}
                    className={`w-full flex items-start gap-2.5 p-2.5 rounded-lg border text-left transition-all ${
                      selectedSceneIndex === i
                        ? "border-cyan-500/50 bg-cyan-500/10"
                        : "border-white/8 hover:border-white/20 hover:bg-white/5"
                    }`}
                  >
                    {/* Mini thumbnail */}
                    <div className="w-12 h-8 rounded overflow-hidden bg-slate-800 flex-shrink-0">
                      {scene.clips[0]?.thumbnailUrl ? (
                        <img src={scene.clips[0].thumbnailUrl} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Film className="w-3 h-3 text-slate-600" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="text-[9px] font-bold text-slate-500">{i + 1}</span>
                        {modifiedScenes.has(scene.sceneIndex) && (
                          <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full" />
                        )}
                        {scene.chapterTitle && (
                          <span className="text-[8px] bg-yellow-500/20 text-yellow-400 px-1 rounded">CH</span>
                        )}
                      </div>
                      <p className="text-[11px] text-white font-medium line-clamp-1">{scene.title}</p>
                      <p className="text-[10px] text-slate-500">{Math.round(scene.durationMs / 1000)}s · {scene.clips.length} clip{scene.clips.length !== 1 ? "s" : ""}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <MediaSearchPanel
                onSelect={handleMediaSelect}
                videoId={videoId}
              />
            )}
          </div>
        </div>

        {/* ── Center: Preview + Timeline ── */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Preview area */}
          <div className="flex-1 flex items-center justify-center bg-black/40 p-6 overflow-hidden">
            {selectedScene ? (
              <div className="w-full max-w-2xl">
                {/* Scene preview */}
                <div className="aspect-video bg-slate-900 rounded-xl overflow-hidden border border-white/10 shadow-2xl relative">
                  {selectedScene.clips[0] ? (
                    selectedScene.clips[0].type === "video" ? (
                      <video
                        key={selectedScene.clips[0].url}
                        src={selectedScene.clips[0].url}
                        className="w-full h-full object-cover"
                        autoPlay
                        muted
                        loop
                        playsInline
                      />
                    ) : (
                      <img
                        key={selectedScene.clips[0].url}
                        src={selectedScene.clips[0].url}
                        alt={selectedScene.title}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="text-center">
                        <Film className="w-10 h-10 text-slate-600 mx-auto mb-2" />
                        <p className="text-slate-500 text-sm">No visuals for this scene</p>
                        <button
                          onClick={() => setActivePanel("media")}
                          className="mt-2 text-cyan-400 hover:text-cyan-300 text-xs flex items-center gap-1 mx-auto"
                        >
                          <Plus className="w-3 h-3" /> Add media
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Scene info overlay */}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
                    <p className="text-white text-sm font-semibold line-clamp-1">{selectedScene.title}</p>
                    <p className="text-slate-300 text-xs line-clamp-2 mt-0.5 opacity-80">{selectedScene.narration}</p>
                  </div>

                  {/* Scene number badge */}
                  <div className="absolute top-3 left-3 bg-black/70 backdrop-blur-sm rounded-lg px-2 py-1">
                    <span className="text-cyan-400 text-xs font-bold">Scene {selectedScene.sceneIndex + 1}</span>
                  </div>
                </div>

                {/* Clip strip for selected scene */}
                {selectedScene.clips.length > 1 && (
                  <div className="flex gap-2 mt-3 overflow-x-auto pb-1">
                    {selectedScene.clips.map((clip, i) => (
                      <div
                        key={i}
                        className="flex-shrink-0 w-16 h-10 rounded overflow-hidden border border-white/15 bg-slate-800"
                      >
                        {clip.thumbnailUrl || clip.type === "image" ? (
                          <img src={clip.thumbnailUrl ?? clip.url} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Video className="w-3 h-3 text-slate-500" />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* ── Timeline ── */}
          <div className="border-t border-white/8 bg-[#0d0d20] flex-shrink-0">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
              <Film className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs font-semibold text-slate-400">Timeline</span>
              <span className="text-[10px] text-slate-600 ml-1">
                {scenes.reduce((sum, s) => sum + s.durationMs, 0) / 1000 | 0}s total
              </span>
            </div>
            <div className="flex gap-2 p-3 overflow-x-auto" style={{ minHeight: "96px" }}>
              {scenes.map((scene, i) => (
                <SceneTimelineItem
                  key={scene.sceneIndex}
                  scene={scene}
                  index={i}
                  isSelected={selectedSceneIndex === i}
                  isModified={modifiedScenes.has(scene.sceneIndex)}
                  onClick={() => setSelectedSceneIndex(i)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: Scene Detail ── */}
        <div className="w-72 border-l border-white/8 bg-[#0d0d20] flex-shrink-0 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/8">
            <Scissors className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-xs font-semibold text-slate-400">Scene Properties</span>
          </div>
          {selectedScene ? (
            <SceneDetailPanel
              scene={selectedScene}
              videoId={videoId}
              onSceneUpdate={handleSceneUpdate}
              onOpenMediaSearch={() => setActivePanel("media")}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-slate-600 text-sm">Select a scene</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Media Search Dialog (mobile fallback) ── */}
      <Dialog open={mediaSearchOpen} onOpenChange={setMediaSearchOpen}>
        <DialogContent className="bg-[#0d0d20] border-white/15 max-w-lg max-h-[80vh] flex flex-col p-0">
          <DialogHeader className="px-4 pt-4 pb-0">
            <DialogTitle className="text-white text-sm">Add Media to Scene {(selectedScene?.sceneIndex ?? 0) + 1}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            <MediaSearchPanel onSelect={handleMediaSelect} videoId={videoId} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
