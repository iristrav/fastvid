/**
 * FASTVID — Admin ▸ Users ▸ edit a user (RONDE 147)
 *
 * ── What this replaces ───────────────────────────────────────────────────────────────────────
 *
 * The users table offered one role action, "Make Admin", and it only went one way: there was no
 * route back from admin to user anywhere in the product. Combined with the server's refusal to let
 * an admin demote themselves, a mistaken promotion was permanent without hand-written SQL.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────────────────────
 *
 * It edits the fields the user model actually has — `role` and `subscriptionStatus` — through the
 * two mutations that already exist. It is not a generic column editor: the brief rules that out,
 * and a form that can write any field is a form that can write `stripeCustomerId` by accident.
 * Everything else about the account is shown read-only, because seeing it is what an admin needs
 * (which login method, when they last signed in, whether Stripe knows them) and changing it from
 * here would desynchronise FastVid from Stripe.
 *
 * Only what actually changed is sent, so opening the dialog and pressing Save writes nothing.
 */
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, Shield, AlertTriangle } from "lucide-react";

export type EditableUser = {
  id: number;
  name: string | null;
  email: string | null;
  role: "user" | "admin" | string;
  subscriptionStatus?: string | null;
  loginMethod?: string | null;
  stripeCustomerId?: string | null;
  subscriptionStartDate?: string | Date | null;
  subscriptionEndDate?: string | Date | null;
  createdAt: string | Date;
  lastSignedIn?: string | Date | null;
};

type Role = "user" | "admin";
type SubscriptionStatus = "active" | "inactive" | "cancelled";

const SUBSCRIPTION_VALUES: SubscriptionStatus[] = ["active", "inactive", "cancelled"];

function formatMoment(value: string | Date | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-slate-500 font-medium uppercase tracking-wide block mb-0.5">{label}</span>
      <span className="text-sm text-slate-200 break-all">{value}</span>
    </div>
  );
}

export function EditUserDialog({
  user,
  currentUserId,
  onClose,
  onSaved,
}: {
  user: EditableUser;
  /** The signed-in admin, so the dialog can refuse the self-demotion the server also refuses. */
  currentUserId: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<Role>(user.role === "admin" ? "admin" : "user");
  const [subscription, setSubscription] = useState<SubscriptionStatus>(
    (SUBSCRIPTION_VALUES as string[]).includes(user.subscriptionStatus ?? "")
      ? (user.subscriptionStatus as SubscriptionStatus)
      : "inactive"
  );
  const [saving, setSaving] = useState(false);

  // A different row can be opened without unmounting the dialog; re-seed the form when it is.
  useEffect(() => {
    setRole(user.role === "admin" ? "admin" : "user");
    setSubscription(
      (SUBSCRIPTION_VALUES as string[]).includes(user.subscriptionStatus ?? "")
        ? (user.subscriptionStatus as SubscriptionStatus)
        : "inactive"
    );
  }, [user.id, user.role, user.subscriptionStatus]);

  const roleMutation = trpc.admin.updateUserRole.useMutation();
  const subMutation = trpc.admin.updateUserSubscription.useMutation();

  const isSelf = currentUserId != null && currentUserId === user.id;
  const wouldDemoteSelf = isSelf && user.role === "admin" && role !== "admin";
  const roleChanged = role !== (user.role === "admin" ? "admin" : "user");
  const subscriptionChanged = subscription !== (user.subscriptionStatus ?? "inactive");
  const dirty = roleChanged || subscriptionChanged;

  async function save() {
    if (!dirty || wouldDemoteSelf) return;
    setSaving(true);
    try {
      // Only what changed. Firing both every time would write a subscription row for a pure role
      // change, which shows up in the audit as a subscription event that never happened.
      if (roleChanged) await roleMutation.mutateAsync({ userId: user.id, role });
      if (subscriptionChanged) {
        await subMutation.mutateAsync({ userId: user.id, subscriptionStatus: subscription });
      }
      toast.success("User updated", { description: user.email ?? `User ${user.id}` });
      onSaved();
      onClose();
    } catch (err) {
      toast.error("Could not save changes", { description: toastErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const selectClass =
    "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-400/60";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg bg-slate-900 border border-white/15 text-white">
        <DialogHeader className="border-b border-white/8 pb-4">
          <DialogTitle className="flex items-center gap-2 text-white">
            <Shield className="w-5 h-5 text-purple-400" />
            Edit user
          </DialogTitle>
          <p className="text-sm text-slate-400 mt-1">
            {user.name ?? "Unknown"} &middot; {user.email ?? "no email"}
          </p>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-slate-500 font-medium uppercase tracking-wide block mb-1.5" htmlFor="edit-user-role">
                Role
              </label>
              <select
                id="edit-user-role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className={selectClass}
                disabled={isSelf && user.role === "admin"}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-slate-500 font-medium uppercase tracking-wide block mb-1.5" htmlFor="edit-user-subscription">
                Subscription
              </label>
              <select
                id="edit-user-subscription"
                value={subscription}
                onChange={(e) => setSubscription(e.target.value as SubscriptionStatus)}
                className={selectClass}
              >
                {SUBSCRIPTION_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {value.charAt(0).toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {isSelf && user.role === "admin" && (
            <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                This is your own account. You cannot remove your own admin role — another admin has
                to do it, so the last admin cannot lock everyone out.
              </span>
            </div>
          )}

          {/*
            Read-only below. An admin needs to SEE these to answer "who is this and can they sign
            in"; changing them from here would either desynchronise FastVid from Stripe or invent
            fields the user model does not have.
          */}
          <div className="grid grid-cols-2 gap-4 pt-2 border-t border-white/8">
            <Field label="User ID" value={String(user.id)} />
            <Field label="Login method" value={user.loginMethod ?? "—"} />
            <Field label="Joined" value={formatMoment(user.createdAt)} />
            <Field label="Last signed in" value={formatMoment(user.lastSignedIn)} />
            <Field label="Subscription start" value={formatMoment(user.subscriptionStartDate)} />
            <Field label="Subscription end" value={formatMoment(user.subscriptionEndDate)} />
            <div className="col-span-2">
              <Field label="Stripe customer" value={user.stripeCustomerId ?? "—"} />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-white/8 pt-4 gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 border border-white/10 hover:bg-white/5 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving || wouldDemoteSelf}
            className="btn-gradient px-5 py-2 rounded-lg font-bold text-white text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save changes
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
