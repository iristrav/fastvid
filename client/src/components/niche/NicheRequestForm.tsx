import { useState } from "react";
import { Loader2 } from "lucide-react";

export type NicheRequestFormValues = {
  contactEmail: string;
  nicheTitle: string;
  titleStructure: string;
  topics: string;
  subniches: string;
};

type Props = {
  initialEmail?: string;
  initialNiche?: string;
  initialTitleStructure?: string;
  initialTopics?: string;
  initialSubniches?: string;
  submitting?: boolean;
  submitLabel?: string;
  onSubmit: (values: NicheRequestFormValues) => void;
};

export function NicheRequestForm({
  initialEmail = "",
  initialNiche = "",
  initialTitleStructure = "",
  initialTopics = "",
  initialSubniches = "",
  submitting = false,
  submitLabel = "Submit",
  onSubmit,
}: Props) {
  const [contactEmail, setContactEmail] = useState(initialEmail);
  const [nicheTitle, setNicheTitle] = useState(initialNiche);
  const [titleStructure, setTitleStructure] = useState(initialTitleStructure);
  const [topics, setTopics] = useState(initialTopics);
  const [subniches, setSubniches] = useState(initialSubniches);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !contactEmail.trim() ||
      !nicheTitle.trim() ||
      titleStructure.trim().length < 3 ||
      topics.trim().length < 3 ||
      subniches.trim().length < 3
    ) {
      return;
    }
    onSubmit({
      contactEmail: contactEmail.trim().toLowerCase(),
      nicheTitle: nicheTitle.trim(),
      titleStructure: titleStructure.trim(),
      topics: topics.trim(),
      subniches: subniches.trim(),
    });
  }

  const canSubmit =
    contactEmail.includes("@") &&
    nicheTitle.trim().length >= 2 &&
    titleStructure.trim().length >= 3 &&
    topics.trim().length >= 3 &&
    subniches.trim().length >= 3;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="niche-email" className="text-xs text-slate-400 font-medium uppercase tracking-wide">
          Email address *
        </label>
        <input
          id="niche-email"
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoComplete="email"
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="niche-title" className="text-xs text-slate-400 font-medium uppercase tracking-wide">
          Niche *
        </label>
        <input
          id="niche-title"
          value={nicheTitle}
          onChange={(e) => setNicheTitle(e.target.value)}
          placeholder="e.g. Titanic, WWII documentaries, SpaceX, true crime…"
          required
          minLength={2}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="niche-topics" className="text-xs text-slate-400 font-medium uppercase tracking-wide">
          Topics *
        </label>
        <textarea
          id="niche-topics"
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          rows={4}
          required
          minLength={3}
          placeholder={"What topics do you cover?\ne.g. shipwrecks, forgotten heroes, technical analyses, famous events…"}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none leading-relaxed"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="niche-subniches" className="text-xs text-slate-400 font-medium uppercase tracking-wide">
          Sub-niches *
        </label>
        <textarea
          id="niche-subniches"
          value={subniches}
          onChange={(e) => setSubniches(e.target.value)}
          rows={3}
          required
          minLength={3}
          placeholder={"More specific angles within your niche\ne.g. passenger stories, engineering failures, conspiracy theories, naval battles…"}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none leading-relaxed"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="niche-title-structure" className="text-xs text-slate-400 font-medium uppercase tracking-wide">
          Title structure *
        </label>
        <textarea
          id="niche-title-structure"
          value={titleStructure}
          onChange={(e) => setTitleStructure(e.target.value)}
          rows={3}
          required
          minLength={3}
          placeholder={'How are your video titles structured?\ne.g. "The Untold Story of [X]" / "Why [X] Changed Everything"'}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-purple-500/50 resize-none leading-relaxed"
        />
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
      <h3 className="text-lg font-bold text-yellow-200">Request received</h3>
      <p className="text-sm text-yellow-100/90 leading-relaxed">
        {email ? (
          <>We received your request at <strong>{email}</strong>. </>
        ) : null}
        Within <strong>2 business days</strong> you will receive an approval email.
        After approval you can <strong>start your first video within 24 hours</strong>.
      </p>
    </div>
  );
}

export function NicheRequestApprovedCard({ onContinue }: { onContinue?: () => void }) {
  return (
    <div className="glass-card border border-green-500/30 bg-green-500/5 rounded-xl p-6 space-y-3">
      <h3 className="text-lg font-bold text-green-200">Approved!</h3>
      <p className="text-sm text-green-100/90 leading-relaxed">
        Your niche has been approved. You can <strong>get started within 24 hours</strong> — activate your subscription and create your first video.
      </p>
      {onContinue && (
        <button
          type="button"
          onClick={onContinue}
          className="mt-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-semibold"
        >
          Go to subscription
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
        <p className="text-sm font-medium text-amber-200">Archive in progress</p>
        <p className="text-xs text-amber-100/80 mt-1 leading-relaxed">
          {nicheHint
            ? `There are still few visuals in the archive for “${nicheHint}”. It may take a bit longer — we are building the archive.`
            : "There are no visuals in the archive for this topic yet. It may take a bit longer — we are building the archive."}
        </p>
      </div>
    </div>
  );
}
