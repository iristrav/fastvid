import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import {
  LayoutDashboard, LogOut, Play, Radio, Settings, Video,
} from "lucide-react";

type DashboardShellProps = {
  activeTab: "dashboard" | "niche-requests";
  children: React.ReactNode;
};

export function DashboardShell({ activeTab, children }: DashboardShellProps) {
  const { user, logout } = useAuth({ redirectOnUnauthenticated: true });
  const [, navigate] = useLocation();
  const userSub = (user as { subscriptionStatus?: string } | null)?.subscriptionStatus;
  const hasActiveSubscription = userSub === "active" || user?.role === "admin";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="fixed left-0 top-0 bottom-0 w-60 bg-background/95 border-r border-white/8 flex flex-col z-40 hidden lg:flex">
        <div className="p-5 border-b border-white/8">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-black text-xl text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <button
            type="button"
            onClick={() => navigate("/dashboard")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
              activeTab === "dashboard"
                ? "bg-purple-600/20 text-white font-medium"
                : "text-slate-400 hover:text-white hover:bg-white/5"
            }`}
          >
            <LayoutDashboard className={`w-4 h-4 ${activeTab === "dashboard" ? "text-purple-400" : ""}`} />
            Dashboard
          </button>
          {user?.role !== "admin" && (
            <button
              type="button"
              onClick={() => navigate("/dashboard/niche-requests")}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                activeTab === "niche-requests"
                  ? "bg-purple-600/20 text-white font-medium"
                  : "text-slate-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <Radio className={`w-4 h-4 ${activeTab === "niche-requests" ? "text-cyan-400" : ""}`} />
              Niche requests
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate("/")}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors"
          >
            <Video className="w-4 h-4" />
            Landing Page
          </button>
          {user?.role === "admin" && (
            <button
              type="button"
              onClick={() => navigate("/admin")}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors"
            >
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
          <button
            type="button"
            onClick={() => { logout(); navigate("/"); }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 text-sm transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Log out
          </button>
        </div>
      </div>

      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-background/95 border-b border-white/8 px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
            <Play className="w-3.5 h-3.5 text-white fill-white" />
          </div>
          <span className="font-black text-lg text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
            Fast<span className="gradient-text">vid</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {user?.role === "admin" && (
            <button
              type="button"
              onClick={() => navigate("/admin")}
              className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
            >
              Admin
            </button>
          )}
          <button
            type="button"
            onClick={() => { logout(); navigate("/"); }}
            className="text-xs text-slate-400 hover:text-white px-2 py-1 rounded-md hover:bg-white/5 transition-colors"
          >
            Logout
          </button>
        </div>
      </div>

      <div className="lg:pl-60 pt-14 lg:pt-0">
        {children}
      </div>
    </div>
  );
}
