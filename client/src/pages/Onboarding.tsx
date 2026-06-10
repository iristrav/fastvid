/**
 * Post-registration onboarding — niche + format application.
 */
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import {
  NicheRequestApprovedCard,
  NicheRequestForm,
  NicheRequestPendingCard,
} from "@/components/niche/NicheRequestForm";
import { ONBOARDING_PENDING_MESSAGE } from "@shared/nicheRequest";

export default function Onboarding() {
  const [, navigate] = useLocation();
  const { user, loading } = useAuth({ redirectOnUnauthenticated: true });
  const utils = trpc.useUtils();

  const { data: access, isLoading } = trpc.nicheRequest.accessStatus.useQuery(undefined, {
    enabled: Boolean(user),
  });

  const submit = trpc.nicheRequest.submit.useMutation({
    onSuccess: async () => {
      await utils.nicheRequest.accessStatus.invalidate();
      toast.success("Aanvraag verstuurd", { description: ONBOARDING_PENDING_MESSAGE });
    },
    onError: (e) => toast.error("Indienen mislukt", { description: toastErrorMessage(e) }),
  });

  if (loading || isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (user?.role === "admin") {
    navigate("/dashboard");
    return null;
  }

  const onboarding = access?.onboarding;
  const status = onboarding?.status;

  if (status === "pending") {
    return (
      <OnboardingShell>
        <NicheRequestPendingCard />
      </OnboardingShell>
    );
  }

  if (status === "approved" || status === "ready") {
    return (
      <OnboardingShell>
        <NicheRequestApprovedCard onContinue={() => navigate("/subscribe")} />
      </OnboardingShell>
    );
  }

  if (status === "in_progress") {
    return (
      <OnboardingShell>
        <div className="glass-card border border-cyan-500/30 bg-cyan-500/5 rounded-xl p-6 space-y-3">
          <h3 className="text-lg font-bold text-cyan-200">Archief in opbouw</h3>
          <p className="text-sm text-cyan-100/90">
            Je aanvraag voor <strong>{onboarding?.nicheTitle}</strong> is goedgekeurd. We bouwen je beeldarchief.
            Je kunt al starten — generatie kan langer duren tot het archief compleet is.
          </p>
          <button
            onClick={() => navigate("/subscribe")}
            className="mt-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-sm font-semibold"
          >
            Verder naar abonnement
          </button>
        </div>
      </OnboardingShell>
    );
  }

  if (status === "rejected") {
    return (
      <OnboardingShell>
        <div className="glass-card border border-red-500/30 bg-red-500/5 rounded-xl p-6 space-y-4">
          <h3 className="text-lg font-bold text-red-200">Aanvraag afgewezen</h3>
          {onboarding?.adminNotes && (
            <p className="text-sm text-red-100/80">{onboarding.adminNotes}</p>
          )}
          <NicheRequestForm
            requestType="onboarding"
            submitting={submit.isPending}
            submitLabel="Opnieuw indienen"
            onSubmit={(values) =>
              submit.mutate({ ...values, requestType: "onboarding", channelName: values.channelName || undefined })
            }
          />
        </div>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell>
      <div className="glass-card border border-white/10 rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-xl font-bold text-white">Niche-aanvraag</h2>
          <p className="text-sm text-slate-400 mt-1">
            Vertel ons over je kanaal. Binnen 2 werkdagen goedkeuring — daarna start je binnen 24 uur.
          </p>
        </div>
        <NicheRequestForm
          requestType="onboarding"
          submitting={submit.isPending}
          onSubmit={(values) =>
            submit.mutate({ ...values, requestType: "onboarding", channelName: values.channelName || undefined })
          }
        />
      </div>
    </OnboardingShell>
  );
}

function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-600/10 rounded-full blur-3xl" />
      </div>
      <div className="relative w-full max-w-lg space-y-6">
        <div className="flex items-center justify-center gap-2">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
            <Play className="w-4 h-4 text-white fill-white" />
          </div>
          <span className="text-2xl font-bold text-white">Fastvid</span>
        </div>
        {children}
      </div>
    </div>
  );
}
