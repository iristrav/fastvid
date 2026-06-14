/**
 * Dedicated niche requests page — onboarding + extra channel requests.
 */
import { Loader2 } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { DashboardNicheRequests } from "@/components/niche/DashboardNicheRequests";

export default function NicheRequestsPage() {
  const { loading } = useAuth({ redirectOnUnauthenticated: true });

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
      </div>
    );
  }

  return (
    <DashboardShell activeTab="niche-requests">
      <div className="max-w-3xl mx-auto p-6 lg:p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
            Niche requests
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Describe your niche with topics, sub-niches, and title structure. We review within 2 business days.
          </p>
        </div>
        <DashboardNicheRequests fullPage />
      </div>
    </DashboardShell>
  );
}
