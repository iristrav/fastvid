import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, Play } from "lucide-react";

export const LEGAL_FOOTER_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms of Service" },
  { href: "/cookie-policy", label: "Cookie Policy" },
  { href: "/contact", label: "Contact" },
] as const;

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-3">{title}</h2>
      {children}
    </section>
  );
}

type LegalPageShellProps = {
  title: string;
  lastUpdated: string;
  children: ReactNode;
};

export function LegalPageShell({ title, lastUpdated, children }: LegalPageShellProps) {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-200">
      <header className="border-b border-white/8 bg-[#070b14]/90 backdrop-blur-md sticky top-0 z-10">
        <div className="container max-w-3xl py-4 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setLocation("/")}
            className="flex items-center gap-2.5 hover:opacity-90 transition-opacity"
          >
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-600 to-cyan-500 flex items-center justify-center">
              <Play className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-black text-lg text-white" style={{ fontFamily: "Outfit, sans-serif" }}>
              Fast<span className="gradient-text">vid</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setLocation("/")}
            className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Home
          </button>
        </div>
      </header>

      <main className="container max-w-3xl py-10 md:py-14 px-4">
        <h1
          className="text-3xl md:text-4xl font-black text-white mb-2"
          style={{ fontFamily: "Outfit, sans-serif" }}
        >
          {title}
        </h1>
        <p className="text-sm text-slate-500 mb-10">Last updated: {lastUpdated}</p>
        <article className="prose-legal space-y-6 text-sm md:text-base text-slate-300 leading-relaxed">
          {children}
        </article>
      </main>

      <footer className="border-t border-white/8 py-8 mt-8">
        <div className="container max-w-3xl px-4 flex flex-col items-center gap-4">
          <nav className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
            {LEGAL_FOOTER_LINKS.map(({ href, label }) => (
              <a key={href} href={href} className="hover:text-slate-300 transition-colors">
                {label}
              </a>
            ))}
          </nav>
          <p className="text-xs text-slate-600">© {new Date().getFullYear()} Fastvid. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
