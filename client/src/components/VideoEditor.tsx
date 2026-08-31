/**
 * FASTVID — RONDE 148 §11–§20 — the minimal editor.
 *
 * ── What this is, and what it deliberately is not ─────────────────────────────────────────────
 *
 * Player, timeline, inspector, SAVE, SAVE & RENDER. Not a drag-and-drop NLE: §14 asks only that a
 * person can SELECT an item, and every hour spent on drag handles is an hour not spent on the loop
 * that actually matters — open a video, change something, get a new MP4 back.
 *
 * ── The one state rule ───────────────────────────────────────────────────────────────────────
 *
 * §20: the SERVER's timeline is the truth and local edits are unsaved state, held in `draft`. The
 * two are never merged silently. `dirty` is a real comparison against the document that came from
 * the server rather than a flag someone remembers to set — a flag gets out of step with reality
 * the first time an edit is undone by hand, and then the tab-close warning fires on a clean editor
 * or, worse, does not fire on a dirty one.
 *
 * ── Errors are shown, not swallowed ──────────────────────────────────────────────────────────
 *
 * §18 forbids "Something went wrong". Every mutation here surfaces the server's own message, which
 * is why the routes were built to carry a code and a sentence worth reading: a version conflict
 * offers a reload, a validator failure lists the faults, an unrehydratable asset names the clip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  AlertCircle,
  Film,
  Loader2,
  Music,
  Play,
  RefreshCw,
  Save,
  Type as TypeIcon,
  X as XIcon,
} from "lucide-react";

/* ═══════════════════════ the timeline, as the client sees it ═══════════════════════ */

type AssetSourceIdentity = {
  provider: string;
  providerAssetId?: string;
  archiveAssetId?: number;
  canonicalUrl?: string;
  mediaUrl?: string;
  sourcePageUrl?: string;
  title?: string;
};

type VideoClip = {
  id: string;
  kind: "video" | "image";
  source: AssetSourceIdentity;
  sourceIn?: number;
  sourceOut?: number;
  timelineStart: number;
  timelineEnd: number;
  motion: string;
  transitionIn: string;
  transitionOut: string;
  previewSource: string;
  disabled?: boolean;
  editedByUser?: boolean;
};

type TextElement = {
  id: string;
  text: string;
  start: number;
  end: number;
  style?: { position?: string; fontSizePx?: number; color?: string };
  disabled?: boolean;
};

type AudioClip = { id: string; source: AssetSourceIdentity; start: number; end: number; gain: number };

/**
 * One member per kind, rather than `{ kind: "TEXT" | "GRAPHICS"; texts: ... }`.
 *
 * A union member whose own discriminant is a union cannot be narrowed away by a check on the
 * others — TypeScript keeps it in the candidate set and the field access fails. Spelling each kind
 * out costs four lines and makes every branch below narrow correctly with no casts.
 */
type Track =
  | { kind: "VIDEO"; clips: VideoClip[] }
  | { kind: "VOICE"; clips: AudioClip[] }
  | { kind: "MUSIC"; clips: AudioClip[] }
  | { kind: "SFX"; clips: AudioClip[] }
  | { kind: "CAPTIONS"; captions: TextElement[] }
  | { kind: "TEXT"; texts: TextElement[] }
  | { kind: "GRAPHICS"; texts: TextElement[] };

type Timeline = {
  schemaVersion?: number;
  version: number;
  videoId: number;
  durationSec: number;
  format: { widthPx: number; heightPx: number; fps: number };
  tracks: Track[];
  renderedVideoUrl?: string;
  createdAt: string;
};

/** §14 — every track kind gets a lane, in the order they stack in the picture and the mix. */
const TRACK_ORDER = ["VIDEO", "VOICE", "MUSIC", "SFX", "CAPTIONS", "TEXT", "GRAPHICS"] as const;
type TrackKind = (typeof TRACK_ORDER)[number];

const TRACK_COLOR: Record<TrackKind, string> = {
  VIDEO: "bg-cyan-500/30 border-cyan-400/50 hover:bg-cyan-500/45",
  VOICE: "bg-emerald-500/30 border-emerald-400/50 hover:bg-emerald-500/45",
  MUSIC: "bg-violet-500/30 border-violet-400/50 hover:bg-violet-500/45",
  SFX: "bg-amber-500/30 border-amber-400/50 hover:bg-amber-500/45",
  CAPTIONS: "bg-sky-500/30 border-sky-400/50 hover:bg-sky-500/45",
  TEXT: "bg-fuchsia-500/30 border-fuchsia-400/50 hover:bg-fuchsia-500/45",
  GRAPHICS: "bg-rose-500/30 border-rose-400/50 hover:bg-rose-500/45",
};

type Selection =
  | { kind: "VIDEO"; clip: VideoClip }
  | { kind: "CAPTIONS"; element: TextElement }
  | { kind: "TEXT"; element: TextElement }
  | { kind: "GRAPHICS"; element: TextElement }
  | { kind: "VOICE"; clip: AudioClip }
  | { kind: "MUSIC"; clip: AudioClip }
  | { kind: "SFX"; clip: AudioClip }
  | null;

/* ═══════════════════════ reading a timeline without rebuilding it ═══════════════════════ */

type LaneItem = { id: string; start: number; end: number; label: string; warn?: boolean };

function laneItems(timeline: Timeline, kind: TrackKind): LaneItem[] {
  const track = timeline.tracks.find((t) => t.kind === kind);
  if (!track) return [];
  if (track.kind === "VIDEO") {
    return track.clips.map((c) => ({
      id: c.id,
      start: c.timelineStart,
      end: c.timelineEnd,
      label: c.source.title || c.source.provider,
      /** §15 — a clip whose source cannot be fetched again is marked, never hidden. */
      warn: !c.source.canonicalUrl && !c.source.mediaUrl && c.source.archiveAssetId == null,
    }));
  }
  if (track.kind === "CAPTIONS") {
    return track.captions.map((c) => ({ id: c.id, start: c.start, end: c.end, label: c.text }));
  }
  if (track.kind === "TEXT" || track.kind === "GRAPHICS") {
    return track.texts.map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.text }));
  }
  return track.clips.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    label: c.source.title || c.source.provider,
  }));
}

function findSelection(timeline: Timeline, kind: TrackKind, id: string): Selection {
  const track = timeline.tracks.find((t) => t.kind === kind);
  if (!track) return null;
  if (track.kind === "VIDEO") {
    const clip = track.clips.find((c) => c.id === id);
    return clip ? { kind: "VIDEO", clip } : null;
  }
  if (track.kind === "CAPTIONS") {
    const el = track.captions.find((c) => c.id === id);
    return el ? { kind: "CAPTIONS", element: el } : null;
  }
  if (track.kind === "TEXT" || track.kind === "GRAPHICS") {
    const el = track.texts.find((t) => t.id === id);
    return el ? { kind: track.kind, element: el } : null;
  }
  const clip = track.clips.find((c) => c.id === id);
  return clip ? { kind: track.kind, clip } : null;
}

/** Replace one text element and leave every other object identical — §16, on the client side. */
function withEditedText(timeline: Timeline, id: string, patch: Partial<TextElement>): Timeline {
  const apply = (el: TextElement) => (el.id === id ? { ...el, ...patch } : el);
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) => {
      if (t.kind === "CAPTIONS") return { ...t, captions: t.captions.map(apply) };
      if (t.kind === "TEXT" || t.kind === "GRAPHICS") return { ...t, texts: t.texts.map(apply) };
      return t;
    }),
  };
}

function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/* ═══════════════════════ the editor ═══════════════════════ */

export function VideoEditor({ videoId, onClose }: { videoId: number; onClose: () => void }) {
  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.timeline.get.useQuery({ videoId });

  /** The document as last received from the server. The thing `dirty` compares against. */
  const [serverTimeline, setServerTimeline] = useState<Timeline | null>(null);
  const [draft, setDraft] = useState<Timeline | null>(null);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<{ kind: TrackKind; id: string } | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!data) return;
    setServerTimeline(data.timeline as Timeline);
    setDraft(data.timeline as Timeline);
    setVersion(data.timelineVersion);
    const running = data.renderJobs?.find((j) => j.status === "queued" || j.status === "running");
    if (running) setActiveJobId(running.id);
  }, [data]);

  /**
   * §20 — "unsaved" is a comparison, not a flag.
   *
   * A boolean set by each edit handler drifts the moment an edit is reverted by hand: the editor
   * claims changes that no longer exist and the close warning cries wolf.
   */
  const dirty = useMemo(
    () => Boolean(draft && serverTimeline && JSON.stringify(draft) !== JSON.stringify(serverTimeline)),
    [draft, serverTimeline]
  );

  /** §20 — a browser-level guard, because a click on the tab's × never reaches React. */
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** §10 — poll only while a job is actually running, and show its PHASE, never a fake percent. */
  const jobQuery = trpc.timeline.renderJob.useQuery(
    { videoId, jobId: activeJobId ?? 0 },
    {
      enabled: activeJobId != null,
      refetchInterval: (q) => {
        const s = q.state.data?.status;
        return s === "queued" || s === "running" ? 3000 : false;
      },
    }
  );

  const job = jobQuery.data;
  useEffect(() => {
    if (!job) return;
    if (job.status === "completed") {
      toast.success(
        job.errorCode === "RENDER_SUPERSEDED"
          ? "Render finished, but a newer render had already replaced it"
          : "Render complete — the new video is below"
      );
      void utils.timeline.get.invalidate({ videoId });
      setActiveJobId(null);
    } else if (job.status === "failed") {
      toast.error(`Render failed — ${job.errorCode}: ${job.errorMessage ?? "no detail recorded"}`);
      setActiveJobId(null);
    }
  }, [job?.status, job?.errorCode, job?.errorMessage, utils, videoId, job]);

  const saveMutation = trpc.timeline.save.useMutation();
  const renderMutation = trpc.timeline.render.useMutation();

  const save = async (): Promise<number | null> => {
    if (!draft) return null;
    try {
      const result = await saveMutation.mutateAsync({
        videoId,
        timeline: draft as never,
        expectedTimelineVersion: version,
      });
      setServerTimeline(result.timeline as Timeline);
      setDraft(result.timeline as Timeline);
      setVersion(result.timelineVersion);
      toast.success(`Saved — version ${result.timelineVersion}`);
      return result.timelineVersion;
    } catch (err) {
      // §18 — the server's own sentence, which names the conflict or lists the faults.
      toast.error((err as Error).message);
      return null;
    }
  };

  const saveAndRender = async () => {
    // §19 — never render before the timeline it renders is safely stored.
    const saved = dirty ? await save() : version;
    if (saved == null) return;
    try {
      const result = await renderMutation.mutateAsync({ videoId, timelineVersion: saved });
      setActiveJobId(result.job.id);
      toast.success("Render queued");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const requestClose = () => {
    if (dirty && !window.confirm("You have unsaved changes. Close the editor and lose them?")) return;
    onClose();
  };

  const selection = useMemo<Selection>(
    () => (draft && selectedId ? findSelection(draft, selectedId.kind, selectedId.id) : null),
    [draft, selectedId]
  );

  /** §13 — selecting an item seeks the player to where it begins. */
  const selectItem = (kind: TrackKind, id: string, start: number) => {
    setSelectedId({ kind, id });
    const el = videoRef.current;
    if (el && Number.isFinite(start)) el.currentTime = Math.max(0, start);
  };

  const previewUrl = data?.video.editedVideoUrl || data?.video.videoUrl || null;
  const duration = draft?.durationSec ?? 0;
  const rendering = job?.status === "queued" || job?.status === "running";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="glass-card border border-white/15 rounded-2xl w-full max-w-6xl max-h-[94vh] overflow-hidden flex flex-col">
        {/* ── header ── */}
        <div className="flex items-center justify-between gap-4 p-4 border-b border-white/8">
          <div className="min-w-0">
            <h2 className="font-bold text-white text-lg truncate">
              {data?.video.title ?? "Editor"}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Timeline v{version}
              {data?.timelineSource === "manifest" && " · rebuilt from the original render"}
              {" · "}
              <span className={dirty ? "text-amber-300" : "text-emerald-400"}>
                {dirty ? "Unsaved changes" : "Saved"}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void save()}
              disabled={!dirty || saveMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-white/5 border border-white/15 text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </button>
            <button
              onClick={() => void saveAndRender()}
              disabled={rendering || saveMutation.isPending || renderMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-purple-600/80 border border-purple-400/40 text-white hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {rendering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Save &amp; Render
            </button>
            <button onClick={requestClose} className="text-slate-400 hover:text-white transition-colors p-2">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── render status: a phase by name, never an invented percentage (§10) ── */}
        {job && (job.status === "queued" || job.status === "running") && (
          <div className="flex items-center gap-2 px-4 py-2 bg-purple-500/10 border-b border-purple-400/20 text-xs text-purple-200">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span className="font-medium">Rendering</span>
            <span className="text-purple-300/80">· {job.progressStep}</span>
            <span className="text-purple-300/50">· timeline v{job.timelineVersion}</span>
          </div>
        )}

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center p-16">
            <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex-1 flex items-start gap-3 p-6">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-300">This editor could not be opened</p>
              <p className="text-xs text-slate-400 mt-1">{error.message}</p>
            </div>
          </div>
        ) : draft ? (
          <div className="flex-1 overflow-y-auto">
            <div className="grid lg:grid-cols-[1fr_320px] gap-4 p-4">
              {/* ── player + timeline ── */}
              <div className="space-y-4 min-w-0">
                <div className="rounded-xl overflow-hidden border border-white/8 bg-black">
                  {previewUrl ? (
                    <video ref={videoRef} src={previewUrl} controls playsInline className="w-full max-h-[42vh]" />
                  ) : (
                    <div className="flex items-center justify-center gap-2 p-12 text-slate-500 text-sm">
                      <Play className="w-4 h-4" /> No preview available yet
                    </div>
                  )}
                </div>

                {data?.video.editedVideoUrl && (
                  <p className="text-[11px] text-slate-500">
                    Showing the last rendered edit
                    {data.video.editedVideoTimelineVersion != null &&
                      ` (from timeline v${data.video.editedVideoTimelineVersion})`}
                    . The original master is kept separately and is never overwritten.
                  </p>
                )}

                {/* ── §14: one lane per track, items sized by their real duration ── */}
                <div className="rounded-xl border border-white/8 bg-black/30 p-3 space-y-1.5 overflow-x-auto">
                  {TRACK_ORDER.map((kind) => {
                    const items = laneItems(draft, kind);
                    return (
                      <div key={kind} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-[10px] font-semibold tracking-wide text-slate-500">
                          {kind}
                        </span>
                        <div className="relative flex-1 h-8 rounded bg-white/[0.03] min-w-[420px]">
                          {items.length === 0 && (
                            <span className="absolute inset-0 flex items-center pl-2 text-[10px] text-slate-600">
                              empty
                            </span>
                          )}
                          {items.map((item) => {
                            const left = duration > 0 ? (item.start / duration) * 100 : 0;
                            const width = duration > 0 ? ((item.end - item.start) / duration) * 100 : 0;
                            const active = selectedId?.id === item.id;
                            return (
                              <button
                                key={item.id}
                                onClick={() => selectItem(kind, item.id, item.start)}
                                title={`${item.label} — ${fmt(item.start)} → ${fmt(item.end)}`}
                                style={{ left: `${left}%`, width: `${Math.max(width, 1.2)}%` }}
                                className={`absolute top-0 h-8 rounded border px-1.5 text-[10px] text-white/90 truncate text-left transition-colors ${TRACK_COLOR[kind]} ${
                                  active ? "ring-2 ring-white/70 z-10" : ""
                                }`}
                              >
                                {item.warn ? "⚠ " : ""}
                                {item.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {data && data.recovery.previewOnly > 0 && (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                    <AlertCircle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-200/90">
                      {data.recovery.previewOnly} of {data.recovery.total} shots have no source that can
                      be fetched again. They can be replaced, but a re-render cannot reproduce them —
                      marked ⚠ above.
                    </p>
                  </div>
                )}
              </div>

              {/* ── §15/§16: the inspector ── */}
              <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 h-fit">
                {!selection ? (
                  <p className="text-xs text-slate-500">Select an item on the timeline to inspect it.</p>
                ) : selection.kind === "VIDEO" ? (
                  <ClipInspector clip={selection.clip} />
                ) : selection.kind === "VOICE" || selection.kind === "MUSIC" || selection.kind === "SFX" ? (
                  <AudioInspector kind={selection.kind} clip={selection.clip} />
                ) : (
                  <TextInspector
                    kind={selection.kind}
                    element={selection.element}
                    onChange={(patch) => setDraft((t) => (t ? withEditedText(t, selection.element.id, patch) : t))}
                  />
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ═══════════════════════ inspectors ═══════════════════════ */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-white/5 last:border-0">
      <span className="text-[10px] uppercase tracking-wide text-slate-500 shrink-0">{label}</span>
      <span className="text-xs text-slate-200 text-right break-all">{value}</span>
    </div>
  );
}

/**
 * §15 — the clip's identity, shown as stored.
 *
 * Including, and especially, when it is not recoverable. Hiding that would mean the person finds
 * out at render time, ten minutes later, about a shot they could have replaced in ten seconds.
 */
function ClipInspector({ clip }: { clip: VideoClip }) {
  const recoverable =
    Boolean(clip.source.canonicalUrl || clip.source.mediaUrl) || clip.source.archiveAssetId != null;
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Film className="w-4 h-4 text-cyan-400" /> {clip.kind === "image" ? "Image" : "Shot"}
      </h3>
      {!recoverable && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-amber-200/90">
            Source cannot be rehydrated. A re-render cannot reproduce this shot — replace it first.
          </p>
        </div>
      )}
      <div>
        <Field label="Title" value={clip.source.title || "—"} />
        <Field label="Provider" value={clip.source.provider} />
        <Field label="Asset id" value={clip.source.providerAssetId ?? (clip.source.archiveAssetId != null ? `archive:${clip.source.archiveAssetId}` : "—")} />
        <Field label="Timeline" value={`${fmt(clip.timelineStart)} → ${fmt(clip.timelineEnd)}`} />
        <Field label="Duration" value={`${(clip.timelineEnd - clip.timelineStart).toFixed(2)}s`} />
        {/* An absent trim is shown as "not recorded", not as 0 — §15 of RONDE 147. */}
        <Field label="Source in" value={clip.sourceIn != null ? `${clip.sourceIn.toFixed(2)}s` : "not recorded"} />
        <Field label="Source out" value={clip.sourceOut != null ? `${clip.sourceOut.toFixed(2)}s` : "not recorded"} />
        <Field label="Transition" value={`${clip.transitionIn} → ${clip.transitionOut}`} />
        {clip.editedByUser && <Field label="Edited" value="replaced by you" />}
      </div>
    </div>
  );
}

function AudioInspector({ kind, clip }: { kind: "VOICE" | "MUSIC" | "SFX"; clip: AudioClip }) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Music className="w-4 h-4 text-emerald-400" /> {kind}
      </h3>
      <div>
        <Field label="Source" value={clip.source.title || clip.source.provider} />
        <Field label="Timeline" value={`${fmt(clip.start)} → ${fmt(clip.end)}`} />
        <Field label="Gain" value={clip.gain.toFixed(2)} />
      </div>
    </div>
  );
}

/** §16 — the one thing in this editor a person can actually change. */
function TextInspector({
  kind,
  element,
  onChange,
}: {
  kind: "CAPTIONS" | "TEXT" | "GRAPHICS";
  element: TextElement;
  onChange: (patch: Partial<TextElement>) => void;
}) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <TypeIcon className="w-4 h-4 text-fuchsia-400" /> {kind === "CAPTIONS" ? "Caption" : kind}
      </h3>
      <label className="block">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">Text</span>
        <textarea
          value={element.text}
          onChange={(e) => onChange({ text: e.target.value })}
          rows={3}
          className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-2.5 py-2 text-xs text-white focus:border-fuchsia-400/50 focus:outline-none resize-y"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Start (s)</span>
          <input
            type="number"
            step="0.1"
            min="0"
            value={element.start}
            onChange={(e) => onChange({ start: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs text-white focus:border-fuchsia-400/50 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">End (s)</span>
          <input
            type="number"
            step="0.1"
            min="0"
            value={element.end}
            onChange={(e) => onChange({ end: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs text-white focus:border-fuchsia-400/50 focus:outline-none"
          />
        </label>
      </div>
      {element.style?.position && <Field label="Position" value={element.style.position} />}
      {element.style?.fontSizePx != null && <Field label="Font size" value={`${element.style.fontSizePx}px`} />}
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Changes are local until you press Save. Rendering always saves first.
      </p>
    </div>
  );
}
