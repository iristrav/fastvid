/**
 * FASTVID — Admin Dashboard
 * Full control over users, subscriptions, and video overview
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import {
  Users, Video, TrendingUp, CheckCircle2, XCircle, Loader2,
  Play, LogOut, LayoutDashboard, Settings, Shield, RefreshCw,
  UserCheck, UserX, Crown, ChevronDown, ChevronUp,
} from "lucide-react";

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: number | string; icon: React.ElementType; color: string; sub?: string;
}) {
  return (
    <div className="glass-card border border-white/8 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">{label}</span>
        <Icon className={`w-4 h-4 ${color}`} />
      </div>
      <p className="text-3xl font-black text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>{value}</p>
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

// ─── Users Table ──────────────────────────────────────────────────────────────
function UsersTable() {
  const { data: users, isLoading, refetch } = trpc.admin.listUsers.useQuery({ limit: 100, offset: 0 });
  const updateSubMutation = trpc.admin.updateUserSubscription.useMutation({
    onSuccess: () => { toast.success("Subscription updated"); refetch(); },
    onError: (e) => toast.error(e.message),
  });
  const updateRoleMutation = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => { toast.success("Role updated"); refetch(); },
    onError: (e) => toast.error(e.message),
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
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center text-white font-bold text-xs shrink-0">
                        {user.name?.[0] ?? "U"}
                      </div>
                      <div>
                        <p className="text-white font-medium text-xs">{user.name ?? "—"}</p>
                        <p className="text-slate-500 text-xs">{user.email ?? user.openId.slice(0, 16) + "..."}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${user.role === "admin" ? "text-purple-300 bg-purple-500/10 border-purple-500/20" : "text-slate-400 bg-white/5 border-white/10"}`}>
                      {user.role === "admin" ? <span className="flex items-center gap-1"><Crown className="w-3 h-3" /> Admin</span> : "User"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_BADGE[user.subscriptionStatus] ?? "text-slate-400 bg-white/5 border-white/10"}`}>
                      {user.subscriptionStatus}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {user.subscriptionStatus !== "active" ? (
                        <button
                          onClick={() => updateSubMutation.mutate({ userId: user.id, subscriptionStatus: "active" })}
                          disabled={updateSubMutation.isPending}
                          className="flex items-center gap-1 text-xs text-green-400 hover:text-green-300 transition-colors px-2 py-1 rounded-md hover:bg-green-400/10"
                        >
                          <UserCheck className="w-3.5 h-3.5" /> Activate
                        </button>
                      ) : (
                        <button
                          onClick={() => updateSubMutation.mutate({ userId: user.id, subscriptionStatus: "inactive" })}
                          disabled={updateSubMutation.isPending}
                          className="flex items-center gap-1 text-xs text-yellow-400 hover:text-yellow-300 transition-colors px-2 py-1 rounded-md hover:bg-yellow-400/10"
                        >
                          <UserX className="w-3.5 h-3.5" /> Deactivate
                        </button>
                      )}
                      {user.role !== "admin" && (
                        <button
                          onClick={() => updateRoleMutation.mutate({ userId: user.id, role: "admin" })}
                          disabled={updateRoleMutation.isPending}
                          className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors px-2 py-1 rounded-md hover:bg-purple-400/10"
                        >
                          <Crown className="w-3.5 h-3.5" /> Make Admin
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

// ─── Videos Table ─────────────────────────────────────────────────────────────
function VideosTable() {
  const { data: videos, isLoading, refetch } = trpc.admin.listVideos.useQuery({ limit: 100, offset: 0 });

  if (isLoading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-purple-400 animate-spin" /></div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-white text-lg flex items-center gap-2"><Video className="w-5 h-5 text-cyan-400" /> Videos ({videos?.length ?? 0})</h2>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
      <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 text-xs text-slate-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Video</th>
                <th className="text-left px-4 py-3">Length</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">User ID</th>
                <th className="text-left px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {videos?.map((video) => (
                <tr key={video.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                  <td className="px-4 py-3 max-w-xs">
                    <p className="text-white text-xs font-medium truncate">{video.title ?? video.prompt.slice(0, 50)}</p>
                    <p className="text-slate-500 text-xs truncate">{video.prompt.slice(0, 60)}...</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-400 font-mono">{video.videoLength} min</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${VIDEO_STATUS_BADGE[video.status] ?? "text-slate-400 bg-white/5"}`}>
                      {video.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">#{video.userId}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{new Date(video.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
              {(!videos || videos.length === 0) && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500 text-sm">No videos yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Main Admin ───────────────────────────────────────────────────────────────
export default function Admin() {
  const { user, loading, isAuthenticated, logout } = useAuth() as {
    user: { name?: string; role?: string } | null;
    loading: boolean; isAuthenticated: boolean; logout: () => void;
  };
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<"overview" | "users" | "videos">("overview");

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
          <button onClick={() => navigate("/")} className="mt-4 text-purple-400 hover:text-purple-300 text-sm transition-colors">← Go home</button>
        </div>
      </div>
    );
  }

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
          <div className="mt-2 px-1">
            <span className="text-xs text-purple-400 font-medium flex items-center gap-1"><Shield className="w-3 h-3" /> Admin Panel</span>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {[
            { id: "overview", label: "Overview", icon: LayoutDashboard },
            { id: "users", label: "Users", icon: Users },
            { id: "videos", label: "Videos", icon: Video },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id as typeof activeTab)}
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
              <TrendingUp className="w-4 h-4" />
              My Dashboard
            </button>
            <button onClick={() => navigate("/")} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors">
              <Play className="w-4 h-4" />
              Landing Page
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

      {/* ── Mobile Header ── */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-background/95 border-b border-white/8 px-4 h-14 flex items-center justify-between">
        <span className="font-black text-lg text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>Fast<span className="gradient-text">vid</span> <span className="text-xs text-purple-400 font-normal">Admin</span></span>
        <div className="flex gap-2">
          {(["overview","users","videos"] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`text-xs px-2 py-1 rounded-md transition-colors ${activeTab === tab ? "bg-purple-600/30 text-purple-300" : "text-slate-400 hover:text-white"}`}>{tab}</button>
          ))}
        </div>
      </div>

      {/* ── Main ── */}
      <div className="lg:pl-60 pt-14 lg:pt-0">
        <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-8">
          <div>
            <h1 className="text-2xl font-black text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Admin <span className="gradient-text">Dashboard</span>
            </h1>
            <p className="text-slate-400 text-sm mt-1">Manage users, subscriptions, and video generation</p>
          </div>

          {/* Overview */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              {statsLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-purple-400 animate-spin" /></div>
              ) : (
                <>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard label="Total Users" value={stats?.users.total ?? 0} icon={Users} color="text-purple-400" />
                    <StatCard label="Active Subscribers" value={stats?.users.active ?? 0} icon={UserCheck} color="text-green-400" sub={`€${(stats?.users.active ?? 0) * 500}/mo revenue`} />
                    <StatCard label="Total Videos" value={stats?.videos.total ?? 0} icon={Video} color="text-cyan-400" />
                    <StatCard label="Completed Videos" value={stats?.videos.completed ?? 0} icon={CheckCircle2} color="text-green-400" sub={`${stats?.videos.failed ?? 0} failed`} />
                  </div>
                  <div className="glass-card border border-white/8 rounded-xl p-5">
                    <h3 className="font-bold text-white mb-4 flex items-center gap-2"><TrendingUp className="w-4 h-4 text-cyan-400" /> Revenue Overview</h3>
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-2xl font-black gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>€{(stats?.users.active ?? 0) * 500}</p>
                        <p className="text-xs text-slate-500 mt-1">Monthly Revenue (MRR)</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>€{(stats?.users.active ?? 0) * 500 * 12}</p>
                        <p className="text-xs text-slate-500 mt-1">Annual Run Rate (ARR)</p>
                      </div>
                      <div>
                        <p className="text-2xl font-black gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>{stats?.users.active ?? 0}</p>
                        <p className="text-xs text-slate-500 mt-1">Paying Subscribers</p>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === "users" && <UsersTable />}
          {activeTab === "videos" && <VideosTable />}
        </div>
      </div>
    </div>
  );
}
