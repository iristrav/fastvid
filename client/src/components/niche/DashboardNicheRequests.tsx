/**
 * User dashboard — niche onboarding + extra kanaal aanvragen.
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Loader2, Plus, Radio } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import {
  NicheRequestApprovedCard,
  NicheRequestForm,
  NicheRequestPendingCard,
} from "@/components/niche/NicheRequestForm";
import { NICHE_REQUEST_STATUS_LABELS, ONBOARDING_PENDING_MESSAGE } from "@shared/nicheRequest";

export function DashboardNicheRequests() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [showNewChannelForm, setShowNewChannelForm] = useState(false);

  const { data: access, isLoading: accessLoading } = trpc.nicheRequest.accessStatus.useQuery(undefined, {
    enabled: Boolean(user) && user?.role !== "admin",
  });
  const { data: requests = [], isLoading: listLoading } = trpc.nicheRequest.listMine.useQuery(undefined, {
    enabled: Boolean(user) && user?.role !== "admin",
  });

  const submitRequest = trpc.nicheRequest.submitRequest.useMutation({
    onSuccess: async (_data, variables) => {
      await utils.nicheRequest.accessStatus.invalidate();
      await utils.nicheRequest.listMine.invalidate();
      setShowNewChannelForm(false);
      if (variables.requestType === "onboarding") {
        toast.success("Aanvraag verstuurd", { description: ONBOARDING_PENDING_MESSAGE });
      } else {
        toast.success("Niche-aanvraag ingediend", {
          description: "Binnen 2 werkdagen ontvang je een goedkeuringsbericht.",
        });
      }
    },
    onError: (e) => toast.error("Indienen mislukt", { description: toastErrorMessage(e) }),
  });

  if (!user || user.role === "admin") return null;

  const onboarding = access?.onboarding;
  const status = onboarding?.status;
  const canUsePlatform = Boolean(access?.canUsePlatform);
  const channelRequests = requests.filter((r) => r.requestType === "new_channel");
  const justSubmitted = submitRequest.isSuccess && submitRequest.variables?.requestType === "onboarding";

  const showOnboardingForm =
    !accessLoading &&
    !justSubmitted &&
    status !== "pending" &&
    status !== "approved" &&
    status !== "in_progress" &&
    status !== "ready";

  const showPending =
    !accessLoading && (status === "pending" || justSubmitted);

  const showApproved =
    !accessLoading &&
    (status === "approved" || status === "in_progress" || status === "ready") &&
    !canUsePlatform;

  return (
    <div id="niche-requests" className="glass-card border border-white/10 rounded-2xl p-6 space-y-5 scroll-mt-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-white text-lg flex items-center gap-2">
            <Radio className="w-5 h-5 text-cyan-400" />
            Niche-aanvraag
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-xl">
            Dien hier je niche in. Wij beoordelen binnen 2 werkdagen en bouwen een beeldarchief op maat.
          </p>
        </div>
        {canUsePlatform && !showNewChannelForm && (
          <button
            type="button"
            onClick={() => setShowNewChannelForm(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-600/20 text-purple-200 border border-purple-500/30 text-sm hover:bg-purple-600/30"
          >
            <Plus className="w-4 h-4" /> Extra kanaal
          </button>
        )}
      </div>

      {accessLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
        </div>
      ) : (
        <>
          {showPending && (
            <NicheRequestPendingCard email={onboarding?.contactEmail ?? user.email ?? undefined} />
          )}

          {showApproved && (
            <NicheRequestApprovedCard onContinue={() => navigate("/subscribe")} />
          )}

          {showOnboardingForm && (
            <div className="border border-purple-500/20 rounded-xl p-4 bg-purple-600/5 space-y-3">
              {status === "rejected" && onboarding?.adminNotes && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                  {onboarding.adminNotes}
                </div>
              )}
              <h3 className="text-sm font-semibold text-white">
                {status === "rejected" ? "Opnieuw indienen" : "Jouw niche & contentformaat"}
              </h3>
              <NicheRequestForm
                initialEmail={onboarding?.contactEmail ?? user.email ?? ""}
                initialNiche={onboarding?.nicheTitle ?? ""}
                initialTitleStructure={onboarding?.titleStructure ?? ""}
                initialTopics={onboarding?.topics ?? ""}
                submitting={submitRequest.isPending}
                submitLabel={status === "rejected" ? "Opnieuw versturen" : "Aanvraag indienen"}
                onSubmit={(values) =>
                  submitRequest.mutate({ ...values, requestType: "onboarding" })
                }
              />
            </div>
          )}

          {canUsePlatform && showNewChannelForm && (
            <div className="border border-purple-500/20 rounded-xl p-4 bg-purple-600/5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">Nieuw kanaal / niche</h3>
                <button
                  type="button"
                  onClick={() => setShowNewChannelForm(false)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  Annuleren
                </button>
              </div>
              <NicheRequestForm
                initialEmail={user.email ?? ""}
                submitting={submitRequest.isPending}
                submitLabel="Aanvraag indienen"
                onSubmit={(values) =>
                  submitRequest.mutate({ ...values, requestType: "new_channel" })
                }
              />
            </div>
          )}

          {canUsePlatform && (
            <div className="space-y-2 pt-1 border-t border-white/8">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Jouw kanaal-aanvragen</p>
              {listLoading ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
                </div>
              ) : channelRequests.length === 0 ? (
                <p className="text-sm text-slate-500">Nog geen extra kanaal-aanvragen.</p>
              ) : (
                <ul className="space-y-2">
                  {channelRequests.map((r) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-white/5 border border-white/8"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{r.nicheTitle}</p>
                        <p className="text-xs text-slate-500 line-clamp-2">
                          {r.titleStructure ?? r.topics ?? "—"}
                        </p>
                      </div>
                      <StatusBadge status={r.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label = NICHE_REQUEST_STATUS_LABELS[status] ?? status;
  const colors: Record<string, string> = {
    pending: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30",
    approved: "bg-green-500/15 text-green-300 border-green-500/30",
    in_progress: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    ready: "bg-purple-500/15 text-purple-300 border-purple-500/30",
    rejected: "bg-red-500/15 text-red-300 border-red-500/30",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${colors[status] ?? "bg-white/10 text-slate-300"}`}>
      {label}
    </span>
  );
}
