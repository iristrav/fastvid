/** @deprecated Use /dashboard/niche-requests — kept for old links. */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2 } from "lucide-react";

export default function Onboarding() {
  const [, navigate] = useLocation();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (authLoading) return;
    navigate(user ? "/dashboard/niche-requests" : "/login");
  }, [authLoading, user, navigate]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
    </div>
  );
}
