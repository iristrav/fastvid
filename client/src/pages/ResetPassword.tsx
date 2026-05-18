/**
 * Password Reset Page
 * Allows users to reset their password with a valid reset token
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, AlertCircle, CheckCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";

export default function ResetPassword() {
  const [, navigate] = useLocation();
  const [token, setToken] = useState<string>("");
  const [showPassword, setShowPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [step, setStep] = useState<"validating" | "reset" | "success" | "error">("validating");

  // Get token from URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token");
    if (!t) {
      setStep("error");
      toast.error("Invalid reset link", { description: "No token provided" });
      return;
    }
    setToken(t);
  }, []);

  // Validate token with useQuery hook
  const validateTokenQuery = trpc.auth.validateResetToken.useQuery(
    { token },
    { enabled: !!token, retry: false }
  );

  useEffect(() => {
    if (!token) return;
    if (validateTokenQuery.isLoading) {
      setStep("validating");
    } else if (validateTokenQuery.isSuccess) {
      setStep("reset");
    } else if (validateTokenQuery.isError) {
      setStep("error");
      const message = validateTokenQuery.error?.message || "Invalid or expired reset link";
      toast.error("Invalid reset link", { description: message });
    }
  }, [validateTokenQuery.isLoading, validateTokenQuery.isSuccess, validateTokenQuery.isError, token]);

  // Reset password mutation
  const resetMutation = trpc.auth.resetPassword.useMutation({
    onSuccess: () => {
      setStep("success");
      toast.success("Password reset successful!", { description: "Redirecting to dashboard..." });
      setTimeout(() => navigate("/dashboard"), 2000);
    },
    onError: (error) => {
      toast.error("Reset failed", { description: error.message });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match", { description: "Please enter the same password in both fields" });
      return;
    }

    if (newPassword.length < 8) {
      toast.error("Password too short", { description: "Password must be at least 8 characters" });
      return;
    }

    resetMutation.mutate({ token, newPassword });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-900 to-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Validating */}
        {step === "validating" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardContent className="pt-6 flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mb-4" />
              <p className="text-white/80">Validating reset link...</p>
            </CardContent>
          </Card>
        )}

        {/* Reset Form */}
        {step === "reset" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-white">Create new password</CardTitle>
              <CardDescription className="text-white/60">
                Enter a new password for your account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-white/80">New Password</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      className="bg-white/10 border-white/20 text-white placeholder:text-white/40 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-xs text-white/50">At least 8 characters</p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-white/80">Confirm Password</Label>
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/40"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={resetMutation.isPending || !newPassword || !confirmPassword}
                  className="w-full bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white font-semibold"
                >
                  {resetMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Resetting password...
                    </>
                  ) : (
                    "Reset password"
                  )}
                </Button>

                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="w-full text-sm text-white/40 hover:text-white/70 text-center"
                >
                  ← Back to login
                </button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Success */}
        {step === "success" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardContent className="pt-6 flex flex-col items-center justify-center py-12">
              <CheckCircle className="w-12 h-12 text-green-400 mb-4" />
              <h3 className="text-white font-semibold mb-2">Password reset successful!</h3>
              <p className="text-white/60 text-sm text-center">Redirecting to dashboard...</p>
            </CardContent>
          </Card>
        )}

        {/* Error */}
        {step === "error" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardContent className="pt-6 flex flex-col items-center justify-center py-12">
              <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
              <h3 className="text-white font-semibold mb-2">Invalid reset link</h3>
              <p className="text-white/60 text-sm text-center mb-6">
                This link is invalid or has expired. Please request a new one.
              </p>
              <Button
                onClick={() => navigate("/login")}
                className="w-full bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white font-semibold"
              >
                Back to login
              </Button>
            </CardContent>
          </Card>
        )}

        <p className="text-center text-white/30 text-xs mt-6">
          Powered by Fastvid · Invite-only access
        </p>
      </div>
    </div>
  );
}
