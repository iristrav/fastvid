import { useState } from "react";
import { NICHE_VIDEO_FORMATS, type NicheVideoFormat } from "@shared/nicheRequest";
import { Loader2 } from "lucide-react";

export type NicheRequestFormValues = {
  nicheTitle: string;
  channelName: string;
  videoFormat: NicheVideoFormat;
  description: string;
};

type Props = {
  requestType: "onboarding" | "new_channel";
  initial?: Partial<NicheRequestFormValues>;
  submitting?: boolean;
  submitLabel?: string;
  onSubmit: (values: NicheRequestFormValues) => void;
};

export function NicheRequestForm({
  requestType,
  initial,
  submitting = false,
  submitLabel = "Aanvraag indienen",
  onSubmit,
}: Props) {
  const [nicheTitle, setNicheTitle] = useState(initial?.nicheTitle ?? "");
  const [channelName, setChannelName] = useState(initial?.channelName ?? "");
  const [videoFormat, setVideoFormat] = useState<NicheVideoFormat>(initial?.videoFormat ?? "8-12");
  const [description, setDescription] = useState(initial?.description ?? "");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!nicheTitle.trim()) return;
    onSubmit({
      nicheTitle: nicheTitle.trim(),
      channelName: channelName.trim(),
      videoFormat,
      description: description.trim(),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {requestType === "new_channel" && (
        <div className="space-y-1.5">
          <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">Kanaalnaam (optioneel)</label>
          <input
            value={channelName}
            onChange={(e) => setChannelName(e.target.value)}
            placeholder="bijv. Titanic Stories NL"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
          />
        </div>
      )}

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">Niche / onderwerp *</label>
        <input
          value={nicheTitle}
          onChange={(e) => setNicheTitle(e.target.value)}
          placeholder="bijv. Titanic, WOII, SpaceX, true crime…"
          required
          minLength={2}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">Videoformaat *</label>
        <select
          value={videoFormat}
          onChange={(e) => setVideoFormat(e.target.value as NicheVideoFormat)}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-purple-500/50"
        >
          {NICHE_VIDEO_FORMATS.map((f) => (
            <option key={f.value} value={f.value} className="bg-slate-900">
              {f.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 font-medium uppercase tracking-wide">Toelichting (optioneel)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Welk type content, doelgroep, voorbeeldvideo's…"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none"
        />
      </div>

      <button
        type="submit"
        disabled={submitting || nicheTitle.trim().length < 2}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gradient-to-r from-purple-600 to-cyan-600 hover:from-purple-500 hover:to-cyan-500 text-white text-sm font-semibold disabled:opacity-50"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {submitLabel}
      </button>
    </form>
  );
}

export function NicheRequestPendingCard() {
  return (
    <div className="glass-card border border-yellow-500/30 bg-yellow-500/5 rounded-xl p-6 space-y-3">
      <h3 className="text-lg font-bold text-yellow-200">Aanvraag ontvangen</h3>
      <p className="text-sm text-yellow-100/90 leading-relaxed">
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
