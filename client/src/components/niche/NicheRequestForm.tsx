import { useState } from "react";
import { Loader2 } from "lucide-react";

export type NicheRequestFormValues = {
  contactEmail: string;
  nicheTitle: string;
  formatDetails: string;
};

type Props = {
  initialEmail?: string;
  initialNiche?: string;
  initialFormat?: string;
  submitting?: boolean;
  submitLabel?: string;
  onSubmit: (values: NicheRequestFormValues) => void;
};

export function NicheRequestForm({
  initialEmail = "",
  initialNiche = "",
  initialFormat = "",
  submitting = false,
  submitLabel = "Aanvraag indienen",
  onSubmit,
}: Props) {
  const [contactEmail, setContactEmail] = useState(initialEmail);
  const [nicheTitle, setNicheTitle] = useState(initialNiche);
  const [formatDetails, setFormatDetails] = useState(initialFormat);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!contactEmail.trim() || !nicheTitle.trim() || formatDetails.trim().length < 10) return;
    onSubmit({
      contactEmail: contactEmail.trim().toLowerCase(),
      nicheTitle: nicheTitle.trim(),
      formatDetails: formatDetails.trim(),
    });
  }

  const canSubmit =
    contactEmail.includes("@") &&
    nicheTitle.trim().length >= 2 &&
    formatDetails.trim().length >= 10;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">E-mailadres *</label>
        <input
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="jij@voorbeeld.nl"
          required
          autoComplete="email"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
        <p className="text-[11px] text-slate-500">Hier sturen we je goedkeuringsbericht naartoe.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">Niche *</label>
        <input
          value={nicheTitle}
          onChange={(e) => setNicheTitle(e.target.value)}
          placeholder="bijv. Titanic, WOII-documentaires, SpaceX, true crime…"
          required
          minLength={2}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">
          Format — titelstructuur &amp; onderwerpen *
        </label>
        <textarea
          value={formatDetails}
          onChange={(e) => setFormatDetails(e.target.value)}
          rows={5}
          required
          minLength={10}
          placeholder={`Beschrijf hoe je titels zijn opgebouwd en welke onderwerpen je behandelt, bijv.:\n\n• Titelstructuur: "The Untold Story of [X]" / "Why [X] Changed Everything"\n• Onderwerpen: scheepsrampen, vergeten helden, technische analyses\n• Voorbeeldvideo's of concurrenten (links)`}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none leading-relaxed"
        />
        <p className="text-[11px] text-slate-500">Minimaal 10 tekens — hoe concreter, hoe sneller we je archief kunnen opbouwen.</p>
      </div>

      <button
        type="submit"
        disabled={submitting || !canSubmit}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white text-sm font-semibold disabled:opacity-50 transition-opacity"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {submitLabel}
      </button>
    </form>
  );
}

export function NicheRequestPendingCard({ email }: { email?: string }) {
  return (
    <div className="glass-card border border-yellow-500/30 bg-yellow-500/5 rounded-xl p-6 space-y-3">
      <h3 className="text-lg font-bold text-yellow-200">Aanvraag ontvangen</h3>
      <p className="text-sm text-yellow-100/90 leading-relaxed">
        {email ? (
          <>We hebben je aanvraag ontvangen op <strong>{email}</strong>. </>
        ) : null}
        Binnen <strong>2 werkdagen</strong> ontvang je een goedkeuringsbericht per e-mail.
        Na goedkeuring kun je <strong>binnen 24 uur</strong> starten met je eerste video.
      </p>
      <p className="text-xs text-yellow-200/70">
        We bereiden ondertussen je niche-archief voor met beeldmateriaal op maat.
      </p>
    </div>
  );
}

export function NicheRequestApprovedCard({ onContinue }: { onContinue?: () => void }) {
  return (
    <div className="glass-card border border-green-500/30 bg-green-500/5 rounded-xl p-6 space-y-3">
      <h3 className="text-lg font-bold text-green-200">Goedgekeurd!</h3>
      <p className="text-sm text-green-100/90 leading-relaxed">
        Je niche is goedgekeurd. Je kunt <strong>binnen 24 uur starten</strong> — activeer je abonnement en maak je eerste video.
      </p>
      {onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="mt-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-semibold"
        >
          Naar abonnement
        </button>
      )}
    </div>
  );
}

export function ArchiveBuildingNotice({ nicheHint }: { nicheHint?: string | null }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-amber-500/25 bg-amber-500/10">
      <span className="text-lg shrink-0">📦</span>
      <div>
        <p className="text-sm font-medium text-amber-200">Archief in opbouw</p>
        <p className="text-xs text-amber-100/80 mt-1 leading-relaxed">
          {nicheHint
            ? `Er zijn nog weinig beelden in het archief voor “${nicheHint}”. Het duurt iets langer — we zijn bezig met het archief.`
            : "Er zijn nog geen beelden in het archief voor dit onderwerp. Het duurt iets langer — we zijn bezig met het archief."}
        </p>
      </div>
    </div>
  );
}
