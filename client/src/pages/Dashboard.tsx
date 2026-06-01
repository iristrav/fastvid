/**
 * FASTVID — User Dashboard
 * Authenticated users can generate videos and view their history
 */
import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import {
  APP_ERROR,
  appErrorText,
  getLoginUrl,
  matchesAppError,
  parseAppErrorCode,
  toastErrorMessage,
} from "@/const";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  Play, Sparkles, Clock, CheckCircle2, XCircle, Loader2,
  FileText, Video, LogOut, User, ChevronRight, RefreshCw,
  Copy, Download, Eye, LayoutDashboard, Settings, CreditCard, Volume2,
  Trash2, Pencil, Check, X as XIcon, Mic, Upload, BookOpen, List, GraduationCap, Lightbulb,
  AlertCircle, ChevronDown, Edit2,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

// ─── Constants ────────────────────────────────────────────────────────────────
const VIDEO_LENGTHS = [
  { label: "1 min (test)", value: "1" as const, desc: "Pipeline smoke test", genTime: "~2 min" },
  { label: "5–8 min", value: "5-8" as const, desc: "Short & punchy", genTime: "~3 min" },
  { label: "8–12 min", value: "8-12" as const, desc: "Tutorials", genTime: "~5 min" },
  { label: "12–15 min", value: "12-15" as const, desc: "In-depth", genTime: "~7 min" },
  { label: "15–20 min", value: "15-20" as const, desc: "Extended", genTime: "~10 min" },
  { label: "20+ min", value: "20+" as const, desc: "Long-form", genTime: "~15 min" },
];

const VIDEO_TYPES = [
  { value: "documentary" as const, label: "Documentary", desc: "Research-backed narration", icon: BookOpen, color: "from-blue-600/40 to-indigo-500/30 border-blue-400/60" },
  { value: "listicle" as const, label: "Top 10 / Listicle", desc: "Numbered items format", icon: List, color: "from-orange-600/40 to-amber-500/30 border-orange-400/60" },
  { value: "tutorial" as const, label: "Tutorial", desc: "Step-by-step guide", icon: GraduationCap, color: "from-green-600/40 to-emerald-500/30 border-green-400/60" },
  { value: "explainer" as const, label: "Explainer", desc: "Simple analogies & visuals", icon: Lightbulb, color: "from-purple-600/40 to-violet-500/30 border-purple-400/60" },
];

type VideoLength = "1" | "5-8" | "8-12" | "12-15" | "15-20" | "20+";
type VideoType = "documentary" | "listicle" | "tutorial" | "explainer";

// Agent-style stage labels for the progress UI
const AGENT_STAGES: Record<string, { label: string; agent: string; icon: string }> = {
  pending:              { label: "Queued",                   agent: "Queue",           icon: "⏳" },
  generating_script:    { label: "Writing script...",        agent: "Scriptwriter",    icon: "✍️" },
  awaiting_approval:    { label: "Writing script...",        agent: "Scriptwriter",    icon: "✍️" },
  generating_voiceover: { label: "Creating voiceover...",    agent: "Voice Engineer",  icon: "🎙️" },
  generating_visuals:   { label: "Matching visuals...",      agent: "Visual Director", icon: "🎬" },
  generating_effects:   { label: "Adding effects...",        agent: "Video Editor",    icon: "✨" },
  completed:            { label: "Completed",                agent: "Done",            icon: "✅" },
  failed:               { label: "Failed",                   agent: "Error",           icon: "❌" },
};

const STATUS_COLORS: Record<string, string> = {
  pending:              "text-yellow-400 bg-yellow-400/10",
  generating_script:    "text-blue-400 bg-blue-400/10",
  awaiting_approval:    "text-blue-400 bg-blue-400/10",
  generating_voiceover: "text-purple-400 bg-purple-400/10",
  generating_visuals:   "text-cyan-400 bg-cyan-400/10",
  generating_effects:   "text-orange-400 bg-orange-400/10",
  completed:            "text-green-400 bg-green-400/10",
  failed:               "text-red-400 bg-red-400/10",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatVideoId(id: number) {
  return `#VID-${String(id).padStart(4, "0")}`;
}

// ─── Script Review Modal ──────────────────────────────────────────────────────
function ScriptReviewModal({ videoId, onClose }: { videoId: number; onClose: () => void }) {
  const { data: video, isLoading } = trpc.video.get.useQuery({ id: videoId });
  const [editedScript, setEditedScript] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (video?.script) setEditedScript(video.script);
  }, [video?.script]);

  const approveMutation = trpc.video.approveScript.useMutation({
    onSuccess: () => {
      toast.success("Script approved! Video production started.", { description: "Your video will be ready in a few minutes." });
      utils.video.list.invalidate();
      onClose();
    },
    onError: (err) => toast.error("Approval failed", { description: toastErrorMessage(err) }),
  });

  const rejectMutation = trpc.video.rejectScript.useMutation({
    onSuccess: () => {
      toast.info("Script rejected. Video cancelled.");
      utils.video.list.invalidate();
      onClose();
    },
    onError: (err) => toast.error("Rejection failed", { description: toastErrorMessage(err) }),
  });

  const handleApprove = () => {
    approveMutation.mutate({
      id: videoId,
      editedScript: isEditing ? editedScript : undefined,
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col bg-slate-900 border border-white/15 text-white">
        <DialogHeader className="border-b border-white/8 pb-4">
          <DialogTitle className="flex items-center gap-2 text-white">
            <FileText className="w-5 h-5 text-cyan-400" />
            Review Your Script
          </DialogTitle>
          <p className="text-sm text-slate-400 mt-1">
            Read through the AI-generated script below. You can edit it before approving, or reject it to cancel.
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
          </div>
        ) : video ? (
          <div className="flex-1 overflow-y-auto py-4 space-y-4">
            {/* Video info */}
            <div className="flex items-center gap-3 px-1">
              <span className="mono text-xs font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded">
                {formatVideoId(video.id)}
              </span>
              <span className="text-sm text-slate-300 font-medium">{video.title ?? video.prompt.slice(0, 80)}</span>
            </div>

            {/* Script editor */}
            <div className="relative">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Script</p>
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md transition-colors ${
                    isEditing ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30" : "bg-white/5 text-slate-400 hover:text-white border border-white/10"
                  }`}
                >
                  <Pencil className="w-3 h-3" />
                  {isEditing ? "Editing" : "Edit script"}
                </button>
              </div>
              {isEditing ? (
                <textarea
                  value={editedScript}
                  onChange={(e) => setEditedScript(e.target.value)}
                  className="w-full h-64 bg-white/5 border border-cyan-500/30 rounded-xl px-4 py-3 text-xs text-slate-200 font-mono leading-relaxed outline-none focus:border-cyan-500/60 resize-none"
                />
              ) : (
                <div className="bg-white/3 border border-white/8 rounded-xl p-4 max-h-64 overflow-y-auto text-xs text-slate-300 leading-relaxed prose prose-invert prose-sm">
                  <Streamdown>{video.script ?? ""}</Streamdown>
                </div>
              )}
              <p className="text-xs text-slate-600 mt-1.5">
                {editedScript.length.toLocaleString()} characters
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter className="border-t border-white/8 pt-4 flex flex-col sm:flex-row gap-2">
          <button
            onClick={() => rejectMutation.mutate({ id: videoId })}
            disabled={rejectMutation.isPending || approveMutation.isPending}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
          >
            {rejectMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <XIcon className="w-4 h-4" />}
            Reject & Cancel
          </button>
          <div className="flex-1" />
          <button
            onClick={() => { navigator.clipboard.writeText(editedScript); toast.success("Script copied!"); }}
            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <Copy className="w-4 h-4" />
            Copy
          </button>
          <button
            onClick={handleApprove}
            disabled={approveMutation.isPending || rejectMutation.isPending}
            className="btn-gradient flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50"
          >
            {approveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            Approve & Start Production
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Video Card ───────────────────────────────────────────────────────────────
function VideoCard({ video, onView, onDelete, onRename, onRetry, onEdit }: {
  video: {
    id: number; title: string | null; prompt: string; status: string;
    videoLength: string; createdAt: Date; thumbnailUrl: string | null;
    errorMessage?: string | null;
  };
  onView: (id: number) => void;
  onDelete: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onRetry: (id: number) => void;
  onEdit?: (id: number) => void;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(video.title ?? video.prompt.slice(0, 80));
  const listStillProcessing = !["completed", "failed"].includes(video.status);
  const needsApproval = video.status === "awaiting_approval";
  const { data: pollData } = trpc.video.pollStatus.useQuery(
    { id: video.id },
    { enabled: listStillProcessing, refetchInterval: listStillProcessing ? 2000 : false }
  );
  const currentStatus = pollData?.status ?? video.status;
  const isProcessing = !["completed", "failed"].includes(currentStatus);
  const stageInfo = AGENT_STAGES[currentStatus] ?? { label: currentStatus, agent: "AI", icon: "⚙️" };
  const statusBadgeLabel =
    isProcessing && pollData?.progressStep
      ? pollData.progressStep
      : stageInfo.label;
  const statusColor = STATUS_COLORS[currentStatus] ?? "text-slate-400 bg-slate-400/10";
  const displayThumbnail = pollData?.thumbnailUrl ?? video.thumbnailUrl;

  useEffect(() => {
    if (pollData?.status === "completed" && video.status !== "completed") {
      void utils.video.list.invalidate();
    }
  }, [pollData?.status, video.status, utils.video.list]);

  const progressPercent = pollData?.progressPercent ?? 0;
  const progressLog = (pollData?.progressLog ?? []) as Array<{ step: string; startedAt: number; completedAt?: number; status: string }>;
  const [elapsed, setElapsed] = useState(0);
  const [stepTimers, setStepTimers] = useState<Record<number, number>>({});

  useEffect(() => {
    const startTime = pollData?.generationStartedAt;
    if (!isProcessing || !startTime) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - new Date(startTime).getTime()) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isProcessing, pollData?.generationStartedAt]);

  // Live per-step elapsed timers
  useEffect(() => {
    if (!isProcessing || progressLog.length === 0) return;
    const id = setInterval(() => {
      const now = Date.now();
      const timers: Record<number, number> = {};
      progressLog.forEach((entry, idx) => {
        if (entry.status === "active") {
          timers[idx] = Math.floor((now - entry.startedAt) / 1000);
        } else if (entry.completedAt) {
          timers[idx] = Math.floor((entry.completedAt - entry.startedAt) / 1000);
        }
      });
      setStepTimers(timers);
    }, 1000);
    return () => clearInterval(id);
  }, [isProcessing, progressLog]);

  const elapsedMin = Math.floor(elapsed / 60);
  const elapsedSec = String(elapsed % 60).padStart(2, "0");
  const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsed}s`;
  const nearingLimit = elapsed > 75 * 60; // warn after 75 min

  return (
    <div className="glass-card border border-white/8 rounded-xl overflow-hidden hover:border-white/15 transition-all duration-300 group">


      {/* Thumbnail */}
      <div className="relative aspect-video bg-gradient-to-br from-purple-900/40 to-cyan-900/30 overflow-hidden">
        {displayThumbnail && currentStatus === "completed" ? (
          <img src={displayThumbnail} alt={video.title ?? "Video"} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {isProcessing ? (
              <div className="flex flex-col w-full h-full overflow-y-auto">
                {/* Header: total elapsed + percent */}
                <div className="flex items-center justify-between px-3 pt-3 pb-2 border-b border-white/8">
                  <div className="flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
                    <span className="text-[10px] font-bold text-white">{stageInfo.agent}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold text-purple-300">{progressPercent}%</span>
                    <span className={`text-[10px] font-mono ${nearingLimit ? "text-amber-400" : "text-slate-500"}`}>⏱ {elapsedStr}</span>
                  </div>
                </div>
                {/* Progress bar */}
                <div className="w-full bg-white/8 h-0.5">
                  <div className="h-full bg-gradient-to-r from-purple-500 to-cyan-500 transition-all duration-700" style={{ width: `${Math.max(progressPercent, 2)}%` }} />
                </div>
                {/* Step list */}
                <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
                  {progressLog.length === 0 ? (
                    <div className="flex items-center gap-2 py-1">
                      <Loader2 className="w-3 h-3 text-slate-500 animate-spin shrink-0" />
                      <span className="text-[10px] text-slate-500">{stageInfo.label}...</span>
                    </div>
                  ) : (
                    progressLog.map((entry, idx) => {
                      const isDone = entry.status === "done";
                      const isActive = entry.status === "active";
                      const stepSec = stepTimers[idx];
                      const stepMin = stepSec !== undefined ? Math.floor(stepSec / 60) : 0;
                      const stepSecRem = stepSec !== undefined ? stepSec % 60 : 0;
                      const stepTimeStr = stepSec !== undefined
                        ? (stepMin > 0 ? `${stepMin}m ${String(stepSecRem).padStart(2,"0")}s` : `${stepSec}s`)
                        : null;
                      return (
                        <div key={idx} className={`flex items-start gap-2 py-0.5 transition-opacity ${isDone ? "opacity-60" : "opacity-100"}`}>
                          {/* Status icon */}
                          <div className="shrink-0 mt-0.5">
                            {isDone ? (
                              <CheckCircle2 className="w-3 h-3 text-green-400" />
                            ) : isActive ? (
                              <Loader2 className="w-3 h-3 text-purple-400 animate-spin" />
                            ) : (
                              <div className="w-3 h-3 rounded-full border border-white/20" />
                            )}
                          </div>
                          {/* Step name */}
                          <div className="flex-1 min-w-0">
                            <p className={`text-[10px] leading-tight ${isActive ? "text-white font-semibold" : isDone ? "text-slate-400" : "text-slate-600"}`}>
                              {entry.step}
                            </p>
                          </div>
                          {/* Step timer */}
                          {stepTimeStr && (
                            <span className={`text-[9px] font-mono shrink-0 ${isActive ? "text-cyan-400" : "text-slate-600"}`}>
                              {stepTimeStr}
                            </span>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
                {nearingLimit && (
                  <div className="px-3 pb-2">
                    <p className="text-[9px] text-amber-400 text-center">⚠️ Nearing 1.5h limit</p>
                  </div>
                )}
                {elapsed > 10 * 60 && (
                  <div className="px-3 pb-3">
                    <button
                      onClick={() => onRetry(video.id)}
                      className="w-full flex items-center justify-center gap-2 text-[10px] font-bold text-white bg-purple-600/80 hover:bg-purple-500 px-3 py-1.5 rounded-lg transition-colors"
                    >
                      <RefreshCw className="w-3 h-3" /> Stuck? Retry
                    </button>
                  </div>
                )}
              </div>
            ) : currentStatus === "failed" ? (
              <div className="flex flex-col items-center gap-2 px-4 py-3 text-center w-full">
                <XCircle className="w-10 h-10 text-red-400/60 shrink-0" />
                {video.errorMessage && (
                  <p className="text-[10px] text-red-300/90 leading-snug line-clamp-4 w-full">
                    {appErrorText(video.errorMessage)}
                  </p>
                )}
                {video.errorMessage && parseAppErrorCode(video.errorMessage) !== null && (
                  <p className="text-[9px] font-mono text-slate-500">
                    Code {parseAppErrorCode(video.errorMessage)}
                  </p>
                )}
                <button
                  onClick={() => onRetry(video.id)}
                  className="flex items-center gap-2 text-xs font-bold text-white bg-purple-600 hover:bg-purple-500 px-3 py-1.5 rounded-lg transition-colors shadow-lg shadow-purple-500/30"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Retry
                </button>
              </div>
            ) : (
              <Video className="w-10 h-10 text-slate-600" />
            )}
          </div>
        )}
        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-medium max-w-[55%] truncate ${statusColor}`}>
          {statusBadgeLabel}
        </div>
        <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-black/60 text-xs text-white font-mono">
          {VIDEO_LENGTHS.find(l => l.value === video.videoLength)?.label ?? video.videoLength}
        </div>
      </div>

      {/* Info */}
      <div className="p-4">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="mono text-[10px] font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-1.5 py-0.5 rounded">
            {formatVideoId(video.id)}
          </span>
        </div>
        {editing ? (
          <div className="flex items-center gap-1 mb-1">
            <input
              autoFocus
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { onRename(video.id, editTitle); setEditing(false); } if (e.key === "Escape") setEditing(false); }}
              className="flex-1 bg-white/10 border border-purple-500/50 rounded px-2 py-1 text-xs text-white outline-none"
            />
            <button onClick={() => { onRename(video.id, editTitle); setEditing(false); }} className="p-1 text-green-400 hover:text-green-300"><Check className="w-3.5 h-3.5" /></button>
            <button onClick={() => setEditing(false)} className="p-1 text-slate-400 hover:text-white"><XIcon className="w-3.5 h-3.5" /></button>
          </div>
        ) : (
          <h3 className="font-semibold text-white text-sm line-clamp-1 mb-1">
            {video.title ?? video.prompt.slice(0, 60)}
          </h3>
        )}
        <p className="text-xs text-slate-500 line-clamp-2 mb-3">{video.prompt}</p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-600">{new Date(video.createdAt).toLocaleDateString()}</span>
          <div className="flex items-center gap-2">

            <button
              onClick={() => { setEditTitle(video.title ?? video.prompt.slice(0, 80)); setEditing(true); }}
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
              title="Rename"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onDelete(video.id)}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
              title="Delete"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            {currentStatus === "completed" && (
              <>
                <button
                  onClick={() => onEdit?.(video.id)}
                  className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                  title="Edit video"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                  Edit
                </button>
                <button
                  onClick={() => onView(video.id)}
                  className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  View
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Video Detail Modal ───────────────────────────────────────────────────────
function VideoDetailModal({ videoId, onClose }: { videoId: number; onClose: () => void }) {
  const { data: video, isLoading } = trpc.video.get.useQuery({ id: videoId });
  // Fetch a direct presigned CloudFront URL for video playback (bypasses 307 redirect)
  const { data: videoUrlData } = trpc.video.getVideoUrl.useQuery(
    { id: videoId },
    { enabled: !!(video?.videoUrl && video?.status === "completed"), staleTime: 1000 * 60 * 5 }
  );
  const rawVideoUrl = (video as { videoUrl?: string | null })?.videoUrl ?? null;
  const fileMissing = videoUrlData?.fileMissing === true;
  // Use authenticated stream URL (Range-aware) for Railway local storage
  const directVideoUrl = fileMissing ? null : (videoUrlData?.url ?? rawVideoUrl);
  type VideoMetadata = { title?: string; description?: string; tags?: string[]; chapters?: { time: string; title: string }[] };
  const metadata = video?.metadata as VideoMetadata | null;

  const copyScript = () => {
    if (video?.script) {
      navigator.clipboard.writeText(video.script);
      toast.success("Script copied to clipboard!");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="glass-card border border-white/15 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-white/8">
          <h2 className="font-bold text-white text-lg">{video?.title ?? "Video Details"}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors text-xl leading-none">×</button>
        </div>
        {isLoading ? (
          <div className="flex-1 flex items-center justify-center p-12">
            <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
          </div>
        ) : video ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {/* Video Player */}
            {video.status === "completed" && (!video.videoUrl || fileMissing) && (
              <div className="glass-card border border-amber-500/20 rounded-xl p-5 flex items-start gap-3 bg-amber-500/5">
                <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-300">Videobestand niet beschikbaar</p>
                  <p className="text-xs text-slate-400 mt-1">
                    {fileMissing
                      ? "Het MP4-bestand staat niet meer op de server (vaak na een Railway-deploy zonder persistent volume). Genereer deze video opnieuw. Koppel een Railway Volume op /data/uploads om dit te voorkomen."
                      : "Deze video is afgerond maar het bestand ontbreekt. Genereer opnieuw."}
                  </p>
                </div>
              </div>
            )}
            {video.status === "completed" && video.videoUrl && !fileMissing && (
              <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
                <div className="flex items-center justify-between px-4 pt-4 pb-2">
                  <h3 className="font-semibold text-white text-sm flex items-center gap-2">
                    <Play className="w-4 h-4 text-green-400" /> Your Video
                  </h3>
                  <a
                    href={`/api/download/video/${video.id}`}
                    download={`${(video.title ?? `fastvid-${formatVideoId(video.id)}`).replace(/[^a-zA-Z0-9\-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || `fastvid-${formatVideoId(video.id)}`}.mp4`}
                    className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors px-2.5 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 hover:bg-cyan-500/20"
                  >
                    <Download className="w-3.5 h-3.5" /> Download MP4
                  </a>
                </div>
                {directVideoUrl ? (
                  <video
                    controls
                    className="w-full"
                    src={directVideoUrl}
                    poster={video.thumbnailUrl ?? undefined}
                    preload="metadata"
                  >
                    Your browser does not support the video tag.
                  </video>
                ) : (
                  <div className="flex items-center justify-center p-8 text-slate-400 text-sm gap-2">
                    <Download className="w-4 h-4" />
                    <span>Video ready — click Download MP4 to save it</span>
                  </div>
                )}
              </div>
            )}
            {/* Metadata */}
            {metadata && (
              <div className="glass-card border border-white/8 rounded-xl p-4 space-y-3">
                <h3 className="font-semibold text-white text-sm flex items-center gap-2"><Sparkles className="w-4 h-4 text-purple-400" /> SEO Metadata</h3>
                {metadata.title && <div><p className="text-xs text-slate-500 mb-1">YouTube Title</p><p className="text-sm text-white font-medium">{metadata.title}</p></div>}
                {metadata.description && <div><p className="text-xs text-slate-500 mb-1">Description</p><p className="text-xs text-slate-300 leading-relaxed line-clamp-4">{metadata.description}</p></div>}
                {metadata.tags && metadata.tags.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-500 mb-2">Tags</p>
                    <div className="flex flex-wrap gap-1.5">
                      {metadata.tags.map((tag: string) => (
                        <span key={tag} className="px-2 py-0.5 rounded-md bg-purple-600/20 border border-purple-500/20 text-xs text-purple-300">{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
                {metadata.chapters && metadata.chapters.length > 0 && (
                  <div>
                    <p className="text-xs text-slate-500 mb-2">Chapters</p>
                    <div className="space-y-1">
                      {metadata.chapters.map((ch) => (
                        <div key={ch.time} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-cyan-400 w-12">{ch.time}</span>
                          <span className="text-slate-300">{ch.title}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {/* Script */}
            {video.script && (
              <div className="glass-card border border-white/8 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-white text-sm flex items-center gap-2"><FileText className="w-4 h-4 text-cyan-400" /> Script</h3>
                  <button onClick={copyScript} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
                    <Copy className="w-3.5 h-3.5" /> Copy
                  </button>
                </div>
                <div className="text-xs text-slate-300 leading-relaxed max-h-64 overflow-y-auto prose prose-invert prose-sm">
                  <Streamdown>{video.script}</Streamdown>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─── Voice Selector Component ────────────────────────────────────────────────
function VoiceSelector({ selectedVoice, onSelect }: { selectedVoice: string; onSelect: (id: string) => void }) {
  const { data: voices = [], isLoading } = trpc.voice.list.useQuery();
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [loadingPreviewId, setLoadingPreviewId] = useState<number | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const previewMutation = trpc.voice.preview.useMutation();

  useEffect(() => {
    if (voices.length > 0 && !voices.find(v => v.fishAudioReferenceId === selectedVoice)) {
      onSelect(voices[0].fishAudioReferenceId);
    }
  }, [voices]);

  function stopAudio() {
    if (audioEl) { audioEl.pause(); audioEl.src = ""; }
    setAudioEl(null);
    setPlayingId(null);
  }

  function playAudioUrl(url: string, voiceId: number) {
    stopAudio();
    const a = new Audio(url);
    a.onended = () => { setPlayingId(null); setAudioEl(null); };
    a.play();
    setAudioEl(a);
    setPlayingId(voiceId);
  }

  async function handlePreview(voice: typeof voices[0], e: React.MouseEvent) {
    e.stopPropagation();
    if (playingId === voice.id) { stopAudio(); return; }
    if (voice.exampleAudioUrl) {
      playAudioUrl(voice.exampleAudioUrl, voice.id);
      return;
    }
    setLoadingPreviewId(voice.id);
    try {
      const result = await previewMutation.mutateAsync({ fishAudioReferenceId: voice.fishAudioReferenceId });
      setLoadingPreviewId(null);
      playAudioUrl(result.url, voice.id);
    } catch (err: unknown) {
      setLoadingPreviewId(null);
      const msg = toastErrorMessage(err, "Could not generate voice preview");
      toast.error("Preview failed", { description: msg });
    }
  }
  return (
    <div>
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Voice (ElevenLabs)</p>
      <div className="grid grid-cols-1 gap-2">
        {voices.map(v => (
          <div
            key={v.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(v.fishAudioReferenceId)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(v.fishAudioReferenceId); }}
            className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all duration-200 flex items-center gap-2.5 w-full text-left cursor-pointer ${
              selectedVoice === v.fishAudioReferenceId
                ? "bg-gradient-to-br from-purple-600/40 to-cyan-500/30 border-purple-400/60 text-white shadow-lg shadow-purple-500/20"
                : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200 bg-white/3"
            }`}
          >
            <span className="text-base">{v.flag ?? "🎙️"}</span>
            <div className="flex-1 min-w-0">
              <span className="font-bold block">{v.name}</span>
              {v.description && <span className={`text-[10px] font-normal truncate block ${
                selectedVoice === v.fishAudioReferenceId ? "text-cyan-300" : "text-slate-600"
              }`}>{v.description}</span>}
            </div>
            <button
              onClick={(e) => handlePreview(v, e)}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                playingId === v.id
                  ? "bg-purple-600 text-white"
                  : loadingPreviewId === v.id
                  ? "bg-white/10 text-slate-400 cursor-wait"
                  : "bg-white/10 text-slate-300 hover:bg-white/20"
              }`}
              disabled={loadingPreviewId !== null && loadingPreviewId !== v.id}
            >
              {loadingPreviewId === v.id ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Generating...</>
              ) : playingId === v.id ? (
                <><Volume2 className="w-3 h-3" /> Stop</>
              ) : (
                <><Volume2 className="w-3 h-3" /> Preview</>
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Custom Voiceover Upload ──────────────────────────────────────────────────
function CustomVoiceoverUpload({ onUpload, onClear, uploadedUrl }: {
  onUpload: (url: string) => void;
  onClear: () => void;
  uploadedUrl: string | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadMutation = trpc.voice.uploadCustom.useMutation({
    onSuccess: (data) => {
      onUpload(data.url);
      toast.success("Voiceover uploaded!", { description: "Your audio will be used instead of TTS." });
    },
    onError: (err) => toast.error("Upload failed", { description: toastErrorMessage(err) }),
  });

  const handleFile = async (file: File) => {
    if (!file) return;
    const maxMb = 50;
    if (file.size > maxMb * 1024 * 1024) {
      toast.error(`File too large (max ${maxMb}MB)`);
      return;
    }
    if (!["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm"].includes(file.type)) {
      toast.error("Unsupported format. Use MP3, WAV, OGG, or M4A.");
      return;
    }
    const arrayBuf = await file.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...Array.from(new Uint8Array(arrayBuf))));
    uploadMutation.mutate({ base64, mimeType: file.type, filename: file.name });
  };

  if (uploadedUrl) {
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-green-500/30 bg-green-500/10">
        <Mic className="w-4 h-4 text-green-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-green-300">Custom voiceover uploaded</p>
          <p className="text-[10px] text-green-400/70 truncate">Your audio will be used instead of TTS</p>
        </div>
        <button onClick={onClear} className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded hover:bg-white/10 transition-colors">
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <input
        ref={fileRef}
        type="file"
        accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/webm,.mp3,.wav,.ogg,.m4a"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={uploadMutation.isPending}
        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-white/20 text-xs text-slate-400 hover:text-slate-200 hover:border-white/30 transition-colors disabled:opacity-50"
      >
        {uploadMutation.isPending ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Uploading...</>
        ) : (
          <><Upload className="w-3.5 h-3.5" /> Upload your own voiceover (MP3, WAV — max 50MB)</>
        )}
      </button>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, loading, isAuthenticated, logout } = useAuth({ redirectOnUnauthenticated: true });
  const [, navigate] = useLocation();
  const [prompt, setPrompt] = useState("");
  const [selectedLength, setSelectedLength] = useState<VideoLength>("15-20");
  const [selectedType, setSelectedType] = useState<VideoType>("documentary");
  const [selectedVoice, setSelectedVoice] = useState("pNInz6obpgDQGcFmaJgB"); // ElevenLabs Michael voice ID
  const [useCustomVoice, setUseCustomVoice] = useState(false);
  const [customVoiceoverUrl, setCustomVoiceoverUrl] = useState<string | null>(null);
  const [enableSubtitles, setEnableSubtitles] = useState(true);
  const [viewingVideoId, setViewingVideoId] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const deleteMutation = trpc.videoManage.delete.useMutation({
    onSuccess: () => { toast.success("Video deleted"); utils.video.list.invalidate(); },
    onError: (err) => toast.error("Delete failed", { description: toastErrorMessage(err) }),
  });
  const renameMutation = trpc.videoManage.updateTitle.useMutation({
    onSuccess: () => { toast.success("Title updated"); utils.video.list.invalidate(); },
    onError: (err) => toast.error("Rename failed", { description: toastErrorMessage(err) }),
  });
  const deleteFailedMutation = trpc.videoManage.deleteAllFailed.useMutation({
    onSuccess: (data) => { toast.success(`Deleted ${data.deleted} failed video${data.deleted !== 1 ? "s" : ""}`); utils.video.list.invalidate(); },
    onError: (err) => toast.error("Failed", { description: toastErrorMessage(err) }),
  });
  const regenScriptMutation = trpc.video.regenScript.useMutation({
    onError: (err) => toast.error("Retry failed", { description: toastErrorMessage(err) }),
  });

  const { data: videos, isLoading: videosLoading, refetch } = trpc.video.list.useQuery(undefined, { enabled: isAuthenticated, refetchInterval: 5000 });
  const checkoutMutation = trpc.billing.createCheckout.useMutation({
    onSuccess: (data) => {
      if (data.url) {
        toast.info("Redirecting to checkout...", { description: "Opening Stripe payment page" });
        window.open(data.url, "_blank");
      }
    },
    onError: (err) => toast.error("Checkout failed", { description: toastErrorMessage(err) }),
  });
  const generateMutation = trpc.video.generate.useMutation({
    onSuccess: (data) => {
      toast.success("Video generation started!", { description: "Your video will be ready in a few minutes. No action needed." });
      setPrompt("");
      setTimeout(() => refetch(), 2000);
    },
    onError: (err) => {
      if (matchesAppError(err.message, APP_ERROR.SUBSCRIPTION_REQUIRED)) {
        toast.error("Active subscription required", { description: "Please contact the admin to activate your subscription." });
      } else {
        toast.error("Failed to start generation", { description: toastErrorMessage(err) });
      }
    },
  });
  
  const userSub = (user as { subscriptionStatus?: string } | null)?.subscriptionStatus;
  const hasActiveSubscription = userSub === "active" || user?.role === "admin";
  const activeLengthOption = VIDEO_LENGTHS.find(l => l.value === selectedLength)!;
  const activeTypeOption = VIDEO_TYPES.find(t => t.value === selectedType)!;

  // ─── Subscription gate ────────────────────────────────────────────────────
  // Redirect non-admin users without an active subscription to /subscribe
  useEffect(() => {
    if (!loading && isAuthenticated && user && !hasActiveSubscription) {
      navigate("/subscribe");
    }
  }, [loading, isAuthenticated, user, hasActiveSubscription, navigate]);

  const handleGenerate = () => {
    if (!prompt.trim() || prompt.length < 10) {
      toast.error("Please enter a prompt of at least 10 characters");
      return;
    }
    generateMutation.mutate({
      prompt: prompt.trim(),
      videoLength: selectedLength,
      videoType: selectedType,
      voiceId: useCustomVoice ? undefined : selectedVoice,
      customVoiceoverUrl: useCustomVoice ? (customVoiceoverUrl ?? undefined) : undefined,
      enableSubtitles,
    });
  };

  const processingVideos = videos?.filter(v => !["completed", "failed"].includes(v.status)) ?? [];
  const completedVideos = videos?.filter(v => v.status === "completed") ?? [];
  const failedVideos = videos?.filter(v => v.status === "failed") ?? [];


  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* ── Sidebar ── */}
      <div className="fixed left-0 top-0 bottom-0 w-60 bg-background/95 border-r border-white/8 flex flex-col z-40 hidden lg:flex">
        <div className="p-5 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-black text-xl text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <button className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-purple-600/20 text-white text-sm font-medium">
            <LayoutDashboard className="w-4 h-4 text-purple-400" />
            Dashboard
          </button>
          <button onClick={() => navigate("/")} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
            <Video className="w-4 h-4" />
            Landing Page
          </button>
          {user?.role === "admin" && (
            <button onClick={() => navigate("/admin")} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
              <Settings className="w-4 h-4" />
              Admin Panel
            </button>
          )}
        </nav>
        <div className="p-4 border-t border-white/8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center text-white font-bold text-sm">
              {user?.name?.[0] ?? "U"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name ?? "User"}</p>
              <p className={`text-xs ${hasActiveSubscription ? "text-green-400" : "text-yellow-400"}`}>
                {hasActiveSubscription ? "Active" : "No subscription"}
              </p>
            </div>
          </div>
          <button onClick={() => { logout(); navigate("/"); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
            <LogOut className="w-4 h-4" />
            Log out
          </button>
        </div>
      </div>

      {/* ── Mobile Header ── */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-background/95 border-b border-white/8 px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
            <Play className="w-3.5 h-3.5 text-white fill-white" />
          </div>
          <span className="font-black text-lg text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>Fast<span className="gradient-text">vid</span></span>
        </div>
        <div className="flex items-center gap-2">
          {user?.role === "admin" && (
            <button onClick={() => navigate("/admin")} className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded-md hover:bg-white/5 transition-colors">Admin</button>
          )}
          <button onClick={() => { logout(); navigate("/"); }} className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded-md hover:bg-white/5 transition-colors">Logout</button>
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="lg:pl-60 pt-14 lg:pt-0">
        <div className="max-w-5xl mx-auto p-6 lg:p-8 space-y-8">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-black text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Welcome back, <span className="gradient-text">{user?.name?.split(" ")[0] ?? "Creator"}</span>
            </h1>
            <p className="text-slate-400 text-sm mt-1">Generate your next viral YouTube video</p>
          </div>

          {/* Subscription warning + Stripe checkout */}
          {!hasActiveSubscription && (
            <div className="glass-card border border-yellow-500/30 bg-yellow-500/5 rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
              <div className="flex items-start gap-3 flex-1">
                <div className="w-5 h-5 rounded-full bg-yellow-500/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-yellow-400 text-xs font-bold">!</span>
                </div>
                <div>
                  <p className="text-sm font-semibold text-yellow-300">No active subscription</p>
                  <p className="text-xs text-yellow-400/70 mt-0.5">Subscribe to the Fastvid Pro plan for €500/month and start generating unlimited videos.</p>
                </div>
              </div>
              <button
                onClick={() => checkoutMutation.mutate({ origin: window.location.origin })}
                disabled={checkoutMutation.isPending}
                className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-2 shrink-0 disabled:opacity-60"
              >
                {checkoutMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                Subscribe — €500/month
              </button>
            </div>
          )}



          {/* ── Video Generator ── */}
          <div className="glass-card border border-white/10 rounded-2xl p-6 space-y-5">
            <h2 className="font-bold text-white text-lg flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              Generate New Video
            </h2>

            {/* Video Type selector */}
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Video format</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {VIDEO_TYPES.map(opt => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setSelectedType(opt.value)}
                      className={`px-3 py-2.5 rounded-lg text-xs font-semibold border transition-all duration-200 flex flex-col items-center gap-1 ${
                        selectedType === opt.value
                          ? `bg-gradient-to-br ${opt.color} text-white shadow-lg`
                          : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200 bg-white/3"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span className="font-bold text-center leading-tight">{opt.label}</span>
                      <span className={`text-[10px] font-normal text-center ${selectedType === opt.value ? "text-white/70" : "text-slate-600"}`}>{opt.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Length selector */}
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Video length</p>
              <div className="flex flex-wrap gap-2">
                {VIDEO_LENGTHS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setSelectedLength(opt.value)}
                    className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all duration-200 flex flex-col items-center gap-0.5 min-w-[72px] ${
                      selectedLength === opt.value
                        ? "bg-gradient-to-br from-purple-600/40 to-cyan-500/30 border-purple-400/60 text-white shadow-lg shadow-purple-500/20"
                        : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200 bg-white/3"
                    }`}
                  >
                    <span className="font-bold">{opt.label}</span>
                    <span className={`text-[10px] font-normal ${selectedLength === opt.value ? "text-cyan-300" : "text-slate-600"}`}>{opt.desc}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-slate-600 mt-2 flex items-center gap-1.5">
                <Clock className="w-3 h-3 text-cyan-500" />
                Generation time: <span className="text-cyan-400 font-medium">{activeLengthOption.genTime}</span>
              </p>
            </div>

            {/* Voice / Custom voiceover */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Voiceover</p>
                <button
                  onClick={() => { setUseCustomVoice(!useCustomVoice); setCustomVoiceoverUrl(null); }}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    useCustomVoice
                      ? "bg-cyan-500/20 text-cyan-300 border-cyan-500/30"
                      : "bg-white/5 text-slate-400 hover:text-white border-white/10"
                  }`}
                >
                  <Mic className="w-3 h-3" />
                  {useCustomVoice ? "Using custom voice" : "Use my own voice"}
                </button>
              </div>
              {useCustomVoice ? (
                <CustomVoiceoverUpload
                  uploadedUrl={customVoiceoverUrl}
                  onUpload={setCustomVoiceoverUrl}
                  onClear={() => setCustomVoiceoverUrl(null)}
                />
              ) : (
                <VoiceSelector selectedVoice={selectedVoice} onSelect={setSelectedVoice} />
              )}
            </div>

            {/* Prompt input */}
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Your prompt</p>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={`Describe your ${activeTypeOption.label} video... e.g. "${
                  selectedType === "listicle" ? "Top 10 productivity hacks for entrepreneurs in 2025" :
                  selectedType === "tutorial" ? "How to set up a professional home studio on a budget" :
                  selectedType === "explainer" ? "How does blockchain technology actually work?" :
                  "The rise and fall of Blockbuster — what really happened"
                }"`}
                rows={3}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-600 outline-none focus:border-purple-500/50 focus:bg-white/8 transition-all resize-none"
              />
              <p className="text-xs text-slate-600 mt-1">{prompt.length}/1000 characters</p>
            </div>

            {/* How it works note */}
            <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-blue-500/5 border border-blue-500/15">
              <span className="text-sm mt-0.5">💡</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                <span className="text-blue-300 font-semibold">How it works:</span> AI writes your script, generates voiceover, matches visuals, and assembles your video automatically. No action needed.
              </p>
            </div>

            {/* Subtitle toggle */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-white/5 border border-white/10">
              <div>
                <p className="text-sm font-medium text-white">Subtitles</p>
                <p className="text-xs text-slate-500">Show captions on the video</p>
              </div>
              <Switch
                checked={enableSubtitles}
                onCheckedChange={setEnableSubtitles}
              />
            </div>
            <button
              onClick={handleGenerate}
              disabled={!hasActiveSubscription || generateMutation.isPending || prompt.length < 10}
              className="btn-gradient px-6 py-3 rounded-xl font-bold text-white flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
            >
              {generateMutation.isPending ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Starting generation...</>
              ) : (
                <><Sparkles className="w-4 h-4" /> Generate Video</>
              )}
            </button>
          </div>

          {/* ── Stats Row ── */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Total", value: videos?.length ?? 0, icon: Video, color: "text-purple-400" },
              { label: "Completed", value: completedVideos.length, icon: CheckCircle2, color: "text-green-400" },
              { label: "In Progress", value: processingVideos.length, icon: Loader2, color: "text-cyan-400" },
              { label: "Failed", value: failedVideos.length, icon: XCircle, color: "text-red-400" },
            ].map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="glass-card border border-white/8 rounded-xl p-4 text-center">
                <Icon className={`w-5 h-5 ${color} mx-auto mb-2`} />
                <p className="text-2xl font-black text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>{value}</p>
                <p className="text-xs text-slate-500">{label}</p>
              </div>
            ))}
          </div>

          {/* ── Video List ── */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-white text-lg">Your Videos</h2>
              <div className="flex items-center gap-2">
                {failedVideos.length > 0 && (
                  <button
                    onClick={() => deleteFailedMutation.mutate()}
                    disabled={deleteFailedMutation.isPending}
                    className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded-md hover:bg-red-500/10"
                  >
                    {deleteFailedMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    Clear {failedVideos.length} failed
                  </button>
                )}
                <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
              </div>
            </div>
            {videosLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
              </div>
            ) : !videos || videos.length === 0 ? (
              <div className="glass-card border border-white/8 rounded-xl p-12 text-center">
                <Video className="w-10 h-10 text-slate-600 mx-auto mb-3" />
                <p className="text-slate-400 font-medium">No videos yet</p>
                <p className="text-slate-600 text-sm mt-1">Generate your first video above</p>
              </div>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {videos.map(video => (
                  <VideoCard
                    key={video.id}
                    video={video}
                    onView={setViewingVideoId}
                    onDelete={(id) => {
                      if (confirm("Delete this video? This cannot be undone.")) deleteMutation.mutate({ id });
                    }} 
                    onRename={(id, title) => renameMutation.mutate({ id, title })}
                    onRetry={(id) => regenScriptMutation.mutate({ id })}
                    onEdit={(id) => navigate(`/editor/${id}`)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Video Detail Modal ── */}
      {viewingVideoId !== null && (
        <VideoDetailModal videoId={viewingVideoId} onClose={() => setViewingVideoId(null)} />
      )}


    </div>
  );
}
