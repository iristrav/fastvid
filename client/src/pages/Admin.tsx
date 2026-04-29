/**
 * FASTVID — Admin Dashboard
 * Full control over users, subscriptions, video overview, and video generation
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  Users, Video, TrendingUp, CheckCircle2, Loader2,
  Play, LogOut, LayoutDashboard, Settings, Shield, RefreshCw,
  UserCheck, Crown, Eye, X, Copy, AlertTriangle,
  FileText, Hash, Sparkles, Search, Filter, Download,
  ChevronDown,
} from "lucide-react";

function formatVideoId(id: number) {
  return `#VID-${String(id).padStart(4, "0")}`;
}

const VIDEO_LENGTHS = [
  { label: "5-8 min", value: "5-8" },
  { label: "8-12 min", value: "8-12" },
  { label: "12-15 min", value: "12-15" },
  { label: "15-20 min", value: "15-20" },
  { label: "20+ min", value: "20+" },
];

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
                  <video src={video.videoUrl} controls className="w-full rounded-xl border border-white/10 bg-black" style={{ maxHeight: "360px" }} />
                  <a href={video.videoUrl} download={`fastvid-${formatVideoId(video.id)}.mp4`} className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white text-sm font-semibold hover:opacity-90 transition-opacity">
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
                    <p className="text-xs text-red-300">{video.errorMessage}</p>
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
  const isInProgress = !['completed', 'failed', 'pending'].includes(video.status);
  const { data: pollData } = trpc.video.pollStatus.useQuery(
    { id: video.id },
    { enabled: isInProgress, refetchInterval: isInProgress ? 3000 : false }
  );
  const status = pollData?.status ?? video.status;
  const progressStep = (pollData as { progressStep?: string | null } | undefined)?.progressStep;
  const progressPercent = (pollData as { progressPercent?: number } | undefined)?.progressPercent ?? 0;
  const isLive = !!pollData && isInProgress;
  return (
    <div className="space-y-1">
      <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${VIDEO_STATUS_BADGE[status] ?? 'text-slate-400 bg-white/5'}`}>
        {status}
      </span>
      {isLive && progressStep && (
        <div className="space-y-0.5 min-w-[120px]">
          <p className="text-xs text-slate-400 truncate max-w-[160px]">{progressStep}</p>
          <div className="w-full bg-white/10 rounded-full h-1 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-purple-500 to-cyan-500 rounded-full transition-all duration-700" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
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
    onError: (err) => toast.error(`Failed to start generation: ${err.message}`),
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

  const statusData = videoStatus as { status?: string; videoUrl?: string; title?: string; progressStep?: string | null; progressPercent?: number; generationStartedAt?: Date | null } | undefined;
  const isGenerating = !!statusData?.status && !['completed', 'failed'].includes(statusData.status);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const startTime = statusData?.generationStartedAt;
    if (!isGenerating || !startTime) { setElapsed(0); return; }
    const update = () => setElapsed(Math.floor((Date.now() - new Date(startTime).getTime()) / 1000));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [isGenerating, statusData?.generationStartedAt]);
  const elapsedStr = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  const STEPS = [
    { key: "generating_script", label: "Writing script" },
    { key: "generating_voiceover", label: "Generating voiceover" },
    { key: "generating_visuals", label: "Rendering visuals" },
    { key: "generating_effects", label: "Applying effects" },
    { key: "completed", label: "Complete" },
  ];

  const currentStepIndex = STEPS.findIndex((s) => s.key === statusData?.status);

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
          onClick={() => generateMutation.mutate({ prompt, videoLength: videoLength as "5-8" | "8-12" | "12-15" | "15-20" | "20+" })}
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
          {isGenerating && statusData?.progressStep && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-300 truncate max-w-[80%]">{statusData.progressStep}</span>
                <span className="text-xs text-slate-500 font-mono ml-2 shrink-0">{elapsedStr}</span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-cyan-500 rounded-full transition-all duration-700"
                  style={{ width: `${statusData.progressPercent ?? 0}%` }}
                />
              </div>
              <p className="text-right text-xs text-slate-600">{statusData.progressPercent ?? 0}%</p>
            </div>
          )}
          <div className="space-y-2">
            {STEPS.map((step, i) => {
              const isDone = statusData?.status === "completed" || (currentStepIndex > i && currentStepIndex !== -1);
              const isActive = step.key === statusData?.status;
              return (
                <div key={step.key} className={`flex items-center gap-3 text-xs transition-colors ${isDone ? "text-green-400" : isActive ? "text-purple-300" : "text-slate-600"}`}>
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center border shrink-0 ${isDone ? "bg-green-500/20 border-green-500/40" : isActive ? "bg-purple-500/20 border-purple-500/40" : "bg-white/3 border-white/10"}`}>
                    {isDone ? <CheckCircle2 className="w-3 h-3" /> : isActive ? <Loader2 className="w-3 h-3 animate-spin" /> : <span className="text-[10px]">{i + 1}</span>}
                  </div>
                  <span className={isActive ? "font-medium" : ""}>{step.label}</span>
                </div>
              );
            })}
          </div>
          {statusData?.status === "completed" && statusData?.videoUrl && (
            <div className="space-y-3 pt-2 border-t border-white/8">
              <p className="text-xs text-green-400 font-medium flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" /> Video ready!
              </p>
              <video src={statusData.videoUrl} controls className="w-full rounded-xl border border-white/10 bg-black" style={{ maxHeight: "300px" }} />
              <a href={statusData.videoUrl} download={`fastvid-${formatVideoId(generatedId)}.mp4`} className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 text-white text-sm font-semibold hover:opacity-90 transition-opacity">
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
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"overview" | "users" | "videos" | "generate">("overview");
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
          <p className="text-slate-400 text-sm mt-1">Admin access required</p>
          <button onClick={() => navigate("/")} className="mt-4 text-purple-400 hover:text-purple-300 text-sm transition-colors">Go home</button>
        </div>
      </div>
    );
  }

  const navItems = [
    { id: "overview" as const, label: "Overview", icon: LayoutDashboard },
    { id: "generate" as const, label: "Generate Video", icon: Sparkles },
    { id: "users" as const, label: "Users", icon: Users },
    { id: "videos" as const, label: "All Videos", icon: Video },
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
              onClick={() => setActiveTab(id)}
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
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`text-xs px-2 py-1 rounded-md transition-colors whitespace-nowrap ${activeTab === tab.id ? "bg-purple-600/30 text-purple-300" : "text-slate-400 hover:text-white"}`}>{tab.label}</button>
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
        </div>
      </div>
    </div>
  );
}
