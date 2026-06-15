import { Button } from "@/components/ui/button";
import { AlertCircle, Home, Play } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background text-foreground px-4">
      <div className="flex items-center gap-2.5 mb-10">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
          <Play className="w-5 h-5 text-white fill-white" />
        </div>
        <span className="font-black text-2xl text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
          Fast<span className="bg-gradient-to-r from-purple-400 to-cyan-400 bg-clip-text text-transparent">vid</span>
        </span>
      </div>

      <div className="w-full max-w-lg glass-card border border-white/10 rounded-2xl p-8 text-center">
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="absolute inset-0 bg-red-500/20 rounded-full animate-pulse" />
            <AlertCircle className="relative h-16 w-16 text-red-400" />
          </div>
        </div>

        <h1 className="text-4xl font-black text-white mb-2" style={{ fontFamily: "Outfit, sans-serif" }}>
          404
        </h1>

        <h2 className="text-xl font-semibold text-slate-300 mb-4">Page not found</h2>

        <p className="text-slate-400 mb-8 leading-relaxed text-sm">
          The page you are looking for does not exist or may have been moved.
        </p>

        <Button
          onClick={() => setLocation("/")}
          className="bg-gradient-to-r from-purple-600 to-cyan-500 hover:from-purple-500 hover:to-cyan-400 text-white px-6 py-2.5 rounded-xl shadow-lg shadow-purple-500/25"
        >
          <Home className="w-4 h-4 mr-2" />
          Go home
        </Button>
      </div>
    </div>
  );
}
