import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Play, Eye, EyeOff } from "lucide-react";

type Step = "choose" | "login" | "invite" | "register";

export default function Login() {
  const [, navigate] = useLocation();

  const [step, setStep] = useState<Step>("choose");
  const [showPassword, setShowPassword] = useState(false);

  // Login form
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  // Register form
  const [inviteCode, setInviteCode] = useState("");
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regPassword2, setRegPassword2] = useState("");

  const utils = trpc.useUtils();

  const validateCode = trpc.auth.validateInviteCode.useMutation({
    onSuccess: () => setStep("register"),
    onError: (e) => toast.error("Invalid code", { description: e.message }),
  });

  const register = trpc.auth.register.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      toast.success("Account created!", { description: "Welcome to Fastvid." });
      navigate("/dashboard");
    },
    onError: (e) => toast.error("Registration failed", { description: e.message }),
  });

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      navigate("/dashboard");
    },
    onError: (e) => toast.error("Login failed", { description: e.message }),
  });

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    loginMutation.mutate({ email: loginEmail, password: loginPassword });
  };

  const handleValidateCode = (e: React.FormEvent) => {
    e.preventDefault();
    validateCode.mutate({ code: inviteCode });
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (regPassword !== regPassword2) {
      toast.error("Passwords don't match");
      return;
    }
    register.mutate({ inviteCode, name: regName, email: regEmail, password: regPassword });
  };

  return (
    <div className="min-h-screen bg-[#0a0a1a] flex items-center justify-center p-4">
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-violet-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 w-[400px] h-[300px] bg-cyan-500/8 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-cyan-500 flex items-center justify-center">
            <Play className="w-4 h-4 text-white fill-white" />
          </div>
          <span className="text-2xl font-bold text-white tracking-tight">Fastvid</span>
        </div>

        {/* ── Step: Choose ── */}
        {step === "choose" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardHeader className="text-center">
              <CardTitle className="text-white text-xl">Welcome back</CardTitle>
              <CardDescription className="text-white/60">Sign in or create a new account</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                className="w-full bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white font-semibold"
                onClick={() => setStep("login")}
              >
                Sign in
              </Button>
              <Button
                variant="outline"
                className="w-full border-white/20 text-white hover:bg-white/10 bg-transparent"
                onClick={() => setStep("invite")}
              >
                Create account with invite code
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ── Step: Login ── */}
        {step === "login" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-white">Sign in</CardTitle>
              <CardDescription className="text-white/60">Enter your email and password</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-white/80">Email</Label>
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    required
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/40"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-white/80">Password</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      required
                      className="bg-white/10 border-white/20 text-white placeholder:text-white/40 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <Button
                  type="submit"
                  disabled={loginMutation.isPending}
                  className="w-full bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white font-semibold"
                >
                  {loginMutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing in...</> : "Sign in"}
                </Button>
                <button
                  type="button"
                  onClick={() => setStep("choose")}
                  className="w-full text-sm text-white/40 hover:text-white/70 text-center"
                >
                  ← Back
                </button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step: Invite code ── */}
        {step === "invite" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-white">Enter invite code</CardTitle>
              <CardDescription className="text-white/60">
                You need a valid invite code to create an account. Contact us to receive one.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleValidateCode} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-white/80">Invite code</Label>
                  <Input
                    placeholder="XXXX-XXXX-XXXX"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                    required
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/40 font-mono tracking-widest text-center text-lg"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={validateCode.isPending || !inviteCode}
                  className="w-full bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white font-semibold"
                >
                  {validateCode.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Checking...</> : "Continue"}
                </Button>
                <button
                  type="button"
                  onClick={() => setStep("choose")}
                  className="w-full text-sm text-white/40 hover:text-white/70 text-center"
                >
                  ← Back
                </button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ── Step: Register ── */}
        {step === "register" && (
          <Card className="bg-white/5 border-white/10 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-white">Create your account</CardTitle>
              <CardDescription className="text-white/60">
                Invite code <span className="text-cyan-400 font-mono">{inviteCode}</span> accepted ✓
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-1.5">
                  <Label className="text-white/80">Full name</Label>
                  <Input
                    placeholder="Your name"
                    value={regName}
                    onChange={(e) => setRegName(e.target.value)}
                    required
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/40"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-white/80">Email</Label>
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    required
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/40"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-white/80">Password (min. 8 characters)</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      required
                      minLength={8}
                      className="bg-white/10 border-white/20 text-white placeholder:text-white/40 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-white/80">Confirm password</Label>
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={regPassword2}
                    onChange={(e) => setRegPassword2(e.target.value)}
                    required
                    className="bg-white/10 border-white/20 text-white placeholder:text-white/40"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={register.isPending}
                  className="w-full bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white font-semibold"
                >
                  {register.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating account...</> : "Create account"}
                </Button>
                <button
                  type="button"
                  onClick={() => setStep("invite")}
                  className="w-full text-sm text-white/40 hover:text-white/70 text-center"
                >
                  ← Back
                </button>
              </form>
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
