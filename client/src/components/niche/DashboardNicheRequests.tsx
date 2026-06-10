/**
 * Dashboard — extra niche/kanaal aanvragen + status overzicht.
 */
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Loader2, Plus, Radio } from "lucide-react";
import { useState } from "react";
import { NicheRequestForm } from "@/components/niche/NicheRequestForm";
import { NICHE_REQUEST_STATUS_LABELS } from "@shared/nicheRequest";

export function DashboardNicheRequests() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [showForm, setShowForm] = useState(false);

  const { data: requests = [], isLoading } = trpc.nicheRequest.listMine.useQuery();

  const submitRequest = trpc.nicheRequest.submitRequest.useMutation({
    onSuccess: async () => {
      await utils.nicheRequest.listMine.invalidate();
      setShowForm(false);
      toast.success("Niche-aanvraag ingediend", {
        description: "Binnen 2 werkdagen ontvang je een goedkeuringsbericht. Na goedkeuring kun je binnen 24 uur starten met dit kanaal.",
      });
    },
    onError: (e) => toast.error("Indienen mislukt", { description: toastErrorMessage(e) }),
  });

  const channelRequests = requests.filter((r) => r.requestType === "new_channel");

  return (
    <div className="glass-card border border-white/10 rounded-2xl p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-white text-lg flex items-center gap-2">
            <Radio className="w-5 h-5 text-cyan-400" />
            Niche-aanvraag
          </h2>
          <p className="text-xs text-slate-400 mt-1 max-w-xl">
            Start een nieuw kanaal? Dien een aanvraag in — wij bouwen een beeldarchief op maat.
            Binnen 2 werkdagen goedkeuring, daarna binnen 24 uur starten.
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-600/20 text-purple-200 border border-purple-500/30 text-sm hover:bg-purple-600/30"
          >
            <Plus className="w-4 h-4" /> Nieuw kanaal
          </button>
        )}
      </div>

      {showForm && (
        <div className="border border-purple-500/20 rounded-xl p-4 bg-purple-600/5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Nieuw kanaal / niche</h3>
            <button type="button" onClick={() => setShowForm(false)} className="text-xs text-slate-400 hover:text-white">
              Annuleren
            </button>
          </div>
          <NicheRequestForm
            initialEmail={user?.email ?? ""}
            submitting={submitRequest.isPending}
            submitLabel="Aanvraag indienen"
            onSubmit={(values) =>
              submitRequest.mutate({ ...values, requestType: "new_channel" })
            }
          />
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
        </div>
      ) : channelRequests.length === 0 ? (
        <p className="text-sm text-slate-500">Nog geen extra kanaal-aanvragen.</p>
      ) : (
        <ul className="space-y-2">
          {channelRequests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 rounded-lg bg-white/5 border border-white/8">
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{r.nicheTitle}</p>
                <p className="text-xs text-slate-500 line-clamp-2">
                  {r.titleStructure ?? r.topics ?? r.description ?? "—"}
                </p>
              </div>
              <StatusBadge status={r.status} />
            </li>
          ))}
        </ul>
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
