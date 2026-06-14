/**
 * FASTVID — Admin Dashboard
 * Full control over users, subscriptions, video overview, and video generation
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { appErrorText, toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  Users, Video, TrendingUp, CheckCircle2, Loader2,
  Play, LogOut, LayoutDashboard, Settings, Shield, RefreshCw,
  UserCheck, Crown, Eye, X, Copy, AlertTriangle,
  FileText, Hash, Sparkles, Search, Filter, Download,
  ChevronDown, Mic, Plus, Pencil, Trash2, Volume2, ToggleLeft, ToggleRight,
  Archive, Upload, Radio,
} from "lucide-react";
import { MediaArchiveAdmin } from "@/components/admin/MediaArchiveAdmin";
import { NicheRequestsAdmin } from "@/components/admin/NicheRequestsAdmin";
import { GenerationProgressBar } from "@/components/GenerationProgressBar";

function formatVideoId(id: number) {
  return `#VID-${String(id).padStart(4, "0")}`;
}

import { VIDEO_LENGTH_OPTIONS, type VideoLength } from "@shared/videoLengths";

const VIDEO_LENGTHS = VIDEO_LENGTH_OPTIONS.map((opt) =>
  opt.value === "1" ? { ...opt, label: "1 min (test)" } : opt
);

function StatCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: number | string; icon: React.ElementType; color: string; sub?: string;
}) {
  return (
    <div className="glass-card border border-white/8 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className="text-3xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  active: "text-green-400 bg-green-400/10 border-green-400/20",
  inactive: "text-yellow-400 bg-yellow-400/10 border-yellow-400/20",
  cancelled: "text-red-400 bg-red-400/10 border-red-400/20",
};

const VIDEO_STATUS_BADGE: Record<string, string> = {
  completed: "text-green-400 bg-green-400/10",
  failed: "text-red-400 bg-red-400/10",
  pending: "text-yellow-400 bg-yellow-400/10",
  generating_script: "text-blue-400 bg-blue-400/10",
  generating_voiceover: "text-purple-400 bg-purple-400/10",
  generating_visuals: "text-cyan-400 bg-cyan-400/10",
  generating_effects: "text-orange-400 bg-orange-400/10",
  queued: "text-amber-400 bg-amber-400/10",
};

type VideoRow = {
  id: number;
  userId: number;
  prompt: string;
  videoLength: string;
  status: string;
  title?: string | null;
  script?: string | null;
  metadata?: string | null;
  videoUrl?: string | null;
  errorMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
  userName?: string | null;
  userEmail?: string | null;
};

function VideoDetailModal({ video, onClose }: { video: VideoRow; onClose: () => void }) {
  const [tab, setTab] = useState<"video" | "info" | "script" | "metadata">(
    video.videoUrl ? "video" : "info"
  );
  // Fetch presigned URL for video playback (needed for /manus-storage/ URLs on Manus sandbox)
  const { data: videoUrlData } = trpc.video.getVideoUrl.useQuery(
    { id: video.id },
    { enabled: !!(video.videoUrl && video.status === "completed"), staleTime: 1000 * 60 * 5 }
  );
  const playbackUrl = videoUrlData?.url ?? video.videoUrl;

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  }

  let parsedMeta: {
    title?: string;
    description?: string;
    tags?: string[];
    chapters?: { timestamp: string; title: string }[];
  } | null = null;
  try {
    if (video.metadata) parsedMeta = JSON.parse(video.metadata);
  } catch {}

  const tabs = [
    ...(video.videoUrl ? [{ id: "video" as const, label: "Video" }] : []),
    { id: "info" as const, label: "Info" },
    { id: "script" as const, label: "Script" },
    { id: "metadata" as const, label: "Metadata" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col glass-card border border-white/12 rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 shrink-0">
          <div className="flex items-center gap-3">
            <span className="mono text-sm font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2.5 py-1 rounded-lg">
              {formatVideoId(video.id)}
            </span>
            <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${VIDEO_STATUS_BADGE[video.status] ?? "text-slate-400 bg-white/5"}`}>
              {video.status}
            </span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-white/5">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex gap-1 px-5 pt-3 shrink-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === t.id ? "bg-purple-600/30 text-purple-300" : "text-slate-400 hover:text-white hover:bg-white/5"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === "video" && (
            <div className="space-y-4">
              {video.videoUrl ? (
                <>
                  {playbackUrl && <video src={playbackUrl} controls className="w-full rounded-xl border border-white/10 bg-black" style={{ maxHeight: "360px" }} />}
                  <a href={`/api/download/video/${video.id}`} download={`fastvid-${formatVideoId(video.id)}.mp4`} className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white text-sm font-semibold hover:opacity-90 transition-opacity">
                    <Download className="w-4 h-4" /> Download MP4
                  </a>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Video className="w-8 h-8 text-slate-600 mb-3" />
                  <p className="text-slate-500 text-sm">Video not yet available</p>
                </div>
              )}
            </div>
          )}
          {tab === "info" && (
            <div className="space-y-3">
              {video.errorMessage && (
                <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/20">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-red-400 mb-1">Error</p>
                    <p className="text-xs text-red-300">{appErrorText(video.errorMessage)}</p>
                  </div>
                </div>
              )}
              <div className="glass-card border border-white/8 rounded-xl p-4 space-y-3">
                {([
                  ["Video ID", <span key="vid" className="mono text-purple-400 text-xs">{formatVideoId(video.id)}</span>],
                  ["DB ID", <span key="dbid" className="mono text-slate-400 text-xs">#{video.id}</span>],
                  ["User ID", <span key="uid" className="mono text-slate-400 text-xs">#{video.userId}</span>],
                  ["Status", <span key="st" className={`px-2 py-0.5 rounded-md text-xs font-medium ${VIDEO_STATUS_BADGE[video.status] ?? "text-slate-400 bg-white/5"}`}>{video.status}</span>],
                  ["Length", <span key="len" className="text-xs text-slate-300">{video.videoLength} min</span>],
                  ["Created", <span key="cr" className="text-xs text-slate-400">{new Date(video.createdAt).toLocaleString()}</span>],
                  ["Updated", <span key="up" className="text-xs text-slate-400">{new Date(video.updatedAt).toLocaleString()}</span>],
                ] as [string, React.ReactNode][]).map(([label, val]) => (
                  <div key={String(label)} className="flex items-center justify-between gap-4">
                    <span className="text-xs text-slate-500 shrink-0">{label}</span>
                    <span className="text-right">{val}</span>
                  </div>
                ))}
              </div>
              <div className="glass-card border border-white/8 rounded-xl p-4">
                <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Original Prompt</p>
                <p className="text-sm text-slate-300 leading-relaxed">{video.prompt}</p>
              </div>
            </div>
          )}
          {tab === "script" && (
            <div>
              {video.script ? (
                <>
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Generated Script</p>
                    <button onClick={() => copyToClipboard(video.script!)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                  <div className="glass-card border border-white/8 rounded-xl p-4 prose prose-invert prose-sm max-w-none">
                    <Streamdown>{video.script}</Streamdown>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FileText className="w-8 h-8 text-slate-600 mb-3" />
                  <p className="text-slate-500 text-sm">Script not yet generated</p>
                  <p className="text-slate-600 text-xs mt-1">Status: {video.status}</p>
                </div>
              )}
            </div>
          )}
          {tab === "metadata" && (
            <div>
              {parsedMeta ? (
                <div className="space-y-3">
                  {parsedMeta.title && (
                    <div className="glass-card border border-white/8 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Title</p>
                        <button onClick={() => copyToClipboard(parsedMeta!.title ?? "")} className="flex items-center gap-1 text-xs text-slate-500 hover:text-white transition-colors"><Copy className="w-3 h-3" /> Copy</button>
                      </div>
                      <p className="text-sm text-slate-300 leading-relaxed">{parsedMeta.title}</p>
                    </div>
                  )}
                  {parsedMeta.description && (
                    <div className="glass-card border border-white/8 rounded-xl p-4">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">Description</p>
                        <button onClick={() => copyToClipboard(parsedMeta!.description ?? "")} className="flex items-center gap-1 text-xs text-slate-500 hover:text-white transition-colors"><Copy className="w-3 h-3" /> Copy</button>
                      </div>
                      <p className="text-sm text-slate-300 leading-relaxed">{parsedMeta.description}</p>
                    </div>
                  )}
                  {Array.isArray(parsedMeta.tags) && (
                    <div className="glass-card border border-white/8 rounded-xl p-4">
                      <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Tags</p>
                      <div className="flex flex-wrap gap-1.5">
                        {(parsedMeta.tags as string[]).map((tag: string) => (
                          <span key={tag} className="px-2 py-0.5 rounded-md bg-white/5 border border-white/8 text-xs text-slate-300">{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {Array.isArray(parsedMeta.chapters) && (
                    <div className="glass-card border border-white/8 rounded-xl p-4">
                      <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Chapters</p>
                      <div className="space-y-1">
                        {(parsedMeta.chapters as { timestamp: string; title: string }[]).map((ch, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="mono text-cyan-400 shrink-0">{ch.timestamp}</span>
                            <span className="text-slate-300">{ch.title}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Hash className="w-8 h-8 text-slate-600 mb-3" />
                  <p className="text-slate-500 text-sm">Metadata not yet generated</p>
                  <p className="text-slate-600 text-xs mt-1">Status: {video.status}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UsersTable() {
  const { data: users, isLoading, refetch } = trpc.admin.listUsers.useQuery({ limit: 100, offset: 0 });
  const updateSubMutation = trpc.admin.updateUserSubscription.useMutation({
    onSuccess: () => { toast.success("Subscription updated"); refetch(); },
    onError: () => toast.error("Failed to update subscription"),
  });
  const updateRoleMutation = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => { toast.success("Role updated"); refetch(); },
    onError: () => toast.error("Failed to update role"),
  });

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-purple-400 animate-spin" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-white text-lg flex items-center gap-2"><Users className="w-5 h-5 text-purple-400" /> Users ({users?.length ?? 0})</h2>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 text-xs text-slate-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">User</th>
                <th className="text-left px-4 py-3">Role</th>
                <th className="text-left px-4 py-3">Subscription</th>
                <th className="text-left px-4 py-3">Joined</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users?.map((user) => (
                <tr key={user.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center text-white font-bold text-xs shrink-0">
                        {(user.name ?? "U")[0]}
                      </div>
                      <div>
                        <p className="text-white text-xs font-medium">{user.name ?? "Unknown"}</p>
                        <p className="text-slate-500 text-xs">{user.email ?? "\u2014"}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${user.role === "admin" ? "text-purple-300 bg-purple-500/10 border-purple-500/20" : "text-slate-400 bg-white/5 border-white/8"}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_BADGE[(user as { subscriptionStatus?: string }).subscriptionStatus ?? "inactive"] ?? "text-slate-400 bg-white/5 border-white/8"}`}>
                      {(user as { subscriptionStatus?: string }).subscriptionStatus ?? "inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{new Date(user.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {(user as { subscriptionStatus?: string }).subscriptionStatus === "active" ? (
                        <button onClick={() => updateSubMutation.mutate({ userId: user.id, subscriptionStatus: "inactive" })} className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded-md hover:bg-red-400/10">
                          <UserCheck className="w-3 h-3" /> Deactivate
                        </button>
                      ) : (
                        <button onClick={() => updateSubMutation.mutate({ userId: user.id, subscriptionStatus: "active" })} className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors px-2 py-1 rounded-md hover:bg-green-400/10">
                          <UserCheck className="w-3 h-3" /> Activate
                        </button>
                      )}
                      {user.role !== "admin" && (
                        <button onClick={() => updateRoleMutation.mutate({ userId: user.id, role: "admin" })} className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors px-2 py-1 rounded-md hover:bg-purple-400/10">
                          <Crown className="w-3 h-3" /> Make Admin
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {(!users || users.length === 0) && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500 text-sm">No users yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function VideoStatusCell({ video }: { video: VideoRow }) {
  const isInProgress = !['completed', 'failed'].includes(video.status);
  const { data: pollData } = trpc.video.pollStatus.useQuery(
    { id: video.id },
    { enabled: isInProgress, refetchInterval: isInProgress ? 3000 : false }
  );
  const status = pollData?.status ?? video.status;
  const progressPercent = (pollData as { progressPercent?: number } | undefined)?.progressPercent ?? 0;
  const isLive = !!pollData && isInProgress;
  return (
    <div className="space-y-1">
      <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${VIDEO_STATUS_BADGE[status] ?? 'text-slate-400 bg-white/5'}`}>
        {status}
      </span>
      {isLive && (
        <GenerationProgressBar
          compact
          progressPercent={progressPercent}
          generationStartedAt={(pollData as { generationStartedAt?: Date | null })?.generationStartedAt}
          videoLength={video.videoLength}
          className="min-w-[140px]"
        />
      )}
    </div>
  );
}

function VideosTable() {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedVideo, setSelectedVideo] = useState<VideoRow | null>(null);

  const { data: videos, isLoading, refetch } = trpc.admin.searchVideos.useQuery({
    query: searchQuery.trim() || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
    limit: 100,
    offset: 0,
  });

  const statusOptions = [
    { value: "all", label: "All statuses" },
    { value: "completed", label: "Completed" },
    { value: "failed", label: "Failed" },
    { value: "queued", label: "Queued" },
    { value: "pending", label: "Pending" },
    { value: "generating_script", label: "Generating script" },
    { value: "generating_voiceover", label: "Generating voiceover" },
    { value: "generating_visuals", label: "Generating visuals" },
    { value: "generating_effects", label: "Generating effects" },
  ];

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-purple-400 animate-spin" /></div>;

  return (
    <div>
      {selectedVideo && (
        <VideoDetailModal video={selectedVideo} onClose={() => setSelectedVideo(null)} />
      )}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-4">
        <h2 className="font-bold text-white text-lg flex items-center gap-2">
          <Video className="w-5 h-5 text-cyan-400" /> All Videos ({videos?.length ?? 0})
        </h2>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by prompt, title, or #VID-XXXX..."
            className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder:text-slate-500 outline-none focus:border-purple-500/50 transition-colors"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="pl-9 pr-8 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white outline-none focus:border-purple-500/50 transition-colors appearance-none cursor-pointer"
          >
            {statusOptions.map((opt) => (
              <option key={opt.value} value={opt.value} className="bg-slate-900">{opt.label}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
        </div>
      </div>
      <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 text-xs text-slate-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Video #</th>
                <th className="text-left px-4 py-3">Video</th>
                <th className="text-left px-4 py-3">Length</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">User</th>
                <th className="text-left px-4 py-3">Created</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {videos?.map((video) => (
                <tr key={video.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                  <td className="px-4 py-3">
                    <span className="mono text-xs font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded-md whitespace-nowrap">
                      {formatVideoId(video.id)}
                    </span>
                  </td>
                  <td className="px-4 py-3 max-w-xs">
                    <p className="text-white text-xs font-medium truncate">{video.title ?? video.prompt.slice(0, 50)}</p>
                    <p className="text-slate-500 text-xs truncate">{video.prompt.slice(0, 60)}...</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 font-mono whitespace-nowrap">{video.videoLength} min</td>
                  <td className="px-4 py-3">
                    <VideoStatusCell video={video as VideoRow} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-xs text-slate-300">{video.userName ?? "Unknown"}</p>
                    <p className="text-xs text-slate-500 font-mono">#{video.userId}{video.userEmail ? " · " + video.userEmail : ""}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(video.createdAt).toLocaleDateString()}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setSelectedVideo(video as VideoRow)}
                        className="flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors px-2 py-1.5 rounded-md hover:bg-cyan-400/10 border border-cyan-500/20"
                      >
                        <Eye className="w-3.5 h-3.5" /> View
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {(!videos || videos.length === 0) && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <Search className="w-8 h-8 text-slate-600 mx-auto mb-3" />
                    <p className="text-slate-500 text-sm">No videos found</p>
                    {(searchQuery || statusFilter !== "all") && (
                      <button onClick={() => { setSearchQuery(""); setStatusFilter("all"); }} className="mt-2 text-xs text-purple-400 hover:text-purple-300 transition-colors">
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function AdminVideoGenerator() {
  const [prompt, setPrompt] = useState("");
  const [videoLength, setVideoLength] = useState("15-20");
  const [generatedId, setGeneratedId] = useState<number | null>(null);

  const generateMutation = trpc.admin.generateVideo.useMutation({
    onSuccess: (data) => {
      setGeneratedId(data.videoId);
      setPrompt("");
      toast.success(`Video ${formatVideoId(data.videoId)} is being generated!`);
    },
    onError: (err) =>
      toast.error("Failed to start generation", { description: toastErrorMessage(err) }),
  });

  const { data: videoStatus, isLoading: statusLoading } = trpc.video.pollStatus.useQuery(
    { id: generatedId! },
    {
      enabled: !!generatedId,
      refetchInterval: (query: { state: { data: unknown } }) => {
        const status = (query.state.data as { status?: string } | undefined)?.status;
        return (status === "completed" || status === "failed") ? false : 3000;
      },
    }
  );

  const statusData = videoStatus as {
    status?: string;
    videoUrl?: string;
    title?: string;
    progressPercent?: number;
    generationStartedAt?: Date | null;
  } | undefined;
  const isGenerating = !!statusData?.status && !['completed', 'failed'].includes(statusData.status);
  // Fetch presigned URL for video playback (needed for /manus-storage/ URLs on Manus sandbox)
  const { data: genVideoUrlData } = trpc.video.getVideoUrl.useQuery(
    { id: generatedId! },
    { enabled: !!(generatedId && statusData?.status === 'completed' && statusData?.videoUrl), staleTime: 1000 * 60 * 5 }
  );
  const genPlaybackUrl = genVideoUrlData?.url ?? statusData?.videoUrl;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-bold text-white text-lg flex items-center gap-2 mb-1">
          <Sparkles className="w-5 h-5 text-purple-400" /> Generate a Video
        </h2>
        <p className="text-slate-400 text-sm">As admin, you can generate videos without a subscription.</p>
      </div>
      <div className="glass-card border border-white/8 rounded-xl p-6 space-y-5">
        <div>
          <label className="block text-xs text-slate-400 font-medium uppercase tracking-wide mb-2">Video Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the YouTube video you want to create..."
            rows={3}
            className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none focus:border-purple-500/50 transition-colors resize-none"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 font-medium uppercase tracking-wide mb-2">Video Length</label>
          <div className="flex flex-wrap gap-2">
            {VIDEO_LENGTHS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setVideoLength(opt.value)}
                className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all duration-200 ${
                  videoLength === opt.value
                    ? "bg-gradient-to-br from-purple-600/40 to-cyan-500/30 border-purple-400/60 text-white shadow-lg shadow-purple-500/20"
                    : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200 bg-white/3"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => generateMutation.mutate({ prompt, videoLength: videoLength as VideoLength })}
          disabled={generateMutation.isPending || prompt.trim().length < 10}
          className="w-full py-3 rounded-xl font-bold text-white text-sm flex items-center justify-center gap-2 btn-gradient disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
        >
          {generateMutation.isPending ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Starting generation...</>
          ) : (
            <><Sparkles className="w-4 h-4" /> Generate Video</>
          )}
        </button>
      </div>

      {generatedId && (
        <div className="glass-card border border-white/8 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-white text-sm flex items-center gap-2">
              <span className="mono text-purple-400">{formatVideoId(generatedId)}</span>
              {statusData?.title && <span className="text-slate-300 font-normal truncate max-w-xs">{statusData.title}</span>}
            </h3>
            {statusLoading && <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />}
          </div>
          {isGenerating && (
            <GenerationProgressBar
              progressPercent={statusData?.progressPercent ?? 0}
              generationStartedAt={statusData?.generationStartedAt}
              videoLength={videoLength}
            />
          )}
          {statusData?.status === "completed" && statusData?.videoUrl && (
            <div className="space-y-3 pt-2 border-t border-white/8">
              <p className="text-xs text-green-400 font-medium flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Video ready!
              </p>
              {genPlaybackUrl && <video src={genPlaybackUrl} controls className="w-full rounded-xl border border-white/10 bg-black" style={{ maxHeight: "300px" }} />}
              <a href={`/api/download/video/${generatedId}`} download={`fastvid-${formatVideoId(generatedId)}.mp4`} className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white text-sm font-semibold hover:opacity-90 transition-opacity">
                <Download className="w-4 h-4" /> Download MP4
              </a>
            </div>
          )}
          {statusData?.status === "failed" && (
            <div className="flex items-center gap-2 text-xs text-red-400 pt-2 border-t border-white/8">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Generation failed. Check the All Videos tab for details.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Admin() {
  const { user, loading, isAuthenticated, logout } = useAuth() as {
    user: { name?: string; role?: string } | null;
    loading: boolean; isAuthenticated: boolean; logout: () => void;
  };
  const [location, navigate] = useLocation();
  type AdminTab = "overview" | "users" | "videos" | "generate" | "voices" | "invites" | "archive" | "niches";
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  useEffect(() => {
    if (location === "/admin/archive") setActiveTab("archive");
  }, [location]);

  function selectTab(id: AdminTab) {
    setActiveTab(id);
    if (id === "archive") navigate("/admin/archive");
    else if (location === "/admin/archive") navigate("/admin");
  }

  const { data: stats, isLoading: statsLoading } = trpc.admin.stats.useQuery(undefined, {
    enabled: isAuthenticated && user?.role === "admin",
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
      </div>
    );
  }
  if (!isAuthenticated || user?.role !== "admin") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Shield className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <p className="text-white font-bold text-lg">Access Denied</p>
          <p className="text-slate-400 text-sm mt-1">You do not have required permission</p>
          <button onClick={() => navigate("/")} className="mt-4 text-purple-400 hover:text-purple-300 text-sm transition-colors">Go home</button>
        </div>
      </div>
    );
  }

  const navItems = [
    { id: "overview" as const, label: "Overview", icon: LayoutDashboard },
    { id: "archive" as const, label: "Media Archief", icon: Archive },
    { id: "niches" as const, label: "Niche-aanvragen", icon: Radio },
    { id: "generate" as const, label: "Generate Video", icon: Sparkles },
    { id: "users" as const, label: "Users", icon: Users },
    { id: "videos" as const, label: "All Videos", icon: Video },
    { id: "voices" as const, label: "Voice Library", icon: Mic },
    { id: "invites" as const, label: "Invite Codes", icon: Hash },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="fixed left-0 top-0 bottom-0 w-60 bg-background/95 border-r border-white/8 flex-col z-40 hidden lg:flex">
        <div className="p-5 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-black text-xl text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </div>
          <div className="mt-2 px-1">
            <span className="text-xs text-purple-400 font-medium flex items-center gap-1"><Shield className="w-3 h-3" /> Admin Panel</span>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => selectTab(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activeTab === id ? "bg-purple-600/20 text-white" : "text-slate-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <Icon className={`w-4 h-4 ${activeTab === id ? "text-purple-400" : ""}`} />
              {label}
            </button>
          ))}
          <div className="pt-2 border-t border-white/8 mt-2">
            <button onClick={() => navigate("/dashboard")} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
              <Settings className="w-4 h-4" /> User Dashboard
            </button>
            <button onClick={() => navigate("/")} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
              <Play className="w-4 h-4" /> Landing Page
            </button>
          </div>
        </nav>
        <div className="p-4 border-t border-white/8">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center text-white font-bold text-sm">
              {user?.name?.[0] ?? "A"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name ?? "Admin"}</p>
              <p className="text-xs text-purple-400 flex items-center gap-1"><Crown className="w-3 h-3" /> Administrator</p>
            </div>
          </div>
          <button onClick={() => { logout(); navigate("/"); }} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
            <LogOut className="w-4 h-4" /> Log out
          </button>
        </div>
      </div>

      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-background/95 border-b border-white/8 px-4 h-14 flex items-center justify-between">
        <span className="font-black text-lg text-white" style={{ fontFamily: "Outfit, sans-serif" }}>Fast<span className="gradient-text">vid</span> <span className="text-xs text-purple-400 font-normal">Admin</span></span>
        <div className="flex gap-1 overflow-x-auto">
          {navItems.map((tab) => (
            <button key={tab.id} onClick={() => selectTab(tab.id)} className={`text-xs px-2 py-1 rounded-md transition-colors whitespace-nowrap ${activeTab === tab.id ? "bg-purple-600/30 text-purple-300" : "text-slate-400 hover:text-white"}`}>{tab.label}</button>
          ))}
        </div>
      </div>

      <div className="lg:pl-60 pt-14 lg:pt-0">
        <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-8">
          <div>
            <h1 className="text-2xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
              Admin <span className="gradient-text">Dashboard</span>
            </h1>
            <p className="text-slate-400 text-sm mt-1">Manage users, subscriptions, and video generation</p>
          </div>

          {activeTab === "overview" && (
            <div className="space-y-6">
              {statsLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-purple-400 animate-spin" /></div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label="Total Users" value={stats?.users.total ?? 0} icon={Users} color="text-purple-400" />
                    <StatCard label="Active Subscribers" value={stats?.users.active ?? 0} icon={UserCheck} color="text-green-400" sub={`\u20ac${(stats?.users.active ?? 0) * 500}/mo revenue`} />
                    <StatCard label="Total Videos" value={stats?.videos.total ?? 0} icon={Video} color="text-cyan-400" />
                    <StatCard label="Completed Videos" value={stats?.videos.completed ?? 0} icon={CheckCircle2} color="text-green-400" sub={`${stats?.videos.failed ?? 0} failed`} />
                  </div>
                  <div className="glass-card border border-purple-500/25 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4 bg-purple-600/5">
                    <div>
                      <h3 className="font-bold text-white flex items-center gap-2">
                        <Archive className="w-4 h-4 text-purple-400" /> Media Archief
                      </h3>
                      <p className="text-xs text-slate-400 mt-1 max-w-xl">
                        Upload hier video&apos;s en foto&apos;s met tags. De pipeline gebruikt alleen bestanden uit jouw archieven.
                      </p>
                    </div>
                    <button
                      onClick={() => selectTab("archive")}
                      className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
                    >
                      <Upload className="w-4 h-4" /> Video&apos;s uploaden
                    </button>
                  </div>
                  <AdminVideoActions />
                  <div className="glass-card border border-white/8 rounded-xl p-5">
                    <h3 className="font-bold text-white mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-cyan-400" /> Revenue Overview</h3>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-2xl font-black gradient-text" style={{ fontFamily: "Outfit, sans-serif" }}>\u20ac{(stats?.users.active ?? 0) * 500}</p>
                        <p className="text-xs text-slate-500 mt-1">Monthly Revenue (MRR)</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black gradient-text" style={{ fontFamily: "Outfit, sans-serif" }}>\u20ac{(stats?.users.active ?? 0) * 500 * 12}</p>
                        <p className="text-xs text-slate-500 mt-1">Annual Run Rate (ARR)</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black gradient-text" style={{ fontFamily: "Outfit, sans-serif" }}>{stats?.users.active ?? 0}</p>
                        <p className="text-xs text-slate-500 mt-1">Paying Subscribers</p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === "generate" && <AdminVideoGenerator />}
          {activeTab === "users" && <UsersTable />}
          {activeTab === "videos" && <VideosTable />}
          {activeTab === "voices" && <VoiceLibraryAdmin />}
          {activeTab === "archive" && <MediaArchiveAdmin />}
          {activeTab === "niches" && <NicheRequestsAdmin />}
          {activeTab === "invites" && <InviteCodesAdmin />}
        </div>
      </div>
    </div>
  );
}

// ─── Admin Video Actions ────────────────────────────────────────────────────
function AdminVideoActions() {
  const utils = trpc.useUtils();
  const retryMut = trpc.videoManage.retryStuck.useMutation({
    onSuccess: (data) => {
      utils.admin.stats.invalidate();
      if (data.reset === 0) toast.info("No stuck videos found — all pipelines are running normally");
      else toast.success(`\u2705 Reset ${data.reset} stuck video${data.reset === 1 ? "" : "s"} back to awaiting approval`);
    },
    onError: (err) => toast.error("Operation failed", { description: toastErrorMessage(err) }),
  });
  const expireMut = trpc.videoManage.expireStuck.useMutation({
    onSuccess: (data) => {
      utils.admin.stats.invalidate();
      if (data.expired === 0) toast.info("No stuck videos found");
      else toast.success(`Marked ${data.expired} stuck video${data.expired === 1 ? "" : "s"} as failed`);
    },
    onError: (err) => toast.error("Operation failed", { description: toastErrorMessage(err) }),
  });
  return (
    <div className="glass-card border border-white/8 rounded-xl p-5">
      <h3 className="font-bold text-white mb-1 flex items-center gap-2"><RefreshCw className="w-4 h-4 text-amber-400" /> Pipeline Actions</h3>
      <p className="text-xs text-slate-500 mb-4">Use these when videos are stuck in voiceover/visuals generation after a deployment.</p>
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => retryMut.mutate()}
          disabled={retryMut.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-300 text-sm font-medium hover:bg-amber-500/25 transition-colors disabled:opacity-50"
        >
          {retryMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Retry Stuck Videos
        </button>
        <button
          onClick={() => expireMut.mutate()}
          disabled={expireMut.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/20 transition-colors disabled:opacity-50"
        >
          {expireMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
          Expire Stuck Videos
        </button>
      </div>
    </div>
  );
}

// ─── Voice Library Admin Panel ────────────────────────────────────────────────
function VoiceLibraryAdmin() {
  const utils = trpc.useUtils();
  const { data: voices = [], isLoading } = trpc.voice.listAll.useQuery();
  const [showForm, setShowForm] = useState(false);
  const [editVoice, setEditVoice] = useState<null | typeof voices[0]>(null);
  const [playingId, setPlayingId] = useState<number | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<number | null>(null);
  const [previewAudioEl, setPreviewAudioEl] = useState<HTMLAudioElement | null>(null);

  const createMut = trpc.voice.create.useMutation({ onSuccess: () => { utils.voice.listAll.invalidate(); setShowForm(false); toast.success("Voice added!"); } });
  const updateMut = trpc.voice.update.useMutation({ onSuccess: () => { utils.voice.listAll.invalidate(); setEditVoice(null); toast.success("Voice updated!"); } });
  const deleteMut = trpc.voice.delete.useMutation({ onSuccess: () => { utils.voice.listAll.invalidate(); toast.success("Voice deleted!"); } });
  const uploadAudioMut = trpc.voice.uploadExampleAudio.useMutation({ onSuccess: () => { utils.voice.listAll.invalidate(); toast.success("Example audio uploaded!"); } });
  const previewMut = trpc.voice.preview.useMutation({
    onSuccess: (data) => {
      if (previewAudioEl) { previewAudioEl.pause(); previewAudioEl.src = ""; }
      const a = new Audio(data.url);
      a.onended = () => { setPreviewingId(null); setPreviewAudioEl(null); };
      a.play();
      setPreviewAudioEl(a);
    },
    onError: (err) => {
      setPreviewingId(null);
      toast.error("Preview failed", { description: toastErrorMessage(err) });
    },
  });
  const resetDefaultsMut = trpc.voice.resetDefaults.useMutation({
    onSuccess: (data) => { utils.voice.listAll.invalidate(); toast.success(`Reset complete — ${data.upserted} voices updated`); },
    onError: (err) => toast.error("Reset failed", { description: toastErrorMessage(err) }),
  });

  function playExample(voice: typeof voices[0]) {
    if (!voice.exampleAudioUrl) { toast.error("No example audio for this voice"); return; }
    if (audioEl) { audioEl.pause(); audioEl.src = ""; }
    if (playingId === voice.id) { setPlayingId(null); setAudioEl(null); return; }
    const a = new Audio(voice.exampleAudioUrl);
    a.onended = () => { setPlayingId(null); setAudioEl(null); };
    a.play();
    setAudioEl(a);
    setPlayingId(voice.id);
  }

  function testPreview(voice: typeof voices[0]) {
    if (voice.fishAudioReferenceId.startsWith("PLACEHOLDER")) {
      toast.error("Cannot preview: this voice has a placeholder ElevenLabs voice ID. Please edit and set a real ID.");
      return;
    }
    if (previewAudioEl) { previewAudioEl.pause(); previewAudioEl.src = ""; }
    if (previewingId === voice.id) { setPreviewingId(null); setPreviewAudioEl(null); return; }
    setPreviewingId(voice.id);
    previewMut.mutate({ fishAudioReferenceId: voice.fishAudioReferenceId });
  }

  async function handleAudioUpload(voiceId: number, file: File) {
    if (file.size > 5 * 1024 * 1024) { toast.error("File too large (max 5MB)"); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = (e.target?.result as string).split(",")[1];
      uploadAudioMut.mutate({ voiceId, audioBase64: base64, mimeType: file.type });
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>Voice <span className="gradient-text">Library</span></h2>
          <p className="text-slate-400 text-sm mt-1">Manage ElevenLabs voices available to users</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { if (confirm("Reset all voices to defaults? This will delete placeholder voices and upsert 6 real ElevenLabs voices.")) resetDefaultsMut.mutate(); }}
            disabled={resetDefaultsMut.isPending}
            className="flex items-center gap-2 px-3 py-2 bg-white/10 hover:bg-white/15 text-slate-300 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            {resetDefaultsMut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Reset to Defaults
          </button>
          <button onClick={() => { setEditVoice(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors">
            <Plus className="w-4 h-4" /> Add Voice
          </button>
        </div>
      </div>

      {/* Add / Edit Form */}
      {(showForm || editVoice) && (
        <VoiceForm
          initial={editVoice}
          onSave={(data) => {
            if (editVoice) updateMut.mutate({ id: editVoice.id, ...data });
            else createMut.mutate(data);
          }}
          onCancel={() => { setShowForm(false); setEditVoice(null); }}
          saving={createMut.isPending || updateMut.isPending}
        />
      )}

      {/* Voice Cards */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-purple-400 animate-spin" /></div>
      ) : voices.length === 0 ? (
        <div className="text-center py-12 text-slate-500">No voices yet — click "Add Voice" to get started.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {voices.map((v) => (
            <div key={v.id} className="glass-card border border-white/8 rounded-xl p-5 space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{v.flag ?? "🎙️"}</span>
                  <div>
                    <p className="font-bold text-white">{v.name}</p>
                    <p className="text-xs text-slate-400">{v.description ?? "—"}</p>
                  </div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${v.isActive ? "bg-green-400/10 text-green-400" : "bg-slate-700 text-slate-400"}`}>
                  {v.isActive ? "Active" : "Hidden"}
                </span>
              </div>

              {v.fishAudioReferenceId.startsWith("PLACEHOLDER") ? (
                <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded px-2 py-1">
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  <span className="font-mono truncate">Placeholder ID — set a real ElevenLabs voice ID</span>
                </div>
              ) : (
                <div className="text-xs text-slate-500 font-mono bg-white/5 rounded px-2 py-1 truncate">
                  ElevenLabs ID: {v.fishAudioReferenceId}
                </div>
              )}

              {/* Live preview + example audio upload + play */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* Test Preview: calls ElevenLabs live */}
                <button
                  onClick={() => testPreview(v)}
                  disabled={previewMut.isPending && previewingId === v.id}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    previewingId === v.id
                      ? "bg-cyan-600 text-white"
                      : "bg-cyan-500/20 text-cyan-300 hover:bg-cyan-500/30"
                  }`}
                >
                  {previewMut.isPending && previewingId === v.id ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Mic className="w-3 h-3" />
                  )}
                  {previewingId === v.id && !previewMut.isPending ? "Stop" : "Test Preview"}
                </button>
                {/* Play uploaded sample */}
                <button
                  onClick={() => playExample(v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    v.exampleAudioUrl
                      ? playingId === v.id
                        ? "bg-purple-600 text-white"
                        : "bg-white/10 text-white hover:bg-white/20"
                      : "bg-white/5 text-slate-500 cursor-not-allowed"
                  }`}
                  disabled={!v.exampleAudioUrl}
                >
                  <Volume2 className="w-3 h-3" />
                  {playingId === v.id ? "Stop" : "Play Sample"}
                </button>
                <label className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer">
                  <Plus className="w-3 h-3" />
                  {v.exampleAudioUrl ? "Replace Audio" : "Upload Audio"}
                  <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleAudioUpload(v.id, f); e.target.value = ""; }} />
                </label>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1 border-t border-white/8">
                <button onClick={() => { setShowForm(false); setEditVoice(v); }} className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors">
                  <Pencil className="w-3 h-3" /> Edit
                </button>
                <button
                  onClick={() => updateMut.mutate({ id: v.id, isActive: v.isActive ? 0 : 1 })}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-white transition-colors"
                >
                  {v.isActive ? <ToggleRight className="w-3 h-3 text-green-400" /> : <ToggleLeft className="w-3 h-3" />}
                  {v.isActive ? "Hide" : "Show"}
                </button>
                <button
                  onClick={() => { if (confirm(`Delete voice "${v.name}"?`)) deleteMut.mutate({ id: v.id }); }}
                  className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors ml-auto"
                >
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VoiceForm({
  initial, onSave, onCancel, saving,
}: {
  initial?: { name: string; description?: string | null; fishAudioReferenceId: string; flag?: string | null; sortOrder?: number | null; isActive?: number } | null;
  onSave: (data: { name: string; description?: string; fishAudioReferenceId: string; flag?: string; sortOrder?: number; isActive?: number }) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [fishId, setFishId] = useState(initial?.fishAudioReferenceId ?? "");
  const [flag, setFlag] = useState(initial?.flag ?? "🇺🇸");
  const [sortOrder, setSortOrder] = useState(initial?.sortOrder ?? 0);

  return (
    <div className="glass-card border border-purple-500/30 rounded-xl p-5 space-y-4">
      <h3 className="font-bold text-white text-sm">{initial ? "Edit Voice" : "Add New Voice"}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Voice Name *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Michael" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Flag Emoji</label>
          <input value={flag} onChange={e => setFlag(e.target.value)} placeholder="🇺🇸" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs text-slate-400 mb-1 block">ElevenLabs Voice ID *</label>
          <input value={fishId} onChange={e => setFishId(e.target.value)} placeholder="e.g. pNInz6obpgDQGcFmaJgB" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-purple-500" />
          <p className="text-xs text-slate-500 mt-1">Find this in your ElevenLabs dashboard under Voices → Voice Library</p>
        </div>
        <div className="md:col-span-2">
          <label className="text-xs text-slate-400 mb-1 block">Description</label>
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. American Male — natural, YouTube-style narrator" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1 block">Sort Order</label>
          <input type="number" value={sortOrder} onChange={e => setSortOrder(Number(e.target.value))} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-purple-500" />
        </div>
      </div>
      <div className="flex gap-3 justify-end">
        <button onClick={onCancel} className="px-4 py-2 text-slate-400 hover:text-white text-sm transition-colors">Cancel</button>
        <button
          onClick={() => onSave({ name, description: description || undefined, fishAudioReferenceId: fishId, flag: flag || undefined, sortOrder })}
          disabled={!name || !fishId || saving}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {initial ? "Save Changes" : "Add Voice"}
        </button>
      </div>
    </div>
  );
}

// ─── Invite Codes Admin ─────────────────────────────────────────────────────
function InviteCodesAdmin() {
  const utils = trpc.useUtils();
  const [note, setNote] = useState("");

  const { data: codes, isLoading } = trpc.admin.listInviteCodes.useQuery();

  const createCode = trpc.admin.createInviteCode.useMutation({
    onSuccess: (data) => {
      toast.success(`Code created: ${data.code}`, { description: "Share this code with the new user." });
      utils.admin.listInviteCodes.invalidate();
      setNote("");
    },
    onError: (e) => toast.error("Failed to create code", { description: toastErrorMessage(e) }),
  });

  const deleteCode = trpc.admin.deleteInviteCode.useMutation({
    onSuccess: () => { toast.success("Code deleted"); utils.admin.listInviteCodes.invalidate(); },
    onError: (e) => toast.error("Failed to delete", { description: toastErrorMessage(e) }),
  });

  const deactivateCode = trpc.admin.deactivateInviteCode.useMutation({
    onSuccess: () => { toast.success("Code deactivated"); utils.admin.listInviteCodes.invalidate(); },
    onError: (e) => toast.error("Failed to deactivate", { description: toastErrorMessage(e) }),
  });

  return (
    <div className="space-y-6">
      {/* Create new code */}
      <div className="glass-card border border-white/8 rounded-xl p-5">
        <h3 className="font-bold text-white mb-1 flex items-center gap-2">
          <Hash className="w-4 h-4 text-cyan-400" /> Generate Invite Code
        </h3>
        <p className="text-xs text-slate-500 mb-4">Each code can only be used once. Share it with a new user to let them register.</p>
        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-xs text-slate-400 mb-1 block">Note (optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. For John Doe"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
            />
          </div>
          <button
            onClick={() => createCode.mutate({ note: note || undefined })}
            disabled={createCode.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600/20 border border-purple-500/30 text-purple-300 text-sm font-medium hover:bg-purple-600/30 transition-colors disabled:opacity-50"
          >
            {createCode.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Generate Code
          </button>
        </div>
      </div>

      {/* Code list */}
      <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-white/8">
          <h3 className="font-bold text-white flex items-center gap-2">
            <Hash className="w-4 h-4 text-slate-400" /> All Invite Codes
          </h3>
        </div>
        {isLoading ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-purple-400" /></div>
        ) : !codes || codes.length === 0 ? (
          <div className="p-8 text-center text-slate-500 text-sm">No invite codes yet. Generate one above.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-slate-400 text-xs">
                  <th className="text-left px-4 py-3 font-medium">Code</th>
                  <th className="text-left px-4 py-3 font-medium">Note</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Used by</th>
                  <th className="text-left px-4 py-3 font-medium">Created</th>
                  <th className="text-right px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {codes.map((c) => (
                  <tr key={c.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-cyan-300 tracking-wider">{c.code}</span>
                        <button
                          onClick={() => { navigator.clipboard.writeText(c.code); toast.success("Code copied!"); }}
                          className="text-slate-500 hover:text-slate-300 transition-colors"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{c.note ?? "—"}</td>
                    <td className="px-4 py-3">
                      {c.isActive === 1 ? (
                        <span className="px-2 py-0.5 rounded-full text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">Active</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-xs bg-slate-500/15 text-slate-400 border border-slate-500/20">Used / Inactive</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{c.usedByUserId ? `User #${c.usedByUserId}` : "—"}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        {c.isActive === 1 && (
                          <button
                            onClick={() => deactivateCode.mutate({ id: c.id })}
                            disabled={deactivateCode.isPending}
                            className="text-xs px-2 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-colors"
                          >
                            Deactivate
                          </button>
                        )}
                        <button
                          onClick={() => { if (confirm("Delete this code?")) deleteCode.mutate({ id: c.id }); }}
                          disabled={deleteCode.isPending}
                          className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
