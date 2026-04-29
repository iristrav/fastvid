/**
 * FASTVID — Home Landing Page
 * Design: Neon Gradient Studio — deep space navy, violet-to-cyan gradient, glassmorphism
 * Fonts: Outfit (display), Space Grotesk (body), JetBrains Mono (code/labels)
 * Sections: Nav, Hero (with length selector), Stats, How It Works, Features, Pricing, Testimonials, FAQ, CTA Footer
 */

import { useState, useEffect, useRef } from "react";
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
  { label: "5–8 min", value: "5-8", desc: "Kort & krachtig", genTime: "~3 min" },
  { label: "8–12 min", value: "8-12", desc: "Ideaal voor tutorials", genTime: "~5 min" },
  { label: "12–15 min", value: "12-15", desc: "Diepgaande content", genTime: "~7 min" },
  { label: "15–20 min", value: "15-20", desc: "Uitgebreide video's", genTime: "~10 min" },
  { label: "20+ min", value: "20+", desc: "Lange documentaires", genTime: "~15 min" },
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

// ─── Stat Counter ─────────────────────────────────────────────────────────────
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
      q: "Welke videolengte moet ik kiezen?",
      a: "Dat hangt af van je niche en doelgroep. Korte video's (5–8 min) werken goed voor snelle tips en nieuws. Middellange video's (8–15 min) zijn ideaal voor tutorials en reviews. Lange video's (15–20 min en 20+) scoren beter voor diepgaande analyses, documentaires en educatieve content — en leveren meer kijktijd en advertentie-inkomsten op.",
    },
    {
      q: "Hoe lang duurt het om een video te genereren?",
      a: "De generatietijd hangt af van de gekozen videolengte. Een video van 5–8 minuten is klaar in ~3 minuten, terwijl een video van 20+ minuten ~15 minuten duurt. Fastvid werkt parallel: script, voiceover en visuals worden tegelijkertijd verwerkt.",
    },
    {
      q: "Kan ik de videolengte per video aanpassen?",
      a: "Ja, absoluut. Je kiest de gewenste lengte per video bij elke generatie. Je bent niet gebonden aan één lengte — je kunt voor het ene kanaal korte video's maken en voor het andere lange documentaires.",
    },
    {
      q: "Kan ik de video bewerken na het genereren?",
      a: "Ja, elke gegenereerde video wordt geleverd met een volledig bewerkbaar project. Je kunt het script aanpassen, de voiceover opnieuw genereren, visuals vervangen en effecten finetunen via de ingebouwde editor.",
    },
    {
      q: "Is er een gratis proefperiode?",
      a: "Ja! Je krijgt 14 dagen gratis toegang tot alle functies en alle videolengtes, zonder creditcard. Na de proefperiode kies je zelf of je wilt doorgaan voor €500/maand.",
    },
    {
      q: "Hoe worden de video's geoptimaliseerd voor YouTube?",
      a: "Fastvid analyseert trending topics, optimale videolengtes per niche, thumbnail-stijlen en SEO-metadata. Het script wordt geschreven met bewezen virale structuren: haak, opbouw, climax en call-to-action — aangepast aan de gekozen videolengte.",
    },
    {
      q: "Welke betaalmethoden accepteren jullie?",
      a: "Wij accepteren SEPA Direct Debit, Bancontact, PayPal en alle gangbare creditcards (Visa, Mastercard, Amex).",
    },
    {
      q: "Zijn de video's 100% uniek en auteursrechtvrij?",
      a: "Ja. Elk script wordt uniek gegenereerd op basis van jouw prompt. De visuals worden geselecteerd uit auteursrechtvrije stockbibliotheken of volledig door AI gegenereerd. Je bezit alle rechten op de geproduceerde video's.",
    },
  ];

  const steps = [
    {
      number: "01",
      icon: Sparkles,
      title: "Geef je prompt",
      desc: "Beschrijf je video in één zin en kies de gewenste lengte. Fastvid begrijpt je niche, doelgroep en toon automatisch.",
    },
    {
      number: "02",
      icon: FileText,
      title: "AI schrijft het script",
      desc: "Een viraal geoptimaliseerd script op maat van de gekozen lengte — met sterke hook, opbouw en call-to-action.",
    },
    {
      number: "03",
      icon: Mic,
      title: "Professionele voiceover",
      desc: "Kies uit tientallen AI-stemmen of clone je eigen stem. Vloeiend, natuurlijk en op maat gemonteerd.",
    },
    {
      number: "04",
      icon: Image,
      title: "Visuals & B-roll",
      desc: "AI matcht elk scriptonderdeel aan passende beelden, stockvideo's en AI-gegenereerde visuals.",
    },
    {
      number: "05",
      icon: Wand2,
      title: "Effecten & export",
      desc: "Automatische tekstoverlays, transitions, muziek en kleurcorrectie. Klaar voor upload naar YouTube.",
    },
  ];

  const testimonials = [
    {
      name: "Daan Vermeer",
      role: "YouTube creator — 180K subscribers",
      text: "Ik maak nu 3x zoveel video's in dezelfde tijd. De kwaliteit van de scripts is echt indrukwekkend — beter dan wat ik zelf zou schrijven.",
      stars: 5,
    },
    {
      name: "Lena Hofstra",
      role: "Online ondernemer",
      text: "Mijn kanaal groeide van 2K naar 45K subscribers in 3 maanden. Fastvid is de beste investering die ik ooit heb gedaan voor mijn business.",
      stars: 5,
    },
    {
      name: "Remi Claes",
      role: "Content agency eigenaar",
      text: "We produceren nu 20+ videos per week voor onze klanten. De ROI is absurd. €500/maand voor onbeperkte video's is een no-brainer.",
      stars: 5,
    },
    {
      name: "Sanne de Wit",
      role: "Educatieve YouTuber",
      text: "De voiceover klinkt zo natuurlijk dat mijn kijkers niet eens doorhebben dat het AI is. Geweldige tool.",
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
            {[["Hoe het werkt", "how-it-works"], ["Features", "features"], ["Prijzen", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
              <button key={id} onClick={() => scrollTo(id)} className="text-sm text-slate-400 hover:text-white transition-colors duration-200">
                {label}
              </button>
            ))}
          </div>

          <div className="hidden md:flex items-center gap-3">
            <button onClick={() => scrollTo("pricing")} className="text-sm text-slate-400 hover:text-white transition-colors">
              Inloggen
            </button>
            <button onClick={() => scrollTo("pricing")} className="btn-gradient px-4 py-2 rounded-lg text-sm font-semibold text-white">
              Gratis proberen
            </button>
          </div>

          <button className="md:hidden text-white p-1" onClick={() => setMobileMenuOpen(!mobileMenuOpen)}>
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="md:hidden bg-background/95 backdrop-blur-xl border-b border-white/8 px-4 pb-4 flex flex-col gap-3">
            {[["Hoe het werkt", "how-it-works"], ["Features", "features"], ["Prijzen", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
              <button key={id} onClick={() => scrollTo(id)} className="text-sm text-slate-300 hover:text-white py-2 text-left transition-colors">
                {label}
              </button>
            ))}
            <button onClick={() => scrollTo("pricing")} className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white mt-2">
              14 dagen gratis proberen
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
                Van prompt naar{" "}
                <span className="gradient-text">virale YouTube video</span>{" "}
                in minuten
              </h1>

              <p className="animate-fade-up delay-200 text-base md:text-lg text-slate-300 leading-relaxed max-w-lg">
                Fastvid genereert complete YouTube video's van jouw gewenste lengte — inclusief viraal script, professionele voiceover, passende visuals en cineastische effecten. Eén prompt is alles wat je nodig hebt.
              </p>

              {/* Video length selector */}
              <div className="animate-fade-up delay-250 flex flex-col gap-2">
                <span className="mono text-xs text-slate-500 font-medium tracking-wide uppercase">Kies videolengte</span>
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
                  Generatietijd voor <span className="text-cyan-400 font-medium">{activeLengthOption.label}</span>: {activeLengthOption.genTime}
                </p>
              </div>

              {/* Prompt input */}
              <div className="animate-fade-up delay-300 prompt-input-wrapper flex items-center gap-2 p-2 pl-4">
                <input
                  type="text"
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  placeholder={`Maak een ${activeLengthOption.label} video over...`}
                  className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-500 outline-none"
                />
                <button
                  onClick={() => scrollTo("pricing")}
                  className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-2 shrink-0"
                >
                  <Sparkles className="w-4 h-4" />
                  Genereer
                </button>
              </div>

              {/* Trust signals */}
              <div className="animate-fade-up delay-400 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> 14 dagen gratis</span>
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Geen creditcard nodig</span>
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Alle videolengtes</span>
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
            <StatItem value="5–20+" label="minuten, jij kiest de lengte" icon={Clock} />
            <StatItem value="∞" label="video's per maand" icon={Infinity} />
            <StatItem value="5 lengtes" label="om uit te kiezen" icon={Zap} />
            <StatItem value="3×" label="meer views gemiddeld" icon={TrendingUp} />
          </div>
        </div>
      </section>

      {/* ── Video Length Detail ── */}
      <section className="relative py-20 overflow-hidden">
        <div className="glow-orb w-72 h-72 bg-cyan-500/8 top-0 right-0 animate-orb-drift-slow" />
        <div className="container relative z-10">
          <div className="text-center mb-12">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Flexibele videolengte</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Kies de lengte die{" "}
              <span className="gradient-text">bij jouw niche past</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Elke videolengte heeft zijn eigen strategie. Fastvid past het script, de structuur en de montage automatisch aan op de gekozen duur.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {[
              {
                label: "5–8 min",
                value: "5-8",
                icon: "⚡",
                color: "cyan",
                title: "Kort & krachtig",
                useCases: ["Nieuws & updates", "Snelle tips", "Product reveals", "Trending topics"],
                genTime: "~3 min",
              },
              {
                label: "8–12 min",
                value: "8-12",
                icon: "🎯",
                color: "purple",
                title: "Ideaal voor tutorials",
                useCases: ["How-to video's", "Reviews", "Top 5 lijsten", "Vlog-stijl content"],
                genTime: "~5 min",
              },
              {
                label: "12–15 min",
                value: "12-15",
                icon: "📈",
                color: "cyan",
                title: "Diepgaande content",
                useCases: ["Uitgebreide tutorials", "Case studies", "Vergelijkingen", "Educatief"],
                genTime: "~7 min",
              },
              {
                label: "15–20 min",
                value: "15-20",
                icon: "🎬",
                color: "purple",
                title: "Uitgebreide video's",
                useCases: ["Documentaire-stijl", "Diepgaande analyses", "Interviews", "Storytelling"],
                genTime: "~10 min",
              },
              {
                label: "20+ min",
                value: "20+",
                icon: "🏆",
                color: "cyan",
                title: "Lange documentaires",
                useCases: ["Masterclasses", "Volledige cursussen", "Epische verhalen", "Deep dives"],
                genTime: "~15 min",
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
                  <span className="mono text-xs text-cyan-400">{opt.genTime} generatietijd</span>
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
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Hoe het werkt</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Van idee naar video in{" "}
              <span className="gradient-text">5 stappen</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Fastvid automatiseert het volledige productieproces. Jij geeft de richting en de lengte, de AI doet het werk.
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
              Alles wat je nodig hebt voor{" "}
              <span className="gradient-text">virale content</span>
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
                  Scripts die <span className="gradient-text">viraal gaan</span>
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  Onze AI schrijft scripts op maat van de gekozen videolengte. Of het nu een snelle 5-minuten tip is of een uitgebreide 20+ minuten documentaire — de structuur, het tempo en de hook worden automatisch aangepast.
                </p>
                <ul className="space-y-2">
                  {["Viraal geoptimaliseerde hooks voor elke lengte", "SEO-vriendelijke titels & beschrijvingen", "Automatische hoofdstukindeling", "Aanpasbare toon & stijl"].map((item) => (
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
                  Beelden die <span className="gradient-text">versterken</span>
                </h3>
                <p className="text-slate-400 leading-relaxed">
                  Fastvid matcht automatisch elk scriptonderdeel aan de perfecte visuals — ongeacht de videolengte. Van stockvideo's en AI-gegenereerde beelden tot animaties en infographics.
                </p>
                <ul className="space-y-2">
                  {["Automatische B-roll matching", "AI-gegenereerde visuals", "Cineastische transitions", "Tekstoverlays & lower thirds"].map((item) => (
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
                { icon: Mic, title: "Voice Cloning", desc: "Upload je eigen stem en Fastvid kloont hem voor alle toekomstige video's. Volledig authentiek.", color: "purple" },
                { icon: Wand2, title: "Auto-effecten", desc: "Kleurcorrectie, achtergrondmuziek, geluidseffecten en cinematische filters worden automatisch toegepast.", color: "cyan" },
                { icon: TrendingUp, title: "Trend Analyse", desc: "Fastvid analyseert dagelijks trending topics in jouw niche en suggereert video-ideeën die nu scoren.", color: "purple" },
                { icon: Zap, title: "Snelle export", desc: "Exporteer in 4K, 1080p of geoptimaliseerd voor YouTube Shorts. Direct klaar voor upload.", color: "cyan" },
                { icon: FileText, title: "Multi-taal", desc: "Genereer video's in het Nederlands, Engels, Duits, Frans en Spaans met native voiceovers.", color: "purple" },
                { icon: Sparkles, title: "Thumbnail AI", desc: "Automatisch gegenereerde click-bait thumbnails geoptimaliseerd voor maximale CTR op YouTube.", color: "cyan" },
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
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Prijzen</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Eén plan. <span className="gradient-text">Onbeperkt alles.</span>
            </h2>
            <p className="text-slate-400 max-w-md mx-auto text-sm md:text-base">
              Geen verborgen kosten, geen limieten. Alle videolengtes, onbeperkte video's, vaste prijs.
            </p>
          </div>

          <div className="max-w-lg mx-auto">
            <div className="relative gradient-border p-8 md:p-10 rounded-2xl">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                <span className="btn-gradient px-4 py-1.5 rounded-full text-xs font-bold text-white shadow-lg shadow-purple-500/30">
                  Meest gekozen
                </span>
              </div>

              <div className="text-center mb-8">
                <h3 className="text-xl font-bold text-white mb-2" style={{ fontFamily: 'Outfit, sans-serif' }}>Pro Plan</h3>
                <div className="flex items-end justify-center gap-2 mb-1">
                  <span className="text-6xl font-black gradient-text" style={{ fontFamily: 'Outfit, sans-serif' }}>€500</span>
                  <span className="text-slate-400 mb-3">/maand</span>
                </div>
                <p className="text-xs text-slate-500">14 dagen gratis proberen · Geen creditcard nodig</p>
              </div>

              {/* Length selector in pricing */}
              <div className="mb-6 p-4 rounded-xl bg-white/3 border border-white/8">
                <p className="text-xs text-slate-400 mb-3 font-medium">Alle videolengtes inbegrepen:</p>
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
                  "Onbeperkt video's genereren",
                  "Alle 5 videolengtes (5–8, 8–12, 12–15, 15–20, 20+ min)",
                  "Viraal geoptimaliseerde scripts",
                  "Professionele AI voiceover",
                  "Automatische visual matching",
                  "Cineastische effecten & transitions",
                  "AI thumbnail generator",
                  "Voice cloning (eigen stem)",
                  "Multi-taal ondersteuning",
                  "4K export",
                  "Prioriteit support",
                  "Trend analyse dashboard",
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
                onClick={() => window.open("#", "_blank")}
                className="btn-gradient w-full py-4 rounded-xl font-bold text-white text-base flex items-center justify-center gap-2"
              >
                <Sparkles className="w-5 h-5" />
                Start 14 dagen gratis
                <ArrowRight className="w-4 h-4" />
              </button>

              <p className="text-center text-xs text-slate-500 mt-4">
                Betaal met SEPA, Bancontact, PayPal of creditcard. Maandelijks opzegbaar.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Testimonials ── */}
      <section className="py-20 overflow-hidden">
        <div className="container mb-10">
          <div className="text-center">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Ervaringen</span>
            <h2 className="text-3xl md:text-4xl font-black text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Wat creators <span className="gradient-text">zeggen</span>
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
              Veelgestelde <span className="gradient-text">vragen</span>
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
          <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-4 block">Klaar om te beginnen?</span>
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-black text-white mb-6 leading-tight" style={{ fontFamily: 'Outfit, sans-serif' }}>
            Jouw eerste virale video<br />
            <span className="gradient-text">begint hier</span>
          </h2>
          <p className="text-slate-300 max-w-lg mx-auto mb-10 text-base md:text-lg">
            Sluit je aan bij honderden creators die al dagelijks video's genereren met Fastvid. Alle lengtes, onbeperkt, 14 dagen gratis.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <button
              onClick={() => scrollTo("pricing")}
              className="btn-gradient px-8 py-4 rounded-xl font-bold text-white text-base flex items-center justify-center gap-2 shadow-2xl shadow-purple-500/30"
            >
              <Sparkles className="w-5 h-5" />
              Start gratis proefperiode
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => scrollTo("how-it-works")}
              className="px-8 py-4 rounded-xl font-semibold text-white text-base border border-white/15 hover:bg-white/5 transition-colors flex items-center justify-center gap-2"
            >
              <Play className="w-4 h-4" />
              Bekijk demo
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
            {["Privacybeleid", "Algemene voorwaarden", "Cookiebeleid", "Contact"].map((item) => (
              <button key={item} className="hover:text-slate-300 transition-colors">{item}</button>
            ))}
          </div>
          <p className="text-xs text-slate-600">© 2025 Fastvid. Alle rechten voorbehouden.</p>
        </div>
      </footer>
    </div>
  );
}
