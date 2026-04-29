/**
 * FASTVID — Home Landing Page
 * Design: Neon Gradient Studio — deep space navy, violet-to-cyan gradient, glassmorphism
 * Fonts: Outfit (display), Space Grotesk (body), JetBrains Mono (code/labels)
 * Sections: Nav, Hero, Stats, How It Works, Features, Pricing, Testimonials, FAQ, CTA Footer
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
function StepCard({ number, icon: Icon, title, desc, delay }: {
  number: string; icon: React.ElementType; title: string; desc: string; delay: string;
}) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={`glass-card gradient-border p-6 flex flex-col gap-4 transition-all duration-700 ${
        inView ? `opacity-100 translate-y-0 ${delay}` : "opacity-0 translate-y-8"
      }`}
      style={{ transitionDelay: delay.replace("delay-", "").replace("0", "") + "ms" }}
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

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
    setMobileMenuOpen(false);
  };

  const faqs = [
    {
      q: "Hoe lang duurt het om een video te genereren?",
      a: "Gemiddeld duurt het genereren van een complete 15–20 minuten YouTube video tussen de 8 en 15 minuten. Fastvid werkt parallel: script, voiceover en visuals worden tegelijkertijd verwerkt voor maximale snelheid.",
    },
    {
      q: "Kan ik de video bewerken na het genereren?",
      a: "Ja, elke gegenereerde video wordt geleverd met een volledig bewerkbaar project. Je kunt het script aanpassen, de voiceover opnieuw genereren, visuals vervangen en effecten finetunen via de ingebouwde editor.",
    },
    {
      q: "Welke talen worden ondersteund?",
      a: "Fastvid ondersteunt momenteel Nederlands, Engels, Duits, Frans en Spaans voor zowel scripts als voiceovers. Meer talen worden binnenkort toegevoegd.",
    },
    {
      q: "Is er een gratis proefperiode?",
      a: "Ja! Je krijgt 14 dagen gratis toegang tot alle functies, zonder creditcard. Na de proefperiode kies je zelf of je wilt doorgaan voor €500/maand.",
    },
    {
      q: "Hoe worden de video's geoptimaliseerd voor YouTube?",
      a: "Fastvid analyseert trending topics, optimale videolengtes, thumbnail-stijlen en SEO-metadata. Het script wordt geschreven met bewezen virale structuren: haak, opbouw, climax en call-to-action.",
    },
    {
      q: "Welke betaalmethoden accepteren jullie?",
      a: "Wij accepteren SEPA Direct Debit, Bancontact, PayPal en alle gangbare creditcards (Visa, Mastercard, Amex).",
    },
    {
      q: "Zijn de video's 100% uniek en auteursrechtvrij?",
      a: "Ja. Elk script wordt uniek gegenereerd op basis van jouw prompt. De visuals worden geselecteerd uit auteursrechtvrije stockbibliotheken of volledig door AI gegenereerd. Je bezit alle rechten op de geproduceerde video's.",
    },
    {
      q: "Kan ik mijn eigen stem of branding toevoegen?",
      a: "Absoluut. Je kunt je eigen stem uploaden voor voice cloning, je logo en merkkleur instellen, en intro/outro templates koppelen aan je kanaal.",
    },
  ];

  const steps = [
    {
      number: "01",
      icon: Sparkles,
      title: "Geef je prompt",
      desc: "Beschrijf je video in één zin. Fastvid begrijpt je niche, doelgroep en gewenste toon automatisch.",
    },
    {
      number: "02",
      icon: FileText,
      title: "AI schrijft het script",
      desc: "Een viraal geoptimaliseerd script van 15–20 minuten met sterke hook, opbouw en call-to-action.",
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
          {/* Logo */}
          <button onClick={() => scrollTo("hero")} className="flex items-center gap-2.5 group">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-purple-500/30">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-black text-xl text-white" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </button>

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-8">
            {[["Hoe het werkt", "how-it-works"], ["Features", "features"], ["Prijzen", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
              <button
                key={id}
                onClick={() => scrollTo(id)}
                className="text-sm text-slate-400 hover:text-white transition-colors duration-200"
              >
                {label}
              </button>
            ))}
          </div>

          {/* CTA */}
          <div className="hidden md:flex items-center gap-3">
            <button
              onClick={() => scrollTo("pricing")}
              className="text-sm text-slate-400 hover:text-white transition-colors"
            >
              Inloggen
            </button>
            <button
              onClick={() => scrollTo("pricing")}
              className="btn-gradient px-4 py-2 rounded-lg text-sm font-semibold text-white"
            >
              Gratis proberen
            </button>
          </div>

          {/* Mobile menu toggle */}
          <button
            className="md:hidden text-white p-1"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden bg-background/95 backdrop-blur-xl border-b border-white/8 px-4 pb-4 flex flex-col gap-3">
            {[["Hoe het werkt", "how-it-works"], ["Features", "features"], ["Prijzen", "pricing"], ["FAQ", "faq"]].map(([label, id]) => (
              <button
                key={id}
                onClick={() => scrollTo(id)}
                className="text-sm text-slate-300 hover:text-white py-2 text-left transition-colors"
              >
                {label}
              </button>
            ))}
            <button
              onClick={() => scrollTo("pricing")}
              className="btn-gradient px-4 py-2.5 rounded-lg text-sm font-semibold text-white mt-2"
            >
              14 dagen gratis proberen
            </button>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section id="hero" className="relative min-h-screen flex items-center pt-16 overflow-hidden">
        {/* Background image */}
        <div
          className="absolute inset-0 bg-cover bg-center opacity-40"
          style={{ backgroundImage: `url(${HERO_BG})` }}
        />
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-background via-background/80 to-background/60" />
        {/* Animated orbs */}
        <div className="glow-orb w-96 h-96 bg-purple-600/20 top-20 -left-20 animate-orb-drift" />
        <div className="glow-orb w-80 h-80 bg-cyan-500/15 bottom-20 right-10 animate-orb-drift-slow" />

        <div className="container relative z-10 py-20">
          <div className="grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
            {/* Left: Text */}
            <div className="flex flex-col gap-6">
              {/* Badge */}
              <div className="animate-fade-up inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 w-fit">
                <Zap className="w-3.5 h-3.5 text-purple-400" />
                <span className="mono text-xs text-purple-300 font-medium">AI-powered YouTube automation</span>
              </div>

              {/* Headline */}
              <h1
                className="animate-fade-up delay-100 text-4xl sm:text-5xl lg:text-6xl font-black leading-tight text-white"
                style={{ fontFamily: 'Outfit, sans-serif' }}
              >
                Van prompt naar{" "}
                <span className="gradient-text">virale YouTube video</span>{" "}
                in minuten
              </h1>

              {/* Sub */}
              <p className="animate-fade-up delay-200 text-base md:text-lg text-slate-300 leading-relaxed max-w-lg">
                Fastvid genereert complete 15–20 minuten YouTube video's — inclusief viraal script, professionele voiceover, passende visuals en cineastische effecten. Eén prompt is alles wat je nodig hebt.
              </p>

              {/* Prompt input */}
              <div className="animate-fade-up delay-300 prompt-input-wrapper flex items-center gap-2 p-2 pl-4">
                <input
                  type="text"
                  value={promptValue}
                  onChange={(e) => setPromptValue(e.target.value)}
                  placeholder="Maak een video over de top 10 AI tools van 2025..."
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
                <span className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5 text-cyan-400" /> Onbeperkte video's</span>
              </div>
            </div>

            {/* Right: Mockup */}
            <div className="animate-slide-in-right delay-300 relative">
              <div className="animate-float relative">
                {/* Glow behind mockup */}
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
            <StatItem value="15–20" label="minuten per video" icon={Clock} />
            <StatItem value="∞" label="video's per maand" icon={Infinity} />
            <StatItem value="8 min" label="gemiddelde generatietijd" icon={Zap} />
            <StatItem value="3×" label="meer views gemiddeld" icon={TrendingUp} />
          </div>
        </div>
      </section>

      {/* ── How It Works ── */}
      <section id="how-it-works" className="relative py-24 overflow-hidden">
        <div className="glow-orb w-72 h-72 bg-purple-600/10 top-10 right-0 animate-orb-drift" />
        <div className="container relative z-10">
          {/* Section header */}
          <div className="text-center mb-16">
            <span className="mono text-xs text-cyan-400 font-medium tracking-widest uppercase mb-3 block">Hoe het werkt</span>
            <h2 className="text-3xl md:text-4xl font-black text-white mb-4" style={{ fontFamily: 'Outfit, sans-serif' }}>
              Van idee naar video in{" "}
              <span className="gradient-text">5 stappen</span>
            </h2>
            <p className="text-slate-400 max-w-xl mx-auto text-sm md:text-base">
              Fastvid automatiseert het volledige productieproces. Jij geeft de richting, de AI doet het werk.
            </p>
          </div>

          {/* Steps grid */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {steps.map((step, i) => (
              <StepCard
                key={step.number}
                {...step}
                delay={`delay-${(i + 1) * 100}`}
              />
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

          {/* Feature rows */}
          <div className="space-y-16">
            {/* Row 1: Script + Voiceover */}
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
                  Onze AI analyseert duizenden virale YouTube video's en schrijft scripts met bewezen structuren. Sterke hooks die kijkers vasthouden, opbouw die spanning creëert en een call-to-action die converteert.
                </p>
                <ul className="space-y-2">
                  {["Viraal geoptimaliseerde hooks", "SEO-vriendelijke titels & beschrijvingen", "Automatische hoofdstukindeling", "Aanpasbare toon & stijl"].map((item) => (
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

            {/* Row 2: Visuals */}
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
                  Fastvid matcht automatisch elk scriptonderdeel aan de perfecte visuals. Van stockvideo's en AI-gegenereerde beelden tot animaties en infographics — alles wordt naadloos geïntegreerd.
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
                    color === "purple"
                      ? "bg-purple-600/20 border-purple-500/20"
                      : "bg-cyan-600/20 border-cyan-500/20"
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
              Geen verborgen kosten, geen limieten. Genereer zoveel video's als je wilt voor een vaste prijs per maand.
            </p>
          </div>

          {/* Pricing card */}
          <div className="max-w-lg mx-auto">
            <div className="relative gradient-border p-8 md:p-10 rounded-2xl">
              {/* Popular badge */}
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

              <ul className="space-y-3 mb-8">
                {[
                  "Onbeperkt video's genereren",
                  "Video's van 15–20 minuten",
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
        {/* Horizontal scroll */}
        <div className="flex gap-5 overflow-x-auto pb-4 px-4 md:px-8 scrollbar-hide snap-x snap-mandatory">
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
            Sluit je aan bij honderden creators die al dagelijks video's genereren met Fastvid. 14 dagen gratis, geen creditcard nodig.
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
