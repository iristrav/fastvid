/**
 * Publieke niche-aanvraag — doorverwijst ingelogde gebruikers naar het dashboard.
 */
import { useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Loader2, Play, ArrowLeft } from "lucide-react";
import { NicheRequestForm } from "@/components/niche/NicheRequestForm";
import { ONBOARDING_PENDING_MESSAGE } from "@shared/nicheRequest";

export default function NicheAanvraag() {
  const [, navigate] = useLocation();
  const { user, loading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && user) {
      navigate("/dashboard#niche-requests");
    }
  }, [authLoading, user, navigate]);

  const submitRequest = trpc.nicheRequest.submitRequest.useMutation({
    onSuccess: async () => {
      toast.success("Aanvraag verstuurd", { description: ONBOARDING_PENDING_MESSAGE });
      navigate("/login");
    },
    onError: (e) => toast.error("Indienen mislukt", { description: toastErrorMessage(e) }),
  });

  if (authLoading || user) {
    return (
      <PageShell>
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="glass-card border border-white/10 rounded-2xl p-6 md:p-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
            Niche-aanvraag
          </h1>
          <p className="text-sm text-slate-400 leading-relaxed">
            Vul het formulier in. Na registratie dien je aanvragen in via je dashboard.
          </p>
        </div>

        <NicheRequestForm
          submitting={submitRequest.isPending}
          submitLabel="Versturen"
          onSubmit={(values) => submitRequest.mutate({ ...values, requestType: "onboarding" })}
        />
      </div>

      <p className="text-center text-xs text-slate-500">
        Al een account?{" "}
        <button type="button" onClick={() => navigate("/login")} className="text-purple-400 hover:text-purple-300">
          Inloggen
        </button>
      </p>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  const [, navigate] = useLocation();

  return (
    <div className="min-h-screen bg-[#0a0a1a] flex flex-col items-center justify-center p-4 py-10">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[300px] bg-cyan-500/8 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Home
          </button>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
              <Play className="w-3.5 h-3.5 text-white fill-white" />
            </div>
            <span className="text-xl font-bold text-white">Fastvid</span>
          </div>
          <div className="w-14" />
        </div>
        {children}
      </div>
    </div>
  );
}
