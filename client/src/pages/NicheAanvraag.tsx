/**
 * Publieke niche-aanvraagpagina — e-mail, niche, format (titelstructuur + onderwerpen).
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

  const apply = trpc.nicheRequest.apply.useMutation({
    onSuccess: async () => {
      if (user) await utils.nicheRequest.accessStatus.invalidate();
      toast.success("Aanvraag verstuurd", { description: ONBOARDING_PENDING_MESSAGE });
    },
    onError: (e) => toast.error("Indienen mislukt", { description: toastErrorMessage(e) }),
  });

  const isLoading = authLoading || (Boolean(user) && accessLoading);

  if (isLoading) {
    return (
      <PageShell>
        <div className="flex justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
        </div>
      </PageShell>
    );
  }

  if (user?.role === "admin") {
    navigate("/dashboard");
    return null;
  }

  const onboarding = access?.onboarding;
  const status = onboarding?.status;

  if (user && status === "pending") {
    return (
      <PageShell>
        <NicheRequestPendingCard email={onboarding?.contactEmail ?? user.email ?? undefined} />
      </PageShell>
    );
  }

  if (user && (status === "approved" || status === "ready")) {
    return (
      <PageShell>
        <NicheRequestApprovedCard onContinue={() => navigate("/subscribe")} />
      </PageShell>
    );
  }

  if (user && status === "in_progress") {
    return (
      <PageShell>
        <div className="glass-card border border-cyan-500/30 bg-cyan-500/5 rounded-xl p-6 space-y-3">
          <h3 className="text-lg font-bold text-cyan-200">Archief in opbouw</h3>
          <p className="text-sm text-cyan-100/90">
            Je aanvraag voor <strong>{onboarding?.nicheTitle}</strong> is goedgekeurd. We bouwen je beeldarchief.
            Je kunt al starten — generatie kan langer duren tot het archief compleet is.
          </p>
          <button
            type="button"
            onClick={() => navigate("/subscribe")}
            className="mt-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-semibold"
          >
            Verder naar abonnement
          </button>
        </div>
      </PageShell>
    );
  }

  if (user && status === "rejected") {
    return (
      <PageShell>
        <div className="glass-card border border-red-500/30 bg-red-500/5 rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-bold text-red-200">Aanvraag afgewezen</h3>
          {onboarding?.adminNotes && (
            <p className="text-sm text-red-100/80">{onboarding.adminNotes}</p>
          )}
          <NicheRequestForm
            initialEmail={onboarding?.contactEmail ?? user.email ?? ""}
            initialNiche={onboarding?.nicheTitle}
            initialFormat={onboarding?.description ?? undefined}
            submitting={apply.isPending}
            submitLabel="Opnieuw indienen"
            onSubmit={(values) =>
              apply.mutate({ ...values, requestType: "onboarding" })
            }
          />
        </div>
      </PageShell>
    );
  }

  const justSubmitted = apply.isSuccess && !user;

  if (justSubmitted) {
    return (
      <PageShell>
        <NicheRequestPendingCard />
        <p className="text-center text-xs text-slate-500">
          Nog geen account?{" "}
          <button type="button" onClick={() => navigate("/login")} className="text-purple-400 hover:text-purple-300">
            Maak er een aan met je invite code
          </button>
        </p>
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
            Vul je niche in, je e-mailadres en hoe je kanaal werkt (titelstructuur en onderwerpen).
            Binnen <strong className="text-white">2 werkdagen</strong> hoor je van ons — na goedkeuring start je binnen{" "}
            <strong className="text-white">24 uur</strong>.
          </p>
        </div>

        <NicheRequestForm
          initialEmail={user?.email ?? ""}
          submitting={apply.isPending}
          onSubmit={(values) => apply.mutate({ ...values, requestType: "onboarding" })}
        />
      </div>

      {!user && (
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
