/**
 * FASTVID — Home Landing Page
 * Design: Neon Gradient Studio — deep space navy, violet-to-cyan gradient, glassmorphism
 * Fonts: Outfit (display), Space Grotesk (body), JetBrains Mono (code/labels)
 * Language: English
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

// ─── Asset URLs ────────────────────────────────────────────────────────────────
const HERO_BG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-hero-bg-mWVG39EKHRHQLbpq3Vhb3L.webp";
const MOCKUP_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-mockup-i82oKf6TdBwMNMcNDTq5Vy.webp";
const SCRIPT_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-feature-script-JueTt4K7PbHkfqDhKoXwkv.webp";
const VISUALS_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-feature-visuals-YGMDS8Lz6mqFNsCHUYEQDS.webp";

// ─── Video length options ──────────────────────────────────────────────────────
const VIDEO_LENGTHS = [
  { label: "5–8 min", value: "5-8", desc: "Short & punchy", genTime: "~15 min" },
  { label: "8–12 min", value: "8-12", desc: "Perfect for tutorials", genTime: "~25 min" },
  { label: "12–15 min", value: "12-15", desc: "In-depth content", genTime: "~35 min" },
  { label: "15–20 min", value: "15-20", desc: "Extended videos", genTime: "~50 min" },
  { label: "20+ min", value: "20+", desc: "Long-form documentaries", genTime: "~75 min" },
];

// ─── Intersection Observer Hook ────────────────────────────────────────────────
function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); obs.disconnect(); } },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

// ─── FAQ Item ─────────────────────────────────────────────────────────────────
function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-card border border-white/8 overflow-hidden transition-all duration-300">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left gap-4"
      >
        <span className="font-semibold text-white text-sm md:text-base leading-snug">{q}</span>
        <ChevronDown
          className={`shrink-0 w-5 h-5 text-purple-400 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div className={`overflow-hidden transition-all duration-300 ${open ? "max-h-96" : "max-h-0"}`}>
        <p className="px-5 pb-5 text-sm text-slate-300 leading-relaxed">{a}</p>
      </div>
    </div>
  );
}

// ─── Step Card ────────────────────────────────────────────────────────────────
function StepCard({ number, icon: Icon, title, desc }: {
  number: string; icon: React.ElementType; title: string; desc: string;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={`glass-card gradient-border p-6 flex flex-col gap-4 transition-all duration-700 ${
        inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="mono text-xs font-medium text-purple-400/60">{number}</span>
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600/30 to-cyan-500/30 flex items-center justify-center border border-purple-500/20">
          <Icon className="w-5 h-5 text-purple-300" />
        </div>
      </div>
      <div>
        <h3 className="font-bold text-white text-lg mb-1">{title}</h3>
        <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

// ─── Stat Item ────────────────────────────────────────────────────────────────
function StatItem({ value, label, icon: Icon }: { value: string; label: string; icon: React.ElementType }) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={`flex flex-col items-center gap-2 transition-all duration-700 ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"}`}
    >
      <Icon className="w-6 h-6 text-cyan-400 mb-1" />
      <span className="font-black text-4xl md:text-5xl gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>{value}</span>
      <span className="text-sm text-slate-400 text-center">{label}</span>
    </div>
  );
}

// ─── Testimonial Card ─────────────────────────────────────────────────────────
function TestimonialCard({ name, role, text, stars }: { name: string; role: string; text: string; stars: number }) {
  return (
    <div className="glass-card gradient-border p-6 flex flex-col gap-4 min-w-[300px] max-w-[340px] shrink-0">
      <div className="flex gap-1">
        {Array.from({ length: stars }).map((_, i) => (
          <Star key={i} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
        ))}
      </div>
      <p className="text-sm text-slate-300 leading-relaxed">"{text}"</p>
      <div className="flex items-center gap-3 mt-auto">
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center text-white font-bold text-sm">
          {name[0]}
        </div>
        <div>
          <p className="text-sm font-semibold text-white">{name}</p>
          <p className="text-xs text-slate-500">{role}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Home() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [promptValue, setPromptValue] = useState("");
  const [selectedLength, setSelectedLength] = useState("15-20");
  const { isAuthenticated } = useAuth();
  const handleGetStarted = () => {
    if (isAuthenticated) { window.location.href = "/dashboard"; }
    else { window.location.href = getLoginUrl(); }
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    setMobileMenuOpen(false);
  };

  const activeLengthOption = VIDEO_LENGTHS.find((l) => l.value === selectedLength)!;

  const faqs = [
    {
      q: "Which video length should I choose?",
      a: "It depends on your niche and audience. Short videos (5–8 min) work great for quick tips and news. Mid-length videos (8–15 min) are ideal for tutorials and reviews. Long videos (15–20 min and 20+) perform best for in-depth analyses, documentaries, and educational content — and generate more watch time and ad revenue.",
    },
    {
      q: "How long does it take to generate a video?",
      a: "Generation time depends on the chosen video length. A 5–8 minute video is ready in ~15 minutes (12 scenes with AI images), while a 20+ minute video takes ~75 minutes (35 scenes). Each scene gets a unique Stability AI-generated image plus stock video clips. All scenes are processed in parallel for maximum speed.",
    },
    {
      q: "Can I change the video length for each video?",
      a: "Yes, absolutely. You choose the desired length per video with every generation. You're not locked into one length — you can create short videos for one channel and long documentaries for another.",
    },
    {
      q: "Can I edit the video after it's generated?",
      a: "Yes, every generated video comes with a fully editable project. You can adjust the script, regenerate the voiceover, swap visuals, and fine-tune effects through the built-in editor.",
    },
    {
      q: "Can I cancel my subscription at any time?",
      a: "Yes, you can cancel your subscription at any time. Your access remains active until the end of the current billing period. No questions asked.",
    },
    {
      q: "How are videos optimized for YouTube?",
      a: "Fastvid analyzes trending topics, optimal video lengths per niche, thumbnail styles, and SEO metadata. Scripts are written using proven viral structures: hook, build-up, climax, and call-to-action — all adapted to the chosen video length.",
    },
    {
      q: "What payment methods do you accept?",
      a: "We accept SEPA Direct Debit, Bancontact, PayPal, and all major credit cards (Visa, Mastercard, Amex).",
    },
    {
      q: "Are the videos 100% unique and copyright-free?",
      a: "Yes. Every script is uniquely generated based on your prompt. Visuals are sourced from royalty-free stock libraries or fully AI-generated. You own all rights to the produced videos.",
    },
    {
      q: "Can I add my own voice or branding?",
      a: "Absolutely. You can upload your own voice for cloning, set your logo and brand colors, and attach intro/outro templates to your channel.",
    },
  ];

  const steps = [
    {
      number: "01",
      icon: Sparkles,
      title: "Enter your prompt",
      desc: "Describe your video in one sentence and choose the desired length. Fastvid automatically understands your niche, audience, and tone.",
    },
    {
      number: "02",
      icon: FileText,
      title: "AI writes the script",
      desc: "A virally optimized script tailored to your chosen length — with a strong hook, build-up, and call-to-action.",
    },
    {
      number: "03",
      icon: Mic,
      title: "Professional voiceover",
      desc: "Choose from dozens of AI voices or clone your own. Smooth, natural, and perfectly timed to the edit.",
    },
    {
      number: "04",
      icon: Image,
      title: "Visuals & B-roll",
      desc: "AI matches every part of the script to fitting footage, stock video, and AI-generated visuals.",
    },
    {
      number: "05",
      icon: Wand2,
      title: "Effects & export",
      desc: "Automatic text overlays, transitions, music, and color grading. Ready to upload to YouTube.",
    },
  ];

  const testimonials = [
    {
      name: "James Carter",
      role: "YouTube creator — 180K subscribers",
      text: "I'm now producing 3x more videos in the same amount of time. The script quality is genuinely impressive — better than what I'd write myself.",
      stars: 5,
    },
    {
      name: "Sophie Williams",
      role: "Online entrepreneur",
      text: "My channel grew from 2K to 45K subscribers in 3 months. Fastvid is the best investment I've ever made for my business.",
      stars: 5,
    },
    {
      name: "Marcus Reid",
      role: "Content agency owner",
      text: "We're now producing 20+ videos per week for our clients. The ROI is insane. €500/month for unlimited videos is a no-brainer.",
      stars: 5,
    },
    {
      name: "Emma Thornton",
      role: "Educational YouTuber",
      text: "The voiceover sounds so natural that my viewers don't even realize it's AI. An incredible tool.",
      stars: 5,
    },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">

      {/* ── Navigation ── */}
      <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled ? "bg-background/80 backdrop-blur-xl border-b border-white/8" : "bg-transparent"
      }`}>
        <div className="container flex items-center justify-between h-16">
          <button onClick={() => scrollTo("hero")} className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-black text-xl text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </button>

          <div className="hidden md:flex items-center gap-8">
            {[["How it works", "how-it-works"], ["Features", "features"], ["Pricing", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
              <button key={id} onClick={() => scrollTo(id)} className="text-sm text-slate-400 hover:text-white transition-colors duration-200">
                {label}
              </button>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            <button onClick={handleGetStarted} className="text-sm text-slate-400 hover:text-white transition-colors">
              {isAuthenticated ? "Dashboard" : "Log in"}
            </button>
            <button onClick={handleGetStarted} className="btn-gradient px-4 py-2 rounded-lg text-sm font-semibold text-white">
              Get started
            </button>
          </div>

          <button className="md:hidden text-white p-1" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-background/95 backdrop-blur-xl border-b border-white/8 px-4 pb-4 flex flex-col gap-3">
            {[["How it works", "how-it-works"], ["Features", "features"], ["Pricing", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
              <button key={id} onClick={() => scrollTo(id)} className="text-sm text-slate-300 hover:text-white py-2 text-left transition-colors">
                {label}
              </button>
            ))}
            <button onClick={handleGetStarted} className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white mt-2">
                Get started
              </button>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section id="hero" className="relative min-h-screen flex items-center pt-16 overflow-hidden">
        <div className="absolute inset-0 bg-cover bg-center opacity-40" style={{ backgroundImage: `url(${HERO_BG})` }} />
        <div className="absolute inset-0 bg-gradient-to-br from-background via-background/80 to-background/60" />
        <div className="glow-orb w-96 h-96 bg-purple-600/20 top-20 -left-20 animate-orb-drift" />
        <div className="glow-orb w-80 h-80 bg-cyan-500/15 bottom-20 right-10 animate-orb-drift-slow" />

        <div className="container relative z-10 py-20">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left: Text */}
            <div className="flex flex-col gap-6">
              <div className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 w-fit">
                <Zap className="w-3.5 h-3.5 text-purple-400" />
                <span className="mono text-xs text-purple-300 font-medium">AI-powered YouTube automation</span>
              </div>

              <h1 className="animate-fade-up delay-100 text-4xl sm:text-5xl lg:text-6xl font-black leading-tight text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
                From prompt to{" "}
                <span className="gradient-text">viral YouTube video</span>{" "}
                in minutes
              </h1>

              <p className="animate-fade-up delay-200 text-base md:text-lg text-slate-300 leading-relaxed max-w-lg">
                Fastvid generates complete YouTube videos at your chosen length — including a viral script, professional voiceover, matching visuals, and cinematic effects. One prompt is all you need.
              </p>

              {/* Video length selector */}
              <div className="animate-fade-up delay-250 flex flex-col gap-2">
                <span className="mono text-xs text-slate-500 font-medium tracking-wide uppercase">Choose video length</span>
                <div className="flex flex-wrap gap-2">
                  {VIDEO_LENGTHS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSelectedLength(opt.value)}
                      className={`px-3 py-2 rounded-lg text-xs font-semibold border transition-all duration-200 flex flex-col items-center gap-0.5 min-w-[70px] ${
                        selectedLength === opt.value
                          ? "bg-gradient-to-br from-purple-600/40 to-cyan-500/30 border-purple-400/60 text-white shadow-lg shadow-purple-500/20"
                          : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200 bg-white/3"
                      }`}
                    >
                      <span className="font-bold">{opt.label}</span>
                      <span className={`text-[10px] font-normal ${selectedLength === opt.value ? "text-cyan-300" : "text-slate-600"}`}>
                        {opt.desc}
                      </span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-600 flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-cyan-500" />
                  Generation time for <span className="text-cyan-400 font-medium">{activeLengthOption.label}</span>: {activeLengthOption.genTime}
                </p>
              </div>

              {/* Prompt input */}
              <div className="animate-fade-up delay-300 prompt-input-wrapper flex items-center gap-2 p-2 pl-4">
                <input
                  type="text"
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  placeholder={`Create a ${activeLengthOption.label} video about...`}
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 outline-none"
                />
                <button
                  onClick={handleGetStarted}
                  className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-2 shrink-0"
                >
                  <Sparkles className="w-4 h-4" />
                  Generate
                </button>
              </div>

              {/* Trust signals */}
              <div className="animate-fade-up delay-400 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Unlimited videos</span>
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> All video lengths</span>
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Cancel anytime</span>
              </div>
            </div>

            {/* Right: Mockup */}
            <div className="animate-slide-in-right delay-300 relative">
              <div className="animate-float relative">
                <div className="absolute inset-0 bg-gradient-to-br from-purple-600/20 to-cyan-500/20 blur-3xl rounded-3xl" />
                <img
                  src={MOCKUP_IMG}
                  alt="Fastvid dashboard mockup"
                  className="relative rounded-2xl shadow-2xl shadow-purple-900/40 border border-white/10 w-full"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats ── */}
      <section className="relative py-16 border-y border-white/8">
        <div className="container">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-12">
            <StatItem value="5–20+" label="minutes — you choose the length" icon={Clock} />
            <StatItem value="∞" label="videos per month" icon={Infinity} />
            <StatItem value="5" label="length options to choose from" icon={Zap} />
            <StatItem value="3×" label="more views on average" icon={TrendingUp} />
          </div>
        </div>
      </section>

      {/* ── Video Length Detail ── */}
      <section className="relative py-20 overflow-hidden">
        <div className="glow-orb w-72 h-72 bg-cyan-500/8 top-0 right-0 animate-orb-drift-slow" />
        <div className="container relative z-10">
          <div className="text-center mb-12">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Flexible video length</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Choose the length that{" "}
              <span className="gradient-text">fits your niche</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Every video length has its own strategy. Fastvid automatically adapts the script structure, pacing, and editing to match the chosen duration.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {[
              {
                label: "5–8 min",
                value: "5-8",
                icon: "⚡",
                title: "Short & punchy",
                useCases: ["News & updates", "Quick tips", "Product reveals", "Trending topics"],
                genTime: "~15 min",
              },
              {
                label: "8–12 min",
                value: "8-12",
                icon: "🎯",
                title: "Perfect for tutorials",
                useCases: ["How-to videos", "Reviews", "Top 5 lists", "Vlog-style content"],
                genTime: "~25 min",
              },
              {
                label: "12–15 min",
                value: "12-15",
                icon: "📈",
                title: "In-depth content",
                useCases: ["Extended tutorials", "Case studies", "Comparisons", "Educational"],
                genTime: "~35 min",
              },
              {
                label: "15–20 min",
                value: "15-20",
                icon: "🎬",
                title: "Extended videos",
                useCases: ["Documentary-style", "Deep-dive analyses", "Interviews", "Storytelling"],
                genTime: "~50 min",
              },
              {
                label: "20+ min",
                value: "20+",
                icon: "🏆",
                title: "Long-form documentaries",
                useCases: ["Masterclasses", "Full courses", "Epic stories", "Deep dives"],
                genTime: "~75 min",
              },
            ].map((opt) => (
              <div
                key={opt.value}
                className={`glass-card p-5 flex flex-col gap-3 border transition-all duration-300 cursor-pointer ${
                  selectedLength === opt.value
                    ? "border-purple-400/50 bg-gradient-to-b from-purple-600/10 to-cyan-500/5 shadow-lg shadow-purple-500/10"
                    : "border-white/8 hover:border-white/15"
                }`}
                onClick={() => setSelectedLength(opt.value)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-2xl">{opt.icon}</span>
                  {selectedLength === opt.value && (
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                  )}
                </div>
                <div>
                  <span className="font-black text-white text-lg" style={{ fontFamily: 'Outfit, sans-serif' }}>{opt.label}</span>
                  <p className="text-xs text-slate-400 mt-0.5">{opt.title}</p>
                </div>
                <ul className="space-y-1">
                  {opt.useCases.map((uc) => (
                    <li key={uc} className="text-xs text-slate-500 flex items-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-cyan-500/60 shrink-0" />
                      {uc}
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-2 border-t border-white/6 flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-cyan-500" />
                  <span className="mono text-xs text-cyan-400">{opt.genTime} generation time</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section id="how-it-works" className="relative py-24 overflow-hidden">
        <div className="glow-orb w-72 h-72 bg-purple-600/10 top-10 right-0 animate-orb-drift" />
        <div className="container relative z-10">
          <div className="text-center mb-16">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">How it works</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              From idea to video in{" "}
              <span className="gradient-text">5 steps</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Fastvid automates the entire production process. You set the direction and length — the AI does the work.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {steps.map((step) => (
              <StepCard key={step.number} {...step} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section id="features" className="relative py-24 bg-gradient-to-b from-transparent via-purple-950/10 to-transparent overflow-hidden">
        <div className="glow-orb w-96 h-96 bg-cyan-500/8 bottom-0 left-0 animate-orb-drift-slow" />
        <div className="container relative z-10">
          <div className="text-center mb-16">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Features</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Everything you need for{" "}
              <span className="gradient-text">viral content</span>
            </h2>
          </div>

          <div className="space-y-16">
            {/* Row 1 */}
            <div className="grid lg:grid-cols-2 gap-8 items-center">
              <div className="order-2 lg:order-1 flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600/30 to-purple-400/20 flex items-center justify-center border border-purple-500/20">
                    <FileText className="w-5 h-5 text-purple-300" />
                  </div>
                  <span className="mono text-xs text-purple-400 font-medium">Script Engine</span>
                </div>
                <h3 className="text-2xl md:text-3xl font-bold text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
                  Scripts built to <span className="gradient-text">go viral</span>
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  Our AI writes scripts tailored to your chosen video length. Whether it's a quick 5-minute tip or an in-depth 20+ minute documentary — the structure, pacing, and hook are automatically adapted.
                </p>
                <ul className="space-y-2">
                  {["Virally optimized hooks for every length", "SEO-friendly titles & descriptions", "Automatic chapter structure", "Adjustable tone & style"].map((item) => (
                    <li key={item} className="flex items-center gap-2.5 text-sm text-slate-300">
                      <Check className="w-4 h-4 text-cyan-400 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="order-1 lg:order-2 relative">
                <div className="absolute inset-0 bg-gradient-to-br from-purple-600/15 to-cyan-500/10 blur-2xl rounded-2xl" />
                <img src={SCRIPT_IMG} alt="Script engine" className="relative rounded-2xl border border-white/10 shadow-xl w-full" />
              </div>
            </div>

            {/* Row 2 */}
            <div className="grid lg:grid-cols-2 gap-8 items-center">
              <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/15 to-purple-600/10 blur-2xl rounded-2xl" />
                <img src={VISUALS_IMG} alt="Visual matching" className="relative rounded-2xl border border-white/10 shadow-xl w-full" />
              </div>
              <div className="flex flex-col gap-5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-600/30 to-cyan-400/20 flex items-center justify-center border border-cyan-500/20">
                    <Image className="w-5 h-5 text-cyan-300" />
                  </div>
                  <span className="mono text-xs text-cyan-400 font-medium">Visual AI</span>
                </div>
                <h3 className="text-2xl md:text-3xl font-bold text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
                  Visuals that <span className="gradient-text">amplify</span>
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  Fastvid automatically matches every part of the script to the perfect visuals — regardless of video length. From stock footage and AI-generated imagery to animations and infographics.
                </p>
                <ul className="space-y-2">
                  {["Automatic B-roll matching", "AI-generated visuals", "Cinematic transitions", "Text overlays & lower thirds"].map((item) => (
                    <li key={item} className="flex items-center gap-2.5 text-sm text-slate-300">
                      <Check className="w-4 h-4 text-cyan-400 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Feature grid */}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { icon: Mic, title: "Voice Cloning", desc: "Upload your own voice and Fastvid clones it for all future videos. Fully authentic, every time.", color: "purple" },
                { icon: Wand2, title: "Auto Effects", desc: "Color grading, background music, sound effects, and cinematic filters are applied automatically.", color: "cyan" },
                { icon: TrendingUp, title: "Trend Analysis", desc: "Fastvid analyzes daily trending topics in your niche and suggests video ideas that are performing right now.", color: "purple" },
                { icon: Zap, title: "Fast Export", desc: "Export in 4K, 1080p, or optimized for YouTube Shorts. Ready to upload instantly.", color: "cyan" },
                { icon: FileText, title: "Multi-language", desc: "Generate videos in English, Dutch, German, French, and Spanish with native voiceovers.", color: "purple" },
                { icon: Sparkles, title: "Thumbnail AI", desc: "Auto-generated click-worthy thumbnails optimized for maximum CTR on YouTube.", color: "cyan" },
              ].map(({ icon: Icon, title, desc, color }) => (
                <div key={title} className="glass-card gradient-border p-5 flex flex-col gap-3 hover:bg-white/5 transition-colors duration-300">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${
                    color === "purple" ? "bg-purple-600/20 border-purple-500/20" : "bg-cyan-600/20 border-cyan-500/20"
                  }`}>
                    <Icon className={`w-4 h-4 ${color === "purple" ? "text-purple-300" : "text-cyan-300"}`} />
                  </div>
                  <h4 className="font-bold text-white text-sm">{title}</h4>
                  <p className="text-xs text-slate-400 leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="relative py-24 overflow-hidden">
        <div className="glow-orb w-96 h-96 bg-purple-600/15 top-0 left-1/2 -translate-x-1/2 animate-orb-drift" />
        <div className="container relative z-10">
          <div className="text-center mb-16">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Pricing</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              One plan. <span className="gradient-text">Unlimited everything.</span>
            </h2>
            <p className="text-slate-400 max-w-md mx-auto text-sm md:text-base">
              No hidden fees, no limits. All video lengths, unlimited videos, one fixed monthly price.
            </p>
          </div>

          <div className="max-w-lg mx-auto">
            <div className="relative gradient-border p-8 md:p-10 rounded-2xl">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                <span className="btn-gradient px-4 py-1.5 rounded-full text-xs font-bold text-white shadow-lg shadow-purple-500/30">
                  Most popular
                </span>
              </div>

              <div className="text-center mb-8">
                <h3 className="text-xl font-bold text-white mb-2" style={{ fontFamily: 'Outfit, sans-serif' }}>Pro Plan</h3>
                <div className="flex items-end justify-center gap-2 mb-1">
                  <span className="text-6xl font-black gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>€500</span>
                  <span className="text-slate-400 mb-3">/month</span>
                </div>
                <p className="text-xs text-slate-500">€500/month · Cancel anytime</p>
              </div>

              {/* All lengths included */}
              <div className="mb-6 p-4 rounded-xl bg-white/3 border border-white/8">
                <p className="text-xs text-slate-400 mb-3 font-medium">All video lengths included:</p>
                <div className="flex flex-wrap gap-2">
                  {VIDEO_LENGTHS.map((opt) => (
                    <span key={opt.value} className="px-2.5 py-1 rounded-lg bg-gradient-to-br from-purple-600/20 to-cyan-500/15 border border-purple-400/20 text-xs font-semibold text-white flex items-center gap-1">
                      <Check className="w-3 h-3 text-cyan-400" />
                      {opt.label}
                    </span>
                  ))}
                </div>
              </div>

              <ul className="space-y-3 mb-8">
                {[
                  "Unlimited video generation",
                  "All 5 video lengths (5–8, 8–12, 12–15, 15–20, 20+ min)",
                  "Virally optimized scripts",
                  "Professional AI voiceover",
                  "Automatic visual matching",
                  "Cinematic effects & transitions",
                  "AI thumbnail generator",
                  "Voice cloning (your own voice)",
                  "Multi-language support",
                  "4K export",
                  "Priority support",
                  "Trend analysis dashboard",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3 text-sm text-slate-200">
                    <div className="w-5 h-5 rounded-full bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center shrink-0">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                onClick={handleGetStarted}
                className="btn-gradient w-full py-4 rounded-xl font-bold text-white text-base flex items-center justify-center gap-2"
              >
                <Sparkles className="w-5 h-5" />
                Get started now
                <ArrowRight className="w-4 h-4" />
              </button>

              <p className="text-center text-xs text-slate-500 mt-4">
                Pay with SEPA, Bancontact, PayPal, or credit card.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="py-20 overflow-hidden">
        <div className="container mb-10">
          <div className="text-center">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Testimonials</span>
            <h2 className="text-3xl md:text-4xl font-black text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              What creators <span className="gradient-text">are saying</span>
            </h2>
          </div>
        </div>
        <div className="flex gap-5 overflow-x-auto pb-4 px-4 md:px-8 snap-x snap-mandatory">
          {testimonials.map((t) => (
            <div key={t.name} className="snap-start">
              <TestimonialCard {...t} />
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" className="relative py-24 overflow-hidden">
        <div className="glow-orb w-80 h-80 bg-cyan-500/8 bottom-10 right-0 animate-orb-drift-slow" />
        <div className="container relative z-10">
          <div className="text-center mb-14">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">FAQ</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Frequently asked <span className="gradient-text">questions</span>
            </h2>
          </div>
          <div className="max-w-2xl mx-auto space-y-3">
            {faqs.map((faq) => (
              <FAQItem key={faq.q} q={faq.q} a={faq.a} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section className="relative py-28 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-purple-950/40 via-background to-cyan-950/20" />
        <div className="glow-orb w-96 h-96 bg-purple-600/20 top-0 left-1/4 animate-orb-drift" />
        <div className="glow-orb w-80 h-80 bg-cyan-500/15 bottom-0 right-1/4 animate-orb-drift-slow" />
        <div className="container relative z-10 text-center">
          <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-4 block">Ready to start?</span>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-black text-white mb-6 leading-tight" style={{ fontFamily: 'Outfit, sans-serif' }}>
            Your first viral video<br />
            <span className="gradient-text">starts here</span>
          </h2>
          <p className="text-slate-300 max-w-lg mx-auto mb-10 text-base md:text-lg">
            Join hundreds of creators already generating videos daily with Fastvid. All lengths, unlimited, one flat price.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <button
              onClick={handleGetStarted}
              className="btn-gradient px-8 py-4 rounded-xl font-bold text-white text-base flex items-center justify-center gap-2 shadow-2xl shadow-purple-500/30"
            >
              <Sparkles className="w-5 h-5" />
              Get started now
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => scrollTo("how-it-works")}
              className="px-8 py-4 rounded-xl font-semibold text-white text-base border border-white/15 hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
            >
              <Play className="w-4 h-4" />
              Watch demo
            </button>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/8 py-10">
        <div className="container flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
              <Play className="w-3.5 h-3.5 text-white fill-white" />
            </div>
            <span className="font-black text-lg text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-6 text-xs text-slate-500">
            {["Privacy Policy", "Terms of Service", "Cookie Policy", "Contact"].map((item) => (
              <button key={item} className="hover:text-slate-300 transition-colors">{item}</button>
            ))}
          </div>
          <p className="text-xs text-slate-600">© 2025 Fastvid. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
