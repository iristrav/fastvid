/**
 * FASTVID — Home Landing Page
 * Design: Neon Gradient Studio — deep space navy, violet-to-cyan gradient, glassmorphism
 * Fonts: Outfit (display), Space Grotesk (body), JetBrains Mono (code/labels)
 * Language: English
 */

import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { LEGAL_FOOTER_LINKS } from "@/components/LegalPageShell";
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
  Cloud,
  Film,
  ListOrdered,
  Edit3,
  Search,
  Menu,
  X,
  MessageCircle,
  CalendarDays,
} from "lucide-react";

/** Set VITE_DISCORD_INVITE_URL in Railway / .env (e.g. https://discord.gg/your-invite) */
const DISCORD_INVITE_URL = (import.meta.env.VITE_DISCORD_INVITE_URL as string | undefined)?.trim() ?? "";

// ─── Asset URLs ────────────────────────────────────────────────────────────────
const HERO_BG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-hero-bg-mWVG39EKHRHQLbpq3Vhb3L.webp";
const MOCKUP_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-mockup-i82oKf6TdBwMNMcNDTq5Vy.webp";
const SCRIPT_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-feature-script-JueTt4K7PbHkfqDhKoXwkv.webp";
const VISUALS_IMG = "https://d2xsxph8kpxj0f.cloudfront.net/310519663314427713/B9GyrhcpQX4Q32cZzpFMG9/fastvid-feature-visuals-YGMDS8Lz6mqFNsCHUYEQDS.webp";

import { VIDEO_LENGTH_OPTIONS } from "@shared/videoLengths";

const VIDEO_LENGTHS = VIDEO_LENGTH_OPTIONS;

const VIDEO_FORMATS = [
  {
    id: "documentary",
    title: "Documentary",
    desc: "One flowing story with narration and script-matched B-roll — history, true crime, biographies, news analysis, and explainers.",
    available: true,
  },
  {
    id: "listicle",
    title: "Top 10 Listicle",
    desc: "Countdown format with structured beats per item — comparisons, rankings, and list-style channels.",
    available: false,
  },
] as const;

const BEST_FOR_NICHES = [
  "History & geopolitics",
  "True crime & mysteries",
  "Biographies & business",
  "Science & nature",
  "News & current events",
  "Educational explainers",
];

const WORKFLOW_STEPS = [
  {
    number: "01",
    icon: FileText,
    title: "Write your brief",
    desc: "Describe your topic in one prompt — or paste your own script. Pick documentary length and tone.",
  },
  {
    number: "02",
    icon: Cloud,
    title: "Fastvid builds the video",
    desc: "AI writes the script, records voiceover, finds real and stock visuals matched to each beat, and assembles everything in the cloud.",
  },
  {
    number: "03",
    icon: Edit3,
    title: "Review & publish",
    desc: "Open the built-in editor to swap clips, adjust pacing, then export a YouTube-ready MP4.",
  },
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
  const [, navigate] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [promptValue, setPromptValue] = useState("");
  const [selectedLength, setSelectedLength] = useState("8-10");

  const { isAuthenticated } = useAuth();

  // 👉 Generate knop (met prompt + length)
  const handleGenerate = () => {
  if (isAuthenticated) {
    navigate(`/dashboard?prompt=${encodeURIComponent(promptValue)}&length=${selectedLength}`);
  } else {
    navigate(`/login?prompt=${encodeURIComponent(promptValue)}&length=${selectedLength}`);
  }
};

  // 👉 Overige knoppen (zonder prompt)
 const handleGetStarted = () => {
  if (isAuthenticated) {
    navigate("/dashboard");
  } else {
    navigate("/login");
  }
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
      q: "How is Fastvid different from generic AI video tools?",
      a: "Fastvid is built for factual, narrator-led YouTube content — documentaries, explainers, and analysis channels. Scripts drive every visual beat; we prioritize real footage (including Creative Commons sources) and licensed stock over random B-roll.",
    },
    {
      q: "Which video length should I choose?",
      a: "Match length to how much story you have: 1 min to test a topic, 8–10 min for standard documentaries, 10–15 min for deep dives, and 15–20 min for extended narratives. Fastvid adapts pacing and scene count automatically.",
    },
    {
      q: "How long does generation take?",
      a: "A 1 min test often finishes in a few minutes. A typical 8–10 minute documentary usually takes roughly 30–60 minutes in the cloud — you can leave the tab open or return when the project is ready.",
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
      a: "We accept all major credit cards (Visa, Mastercard, Amex), Apple Pay, Google Pay, and PayPal.",
    },
    {
      q: "Are the videos unique and safe to upload?",
      a: "Every script is generated for your prompt. Visuals come from licensed stock, Creative Commons YouTube clips (where available), and curated image sources — with transformative editing. You are responsible for final review before publishing.",
    },
    {
      q: "Can I add my own voice or branding?",
      a: "Absolutely. You can upload your own voice for cloning, set your logo and brand colors, and attach intro/outro templates to your channel.",
    },
    {
      q: "How do I get access after signing up?",
      a: "After your invite code, register and submit your niche, email, and content format (title structure and topics) on the application page. We review within 2 business days. Once approved, you can activate your subscription and start generating within 24 hours.",
    },
    {
      q: "What if there is no footage in the archive for my topic?",
      a: "If your niche archive is still being built, generation may take longer. Fastvid will tell you when footage for your topic is limited and continues expanding the archive in the background.",
    },
    {
      q: "What do I get in the Fastvid Discord?",
      a: "Members receive a curated, high-potential YouTube niche pick every week — plus updates, tips, and support from other documentary creators. Join via the Community section on this page.",
    },
  ];

  const productionSteps = [
    {
      number: "01",
      icon: Sparkles,
      title: "Read your prompt",
      desc: "Topic, length, and tone are taken from your idea — the starting point for everything.",
    },
    {
      number: "02",
      icon: FileText,
      title: "Professional script",
      desc: "Documentary narration — visuals are matched automatically from your spoken words.",
    },
    {
      number: "03",
      icon: Mic,
      title: "Full script in ElevenLabs",
      desc: "One continuous voiceover for the entire script, then split per scene for perfect sync.",
    },
    {
      number: "04",
      icon: Edit3,
      title: "Voiceover in the editor",
      desc: "Scenes and timing land in the edit system before visuals are fetched.",
    },
    {
      number: "05",
      icon: Search,
      title: "One image per sentence",
      desc: "For each line we pick the most important word and search stock, B-roll, or real footage.",
    },
    {
      number: "06",
      icon: Film,
      title: "Whole video covered",
      desc: "Every scene and beat gets a clip — no grey placeholders, no duplicate shots.",
    },
    {
      number: "07",
      icon: ListOrdered,
      title: "Stitch it together",
      desc: "Scenes are concatenated with documentary music and chapter-ready structure.",
    },
    {
      number: "08",
      icon: Wand2,
      title: "Effects & transitions",
      desc: "Montage, color grade, audio fades, and smooth cuts for a broadcast finish.",
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
      text: "We're now producing 20+ videos per week for our clients. The ROI is insane. $499/month for unlimited videos is a no-brainer.",
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
            {[["How it works", "how-it-works"], ["Formats", "formats"], ["Community", "community"], ["Features", "features"], ["Pricing", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
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
            {[["How it works", "how-it-works"], ["Formats", "formats"], ["Community", "community"], ["Features", "features"], ["Pricing", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
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
                <Film className="w-3.5 h-3.5 text-purple-400" />
                <span className="mono text-xs text-purple-300 font-medium">YouTube-ready documentaries</span>
              </div>

              <h1 className="animate-fade-up delay-100 text-4xl sm:text-5xl lg:text-6xl font-black leading-tight text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
                Turn your topic into a{" "}
                <span className="gradient-text">YouTube-ready documentary</span>
              </h1>

              <p className="animate-fade-up delay-200 text-base md:text-lg text-slate-300 leading-relaxed max-w-lg">
                Describe your story once. Fastvid writes the script, narrates it, finds visuals that match what is being said, and delivers a finished video — built for factual, narrator-led channels.
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
                  onClick={handleGenerate}
                  className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-2 shrink-0"
                >
                  <Sparkles className="w-4 h-4" />
                  Generate
                </button>
              </div>

              {/* Trust signals */}
              <div className="animate-fade-up delay-400 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Script-matched B-roll</span>
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Cloud generation</span>
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Built-in editor</span>
              </div>

              <div className="animate-fade-up delay-450 rounded-xl border border-purple-500/25 bg-purple-500/5 px-4 py-3 text-xs text-slate-300 leading-relaxed">
                <span className="text-purple-300 font-semibold">Getting started:</span>{" "}
                Submit your niche, email, and content format on our{" "}
                <button type="button" onClick={() => navigate("/niche-aanvraag")} className="text-purple-300 hover:text-white underline underline-offset-2">
                  application page
                </button>
                . Approval within <strong className="text-white">2 business days</strong> — start within{" "}
                <strong className="text-white">24 hours</strong> after that.
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
            <StatItem value="1–20" label="minute documentaries" icon={Clock} />
            <StatItem value="~60" label="min avg. full production" icon={Cloud} />
            <StatItem value="3" label="steps: brief → build → edit" icon={Film} />
            <StatItem value="100+" label="AI voice options" icon={Mic} />
          </div>
        </div>
      </section>

      {/* ── Vidrush-style workflow ── */}
      <section id="formats" className="relative py-20 overflow-hidden">
        <div className="glow-orb w-80 h-80 bg-purple-600/10 -right-20 top-10 animate-orb-drift" />
        <div className="container relative z-10">
          <div className="text-center mb-12">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">
              Production flow
            </span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: "Outfit, sans-serif" }}>
              What used to take days,{" "}
              <span className="gradient-text">now takes one session</span>
            </h2>
            <p className="text-slate-400 max-w-2xl mx-auto text-sm md:text-base">
              The same end-to-end flow documentary creators expect: you set the story, Fastvid runs production in the cloud, you polish and publish.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-5 mb-16">
            {WORKFLOW_STEPS.map((step) => (
              <StepCard key={step.number} {...step} />
            ))}
          </div>

          <div className="text-center mb-8">
            <span className="mono text-xs text-purple-400 font-medium tracking-widest uppercase mb-3 block">
              Formats
            </span>
            <h3 className="text-2xl md:text-3xl font-black text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
              Built for <span className="gradient-text">documentary</span> channels
            </h3>
          </div>
          <div className="grid md:grid-cols-2 gap-5 max-w-4xl mx-auto mb-12">
            {VIDEO_FORMATS.map((fmt) => (
              <div
                key={fmt.id}
                className={`glass-card p-6 border flex flex-col gap-3 ${
                  fmt.available ? "border-purple-400/40 bg-purple-600/5" : "border-white/8 opacity-80"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {fmt.id === "documentary" ? (
                      <Film className="w-5 h-5 text-purple-400" />
                    ) : (
                      <ListOrdered className="w-5 h-5 text-slate-500" />
                    )}
                    <h4 className="font-bold text-white">{fmt.title}</h4>
                  </div>
                  {!fmt.available && (
                    <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-white/15 text-slate-500">
                      Coming soon
                    </span>
                  )}
                  {fmt.available && (
                    <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
                      Available
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-400 leading-relaxed">{fmt.desc}</p>
              </div>
            ))}
          </div>

          <div className="glass-card border border-white/8 rounded-2xl p-6 md:p-8">
            <p className="mono text-xs text-slate-500 uppercase tracking-wide mb-4 text-center">Strong fit for</p>
            <div className="flex flex-wrap justify-center gap-2">
              {BEST_FOR_NICHES.map((niche) => (
                <span
                  key={niche}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/10 bg-white/3"
                >
                  {niche}
                </span>
              ))}
            </div>
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
              Match length to{" "}
              <span className="gradient-text">story depth</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Pick a runtime that fits how many beats your topic needs — from quick tests to full deep dives.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[
              { label: "1 min", value: "1", icon: "🧪", title: "Quick test", useCases: ["Pipeline check", "Topic test", "Visual QA"] },
              { label: "8–10 min", value: "8-10", icon: "🎬", title: "Standard doc", useCases: ["Biography", "Company story", "Science explainer"] },
              { label: "10–15 min", value: "10-15", icon: "📈", title: "Deep-dive", useCases: ["True crime", "Geopolitics", "Tech analysis"] },
              { label: "15–20 min", value: "15-20", icon: "🔍", title: "Extended", useCases: ["Investigations", "Historical arcs", "Multi-act story"] },
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
              Inside each{" "}
              <span className="gradient-text">generation</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Under the hood, Fastvid runs a full documentary pipeline — not a single generic template.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {productionSteps.map((step) => (
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
              Everything for{" "}
              <span className="gradient-text">factual storytelling</span>
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
                  Scripts that <span className="gradient-text">drive the edit</span>
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  Structured prompts produce narration with clear beats — who, what, and when — so visuals can follow the story, not random keywords.
                </p>
                <ul className="space-y-2">
                  {["Hook → context → payoff structure", "SEO titles & descriptions", "Scene beats for visual matching", "Documentary & explainer tone"].map((item) => (
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
                  Visuals matched to <span className="gradient-text">the narration</span>
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  Each beat searches for footage that fits the line being spoken — real events, named people, and topic-specific B-roll before generic stock.
                </p>
                <ul className="space-y-2">
                  {["Creative Commons & licensed sources", "Person- and event-aware queries", "No duplicate clips per video", "Smooth documentary pacing"].map((item) => (
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
                { icon: Edit3, title: "Built-in editor", desc: "Swap clips, review scenes, and refine the cut before you export — like a lightweight post suite.", color: "purple" },
                { icon: Mic, title: "Pro AI voices", desc: "Natural narration via ElevenLabs and more — authoritative tones suited to documentaries.", color: "cyan" },
                { icon: Wand2, title: "Auto assembly", desc: "Music, grading, and transitions applied so the timeline feels broadcast-ready.", color: "purple" },
                { icon: Cloud, title: "Cloud render", desc: "Heavy lifting runs on our servers; download when your project is done.", color: "cyan" },
                { icon: FileText, title: "Custom scripts", desc: "Paste your own script when you already have the words — Fastvid builds visuals around it.", color: "purple" },
                { icon: Sparkles, title: "SEO package", desc: "Titles, descriptions, and chapter-friendly structure generated with your video.", color: "cyan" },
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
                  <span className="text-6xl font-black gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>$499</span>
                  <span className="text-slate-400 mb-3">/month</span>
                </div>
                <p className="text-xs text-slate-500">$499/month · Cancel anytime</p>
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
                  "All lengths: 1, 8–10, 10–15, and 15–20 min",
                  "Documentary & explainer scripts",
                  "Script-matched B-roll (stock + real footage)",
                  "Professional AI voiceover",
                  "Built-in video editor",
                  "Cinematic effects & transitions",
                  "YouTube SEO metadata",
                  "Cloud production",
                  "4K export",
                  "Priority support",
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

      {/* ── Discord community ── */}
      <section id="community" className="relative py-24 overflow-hidden">
        <div className="glow-orb w-96 h-96 bg-[#5865F2]/15 top-0 left-1/2 -translate-x-1/2 animate-orb-drift" />
        <div className="container relative z-10">
          <div className="max-w-3xl mx-auto glass-card gradient-border rounded-2xl p-8 md:p-10 border border-[#5865F2]/25 bg-[#5865F2]/5">
            <div className="flex flex-col md:flex-row md:items-start gap-8">
              <div className="shrink-0 w-14 h-14 rounded-2xl bg-[#5865F2]/20 border border-[#5865F2]/40 flex items-center justify-center">
                <MessageCircle className="w-7 h-7 text-[#5865F2]" />
              </div>
              <div className="flex-1 flex flex-col gap-5">
                <div>
                  <span className="mono text-xs text-[#5865F2] font-medium tracking-widest uppercase mb-2 block">
                    Free for members
                  </span>
                  <h2 className="text-2xl md:text-3xl font-black text-white mb-3" style={{ fontFamily: "Outfit, sans-serif" }}>
                    Join our Discord — get a winning{" "}
                    <span className="gradient-text">niche every week</span>
                  </h2>
                  <p className="text-slate-300 text-sm md:text-base leading-relaxed">
                    Become a member of the Fastvid community. Each week we share one strong YouTube niche
                    idea (documentary or explainer) with angle, audience, and why it works now — so you always
                    know what to produce next.
                  </p>
                </div>
                <ul className="space-y-2.5">
                  {[
                    "Weekly curated niche drop (high CPM / search-friendly where possible)",
                    "Tips on prompts, length, and documentary structure",
                    "Ask questions and share results with other creators",
                    "Early access to features and pipeline updates",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-sm text-slate-300">
                      <Check className="w-4 h-4 text-[#5865F2] shrink-0 mt-0.5" />
                      {item}
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <CalendarDays className="w-4 h-4 text-cyan-400" />
                  New niche posted every week in the group
                </div>
                {DISCORD_INVITE_URL ? (
                  <a
                    href={DISCORD_INVITE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 w-full sm:w-auto px-6 py-3.5 rounded-xl font-bold text-white bg-[#5865F2] hover:bg-[#4752c4] transition-colors shadow-lg shadow-[#5865F2]/25"
                  >
                    <MessageCircle className="w-5 h-5" />
                    Join the Discord
                    <ArrowRight className="w-4 h-4" />
                  </a>
                ) : (
                  <p className="text-sm text-slate-500">
                    Discord invite link is being configured. Check back soon or email{" "}
                    <a href="mailto:support@fastvid.app" className="text-cyan-400 hover:underline">
                      support@fastvid.app
                    </a>
                    .
                  </p>
                )}
              </div>
            </div>
          </div>
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
            Your next documentary<br />
            <span className="gradient-text">starts with one prompt</span>
          </h2>
          <p className="text-slate-300 max-w-lg mx-auto mb-10 text-base md:text-lg">
            Join creators producing narrator-led YouTube videos without a full production crew. Brief, build, edit, publish.
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
          <nav className="flex flex-wrap justify-center gap-6 text-xs text-slate-500">
            {LEGAL_FOOTER_LINKS.map(({ href, label }) => (
              <a key={href} href={href} className="hover:text-slate-300 transition-colors">
                {label}
              </a>
            ))}
            {DISCORD_INVITE_URL ? (
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-slate-300 transition-colors"
              >
                Discord
              </a>
            ) : null}
          </nav>
          <p className="text-xs text-slate-600">© {new Date().getFullYear()} Fastvid. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
