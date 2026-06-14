import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import { Loader2, Check, X } from "lucide-react";
import { NICHE_REQUEST_STATUS_LABELS } from "@shared/nicheRequest";

const STATUSES = ["pending", "approved", "in_progress", "ready", "rejected"] as const;

export function NicheRequestsAdmin() {
  const utils = trpc.useUtils();
  const { data: requests = [], isLoading } = trpc.nicheRequest.listAll.useQuery();
  const { data: archives = [] } = trpc.mediaArchive.listArchives.useQuery();
  const [filter, setFilter] = useState<string>("pending");

  const updateStatus = trpc.nicheRequest.updateStatus.useMutation({
    onSuccess: () => {
      utils.nicheRequest.listAll.invalidate();
      toast.success("Status updated");
    },
    onError: (e) => toast.error("Save failed", { description: toastErrorMessage(e) }),
  });

  const filtered = filter === "all" ? requests : requests.filter((r) => r.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-white">Niche requests</h2>
          <p className="text-sm text-slate-400">Approve, link archive, update status.</p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="all" className="bg-slate-900">All</option>
          {STATUSES.map((s) => (
            <option key={s} value={s} className="bg-slate-900">{NICHE_REQUEST_STATUS_LABELS[s]}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-purple-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="glass-card border border-white/8 rounded-xl p-8 text-center text-slate-500 text-sm">
          No requests in this filter.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <div key={r.id} className="glass-card border border-white/8 rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-white">
                    {r.requestType === "onboarding" ? "Onboarding" : "New channel"} — {r.nicheTitle}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {r.contactEmail ?? r.userEmail ?? "—"}
                    {r.userName ? ` · ${r.userName}` : ""}
                  </p>
                  {r.topics && (
                    <div className="mt-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Topics</p>
                      <p className="text-sm text-slate-400 whitespace-pre-wrap">{r.topics}</p>
                    </div>
                  )}
                  {r.subniches && (
                    <div className="mt-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Sub-niches</p>
                      <p className="text-sm text-slate-400 whitespace-pre-wrap">{r.subniches}</p>
                    </div>
                  )}
                  {r.titleStructure && (
                    <div className="mt-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Title structure</p>
                      <p className="text-sm text-slate-400 whitespace-pre-wrap">{r.titleStructure}</p>
                    </div>
                  )}
                  {!r.titleStructure && !r.topics && !r.subniches && r.description && (
                    <div className="mt-2">
                      <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">Notes</p>
                      <p className="text-sm text-slate-400 whitespace-pre-wrap">{r.description}</p>
                    </div>
                  )}
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-white/10 text-slate-300">
                  {NICHE_REQUEST_STATUS_LABELS[r.status]}
                </span>
              </div>

              <div className="flex flex-wrap gap-2">
                {STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    disabled={updateStatus.isPending || r.status === status}
                    onClick={() => updateStatus.mutate({ id: r.id, status })}
                    className={`text-xs px-2.5 py-1 rounded-md border transition-colors disabled:opacity-40 ${
                      r.status === status
                        ? "bg-purple-600/30 border-purple-500/50 text-white"
                        : "border-white/10 text-slate-400 hover:bg-white/5"
                    }`}
                  >
                    {status === "approved" && <Check className="w-3 h-3 inline mr-1" />}
                    {status === "rejected" && <X className="w-3 h-3 inline mr-1" />}
                    {NICHE_REQUEST_STATUS_LABELS[status]}
                  </button>
                ))}
              </div>

              {archives.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-slate-500">Link archive:</span>
                  <select
                    defaultValue={r.linkedArchiveId ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      updateStatus.mutate({
                        id: r.id,
                        status: r.status,
                        linkedArchiveId: Number(v),
                      });
                    }}
                    className="text-xs bg-white/5 border border-white/10 rounded px-2 py-1 text-white"
                  >
                    <option value="" className="bg-slate-900">—</option>
                    {archives.map((a) => (
                      <option key={a.id} value={a.id} className="bg-slate-900">{a.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
