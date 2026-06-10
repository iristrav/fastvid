/**
 * Publieke niche-aanvraag — contactformulier (e-mail, niche, titelstructuur, onderwerpen).
 */
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Loader2, Play, ArrowLeft } from "lucide-react";
import {
  NicheRequestApprovedCard,
  NicheRequestForm,
  NicheRequestPendingCard,
} from "@/components/niche/NicheRequestForm";
import { ONBOARDING_PENDING_MESSAGE } from "@shared/nicheRequest";

export default function NicheAanvraag() {
  const [, navigate] = useLocation();
  const { user, loading: authLoading } = useAuth();
  const utils = trpc.useUtils();

  const { data: access, isLoading: accessLoading } = trpc.nicheRequest.accessStatus.useQuery(undefined, {
    enabled: Boolean(user),
  });

  const submitRequest = trpc.nicheRequest.submitRequest.useMutation({
    onSuccess: async () => {
      if (user) await utils.nicheRequest.accessStatus.invalidate();
      toast.success("Aanvraag verstuurd", { description: ONBOARDING_PENDING_MESSAGE });
    },
    onError: (e) => toast.error("Indienen mislukt", { description: toastErrorMessage(e) }),
  });

  const isLoading = authLoading || (Boolean(user) && accessLoading);
  const onboarding = access?.onboarding;
  const status = onboarding?.status;
  const justSubmitted = submitRequest.isSuccess;

  if (isLoading) {
    return (
      <PageShell>
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
        </div>
      </PageShell>
    );
  }

  if (user && status === "pending" && !justSubmitted) {
    return (
      <PageShell>
        <NicheRequestPendingCard email={onboarding?.contactEmail ?? user.email ?? undefined} />
      </PageShell>
    );
  }

  if (user && (status === "approved" || status === "ready") && user.role !== "admin") {
    return (
      <PageShell>
        <NicheRequestApprovedCard onContinue={() => navigate("/subscribe")} />
      </PageShell>
    );
  }

  if (user && status === "in_progress" && user.role !== "admin") {
    return (
      <PageShell>
        <NicheRequestApprovedCard onContinue={() => navigate("/subscribe")} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      {justSubmitted ? (
        <NicheRequestPendingCard email={user?.email} />
      ) : (
        <div className="glass-card border border-white/10 rounded-2xl p-6 md:p-8 space-y-6">
          <div className="space-y-2">
            <h1 className="text-2xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
              Niche-aanvraag
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Vul het formulier in. Binnen <strong className="text-white">2 werkdagen</strong> hoor je van ons.
            </p>
          </div>

          {user && status === "rejected" && onboarding?.adminNotes && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {onboarding.adminNotes}
            </div>
          )}

          <NicheRequestForm
            initialEmail={onboarding?.contactEmail ?? user?.email ?? ""}
            initialNiche={onboarding?.nicheTitle ?? ""}
            initialTitleStructure={onboarding?.titleStructure ?? ""}
            initialTopics={onboarding?.topics ?? ""}
            submitting={submitRequest.isPending}
            submitLabel={status === "rejected" ? "Opnieuw versturen" : "Versturen"}
            onSubmit={(values) => submitRequest.mutate({ ...values, requestType: "onboarding" })}
          />
        </div>
      )}

      {!user && !justSubmitted && (
        <p className="text-center text-xs text-slate-500">
          Al een account?{" "}
          <button type="button" onClick={() => navigate("/login")} className="text-purple-400 hover:text-purple-300">
            Inloggen
          </button>
        </p>
      )}
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
