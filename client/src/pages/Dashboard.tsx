/**
 * FASTVID — User Dashboard
 * Authenticated users can generate videos and view their history
 */
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import {
  Play, Sparkles, Clock, CheckCircle2, XCircle, Loader2,
  FileText, Video, LogOut, User, ChevronRight, RefreshCw,
  Copy, Download, Eye, LayoutDashboard, Settings,
} from "lucide-react";

// ─── Asset URLs ───────────────────────────────────────────────────────────────
const VIDEO_LENGTHS = [
  { label: "5–8 min", value: "5-8" as const, desc: "Short & punchy", genTime: "~3 min" },
  { label: "8–12 min", value: "8-12" as const, desc: "Tutorials", genTime: "~5 min" },
  { label: "12–15 min", value: "12-15" as const, desc: "In-depth", genTime: "~7 min" },
  { label: "15–20 min", value: "15-20" as const, desc: "Extended", genTime: "~10 min" },
  { label: "20+ min", value: "20+" as const, desc: "Long-form", genTime: "~15 min" },
];

type VideoLength = "5-8" | "8-12" | "12-15" | "15-20" | "20+";

const STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  generating_script: "Writing script...",
  generating_voiceover: "Creating voiceover...",
  generating_visuals: "Matching visuals...",
  generating_effects: "Adding effects...",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "text-yellow-400 bg-yellow-400/10",
  generating_script: "text-blue-400 bg-blue-400/10",
  generating_voiceover: "text-purple-400 bg-purple-400/10",
  generating_visuals: "text-cyan-400 bg-cyan-400/10",
  generating_effects: "text-orange-400 bg-orange-400/10",
  completed: "text-green-400 bg-green-400/10",
  failed: "text-red-400 bg-red-400/10",
};

// ─── Video Card ───────────────────────────────────────────────────────────────
function VideoCard({ video, onView }: { video: {
  id: number; title: string | null; prompt: string; status: string;
  videoLength: string; createdAt: Date; thumbnailUrl: string | null;
}; onView: (id: number) => void }) {
  const isProcessing = !["completed", "failed"].includes(video.status);
  const { data: pollData } = trpc.video.pollStatus.useQuery(
    { id: video.id },
    { enabled: isProcessing, refetchInterval: isProcessing ? 3000 : false }
  );
  const currentStatus = pollData?.status ?? video.status;
  const statusLabel = STATUS_LABELS[currentStatus] ?? currentStatus;
  const statusColor = STATUS_COLORS[currentStatus] ?? "text-slate-400 bg-slate-400/10";

  return (
    <div className="glass-card border border-white/8 rounded-xl overflow-hidden hover:border-white/15 transition-all duration-300 group">
      {/* Thumbnail */}
      <div className="relative aspect-video bg-gradient-to-br from-purple-900/40 to-cyan-900/30 overflow-hidden">
        {video.thumbnailUrl && currentStatus === "completed" ? (
          <img src={video.thumbnailUrl} alt={video.title ?? "Video"} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            {isProcessing || (pollData && !["completed","failed"].includes(pollData.status)) ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                <span className="text-xs text-slate-400">{statusLabel}</span>
              </div>
            ) : currentStatus === "failed" ? (
              <XCircle className="w-10 h-10 text-red-400/60" />
            ) : (
              <Video className="w-10 h-10 text-slate-600" />
            )}
          </div>
        )}
        <div className={`absolute top-2 right-2 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}>
          {statusLabel}
        </div>
        <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded-md bg-black/60 text-xs text-white font-mono">
          {VIDEO_LENGTHS.find(l => l.value === video.videoLength)?.label ?? video.videoLength}
        </div>
      </div>
      {/* Info */}
      <div className="p-4">
        <h3 className="font-semibold text-white text-sm line-clamp-1 mb-1">
          {video.title ?? video.prompt.slice(0, 60)}
        </h3>
        <p className="text-xs text-slate-500 line-clamp-2 mb-3">{video.prompt}</p>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-600">{new Date(video.createdAt).toLocaleDateString()}</span>
          {currentStatus === "completed" && (
            <button
              onClick={() => onView(video.id)}
              className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
            >
              <Eye className="w-3.5 h-3.5" />
              View
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Video Detail Modal ───────────────────────────────────────────────────────
function VideoDetailModal({ videoId, onClose }: { videoId: number; onClose: () => void }) {
  const { data: video, isLoading } = trpc.video.get.useQuery({ id: videoId });
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

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const { user, loading, isAuthenticated, logout } = useAuth() as { user: { name?: string; role?: string; subscriptionStatus?: string } | null; loading: boolean; isAuthenticated: boolean; logout: () => void };
  const [, navigate] = useLocation();
  const [prompt, setPrompt] = useState("");
  const [selectedLength, setSelectedLength] = useState<VideoLength>("15-20");
  const [viewingVideoId, setViewingVideoId] = useState<number | null>(null);

  const { data: videos, isLoading: videosLoading, refetch } = trpc.video.list.useQuery(undefined, { enabled: isAuthenticated });
  const generateMutation = trpc.video.generate.useMutation({
    onSuccess: (data) => {
      toast.success("Video generation started!", { description: `Video ID: ${data.videoId}` });
      setPrompt("");
      setTimeout(() => refetch(), 2000);
    },
    onError: (err) => {
      if (err.message.includes("subscription")) {
        toast.error("Active subscription required", { description: "Please contact the admin to activate your subscription." });
      } else {
        toast.error("Failed to start generation", { description: err.message });
      }
    },
  });

  useEffect(() => {
    if (!loading && !isAuthenticated) {
      window.location.href = getLoginUrl();
    }
  }, [loading, isAuthenticated]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
      </div>
    );
  }

  const userSub = (user as { subscriptionStatus?: string } | null)?.subscriptionStatus;
  const hasActiveSubscription = userSub === "active" || user?.role === "admin";
  const activeLengthOption = VIDEO_LENGTHS.find(l => l.value === selectedLength)!;

  const handleGenerate = () => {
    if (!prompt.trim() || prompt.length < 10) {
      toast.error("Please enter a prompt of at least 10 characters");
      return;
    }
    generateMutation.mutate({ prompt: prompt.trim(), videoLength: selectedLength });
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

          {/* Subscription warning */}
          {!hasActiveSubscription && (
            <div className="glass-card border border-yellow-500/30 bg-yellow-500/5 rounded-xl p-4 flex items-start gap-3">
              <div className="w-5 h-5 rounded-full bg-yellow-500/20 flex items-center justify-center shrink-0 mt-0.5">
                <span className="text-yellow-400 text-xs font-bold">!</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-yellow-300">No active subscription</p>
                <p className="text-xs text-yellow-400/70 mt-0.5">Contact the admin to activate your €500/month subscription and start generating videos.</p>
              </div>
            </div>
          )}

          {/* ── Video Generator ── */}
          <div className="glass-card border border-white/10 rounded-2xl p-6 space-y-5">
            <h2 className="font-bold text-white text-lg flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-purple-400" />
              Generate New Video
            </h2>

            {/* Length selector */}
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Choose video length</p>
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

            {/* Prompt input */}
            <div>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-2">Your prompt</p>
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={`Describe your ${activeLengthOption.label} video... e.g. "Top 10 productivity hacks for entrepreneurs in 2025"`}
                rows={3}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-slate-600 outline-none focus:border-purple-500/50 focus:bg-white/8 transition-all resize-none"
              />
              <p className="text-xs text-slate-600 mt-1">{prompt.length}/1000 characters</p>
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
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Total Videos", value: videos?.length ?? 0, icon: Video, color: "text-purple-400" },
              { label: "Completed", value: completedVideos.length, icon: CheckCircle2, color: "text-green-400" },
              { label: "In Progress", value: processingVideos.length, icon: Loader2, color: "text-cyan-400" },
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
              <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
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
                  <VideoCard key={video.id} video={video} onView={setViewingVideoId} />
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
