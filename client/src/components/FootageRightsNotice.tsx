/**
 * RONDE 652 — the YouTube footage in this video whose licence FastVid could not prove.
 *
 * Shown next to the finished video, above the fold of the details, so the person sees it before
 * publishing rather than after a claim. Nothing is shown when the video uses no YouTube footage
 * or only footage YouTube reports as Creative Commons (which still asks for attribution).
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { trpc } from "@/lib/trpc";

const STATUS_LABEL: Record<string, string> = {
  creative_commons: "Creative Commons (CC BY) — credit the creator",
  standard_youtube_licence: "Standard YouTube licence — reuse not granted",
  unknown: "Licence unknown",
};

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function FootageRightsNotice({ videoId }: { videoId: number }) {
  const { data } = trpc.timeline.footageRights.useQuery({ videoId }, { staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  if (!data || data.entries.length === 0) return null;

  const attributionOnly = data.needsCheck === 0;
  return (
    <div
      className={
        attributionOnly
          ? "glass-card border border-white/8 rounded-xl p-4"
          : "glass-card border border-amber-500/25 rounded-xl p-4 bg-amber-500/5"
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className={`w-5 h-5 mt-0.5 shrink-0 ${attributionOnly ? "text-slate-400" : "text-amber-400"}`}
        />
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium ${attributionOnly ? "text-slate-200" : "text-amber-300"}`}>
            {attributionOnly
              ? "This video uses Creative Commons footage from YouTube"
              : `Check the rights before publishing: ${data.needsCheck} YouTube ${
                  data.needsCheck === 1 ? "video" : "videos"
                } without a proven licence`}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            {attributionOnly
              ? "Credit each creator in your video description."
              : `${Math.round(data.needsCheckSeconds)} of ${Math.round(
                  data.youtubeSeconds
                )} seconds of YouTube footage come from videos whose reuse rights FastVid could not confirm. Replace those shots in the editor, or make sure you have permission before you publish.`}
          </p>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 flex items-center gap-1 text-xs text-slate-300 hover:text-white transition-colors"
            aria-expanded={open}
          >
            {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {open ? "Hide sources" : `Show ${data.entries.length} ${data.entries.length === 1 ? "source" : "sources"}`}
          </button>
          {open && (
            <ul className="mt-2 space-y-2">
              {data.entries.map((e, i) => (
                <li key={e.youtubeVideoId ?? i} className="text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    {e.youtubeUrl ? (
                      <a
                        href={e.youtubeUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-cyan-400 hover:text-cyan-300 truncate flex items-center gap-1"
                      >
                        {e.title ?? e.youtubeVideoId}
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <span className="text-slate-300 truncate">{e.title ?? "Unknown YouTube video"}</span>
                    )}
                  </div>
                  <div className="text-slate-500 mt-0.5">
                    <span className={e.status === "creative_commons" ? "text-slate-400" : "text-amber-400/90"}>
                      {STATUS_LABEL[e.status] ?? STATUS_LABEL.unknown}
                    </span>
                    {" · on screen at "}
                    <span className="tabular-nums">
                      {e.appearances.map((a) => `${clock(a.start)}–${clock(a.end)}`).join(", ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
