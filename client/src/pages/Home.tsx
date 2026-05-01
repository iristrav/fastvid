/**
 * FASTVID — Home Landing Page
 */

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { getLoginUrl } from "@/const";
import {
  Play,
  Sparkles,
  FileText,
  Mic,
  Image,
  Wand2,
  ChevronDown,
  Check,
  Star,
  ArrowRight,
  Zap,
  Clock,
  Infinity,
  TrendingUp,
  Menu,
  X,
} from "lucide-react";

const VIDEO_LENGTHS = [
  { label: "5–8 min", value: "5-8", desc: "Short & punchy", genTime: "~15 min" },
  { label: "8–12 min", value: "8-12", desc: "Perfect for tutorials", genTime: "~25 min" },
  { label: "12–15 min", value: "12-15", desc: "In-depth content", genTime: "~35 min" },
  { label: "15–20 min", value: "15-20", desc: "Extended videos", genTime: "~50 min" },
  { label: "20+ min", value: "20+", desc: "Long-form documentaries", genTime: "~75 min" },
];

export default function Home() {
  const [selectedLength, setSelectedLength] = useState("15-20");
  const { isAuthenticated } = useAuth();

  const handleGetStarted = () => {
    if (isAuthenticated) {
      window.location.href = "/dashboard";
    } else {
      window.location.href = getLoginUrl();
    }
  };
    return (
    <div className="min-h-screen bg-background text-white">

      {/* HERO */}
      <section className="py-32 text-center px-6">
        <h1 className="text-5xl font-black mb-6">
          Fast<span className="text-purple-400">vid</span>
        </h1>

        <p className="text-slate-400 max-w-xl mx-auto mb-8">
          Generate complete YouTube videos from one prompt.
        </p>

        <div className="flex justify-center gap-2 mb-6 flex-wrap">
          {VIDEO_LENGTHS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setSelectedLength(opt.value)}
              className={`px-3 py-2 rounded-lg text-xs ${
                selectedLength === opt.value
                  ? "bg-purple-600 text-white"
                  : "bg-white/5 text-slate-400"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <button
          onClick={handleGetStarted}
          className="px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 font-bold flex items-center gap-2 mx-auto"
        >
          <Sparkles className="w-5 h-5" />
          Get started
          <ArrowRight className="w-4 h-4" />
        </button>
      </section>
            {/* PRICING */}
      <section className="py-24 flex justify-center">
        <div className="border border-white/10 rounded-2xl p-10 max-w-md w-full text-center">

          <h2 className="text-2xl font-bold mb-4">Pro Plan</h2>

          {/* ✅ PRIJS AANGEPAST */}
          <div className="text-6xl font-black text-purple-400 mb-2">
            €499
          </div>

          <p className="text-slate-400 mb-6">€499/month · Cancel anytime</p>

          <ul className="text-left space-y-2 mb-8 text-slate-300">
            <li>✔ Unlimited video generation</li>
            <li>✔ All video lengths</li>
            <li>✔ AI voiceover</li>
            <li>✔ Visual generation</li>
          </ul>

          <button
            onClick={handleGetStarted}
            className="w-full px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-500 font-bold flex items-center justify-center gap-2"
          >
            <Sparkles className="w-5 h-5" />
            Get started
          </button>

        </div>
      </section>

      {/* FOOTER */}
      <footer className="py-10 text-center text-xs text-slate-500">
        © 2025 Fastvid. All rights reserved.
      </footer>

    </div>
  );
}
