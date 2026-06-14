/**
 * Legacy URL — niche requests require an account (invite code first).
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2 } from "lucide-react";

export default function NicheAanvraag() {
  const [, navigate] = useLocation();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    navigate(user ? "/dashboard/niche-requests" : "/login");
  }, [authLoading, user, navigate]);

  return (
    <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
    </div>
  );
}
