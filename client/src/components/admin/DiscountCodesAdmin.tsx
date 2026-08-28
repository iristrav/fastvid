/**
 * FASTVID — Admin ▸ Discount Codes (RONDE 147)
 *
 * The codes managed here are real Stripe promotion codes, not a FastVid-only concept. Checkout
 * already renders Stripe's promotion-code box (`allow_promotion_codes: true` in
 * billing.createCheckout), so anything created on this page is redeemable by a customer the moment
 * it is saved — and anything switched off here stops working at checkout immediately.
 *
 * Two consequences shape the UI:
 *
 *  · A code's discount is immutable. Stripe coupons cannot be re-priced, so the form creates and
 *    the table only toggles, annotates and (when safe) deletes. Changing 25% to 30% means issuing
 *    a new code, which is also how it works in Stripe's own dashboard.
 *  · Redemption counts are Stripe's number, refreshed on load. They are shown as "used / max" so
 *    an exhausted code is visible at a glance rather than needing arithmetic.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import {
  Ticket, Plus, Loader2, RefreshCw, ToggleLeft, ToggleRight, Trash2, Check, X,
} from "lucide-react";

type DiscountKind = "percent" | "amount";

function formatDiscount(row: { percentOff: number | null; amountOffCents: number | null; currency: string | null }) {
  if (row.percentOff != null) return `${row.percentOff}%`;
  if (row.amountOffCents != null) {
    const amount = (row.amountOffCents / 100).toFixed(2);
    return `${(row.currency ?? "usd").toUpperCase()} ${amount}`;
  }
  return "—";
}

function formatUsage(row: { timesRedeemed: number; maxRedemptions: number | null }) {
  return row.maxRedemptions == null
    ? String(row.timesRedeemed)
    : `${row.timesRedeemed} / ${row.maxRedemptions}`;
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function CreateCodeForm({ onCreated }: { onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<DiscountKind>("percent");
  const [percentOff, setPercentOff] = useState("25");
  const [amountOff, setAmountOff] = useState("50");
  const [expiresAt, setExpiresAt] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [note, setNote] = useState("");

  const createMutation = trpc.discount.create.useMutation({
    onSuccess: (res) => {
      toast.success(`${res.code} created`, { description: "Customers can use it at checkout now." });
      setCode("");
      setNote("");
      setMaxRedemptions("");
      setExpiresAt("");
      setStartsAt("");
      onCreated();
    },
    onError: (err) => toast.error("Could not create code", { description: toastErrorMessage(err) }),
  });

  const submit = () => {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 3) {
      toast.error("Give the code at least 3 characters");
      return;
    }
    const percent = parseInt(percentOff, 10);
    const amount = Math.round(parseFloat(amountOff) * 100);
    if (kind === "percent" && (!Number.isFinite(percent) || percent < 1 || percent > 100)) {
      toast.error("The percentage must be between 1 and 100");
      return;
    }
    if (kind === "amount" && (!Number.isFinite(amount) || amount < 1)) {
      toast.error("The amount must be greater than zero");
      return;
    }
    const max = maxRedemptions.trim() ? parseInt(maxRedemptions, 10) : undefined;
    if (max !== undefined && (!Number.isFinite(max) || max < 1)) {
      toast.error("The usage limit must be a whole number of 1 or more");
      return;
    }
    createMutation.mutate({
      code: trimmed,
      ...(kind === "percent" ? { percentOff: percent } : { amountOffCents: amount }),
      ...(startsAt ? { startsAt: new Date(startsAt) } : {}),
      ...(expiresAt ? { expiresAt: new Date(expiresAt) } : {}),
      ...(max !== undefined ? { maxRedemptions: max } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
  };

  const inputClass =
    "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-purple-400/60";
  const labelClass = "text-xs text-slate-500 font-medium uppercase tracking-wide mb-1.5 block";

  return (
    <div className="glass-card border border-white/8 rounded-xl p-5 mb-6">
      <h3 className="font-bold text-white text-sm mb-4 flex items-center gap-2">
        <Plus className="w-4 h-4 text-purple-400" /> New discount code
      </h3>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="discount-code">Code</label>
          <input
            id="discount-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="FASTVID25"
            className={`${inputClass} mono tracking-wider`}
          />
        </div>

        <div>
          <span className={labelClass}>Discount type</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setKind("percent")}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                kind === "percent"
                  ? "bg-purple-600/25 border-purple-400/60 text-white"
                  : "border-white/10 text-slate-400 hover:text-white"
              }`}
            >
              Percentage
            </button>
            <button
              type="button"
              onClick={() => setKind("amount")}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors ${
                kind === "amount"
                  ? "bg-purple-600/25 border-purple-400/60 text-white"
                  : "border-white/10 text-slate-400 hover:text-white"
              }`}
            >
              Fixed amount
            </button>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="discount-value">
            {kind === "percent" ? "Percentage off" : "Amount off (USD)"}
          </label>
          <input
            id="discount-value"
            type="number"
            min={1}
            max={kind === "percent" ? 100 : undefined}
            value={kind === "percent" ? percentOff : amountOff}
            onChange={(e) => (kind === "percent" ? setPercentOff(e.target.value) : setAmountOff(e.target.value))}
            className={inputClass}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="discount-starts">Start date (optional)</label>
          <input id="discount-starts" type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className={labelClass} htmlFor="discount-expires">Expiry date (optional)</label>
          <input id="discount-expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={inputClass} />
        </div>

        <div>
          <label className={labelClass} htmlFor="discount-max">Usage limit (optional)</label>
          <input
            id="discount-max"
            type="number"
            min={1}
            value={maxRedemptions}
            onChange={(e) => setMaxRedemptions(e.target.value)}
            placeholder="Unlimited"
            className={inputClass}
          />
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label className={labelClass} htmlFor="discount-note">Internal note (optional)</label>
          <input
            id="discount-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What this code is for — never shown to customers"
            className={inputClass}
          />
        </div>
      </div>

      <button
        onClick={submit}
        disabled={createMutation.isPending}
        className="btn-gradient mt-4 px-5 py-2.5 rounded-lg font-bold text-white text-sm flex items-center gap-2 disabled:opacity-60"
      >
        {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        Create code
      </button>
    </div>
  );
}

export function DiscountCodesAdmin() {
  const { data: codes, isLoading, refetch, isRefetching } = trpc.discount.list.useQuery();
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const setActiveMutation = trpc.discount.setActive.useMutation({
    onSuccess: () => { toast.success("Discount code updated"); refetch(); },
    onError: (err) => toast.error("Could not update code", { description: toastErrorMessage(err) }),
  });
  const updateMutation = trpc.discount.update.useMutation({
    onSuccess: () => { toast.success("Note saved"); setEditingNoteId(null); refetch(); },
    onError: (err) => toast.error("Could not save note", { description: toastErrorMessage(err) }),
  });
  const removeMutation = trpc.discount.remove.useMutation({
    onSuccess: () => { toast.success("Discount code deleted"); refetch(); },
    onError: (err) => toast.error("Could not delete code", { description: toastErrorMessage(err) }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-bold text-white text-lg flex items-center gap-2">
          <Ticket className="w-5 h-5 text-purple-400" /> Discount Codes ({codes?.length ?? 0})
        </h2>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors px-2 py-1 rounded-md hover:bg-white/5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <p className="text-xs text-slate-500 mb-5 max-w-2xl leading-relaxed">
        These are live Stripe promotion codes. A customer can enter them in the promotion-code field
        at checkout as soon as they are created, and deactivating one stops it working immediately.
        A code&rsquo;s discount cannot be changed after it exists — issue a new code instead.
      </p>

      <CreateCodeForm onCreated={() => refetch()} />

      <div className="glass-card border border-white/8 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/8 text-xs text-slate-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">Code</th>
                <th className="text-left px-4 py-3">Discount</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Used</th>
                <th className="text-left px-4 py-3">Starts</th>
                <th className="text-left px-4 py-3">Expires</th>
                <th className="text-left px-4 py-3">Note</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {codes?.map((row) => (
                <tr key={row.id} className="border-b border-white/5 hover:bg-white/3 transition-colors">
                  <td className="px-4 py-3">
                    <span className="mono text-xs font-bold text-white tracking-wider">{row.code}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-cyan-300 font-semibold tabular-nums">
                    {formatDiscount(row)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-0.5 rounded-md text-xs font-medium border ${
                        row.isActive
                          ? "text-green-300 bg-green-500/10 border-green-500/20"
                          : "text-slate-400 bg-white/5 border-white/8"
                      }`}
                    >
                      {row.isActive ? "ACTIVE" : "INACTIVE"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-300 tabular-nums">{formatUsage(row)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(row.startsAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{formatDate(row.expiresAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-400 max-w-[220px]">
                    {editingNoteId === row.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-400/60"
                          aria-label={`Note for ${row.code}`}
                        />
                        <button
                          onClick={() => updateMutation.mutate({ id: row.id, note: noteDraft.trim() || null })}
                          className="text-green-400 hover:text-green-300 p-1"
                          aria-label="Save note"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setEditingNoteId(null)}
                          className="text-slate-500 hover:text-white p-1"
                          aria-label="Cancel"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditingNoteId(row.id); setNoteDraft(row.note ?? ""); }}
                        className="text-left hover:text-white transition-colors truncate w-full"
                      >
                        {row.note || <span className="text-slate-600">Add note</span>}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => setActiveMutation.mutate({ id: row.id, isActive: !row.isActive })}
                        className={`flex items-center gap-1 text-xs transition-colors px-2 py-1 rounded-md ${
                          row.isActive
                            ? "text-amber-400 hover:text-amber-300 hover:bg-amber-400/10"
                            : "text-green-400 hover:text-green-300 hover:bg-green-400/10"
                        }`}
                      >
                        {row.isActive ? <ToggleLeft className="w-3.5 h-3.5" /> : <ToggleRight className="w-3.5 h-3.5" />}
                        {row.isActive ? "Deactivate" : "Activate"}
                      </button>
                      {/*
                        Only offered for a code nobody has used. A redeemed code is part of a
                        customer's billing history — the server refuses the delete, so hiding the
                        button here just avoids offering an action that cannot succeed.
                      */}
                      {row.timesRedeemed === 0 && (
                        <button
                          onClick={() => removeMutation.mutate({ id: row.id })}
                          className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors px-2 py-1 rounded-md hover:bg-red-400/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {(!codes || codes.length === 0) && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500 text-sm">
                    No discount codes yet — create one above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
