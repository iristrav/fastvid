/**
 * User dashboard — niche onboarding + extra channel requests.
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { ChevronRight, Loader2, Plus, Radio } from "lucide-react";
import { useState } from "react";
import { useLocation } from "wouter";
import {
  NicheRequestApprovedCard,
  NicheRequestForm,
  NicheRequestPendingCard,
} from "@/components/niche/NicheRequestForm";
import { NICHE_REQUEST_STATUS_LABELS, ONBOARDING_PENDING_MESSAGE } from "@shared/nicheRequest";

type Props = {
  /** When true, show the full page layout (forms + history). When false, only onboarding block. */
  fullPage?: boolean;
};

export function DashboardNicheRequests({ fullPage = true }: Props) {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [showNewChannelForm, setShowNewChannelForm] = useState(false);

  const { data: access, isFetching: accessFetching, isError: accessError, refetch: refetchAccess } =
    trpc.nicheRequest.accessStatus.useQuery(undefined, {
      enabled: Boolean(user),
      retry: 1,
    });
  const { data: requests = [], isFetching: listFetching, isError: listError, refetch: refetchList } =
    trpc.nicheRequest.listMine.useQuery(undefined, {
      enabled: Boolean(user),
      retry: 1,
    });

  const submitRequest = trpc.nicheRequest.submitRequest.useMutation({
    onSuccess: async (_data, variables) => {
      await utils.nicheRequest.accessStatus.invalidate();
      await utils.nicheRequest.listMine.invalidate();
      setShowNewChannelForm(false);
      if (variables.requestType === "onboarding") {
        toast.success("Request submitted", { description: ONBOARDING_PENDING_MESSAGE });
      } else {
        toast.success("Niche request submitted", {
          description: "You will receive an approval email within 2 business days.",
        });
      }
    },
    onError: (e) => toast.error("Submission failed", { description: toastErrorMessage(e) }),
  });

  if (!user) return null;

  const onboarding = access?.onboarding;
  const status = onboarding?.status;
  const canUsePlatform = user.role === "admin" || Boolean(access?.canUsePlatform);
  const channelRequests = requests.filter((r) => r.requestType === "new_channel");
  const justSubmitted = submitRequest.isSuccess && submitRequest.variables?.requestType === "onboarding";
  const waitingForAccess = Boolean(user) && accessFetching && !access && !accessError;

  const showOnboardingForm =
    !waitingForAccess &&
    !canUsePlatform &&
    !justSubmitted &&
    status !== "pending" &&
    status !== "approved" &&
    status !== "in_progress" &&
    status !== "ready";

  const showPending =
    !waitingForAccess && (status === "pending" || justSubmitted);

  const showApproved =
    !waitingForAccess &&
    (status === "approved" || status === "in_progress" || status === "ready") &&
    !canUsePlatform;

  return (
    <div id="niche-requests" className="glass-card border border-white/10 rounded-2xl p-6 space-y-5 scroll-mt-24">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-white text-lg flex items-center gap-2">
            <Radio className="w-5 h-5 text-cyan-400" />
            {fullPage ? "Niche requests" : "Niche request"}
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-xl">
            {canUsePlatform
              ? "Starting a second channel in another niche? Submit your topics, sub-niches, and title structure — we review within 2 business days and build a custom media archive."
              : "Submit your niche here. We review within 2 business days and build a custom media archive."}
          </p>
        </div>
        {fullPage && canUsePlatform && !showNewChannelForm && (
          <button
            type="button"
            onClick={() => setShowNewChannelForm(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-600/20 text-purple-200 border border-purple-500/30 text-sm hover:bg-purple-600/30"
          >
            <Plus className="w-4 h-4" /> New channel
          </button>
        )}
      </div>

      {waitingForAccess ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
        </div>
      ) : (
        <>
          {(accessError || listError) && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex flex-wrap items-center justify-between gap-3">
              <span>Could not load niche requests. Try again in a moment.</span>
              <button
                type="button"
                onClick={() => {
                  void refetchAccess();
                  void refetchList();
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-100"
              >
                Retry
              </button>
            </div>
          )}

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
                {status === "rejected" ? "Resubmit" : "Your niche & content format"}
              </h3>
              <NicheRequestForm
                initialEmail={onboarding?.contactEmail ?? user.email ?? ""}
                initialNiche={onboarding?.nicheTitle ?? ""}
                initialTitleStructure={onboarding?.titleStructure ?? ""}
                initialTopics={onboarding?.topics ?? ""}
                initialSubniches={onboarding?.subniches ?? ""}
                submitting={submitRequest.isPending}
                submitLabel={status === "rejected" ? "Resubmit" : "Submit request"}
                onSubmit={(values) =>
                  submitRequest.mutate({ ...values, requestType: "onboarding" })
                }
              />
            </div>
          )}

          {fullPage && canUsePlatform && showNewChannelForm && (
            <div className="border border-purple-500/20 rounded-xl p-4 bg-purple-600/5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-white">New channel / niche</h3>
                <button
                  type="button"
                  onClick={() => setShowNewChannelForm(false)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>
              <NicheRequestForm
                initialEmail={user.email ?? ""}
                submitting={submitRequest.isPending}
                submitLabel="Submit request"
                onSubmit={(values) =>
                  submitRequest.mutate({ ...values, requestType: "new_channel" })
                }
              />
            </div>
          )}

          {fullPage && (
            <div className="space-y-3 pt-1 border-t border-white/8">
              <p className="text-xs text-slate-500 uppercase tracking-wide">Your requests</p>
              {listFetching && requests.length === 0 ? (
                <div className="flex justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
                </div>
              ) : requests.length === 0 ? (
                <p className="text-sm text-slate-500">No niche requests yet.</p>
              ) : (
                <ul className="space-y-3">
                  {requests.map((r) => (
                    <li
                      key={r.id}
                      className="px-4 py-3.5 rounded-xl bg-white/5 border border-white/8 space-y-2"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-white">{r.nicheTitle}</p>
                          <p className="text-[10px] text-slate-500 uppercase tracking-wide mt-0.5">
                            {r.requestType === "onboarding" ? "First channel" : "Extra channel"}
                          </p>
                        </div>
                        <StatusBadge status={r.status} />
                      </div>
                      {r.topics && (
                        <RequestField label="Topics" value={r.topics} />
                      )}
                      {r.subniches && (
                        <RequestField label="Sub-niches" value={r.subniches} />
                      )}
                      {r.titleStructure && (
                        <RequestField label="Title structure" value={r.titleStructure} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {fullPage && canUsePlatform && channelRequests.length === 0 && !showNewChannelForm && (
            <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center">
              <p className="text-sm text-slate-400">
                Want to start a second YouTube channel in a different niche?
              </p>
              <button
                type="button"
                onClick={() => setShowNewChannelForm(true)}
                className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-semibold"
              >
                <Plus className="w-4 h-4" /> Request a new niche
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function NicheRequestsDashboardCard() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const { data: access, isLoading } = trpc.nicheRequest.accessStatus.useQuery(undefined, {
    enabled: Boolean(user),
  });
  const { data: requests = [] } = trpc.nicheRequest.listMine.useQuery(undefined, {
    enabled: Boolean(user),
  });

  if (!user) return null;

  const onboarding = access?.onboarding;
  const status = onboarding?.status;
  const canUsePlatform = user?.role === "admin" || Boolean(access?.canUsePlatform);
  const pendingCount = requests.filter((r) => r.status === "pending").length;
  const channelCount = requests.filter((r) => r.requestType === "new_channel").length;

  let headline = "Manage your niche requests";
  let description = "Submit topics, sub-niches, and title structure for your channel(s).";
  let badge: string | null = null;

  if (!canUsePlatform && status === "pending") {
    headline = "Niche application under review";
    description = "We received your request and will email you within 2 business days.";
    badge = "Pending";
  } else if (!canUsePlatform && ["approved", "in_progress", "ready"].includes(status ?? "")) {
    headline = "Niche approved — activate your subscription";
    description = "Your niche is ready. Subscribe to start generating videos.";
    badge = NICHE_REQUEST_STATUS_LABELS[status ?? ""] ?? null;
  } else if (!canUsePlatform) {
    headline = "Submit your niche to get started";
    description = "Tell us your niche, topics, sub-niches, and title structure.";
  } else if (channelCount === 0) {
    headline = "Starting a second channel?";
    description = "Request a new niche with your topics, sub-niches, and title templates.";
  } else if (pendingCount > 0) {
    badge = `${pendingCount} pending`;
  }

  return (
    <button
      type="button"
      onClick={() => navigate("/dashboard/niche-requests")}
      disabled={isLoading}
      className="w-full text-left glass-card border border-white/10 rounded-2xl p-5 hover:border-purple-500/30 transition-colors group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center shrink-0">
            <Radio className="w-5 h-5 text-cyan-400" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-white group-hover:text-purple-200 transition-colors">{headline}</p>
            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300 border border-yellow-500/30">
              {badge}
            </span>
          )}
          <ChevronRight className="w-4 h-4 text-slate-500 group-hover:text-purple-400 transition-colors" />
        </div>
      </div>
    </button>
  );
}

function RequestField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-0.5">{label}</p>
      <p className="text-xs text-slate-300 whitespace-pre-wrap line-clamp-3">{value}</p>
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
