/**
 * FASTVID — Subscribe Page
 * Shown after registration when user has no active subscription.
 * Flow: Register → /subscribe → Stripe checkout → /dashboard?payment=success
 */
import { useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { trpc } from "@/lib/trpc";
import { toastErrorMessage } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Play, CheckCircle2, Loader2, CreditCard, Sparkles,
  Video, Mic, Wand2, Shield, Zap, Star,
} from "lucide-react";
import { FASTVID_PRO_PRICE_DISPLAY, FASTVID_PRO_PRICE_LABEL } from "@shared/billing";

const PLAN_FEATURES = [
  { icon: Video, text: "Unlimited video generation (all lengths)" },
  { icon: Sparkles, text: "Virally optimized AI scripts" },
  { icon: Mic, text: "Professional AI voiceover + voice cloning" },
  { icon: Wand2, text: "Automatic visual matching & cinematic effects" },
  { icon: Star, text: "AI thumbnail generator" },
  { icon: Shield, text: "Priority support" },
];

export default function Subscribe() {
  const { user, loading, isAuthenticated } = useAuth({ redirectOnUnauthenticated: true });
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const paymentStatus = params.get("payment");

  // If already subscribed (or admin), go straight to dashboard
  const userSub = (user as { subscriptionStatus?: string } | null)?.subscriptionStatus;
  const hasActiveSubscription = userSub === "active" || user?.role === "admin";

  useEffect(() => {
    if (!loading && isAuthenticated && hasActiveSubscription) {
      navigate("/dashboard");
    }
  }, [loading, isAuthenticated, hasActiveSubscription]);

  // Handle return from Stripe
  useEffect(() => {
    if (paymentStatus === "success") {
      toast.success("Payment successful!", {
        description: "Your subscription is being activated. This may take a moment.",
      });
    } else if (paymentStatus === "cancelled") {
      toast.info("Payment cancelled", {
        description: "You can subscribe whenever you're ready.",
      });
    }
  }, [paymentStatus]);

  const checkoutMutation = trpc.billing.createCheckout.useMutation({
    onSuccess: (data) => {
      if (data.url) {
        toast.info("Redirecting to checkout...", {
          description: "Opening Stripe payment page",
        });
        window.open(data.url, "_blank");
      }
    },
    onError: (err) => toast.error("Checkout failed", { description: toastErrorMessage(err) }),
  });

  const handleSubscribe = () => {
    checkoutMutation.mutate({ origin: window.location.origin });
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center px-4 py-16">
      {/* Logo */}
      <div className="flex items-center gap-2.5 mb-12">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
          <Play className="w-5 h-5 text-white fill-white" />
        </div>
        <span className="font-black text-2xl text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
          Fast<span className="bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">vid</span>
        </span>
      </div>

      {/* Card */}
      <div className="w-full max-w-md bg-white/5 border border-white/10 rounded-2xl p-8 shadow-2xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 bg-purple-600/20 border border-purple-500/30 rounded-full px-4 py-1.5 text-purple-300 text-sm font-medium mb-4">
            <Zap className="w-3.5 h-3.5" />
            Activate your account
          </div>
          <h1 className="text-3xl font-black text-white mb-2" style={{ fontFamily: "Outfit, sans-serif" }}>
            Fastvid Pro
          </h1>
          <div className="flex items-baseline justify-center gap-1 mb-2">
            <span className="text-5xl font-black text-white">{FASTVID_PRO_PRICE_DISPLAY}</span>
            <span className="text-white/50 text-lg">/month</span>
          </div>
          <p className="text-white/50 text-sm">
            Cancel anytime · Billed monthly
          </p>
        </div>

        {/* Features */}
        <ul className="space-y-3 mb-8">
          {PLAN_FEATURES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-white/80 text-sm">
              <div className="w-5 h-5 rounded-full bg-purple-600/30 flex items-center justify-center flex-shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5 text-purple-400" />
              </div>
              {text}
            </li>
          ))}
        </ul>

        {/* CTA */}
        <Button
          onClick={handleSubscribe}
          disabled={checkoutMutation.isPending}
          className="w-full h-12 bg-gradient-to-r from-purple-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 text-white font-bold text-base rounded-xl transition-all duration-200 shadow-lg shadow-purple-500/25"
        >
          {checkoutMutation.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Redirecting to Stripe...
            </>
          ) : (
            <>
              <CreditCard className="w-4 h-4 mr-2" />
              Subscribe now — {FASTVID_PRO_PRICE_LABEL}
            </>
          )}
        </Button>

        <p className="text-center text-white/30 text-xs mt-4">
          Secure payment via Stripe · iDEAL, SEPA, Bancontact, PayPal & card accepted
        </p>
      </div>

      {/* Already subscribed? */}
      {paymentStatus === "success" && (
        <div className="mt-6 text-center">
          <p className="text-white/50 text-sm mb-2">
            Payment confirmed — waiting for activation...
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="text-purple-400 hover:text-purple-300"
            onClick={() => navigate("/dashboard")}
          >
            Go to dashboard →
          </Button>
        </div>
      )}

      <p className="mt-8 text-white/30 text-xs text-center">
        Powered by Fastvid · Invite-only access
      </p>
    </div>
  );
}
