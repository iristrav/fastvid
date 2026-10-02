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
  canRedo,
  canUndo,
  newHistory,
  recordEdit,
  redo,
  undo,
  type History,
  type HistoryPolicy,
} from "@shared/timelineHistory";
import {
  addText,
  captionCounts,
  insertVideoClip,
  moveVideoClip,
  removeAudioClip,
  removeTextElement,
  removeVideoClip,
  setAllCaptionsShown,
  setAllCaptionsStyle,
  setAudioClip,
  setAudioClipTiming,
  setTextElementShown,
  setTextElementTiming,
  setVideoClipLength,
  setVideoClipSourceIn,
  setVideoClipSpeed,
  duplicateVideoClip,
  splitVideoClip,
  type AudioPatch,
  type EditableTimeline,
  type EditableVideoClip,
} from "@shared/timelineEdits";
import {
  EDITOR_EFFECTS,
  EDITOR_TRANSITIONS,
  applyEditorOps,
  cameraPreset,
  withEffect,
} from "@shared/editorCommands";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Captions,
  Copy,
  History as HistoryIcon,
  Sparkles,
  Wand2,
  ZoomIn,
  ZoomOut,
  Eye,
  EyeOff,
  Film,
  ImagePlus,
  Plus,
  Scissors,
  Trash2,
  Loader2,
  Music,
  Palette,
  Pause,
  Play,
  RefreshCw,
  Redo2,
  Repeat,
  Save,
  Undo2,
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
  /* RONDE 148 — what the planner decided about framing, movement and treatment. */
  transform?: {
    fit?: "contain" | "cover" | "crop";
    crop?: { x: number; y: number; width: number; height: number };
    scale?: number;
    positionX?: number;
    positionY?: number;
    opacity?: number;
  };
  camera?: { type: string; startScale?: number; endScale?: number; intensity?: number };
  sourceKind?: "archive" | "ai_generated" | "stock" | "unknown";
  effects?: Array<{ effectType: string; intensity: number; reason?: string }>;
  transitionInSec?: number;
  /** Playback speed of a video shot; absent = 1×. */
  speed?: number;
};

/** RONDE 148 §12 — a graphic carries a payload, so it is no longer a text element. */
type GraphicElement = {
  id: string;
  graphicType: string;
  data: Record<string, unknown>;
  start: number;
  end: number;
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  reason?: string;
};

type TextStyle = {
  position?: string;
  fontSizePx?: number;
  color?: string;
  backgroundOpacity?: number;
  backgroundColor?: string;
};

type TextElement = {
  id: string;
  text: string;
  start: number;
  end: number;
  style?: TextStyle;
  /** How it comes on screen: fade, rise, typewriter… — drawn by the renderer's text layer. */
  animation?: string;
  disabled?: boolean;
  /** VIDEO 619 — why the pipeline left it off; "left_to_editor" means: yours to switch on. */
  disabledReason?: string;
};

/** VIDEO 619 — how a text the person adds looks until they change it. */
const NEW_TEXT_STYLE = {
  fontSizePx: 64,
  color: "white",
  backgroundOpacity: 0.35,
  backgroundColor: "black",
  position: "lower_third",
};

type AudioClip = {
  id: string;
  source: AssetSourceIdentity;
  start: number;
  end: number;
  gain: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** Muted: left out of the mix, kept on the timeline. */
  disabled?: boolean;
};

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
  | { kind: "AMBIENT"; clips: AudioClip[] }
  /**
   * Read in BOTH shapes. Every timeline saved before RONDE 148 holds `texts` here, and the editor
   * must open those too — reading only `graphics` would crash on every existing video.
   */
  | { kind: "GRAPHICS"; graphics?: GraphicElement[]; texts?: TextElement[] };

type Timeline = {
  schemaVersion?: number;
  version: number;
  videoId: number;
  durationSec: number;
  format: { widthPx: number; heightPx: number; fps: number };
  tracks: Track[];
  /** RONDE 149 — the video's colour treatment. Absent means untouched pixels. */
  look?: { grade: "none" | "documentary"; strength?: number };
  renderedVideoUrl?: string;
  createdAt: string;
};

/** §14 — every track kind gets a lane, in the order they stack in the picture and the mix. */
const TRACK_ORDER = ["VIDEO", "VOICE", "MUSIC", "AMBIENT", "SFX", "CAPTIONS", "TEXT", "GRAPHICS"] as const;
type TrackKind = (typeof TRACK_ORDER)[number];

const TRACK_COLOR: Record<TrackKind, string> = {
  VIDEO: "bg-cyan-500/30 border-cyan-400/50 hover:bg-cyan-500/45",
  VOICE: "bg-emerald-500/30 border-emerald-400/50 hover:bg-emerald-500/45",
  MUSIC: "bg-violet-500/30 border-violet-400/50 hover:bg-violet-500/45",
  AMBIENT: "bg-teal-500/30 border-teal-400/50 hover:bg-teal-500/45",
  SFX: "bg-amber-500/30 border-amber-400/50 hover:bg-amber-500/45",
  CAPTIONS: "bg-sky-500/30 border-sky-400/50 hover:bg-sky-500/45",
  TEXT: "bg-fuchsia-500/30 border-fuchsia-400/50 hover:bg-fuchsia-500/45",
  GRAPHICS: "bg-rose-500/30 border-rose-400/50 hover:bg-rose-500/45",
};

type Selection =
  | { kind: "VIDEO"; clip: VideoClip }
  | { kind: "CAPTIONS"; element: TextElement }
  | { kind: "TEXT"; element: TextElement }
  | { kind: "GRAPHICS"; graphic: GraphicElement }
  | { kind: "VOICE"; clip: AudioClip }
  | { kind: "MUSIC"; clip: AudioClip }
  | { kind: "SFX"; clip: AudioClip }
  | { kind: "AMBIENT"; clip: AudioClip }
  | null;

/* ═══════════════════════ reading a timeline without rebuilding it ═══════════════════════ */

type LaneItem = { id: string; start: number; end: number; label: string; warn?: boolean; off?: boolean };

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
    return track.captions.map((c) => ({ id: c.id, start: c.start, end: c.end, label: c.text, off: c.disabled }));
  }
  if (track.kind === "TEXT") {
    return track.texts.map((t) => ({ id: t.id, start: t.start, end: t.end, label: t.text, off: t.disabled }));
  }
  if (track.kind === "GRAPHICS") {
    return readGraphics(track).map((g) => ({
      id: g.id, start: g.start, end: g.end,
      label: g.label || g.graphicType,
      /** A graphic with neither words nor a map/route/chart payload cannot be drawn — marked, never hidden. */
      warn: !graphicIsDrawable(g),
      off: g.disabled,
    }));
  }
  return track.clips.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    label: c.source.title || c.source.provider,
  }));
}

/**
 * The GRAPHICS track in either shape.
 *
 * RONDE 148 changed it from text elements to graphics with a payload, and every timeline saved
 * before that still holds the old array. The editor has to open those, so both are read and a
 * legacy text element is presented as the graphic it always was.
 */
function readGraphics(track: { graphics?: GraphicElement[]; texts?: TextElement[] }): GraphicElement[] {
  if (Array.isArray(track.graphics)) return track.graphics;
  return (track.texts ?? []).map((t) => ({
    id: t.id, graphicType: "text", data: {}, start: t.start, end: t.end,
    label: t.text, disabled: t.disabled,
  }));
}

/**
 * Whether the render can draw a graphic: words (any renderer), or a map point, route or chart
 * payload (the Remotion graphics layer of the normal render). Mirrors `chartPayloadIsRenderable`.
 */
function graphicIsDrawable(g: GraphicElement): boolean {
  if (g.label?.trim()) return true;
  const d = g.data ?? {};
  if (typeof d.normX === "number" && typeof d.normY === "number") return true;
  const points = d.points ?? d.route;
  if (Array.isArray(points) && points.length > 0) return true;
  const series = d.series ?? d.values ?? d.data;
  return Array.isArray(series) && series.length > 0;
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
  if (track.kind === "TEXT") {
    const el = track.texts.find((t) => t.id === id);
    return el ? { kind: "TEXT", element: el } : null;
  }
  if (track.kind === "GRAPHICS") {
    const g = readGraphics(track).find((x) => x.id === id);
    return g ? { kind: "GRAPHICS", graphic: g } : null;
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
      if (t.kind === "TEXT") return { ...t, texts: t.texts.map(apply) };
      return t;
    }),
  };
}

/**
 * Patch one video clip's transform/camera, leaving every other clip the SAME object.
 *
 * §17's rule applied to the geometry too: changing how a shot is framed must not move it, and must
 * not touch the shot next to it. Mapping rather than rebuilding is what makes that true by
 * construction rather than by care.
 */
function withEditedClip(timeline: Timeline, id: string, patch: Partial<VideoClip>): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((t) =>
      t.kind === "VIDEO"
        ? { ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
        : t
    ),
  };
}

/** A timeline without the fields that change on every save without changing the picture. */
function contentOf({ version: _v, createdAt: _c, ...rest }: Timeline) {
  return rest;
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
  /**
   * RONDE 181 §13 — the draft, WITH its undo stack.
   *
   * The draft is `history.present` rather than a state of its own: two pieces of state both
   * claiming to be "the current edit" is how an undo stack drifts out of step with what is on
   * screen. There is one document, and the past and future sit beside it.
   *
   * The mechanics are `@shared/timelineHistory`, the same module the server binds to — not a second
   * stack written into this component. Two stacks with slightly different rules about when a step
   * is recorded would disagree about what "one undo" is, and that disagreement only ever shows up
   * as a person pressing undo and getting back the wrong document.
   */
  const [history, setHistory] = useState<History<Timeline> | null>(null);
  const draft = history?.present ?? null;
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<{ kind: TrackKind; id: string } | null>(null);

  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * RONDE 158 §13/§14 — where the playhead is, in seconds.
   *
   * Driven BY the video element rather than by a timer of our own. A second clock would drift
   * against the one the viewer is actually watching, and the playhead would slowly stop meaning
   * what it points at.
   */
  const [playheadSec, setPlayheadSec] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!data) return;
    setServerTimeline(data.timeline as Timeline);
    /** A fresh document from the server starts a new stack — nobody undoes past a load. */
    setHistory(newHistory(data.timeline as Timeline));
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
    () => Boolean(draft && serverTimeline && JSON.stringify(contentOf(draft)) !== JSON.stringify(contentOf(serverTimeline))),
    [draft, serverTimeline]
  );

  /**
   * RONDE 181 — the two decisions the shared mechanics leave to the document's owner.
   *
   * `sameContent` is the SAME structural comparison `dirty` above uses, with the fields that change
   * without changing the picture removed: an edit that only bumps a version or a timestamp is not
   * an edit to undo. The server binds this to `timelineDigest`, which excludes exactly those.
   *
   * `restore` puts the old content back under a NEW version number. Restoring the old number too
   * would put two different documents into circulation as one version, and `timeline.save`'s
   * concurrency check compares versions — so it would see no conflict and let one silently
   * overwrite the other.
   */
  const historyPolicy = useMemo<HistoryPolicy<Timeline>>(
    () => ({
      sameContent: (a, b) => JSON.stringify(contentOf(a)) === JSON.stringify(contentOf(b)),
      restore: (previous, current) => ({
        ...previous,
        version: current.version + 1,
        createdAt: new Date().toISOString(),
      }),
    }),
    []
  );

  /**
   * Every EDIT goes through here, so the undo stack cannot miss one.
   *
   * Reloading from the server is not an edit and deliberately does not use this — see the
   * `newHistory` calls, which start a fresh stack rather than making the server's own document
   * something a person can undo past.
   */
  const applyEdit = (next: (t: Timeline) => Timeline) => {
    setHistory((h) => (h ? recordEdit(h, next(h.present), historyPolicy) : h));
  };

  const undoEdit = () => setHistory((h) => (h ? undo(h, historyPolicy) : h));
  const redoEdit = () => setHistory((h) => (h ? redo(h, historyPolicy) : h));

  /**
   * VIDEO 619 — the structural edits (add, remove, move, length, cut, show/hide) come from
   * `@shared/timelineEdits`, the one place that keeps the picture unbroken and as long as the voice.
   */
  const edit = (fn: (t: EditableTimeline) => EditableTimeline) =>
    applyEdit((t) => fn(t as unknown as EditableTimeline) as unknown as Timeline);
  const [browserOpen, setBrowserOpen] = useState(false);

  /**
   * §13 — the keyboard, because nobody reaches for a toolbar to undo.
   *
   * Ignored while a text field has focus: ⌘Z in a caption box means "undo my typing", and stealing
   * it would make the field unusable.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const el = document.activeElement;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (el as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      if (e.shiftKey) redoEdit();
      else undoEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyPolicy]);

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
  const restoreMutation = trpc.timeline.restoreVersion.useMutation();
  const autoReplaceMutation = trpc.timeline.autoReplaceClip.useMutation();
  const aiEditMutation = trpc.timeline.aiEdit.useMutation();

  /**
   * Save the draft. Used by the Save button, by Render, and by autosave a moment after every edit.
   *
   * The undo stack is KEPT across a save: with autosave a person never chooses a moment to save,
   * so a save cannot be the end of what they can undo. The server ignores the draft's own version
   * field and compares `expectedTimelineVersion`, so undoing past a save and saving again is an
   * ordinary new version — and every version is kept in the history to restore.
   */
  const savingRef = useRef<Promise<number | null> | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const save = async (label?: string, quiet = false): Promise<number | null> => {
    if (savingRef.current) return savingRef.current;
    if (!draft) return null;
    const sent = draft;
    const run = (async () => {
      try {
        const result = await saveMutation.mutateAsync({
          videoId,
          timeline: sent as never,
          expectedTimelineVersion: version,
          ...(label ? { label } : {}),
        });
        setServerTimeline(result.timeline as Timeline);
        /** The saved document carries the server's version; the draft follows it if nothing changed meanwhile. */
        setHistory((h) => (h && h.present === sent ? { ...h, present: result.timeline as Timeline } : h));
        setVersion(result.timelineVersion);
        setLastSavedAt(new Date());
        if (!quiet) toast.success(`Saved — version ${result.timelineVersion}`);
        void utils.timeline.versions.invalidate({ videoId });
        return result.timelineVersion;
      } catch (err) {
        // §18 — the server's own sentence, which names the conflict or lists the faults.
        toast.error((err as Error).message);
        return null;
      } finally {
        savingRef.current = null;
      }
    })();
    savingRef.current = run;
    return run;
  };

  /** Autosave: two seconds after the last change, unless a save or render is already under way. */
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  useEffect(() => {
    if (!dirty || autosaveFailed) return;
    const timer = setTimeout(() => {
      void save("autosave", true).then((v) => {
        if (v == null) setAutosaveFailed(true);
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [draft, dirty, autosaveFailed]);

  const saveAndRender = async () => {
    // §19 — never render before the timeline it renders is safely stored.
    const saved = dirty ? await save("save before render", true) : version;
    if (saved == null) return;
    try {
      const result = await renderMutation.mutateAsync({ videoId, timelineVersion: saved });
      setActiveJobId(result.job.id);
      toast.success("Render queued");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  /**
   * Replace shots through the archive + Visual Judge route. The replacement is saved on the server
   * against the saved version, so the draft is saved first and reloaded after.
   */
  const autoReplace = async (clipIds: string[]) => {
    let at = dirty ? await save("save before replace", true) : version;
    if (at == null) return;
    let replaced = 0;
    for (const clipId of clipIds) {
      try {
        const r = await autoReplaceMutation.mutateAsync({ videoId, clipId, expectedTimelineVersion: at });
        at = r.timelineVersion;
        replaced++;
        toast.success(`Shot replaced — ${r.verdict}`);
      } catch (err) {
        toast.error((err as Error).message);
      }
    }
    if (replaced > 0) {
      void utils.timeline.get.invalidate({ videoId });
      void utils.timeline.versions.invalidate({ videoId });
    }
  };

  /** An instruction in words → editor operations → the same undoable edits a click makes. */
  const runAiCommand = async (instruction: string): Promise<boolean> => {
    if (!draft) return false;
    try {
      const plan = await aiEditMutation.mutateAsync({
        videoId,
        instruction,
        timeline: draft as never,
        ...(selectedId ? { selectedId: selectedId.id } : {}),
        playheadSec,
      });
      if (plan.ops.length === 0) {
        toast.message(plan.summary || "Nothing to change");
        return false;
      }
      const applied = applyEditorOps(draft as unknown as EditableTimeline, plan.ops);
      applyEdit(() => applied.timeline as unknown as Timeline);
      toast.success(plan.summary);
      if (applied.replaceClipIds.length > 0) {
        /** After the edit has rendered, so the replace saves the draft that includes it. */
        setTimeout(() => void latest.current.autoReplace(applied.replaceClipIds), 100);
      }
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
  };

  /** The newest closures, for work scheduled from an older render (see `runAiCommand`). */
  const latest = useRef({ autoReplace });
  latest.current = { autoReplace };

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
              <span className={saveMutation.isPending ? "text-sky-300" : dirty ? "text-amber-300" : "text-emerald-400"}>
                {saveMutation.isPending
                  ? "Saving…"
                  : dirty
                    ? autosaveFailed ? "Not saved — press Save" : "Unsaved changes"
                    : lastSavedAt ? `All changes saved · ${lastSavedAt.toLocaleTimeString()}` : "Saved"}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/*
              RONDE 149 — the look sits in the HEADER, not in the clip inspector, because it is a
              choice about the whole video. Its job is to make archive, stock and generated material
              look like one film, which per-clip control would defeat exactly.
            */}
            <label className="flex items-center gap-1.5">
              <Palette className="w-3.5 h-3.5 text-amber-300 shrink-0" />
              <select
                value={draft?.look?.grade ?? "none"}
                onChange={(e) =>
                  applyEdit((t) => ({
                    ...t,
                    look: { ...t.look, grade: e.target.value as "none" | "documentary" },
                  }))
                }
                className="rounded-lg bg-black/40 border border-white/10 px-2 py-1.5 text-xs text-white focus:border-amber-400/50 focus:outline-none"
                title="Colour treatment for the whole video"
              >
                <option value="none" className="bg-slate-900">No grade</option>
                <option value="documentary" className="bg-slate-900">Documentary</option>
              </select>
            </label>
            {/*
              RONDE 181 §13 — Undo and Redo, next to Save because that is where a person looks for
              them. Disabled rather than hidden: a greyed-out Undo says "there is nothing to undo",
              where a missing one says "this editor cannot undo".
            */}
            <button
              onClick={undoEdit}
              disabled={!history || !canUndo(history)}
              title="Undo (⌘Z)"
              aria-label="Undo"
              className="flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-white/5 border border-white/15 text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={redoEdit}
              disabled={!history || !canRedo(history)}
              title="Redo (⇧⌘Z)"
              aria-label="Redo"
              className="flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-white/5 border border-white/15 text-white hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>
            <VersionHistory
              videoId={videoId}
              currentVersion={version}
              onRestore={async (snapshotId) => {
                if (dirty && (await save("save before restore", true)) == null) return;
                try {
                  await restoreMutation.mutateAsync({ videoId, snapshotId, expectedTimelineVersion: version });
                  void utils.timeline.get.invalidate({ videoId });
                  void utils.timeline.versions.invalidate({ videoId });
                  toast.success("Earlier version restored");
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            />
            <button
              onClick={() => { setAutosaveFailed(false); void save(); }}
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
                    <video
                      ref={videoRef}
                      src={previewUrl}
                      controls
                      playsInline
                      className="w-full max-h-[42vh]"
                      onTimeUpdate={(e) => setPlayheadSec(e.currentTarget.currentTime)}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onSeeked={(e) => setPlayheadSec(e.currentTarget.currentTime)}
                    />
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

                {/* ── RONDE 158 §14 — transport and scrubber ── */}
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      const el = videoRef.current;
                      if (!el) return;
                      if (el.paused) void el.play();
                      else el.pause();
                    }}
                    disabled={!previewUrl}
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 transition"
                    aria-label={playing ? "Pause" : "Play"}
                  >
                    {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  {/*
                    The scrubber is bound to the TIMELINE's duration, not the preview file's.
                    They can differ — the preview may be an older render — and the playhead has to
                    agree with the lanes underneath it, which are laid out on the timeline's clock.
                  */}
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.1, duration)}
                    step={0.05}
                    value={Math.min(playheadSec, duration)}
                    onChange={(e) => {
                      const at = Number(e.target.value);
                      setPlayheadSec(at);
                      if (videoRef.current) videoRef.current.currentTime = at;
                    }}
                    className="flex-1 accent-cyan-400"
                    aria-label="Scrub"
                  />
                  <span className="text-[11px] tabular-nums text-slate-400 w-24 text-right">
                    {fmt(playheadSec)} / {fmt(duration)}
                  </span>
                </div>

                {/* ── VIDEO 619 — what a person adds to the film ── */}
                <EditToolbar
                  captions={captionCounts(draft as unknown as EditableTimeline)}
                  onAddShot={() => setBrowserOpen(true)}
                  onAddText={() => {
                    const id = `txt_u${Date.now().toString(36)}`;
                    edit((t) => addText(t, { text: "Your text", atSec: playheadSec, style: NEW_TEXT_STYLE, id }));
                    setSelectedId({ kind: "TEXT", id });
                  }}
                  onSubtitles={(shown) => edit((t) => setAllCaptionsShown(t, shown))}
                />
                {browserOpen && (
                  <ArchiveBrowser
                    videoId={videoId}
                    onClose={() => setBrowserOpen(false)}
                    onChoose={async (archiveAssetId) => {
                      try {
                        const shot = await utils.timeline.clipFromArchive.fetch({ videoId, archiveAssetId });
                        /** After the chosen shot, else after the shot under the playhead, else at the end. */
                        const clips = (draft.tracks.find((t) => t.kind === "VIDEO") as { clips: VideoClip[] } | undefined)?.clips ?? [];
                        const afterId =
                          (selectedId?.kind === "VIDEO" ? selectedId.id : null) ??
                          clips.find((c) => c.timelineStart <= playheadSec && playheadSec < c.timelineEnd)?.id ??
                          clips[clips.length - 1]?.id ??
                          null;
                        edit((t) => insertVideoClip(t, shot as unknown as EditableVideoClip, afterId));
                        setSelectedId({ kind: "VIDEO", id: shot.id });
                        setBrowserOpen(false);
                        toast.success("Shot added — save & render to see it in the video");
                      } catch (err) {
                        toast.error((err as Error).message);
                      }
                    }}
                  />
                )}

                {/* ── AI editing: words in, ordinary undoable edits out ── */}
                <AiCommandBar busy={aiEditMutation.isPending || autoReplaceMutation.isPending} onRun={runAiCommand} />

                {/* ── §14: one lane per track, items sized by their real duration ── */}
                <TimelineLanes
                  timeline={draft}
                  duration={duration}
                  playheadSec={playheadSec}
                  selectedId={selectedId?.id ?? null}
                  onSeek={(at) => {
                    setPlayheadSec(at);
                    if (videoRef.current) videoRef.current.currentTime = at;
                  }}
                  onSelect={selectItem}
                  onDragEnd={(kind, id, mode, deltaSec) => {
                    const item = laneItems(draft, kind).find((x) => x.id === id);
                    if (!item || Math.abs(deltaSec) < 0.05) return;
                    if (kind === "VIDEO") {
                      if (mode === "end") edit((t) => setVideoClipLength(t, id, item.end - item.start + deltaSec));
                      else if (mode === "move") edit((t) => moveVideoClipTo(t, id, item.start + deltaSec));
                      return;
                    }
                    if (kind === "CAPTIONS" || kind === "TEXT" || kind === "GRAPHICS") {
                      const start = mode === "end" ? item.start : item.start + deltaSec;
                      const end = mode === "start" ? item.end : item.end + deltaSec;
                      edit((t) => setTextElementTiming(t, kind, id, start, end));
                      return;
                    }
                    if ((kind === "MUSIC" || kind === "SFX" || kind === "AMBIENT") && mode === "move") {
                      edit((t) => setAudioClipTiming(t, kind, id, item.start + deltaSec));
                    }
                  }}
                />

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
                  <ClipInspector
                    clip={selection.clip}
                    onChange={(patch) =>
                      applyEdit((t) => withEditedClip(t, selection.clip.id, patch))
                    }
                    videoId={videoId}
                    timelineVersion={version}
                    /**
                     * RONDE 156 — a replacement is saved SERVER-SIDE by its own route, so the
                     * editor's draft is now behind. Refetching is the only correct response:
                     * keeping the local draft would let the next save write the old source back
                     * over the replacement the person just chose.
                     */
                    onReplaced={() => {
                      void utils.timeline.get.invalidate({ videoId });
                      toast.success("Shot replaced");
                    }}
                    playheadSec={playheadSec}
                    onLength={(sec) => edit((t) => setVideoClipLength(t, selection.clip.id, sec))}
                    onSourceIn={(sec) => edit((t) => setVideoClipSourceIn(t, selection.clip.id, sec))}
                    onMove={(dir) => edit((t) => moveVideoClip(t, selection.clip.id, dir))}
                    onSplit={() => edit((t) => splitVideoClip(t, selection.clip.id, playheadSec))}
                    onRemove={() => {
                      edit((t) => removeVideoClip(t, selection.clip.id));
                      setSelectedId(null);
                    }}
                    onDuplicate={() => edit((t) => duplicateVideoClip(t, selection.clip.id))}
                    onSpeed={(speed) => edit((t) => setVideoClipSpeed(t, selection.clip.id, speed))}
                    onAutoReplace={() => void autoReplace([selection.clip.id])}
                    autoReplacing={autoReplaceMutation.isPending}
                  />
                ) : selection.kind === "VOICE" || selection.kind === "MUSIC" ||
                  selection.kind === "SFX" || selection.kind === "AMBIENT" ? (
                  <AudioInspector
                    kind={selection.kind}
                    clip={selection.clip}
                    onChange={(patch) => edit((t) => setAudioClip(t, selection.kind as "VOICE", selection.clip.id, patch))}
                    onRemove={
                      selection.kind === "VOICE"
                        ? undefined
                        : () => {
                            const kind = selection.kind as "MUSIC" | "SFX" | "AMBIENT";
                            edit((t) => removeAudioClip(t, kind, selection.clip.id));
                            setSelectedId(null);
                          }
                    }
                  />
                ) : selection.kind === "GRAPHICS" ? (
                  <GraphicInspector
                    graphic={selection.graphic}
                    onShown={(shown) => edit((t) => setTextElementShown(t, "GRAPHICS", selection.graphic.id, shown))}
                    onTiming={(start, end) => edit((t) => setTextElementTiming(t, "GRAPHICS", selection.graphic.id, start, end))}
                    onRemove={() => {
                      edit((t) => removeTextElement(t, "GRAPHICS", selection.graphic.id));
                      setSelectedId(null);
                    }}
                  />
                ) : (
                  <TextInspector
                    kind={selection.kind}
                    element={selection.element}
                    onChange={(patch) => applyEdit((t) => withEditedText(t, selection.element.id, patch))}
                    onTiming={(start, end) => edit((t) => setTextElementTiming(t, selection.kind, selection.element.id, start, end))}
                    onStyleAllCaptions={
                      selection.kind === "CAPTIONS"
                        ? (style) => edit((t) => setAllCaptionsStyle(t, style as Record<string, unknown>))
                        : undefined
                    }
                    onShown={(shown) => edit((t) => setTextElementShown(t, selection.kind, selection.element.id, shown))}
                    onRemove={() => {
                      edit((t) => removeTextElement(t, selection.kind, selection.element.id));
                      setSelectedId(null);
                    }}
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

/* ═══════════════════════ the timeline lanes ═══════════════════════ */

type DragMode = "move" | "start" | "end";

/**
 * Move a shot so it starts at (or just after) a moment on the timeline, by swapping it with its
 * neighbours — the picture stays one unbroken line, so a drag reorders rather than leaving a gap.
 */
function moveVideoClipTo<T extends EditableTimeline>(t: T, id: string, atSec: number): T {
  let out = t;
  for (let guard = 0; guard < 500; guard++) {
    const clips = (out.tracks.find((x) => x.kind === "VIDEO") as { clips?: EditableVideoClip[] } | undefined)?.clips ?? [];
    const sorted = [...clips].sort((a, b) => a.timelineStart - b.timelineStart);
    const i = sorted.findIndex((c) => c.id === id);
    if (i < 0) return out;
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    /** Where the dragged shot's middle now is, against its neighbours' middles. */
    const centre = atSec + (sorted[i]!.timelineEnd - sorted[i]!.timelineStart) / 2;
    if (prev && centre < (prev.timelineStart + prev.timelineEnd) / 2) out = moveVideoClip(out, id, -1);
    else if (next && centre > (next.timelineStart + next.timelineEnd) / 2) out = moveVideoClip(out, id, 1);
    else return out;
  }
  return out;
}

/**
 * One lane per track, zoomable and scrollable. Drag an item to move it, drag its right edge to
 * make it longer or shorter (a text's left edge too). The drag is applied once, when the mouse is
 * released, through the same shared edits the inspector uses — one undo step per drag.
 */
function TimelineLanes({
  timeline,
  duration,
  playheadSec,
  selectedId,
  onSeek,
  onSelect,
  onDragEnd,
}: {
  timeline: Timeline;
  duration: number;
  playheadSec: number;
  selectedId: string | null;
  onSeek: (sec: number) => void;
  onSelect: (kind: TrackKind, id: string, start: number) => void;
  onDragEnd: (kind: TrackKind, id: string, mode: DragMode, deltaSec: number) => void;
}) {
  const [pxPerSec, setPxPerSec] = useState(0);
  const [drag, setDrag] = useState<{ kind: TrackKind; id: string; mode: DragMode; x0: number; dx: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Fit the whole film into the visible width until the person zooms. */
  const fitPx = useMemo(() => {
    const w = boxRef.current?.clientWidth ?? 720;
    return duration > 0 ? Math.max(4, (w - 80) / duration) : 20;
  }, [duration, boxRef.current?.clientWidth]);
  const scale = pxPerSec > 0 ? pxPerSec : fitPx;
  const laneWidth = Math.max(420, duration * scale);

  /** The latest drag and callback, read once on mouse-up — never inside a state updater. */
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;
  useEffect(() => {
    if (!drag) return;
    const moveHandler = (e: MouseEvent) => setDrag((d) => (d ? { ...d, dx: e.clientX - d.x0 } : d));
    const upHandler = () => {
      const d = dragRef.current;
      setDrag(null);
      if (d && Math.abs(d.dx) > 3) onDragEndRef.current(d.kind, d.id, d.mode, d.dx / scale);
    };
    window.addEventListener("mousemove", moveHandler);
    window.addEventListener("mouseup", upHandler);
    return () => {
      window.removeEventListener("mousemove", moveHandler);
      window.removeEventListener("mouseup", upHandler);
    };
  }, [drag?.id, drag?.mode, scale]);

  return (
    <div className="rounded-xl border border-white/8 bg-black/30 p-3 space-y-2" ref={boxRef}>
      <div className="flex items-center gap-2 text-[10px] text-slate-500">
        <button type="button" aria-label="Zoom out" className="p-1 rounded hover:bg-white/10" onClick={() => setPxPerSec(Math.max(2, scale / 1.5))}>
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button type="button" aria-label="Zoom in" className="p-1 rounded hover:bg-white/10" onClick={() => setPxPerSec(Math.min(400, scale * 1.5))}>
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="px-1.5 py-0.5 rounded hover:bg-white/10" onClick={() => setPxPerSec(0)}>Fit</button>
        <span>Drag to move · drag an edge to trim</span>
      </div>
      <div className="overflow-x-auto">
        <div className="space-y-1.5" style={{ width: laneWidth + 72 }}>
          {TRACK_ORDER.map((kind) => {
            const items = laneItems(timeline, kind);
            return (
              <div key={kind} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] font-semibold tracking-wide text-slate-500">{kind}</span>
                <div
                  className="relative h-8 rounded bg-white/[0.03]"
                  style={{ width: laneWidth }}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget || duration <= 0) return;
                    const box = e.currentTarget.getBoundingClientRect();
                    onSeek(Math.max(0, Math.min(duration, (e.clientX - box.left) / scale)));
                  }}
                >
                  {duration > 0 && (
                    <div
                      className="absolute top-0 bottom-0 w-px bg-cyan-300/80 pointer-events-none z-20"
                      style={{ left: Math.min(laneWidth, playheadSec * scale) }}
                    />
                  )}
                  {items.length === 0 && (
                    <span className="absolute inset-0 flex items-center pl-2 text-[10px] text-slate-600">empty</span>
                  )}
                  {items.map((item) => {
                    const dragging = drag && drag.id === item.id ? drag : null;
                    let left = item.start * scale;
                    let width = Math.max(6, (item.end - item.start) * scale);
                    if (dragging?.mode === "move") left += dragging.dx;
                    if (dragging?.mode === "end") width = Math.max(6, width + dragging.dx);
                    if (dragging?.mode === "start") { left += dragging.dx; width = Math.max(6, width - dragging.dx); }
                    const movable = kind !== "VOICE";
                    const edges = kind === "VIDEO" ? ["end"] : kind === "CAPTIONS" || kind === "TEXT" || kind === "GRAPHICS" ? ["start", "end"] : [];
                    return (
                      <div
                        key={item.id}
                        role="button"
                        tabIndex={0}
                        title={`${item.label} — ${fmt(item.start)} → ${fmt(item.end)}`}
                        style={{ left, width }}
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          onSelect(kind, item.id, item.start);
                          if (movable) setDrag({ kind, id: item.id, mode: "move", x0: e.clientX, dx: 0 });
                        }}
                        onKeyDown={(e) => { if (e.key === "Enter") onSelect(kind, item.id, item.start); }}
                        className={`absolute top-0 h-8 rounded border px-1.5 text-[10px] leading-8 text-white/90 truncate select-none ${movable ? "cursor-grab" : "cursor-pointer"} ${TRACK_COLOR[kind]} ${
                          selectedId === item.id ? "ring-2 ring-white/70 z-10" : ""
                        } ${item.off ? "opacity-35 border-dashed" : ""}`}
                      >
                        {item.warn ? "⚠ " : ""}
                        {item.label}
                        {edges.map((edge) => (
                          <span
                            key={edge}
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              onSelect(kind, item.id, item.start);
                              setDrag({ kind, id: item.id, mode: edge as DragMode, x0: e.clientX, dx: 0 });
                            }}
                            className={`absolute top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/40 ${edge === "start" ? "left-0" : "right-0"}`}
                          />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
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

/** A titled block of controls. Keeps the inspector readable as it grows. */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-2 border-t border-white/5 space-y-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-500">{title}</p>
      {children}
    </div>
  );
}

function Select({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-2 py-1.5 text-xs text-white focus:border-cyan-400/50 focus:outline-none"
      >
        {options.map(([v, text]) => (
          <option key={v} value={v} className="bg-slate-900">{text}</option>
        ))}
      </select>
    </label>
  );
}

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[10px] text-slate-500">
        {label}
        {/* Tabular figures so the number does not jog sideways while the slider moves. */}
        <span className="tabular-nums text-slate-300">{value.toFixed(2)}</span>
      </span>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-cyan-400"
      />
    </label>
  );
}

/**
 * §15 — the clip's identity, shown as stored.
 *
 * Including, and especially, when it is not recoverable. Hiding that would mean the person finds
 * out at render time, ten minutes later, about a shot they could have replaced in ten seconds.
 */

/**
 * RONDE 156 §4 — Replace: see real alternatives, preview one, choose it.
 *
 * ── Why the candidates are fetched lazily ────────────────────────────────────────────────────
 *
 * The query is disabled until the person actually opens the panel. Loading a ranked archive pool
 * for every clip they merely CLICK ON would make selecting a shot cost a database sweep, and most
 * selections are to inspect a clip rather than to replace it.
 *
 * ── What the client is allowed to send back ─────────────────────────────────────────────────
 *
 * `archiveAssetId`, and nothing else. The server looks the provider, the URL and the title up from
 * the archive row itself — so a client cannot name its own provider and launder a source into a
 * timeline. That rule predates this panel and this panel does not weaken it.
 */
function ReplacePanel({
  videoId,
  clipId,
  timelineVersion,
  onReplaced,
}: {
  videoId: number;
  clipId: string;
  timelineVersion: number;
  onReplaced: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The search term is committed on submit rather than on every keystroke.
   *
   * Each query ranks up to 200 rows per archive; firing that per character would be a sweep per
   * letter. A person searching an archive expects to press Enter.
   */
  const [committedSearch, setCommittedSearch] = useState("");

  const candidates = trpc.timeline.replacementCandidates.useQuery(
    { videoId, clipId, limit: 24, ...(committedSearch ? { search: committedSearch } : {}) },
    { enabled: open, staleTime: 30_000 }
  );

  const replaceMutation = trpc.timeline.replaceClip.useMutation();

  const choose = async (archiveAssetId: number) => {
    setError(null);
    try {
      await replaceMutation.mutateAsync({
        videoId,
        clipId,
        archiveAssetId,
        expectedTimelineVersion: timelineVersion,
      });
      setOpen(false);
      setPreviewing(null);
      onReplaced();
    } catch (err) {
      /**
       * The most likely failure is a version conflict: somebody saved while this panel was open.
       * Saying so beats a generic error, because the fix is "reload", not "try again".
       */
      setError((err as Error).message || "the replacement could not be saved");
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 hover:bg-white/10 px-3 py-2 text-xs font-medium text-white transition"
      >
        <Repeat className="w-3.5 h-3.5" /> Replace this shot
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-cyan-400/25 bg-cyan-400/5 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-white">Alternatives for this slot</h4>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-white/50 hover:text-white/80"
        >
          Cancel
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setCommittedSearch(search.trim());
        }}
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search the archive, then press Enter"
          className="w-full rounded-md bg-black/30 border border-white/10 px-2.5 py-1.5 text-[11px] text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50"
        />
      </form>

      {candidates.isLoading && <p className="text-[11px] text-white/50">Searching the archive…</p>}
      {candidates.error && (
        <p className="text-[11px] text-red-300">{candidates.error.message}</p>
      )}

      {candidates.data && candidates.data.candidates.length === 0 && (
        <div className="text-[11px] text-white/60 space-y-1">
          <p>Nothing in the archive fits this slot.</p>
          {/* §"een lege lijst is nooit een mysterie" — say WHY it is empty. */}
          {candidates.data.rejectedReasons.map((r) => (
            <p key={r} className="text-white/40">· {r}</p>
          ))}
        </div>
      )}

      {candidates.data && candidates.data.candidates.length > 0 && (
        <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
          {candidates.data.candidates.map((c) => (
            <div
              key={c.archiveAssetId}
              className="rounded-md border border-white/10 bg-black/25 overflow-hidden flex flex-col"
            >
              {/* The preview is this app's own streaming endpoint — never a signed provider URL. */}
              {previewing === c.archiveAssetId && c.previewUrl ? (
                c.mediaType === "video" ? (
                  <video
                    src={c.previewUrl}
                    className="w-full aspect-video object-cover bg-black"
                    autoPlay
                    muted
                    loop
                    playsInline
                  />
                ) : (
                  <img src={c.previewUrl} alt="" className="w-full aspect-video object-cover bg-black" />
                )
              ) : (
                <button
                  type="button"
                  onClick={() => setPreviewing(c.archiveAssetId)}
                  className="relative w-full aspect-video bg-black/50 flex items-center justify-center group"
                >
                  {c.thumbnailUrl && c.mediaType === "image" ? (
                    <img src={c.thumbnailUrl} alt="" className="w-full h-full object-cover opacity-80" />
                  ) : null}
                  <Play className="absolute w-6 h-6 text-white/70 group-hover:text-white transition" />
                </button>
              )}
              <div className="p-2 space-y-1 flex-1 flex flex-col">
                <p className="text-[11px] text-white font-medium leading-tight line-clamp-2">
                  {c.title || "Untitled"}
                </p>
                <p className="text-[10px] text-white/45">
                  {c.provider}
                  {c.durationSec != null && ` · ${c.durationSec.toFixed(1)}s`}
                  {c.mediaType === "image" && " · still"}
                </p>
                <p className="text-[10px] text-white/35 leading-tight flex-1">{c.reason}</p>
                <button
                  type="button"
                  disabled={replaceMutation.isPending}
                  onClick={() => choose(c.archiveAssetId)}
                  className="w-full rounded bg-cyan-500/80 hover:bg-cyan-400 disabled:opacity-40 px-2 py-1 text-[11px] font-semibold text-black transition"
                >
                  {replaceMutation.isPending ? "Replacing…" : "Use this clip"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-red-300">{error}</p>}
    </div>
  );
}

function ClipInspector({
  clip,
  onChange,
  videoId,
  timelineVersion,
  onReplaced,
  playheadSec,
  onLength,
  onSourceIn,
  onMove,
  onSplit,
  onRemove,
  onDuplicate,
  onSpeed,
  onAutoReplace,
  autoReplacing,
}: {
  clip: VideoClip;
  onChange: (patch: Partial<VideoClip>) => void;
  /** RONDE 156 — what the candidate search needs. */
  videoId: number;
  timelineVersion: number;
  onReplaced: () => void;
  /** VIDEO 619 — the cut and trim tools. */
  playheadSec: number;
  onLength: (sec: number) => void;
  onSourceIn: (sec: number) => void;
  onMove: (direction: -1 | 1) => void;
  onSplit: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onSpeed: (speed: number) => void;
  /** Let FastVid find a better archive shot for this slot, checked by the Visual Judge. */
  onAutoReplace: () => void;
  autoReplacing: boolean;
}) {
  const recoverable =
    Boolean(clip.source.canonicalUrl || clip.source.mediaUrl) || clip.source.archiveAssetId != null;
  const slot = clip.timelineEnd - clip.timelineStart;
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
        <Field label="Slot" value={`${slot.toFixed(2)}s`} />
        {/* An absent trim is shown as "not recorded", not as 0 — §15 of RONDE 147. */}
        <Field label="Source in" value={clip.sourceIn != null ? `${clip.sourceIn.toFixed(2)}s` : "not recorded"} />
        <Field label="Source out" value={clip.sourceOut != null ? `${clip.sourceOut.toFixed(2)}s` : "not recorded"} />
        {clip.editedByUser && <Field label="Edited" value="replaced by you" />}
      </div>

      {/* ── VIDEO 619 — cut, trim, move, remove ── */}
      <Group title="Edit">
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Length (s)" value={slot} min={0.5} step={0.1} onCommit={onLength} />
          {clip.kind === "video" ? (
            <NumberField
              label="Starts at (s in source)"
              value={clip.sourceIn ?? 0}
              min={0}
              step={0.1}
              onCommit={onSourceIn}
            />
          ) : (
            <div />
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <ToolButton onClick={() => onMove(-1)} title="Move one shot earlier"><ArrowLeft className="w-3.5 h-3.5" /> Earlier</ToolButton>
          <ToolButton onClick={() => onMove(1)} title="Move one shot later">Later <ArrowRight className="w-3.5 h-3.5" /></ToolButton>
          <ToolButton
            onClick={onSplit}
            disabled={!(playheadSec > clip.timelineStart + 0.5 && playheadSec < clip.timelineEnd - 0.5)}
            title="Cut this shot in two at the playhead"
          >
            <Scissors className="w-3.5 h-3.5" /> Cut at playhead
          </ToolButton>
          <ToolButton onClick={onDuplicate} title="Put a copy of this shot right after it">
            <Copy className="w-3.5 h-3.5" /> Duplicate
          </ToolButton>
          <ToolButton onClick={onRemove} title="Remove this shot" danger>
            <Trash2 className="w-3.5 h-3.5" /> Remove
          </ToolButton>
        </div>
        {clip.kind === "video" && (
          <Select
            label="Speed"
            value={String(clip.speed ?? 1)}
            options={[
              ["0.5", "0.5× — slow motion"],
              ["0.75", "0.75×"],
              ["1", "1× — normal"],
              ["1.25", "1.25×"],
              ["1.5", "1.5×"],
              ["2", "2× — fast"],
            ]}
            onChange={(v) => onSpeed(Number(v))}
          />
        )}
      </Group>

      <ToolButton onClick={onAutoReplace} disabled={autoReplacing} title="FastVid searches the archive and lets the Visual Judge pick a shot that fits this sentence">
        {autoReplacing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
        {autoReplacing ? "Finding a better shot…" : "Find a better shot automatically"}
      </ToolButton>

      {/* ── RONDE 156 — find a different shot for this slot ── */}
      <ReplacePanel
        videoId={videoId}
        clipId={clip.id}
        timelineVersion={timelineVersion}
        onReplaced={onReplaced}
      />

      {/* ── §32 — framing ── */}
      <Group title="Framing">
        <Select
          label="Fit"
          value={clip.transform?.fit ?? "contain"}
          options={[
            ["contain", "Contain — whole picture, bars"],
            ["cover", "Cover — fill, crop the edges"],
            ["crop", "Crop — an explicit rectangle"],
          ]}
          onChange={(v) =>
            onChange({ transform: { ...clip.transform, fit: v as "contain" | "cover" | "crop" } })
          }
        />
        <Slider
          label="Scale" min={0.5} max={2} step={0.05}
          value={clip.transform?.scale ?? 1}
          onChange={(v) => onChange({ transform: { ...clip.transform, scale: v } })}
        />
        <Slider
          label="Position X" min={0} max={1} step={0.05}
          value={clip.transform?.positionX ?? 0.5}
          onChange={(v) => onChange({ transform: { ...clip.transform, positionX: v } })}
        />
        <Slider
          label="Position Y" min={0} max={1} step={0.05}
          value={clip.transform?.positionY ?? 0.5}
          onChange={(v) => onChange({ transform: { ...clip.transform, positionY: v } })}
        />
        <Slider
          label="Opacity" min={0} max={1} step={0.05}
          value={clip.transform?.opacity ?? 1}
          onChange={(v) => onChange({ transform: { ...clip.transform, opacity: v } })}
        />
        {clip.transform?.fit === "crop" && (
          <>
            {(["x", "y", "width", "height"] as const).map((k) => {
              const crop = clip.transform?.crop ?? { x: 0, y: 0, width: 1, height: 1 };
              return (
                <Slider
                  key={k}
                  label={`Crop ${k}`} min={k === "width" || k === "height" ? 0.1 : 0} max={1} step={0.05}
                  value={crop[k]}
                  onChange={(v) => onChange({ transform: { ...clip.transform, crop: { ...crop, [k]: v } } })}
                />
              );
            })}
          </>
        )}
      </Group>

      {/* ── §32 — camera ── */}
      <Group title="Camera">
        <Select
          label="Movement"
          value={clip.camera?.type ?? "camera_hold"}
          options={[
            ["camera_hold", "Hold — no movement"],
            ["slow_push", "Slow push in"],
            ["slow_pull", "Slow pull out"],
            ["pan_left", "Pan left"],
            ["pan_right", "Pan right"],
            ["tilt_up", "Tilt up"],
            ["tilt_down", "Tilt down"],
          ]}
          onChange={(v) => onChange({ camera: cameraPreset(v) })}
        />
        {clip.camera && clip.camera.type !== "camera_hold" && (
          <p className="text-[10px] text-slate-500">
            Zoom {(clip.camera.startScale ?? 1).toFixed(2)}× → {(clip.camera.endScale ?? 1).toFixed(2)}×
            over {slot.toFixed(1)}s
          </p>
        )}
      </Group>

      {/* ── §32 — transition ── */}
      <Group title="Transition in">
        <Select
          label="Type"
          value={clip.transitionIn}
          options={EDITOR_TRANSITIONS.map((t) => [t, TRANSITION_LABEL[t]] as [string, string])}
          onChange={(v) => onChange({ transitionIn: v })}
        />
        {clip.transitionIn !== "hard_cut" && (
          <Slider
            label="Seconds" min={0.1} max={2} step={0.1}
            value={clip.transitionInSec ?? 0.5}
            onChange={(v) => onChange({ transitionInSec: v })}
          />
        )}
      </Group>

      {/* The look of this shot — a small set, every one executed by the renderer. */}
      <Group title="Effects">
        {EDITOR_EFFECTS.map((effect) => {
          const current = clip.effects?.find((e) => e.effectType === effect)?.intensity ?? 0;
          return (
            <Slider
              key={effect}
              label={EFFECT_LABEL[effect]} min={0} max={1} step={0.05}
              value={current}
              onChange={(v) => onChange({ effects: (withEffect(clip as unknown as EditableVideoClip, effect, v).effects as VideoClip["effects"]) ?? [] })}
            />
          );
        })}
        {clip.effects?.filter((e) => !(EDITOR_EFFECTS as readonly string[]).includes(e.effectType)).map((e) => (
          <div key={e.effectType} className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-slate-200">{e.effectType.replace(/_/g, " ")}</span>
            <span className="text-[10px] text-slate-500">
              {RENDERED_EFFECTS.has(e.effectType) ? `${Math.round(e.intensity * 100)}%` : "not rendered"}
            </span>
          </div>
        ))}
      </Group>
    </div>
  );
}

const TRANSITION_LABEL: Record<(typeof EDITOR_TRANSITIONS)[number], string> = {
  hard_cut: "Cut",
  crossfade: "Fade",
  dissolve: "Dissolve",
  dip_to_black: "Dip to black",
  slide_left: "Slide left",
  slide_right: "Slide right",
  zoom: "Zoom",
  blur: "Blur",
};

const EFFECT_LABEL: Record<(typeof EDITOR_EFFECTS)[number], string> = {
  vignette: "Vignette",
  blur: "Blur",
  exposure: "Brightness",
  contrast: "Contrast",
  film_grain: "Film grain",
  letterbox: "Cinematic bars",
};

/** The effects the renderer executes. Anything else on a clip is shown as planned-but-not-rendered. */
const RENDERED_EFFECTS = new Set([
  "film_grain", "noise", "vignette", "letterbox", "glow", "bloom", "chromatic_aberration",
  "blur", "exposure", "contrast", "saturation", "sharpen", "monochrome", "sepia",
]);

function AudioInspector({
  kind,
  clip,
  onChange,
  onRemove,
}: {
  kind: "VOICE" | "MUSIC" | "SFX" | "AMBIENT";
  clip: AudioClip;
  onChange: (patch: AudioPatch) => void;
  /** VIDEO 619 — music, effects and ambience can be taken out; the narration cannot. */
  onRemove?: () => void;
}) {
  const len = Math.max(0.1, clip.end - clip.start);
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <Music className="w-4 h-4 text-emerald-400" /> {kind}
      </h3>
      <div>
        <Field label="Source" value={clip.source.title || clip.source.provider} />
        <Field label="Timeline" value={`${fmt(clip.start)} → ${fmt(clip.end)}`} />
      </div>
      <ShowHide
        shown={!clip.disabled}
        suggestion={false}
        labels={{ on: "Audible in the video", off: "Muted", hide: "Mute", show: "Unmute" }}
        onShown={(shown) => onChange({ muted: !shown })}
      />
      <Slider label="Volume" min={0} max={2} step={0.05} value={clip.gain} onChange={(gain) => onChange({ gain })} />
      <Slider label="Fade in (s)" min={0} max={Math.min(5, len / 2)} step={0.1} value={clip.fadeInSec ?? 0} onChange={(fadeInSec) => onChange({ fadeInSec })} />
      <Slider label="Fade out (s)" min={0} max={Math.min(5, len / 2)} step={0.1} value={clip.fadeOutSec ?? 0} onChange={(fadeOutSec) => onChange({ fadeOutSec })} />
      {onRemove && (
        <ToolButton onClick={onRemove} title="Take this sound out" danger>
          <Trash2 className="w-3.5 h-3.5" /> Remove sound
        </ToolButton>
      )}
      {kind === "VOICE" && (
        <p className="text-[10px] text-slate-500 leading-relaxed">
          The narration is the permanent voiceover. Music and ambience duck underneath it
          automatically — you do not need to lower them by hand.
        </p>
      )}
    </div>
  );
}

/**
 * §12 — a graphic, shown with its payload.
 *
 * Read-only on purpose. A location card's coordinates and a chart's series are the planner's
 * decisions, and an editor that let them be typed over by hand would be inviting a graphic that
 * says one thing and draws another. What a person CAN change is the words, through the text route.
 */
function GraphicInspector({
  graphic,
  onShown,
  onTiming,
  onRemove,
}: {
  graphic: GraphicElement;
  onShown: (shown: boolean) => void;
  onTiming: (start: number, end: number) => void;
  onRemove: () => void;
}) {
  const drawn = graphicIsDrawable(graphic);
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
        <TypeIcon className="w-4 h-4 text-rose-400" /> {graphic.graphicType.replace(/_/g, " ")}
      </h3>
      {!drawn && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2.5">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-amber-200/90">
            This graphic has no words and no map, route or chart data to draw, so it is kept on the
            timeline and left out of the render.
          </p>
        </div>
      )}
      <div>
        {graphic.label && <Field label="Label" value={graphic.label} />}
        <Field label="Timeline" value={`${fmt(graphic.start)} → ${fmt(graphic.end)}`} />
        {graphic.reason && <Field label="Planned because" value={graphic.reason} />}
        {Object.entries(graphic.data).slice(0, 6).map(([k, v]) => (
          <Field key={k} label={k} value={typeof v === "object" ? JSON.stringify(v) : String(v)} />
        ))}
      </div>
      <ShowHide shown={!graphic.disabled} suggestion={graphic.disabledReason === "left_to_editor"} onShown={onShown} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Start (s)" value={graphic.start} min={0} step={0.1} onCommit={(v) => onTiming(v, v + (graphic.end - graphic.start))} />
        <NumberField label="End (s)" value={graphic.end} min={0} step={0.1} onCommit={(v) => onTiming(graphic.start, v)} />
      </div>
      <ToolButton onClick={onRemove} title="Remove this graphic" danger>
        <Trash2 className="w-3.5 h-3.5" /> Remove
      </ToolButton>
    </div>
  );
}

/** §16 — the one thing in this editor a person can actually change. */
function TextInspector({
  kind,
  element,
  onChange,
  onTiming,
  onShown,
  onRemove,
  onStyleAllCaptions,
}: {
  kind: "CAPTIONS" | "TEXT";
  element: TextElement;
  onChange: (patch: Partial<TextElement>) => void;
  onTiming: (start: number, end: number) => void;
  onShown: (shown: boolean) => void;
  onRemove: () => void;
  /** Captions only: give every subtitle this caption's look. */
  onStyleAllCaptions?: (style: TextStyle) => void;
}) {
  const style = element.style ?? {};
  const setStyle = (patch: Partial<TextStyle>) => onChange({ style: { ...style, ...patch } });
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
        <NumberField label="Start (s)" value={element.start} min={0} step={0.1} onCommit={(v) => onTiming(v, v + (element.end - element.start))} />
        <NumberField label="End (s)" value={element.end} min={0} step={0.1} onCommit={(v) => onTiming(element.start, v)} />
      </div>
      <ShowHide shown={!element.disabled} suggestion={element.disabledReason === "left_to_editor"} onShown={onShown} />
      <Group title="Look">
        <Select
          label="Position"
          value={style.position ?? "bottom"}
          options={[
            ["top", "Top"],
            ["center", "Center"],
            ["lower_third", "Lower third"],
            ["lower_center", "Lower center"],
            ["bottom", "Bottom"],
          ]}
          onChange={(v) => setStyle({ position: v })}
        />
        <Slider
          label="Size (px)" min={24} max={140} step={2}
          value={style.fontSizePx ?? 64}
          onChange={(v) => setStyle({ fontSizePx: v })}
        />
        <label className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-slate-500">Colour</span>
          <input
            type="color"
            value={colourHex(style.color)}
            onChange={(e) => setStyle({ color: e.target.value })}
            className="h-7 w-12 rounded bg-transparent border border-white/10"
          />
        </label>
        <Slider
          label="Background box" min={0} max={1} step={0.05}
          value={style.backgroundOpacity ?? 0}
          onChange={(v) => setStyle({ backgroundOpacity: v, backgroundColor: style.backgroundColor ?? "black" })}
        />
        <Select
          label="Animation"
          value={element.animation ?? (kind === "CAPTIONS" ? "fade" : "fade")}
          options={[
            ["none", "None — just appears"],
            ["fade", "Fade"],
            ["fade_rise", "Fade and rise"],
            ["slide_up", "Slide up"],
            ["pop", "Pop"],
            ["word_reveal", "Word by word"],
            ["typewriter", "Typewriter"],
          ]}
          onChange={(v) => onChange({ animation: v })}
        />
        {onStyleAllCaptions && (
          <ToolButton onClick={() => onStyleAllCaptions(style)} title="Give every subtitle this look">
            <Captions className="w-3.5 h-3.5" /> Use this look for all subtitles
          </ToolButton>
        )}
      </Group>
      <ToolButton onClick={onRemove} title="Remove this text" danger>
        <Trash2 className="w-3.5 h-3.5" /> Remove
      </ToolButton>
      <p className="text-[10px] text-slate-500 leading-relaxed">
        Changes are local until you press Save. Rendering always saves first.
      </p>
    </div>
  );
}

/* ═══════════════════════ VIDEO 619 — the editing tools ═══════════════════════ */

function colourHex(c: string | undefined): string {
  if (c && /^#[0-9a-f]{6}$/i.test(c)) return c;
  const named: Record<string, string> = { white: "#ffffff", black: "#000000", yellow: "#ffd400", red: "#ff3b30" };
  return named[(c ?? "white").toLowerCase()] ?? "#ffffff";
}

function ToolButton({
  children, onClick, title, disabled, danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${
        danger
          ? "border-red-400/30 bg-red-500/10 text-red-200 hover:bg-red-500/20"
          : "border-white/15 bg-white/5 text-white hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}

/** A number that is applied when the person finishes typing, not on every keystroke. */
function NumberField({
  label, value, min, step, onCommit,
}: {
  label: string;
  value: number;
  min: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => setText(value.toFixed(2)), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v >= min && Math.abs(v - value) > 0.001) onCommit(v);
    else setText(value.toFixed(2));
  };
  return (
    <label className="block">
      <span className="text-[10px] text-slate-500">{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        className="mt-1 w-full rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-xs text-white focus:border-cyan-400/50 focus:outline-none"
      />
    </label>
  );
}

/** On screen or not. A suggestion the pipeline left off says so, so it reads as an offer. */
function ShowHide({
  shown, suggestion, onShown, labels,
}: {
  shown: boolean;
  suggestion: boolean;
  onShown: (shown: boolean) => void;
  labels?: { on: string; off: string; hide: string; show: string };
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
      <p className="text-[11px] text-slate-300">
        {shown ? labels?.on ?? "Shown in the video" : suggestion ? "Suggested — not in the video yet" : labels?.off ?? "Hidden"}
      </p>
      <ToolButton onClick={() => onShown(!shown)} title={shown ? "Hide it" : "Show it in the video"}>
        {shown ? <><EyeOff className="w-3.5 h-3.5" /> {labels?.hide ?? "Hide"}</> : <><Eye className="w-3.5 h-3.5" /> {labels?.show ?? "Show"}</>}
      </ToolButton>
    </div>
  );
}

function EditToolbar({
  captions, onAddShot, onAddText, onSubtitles,
}: {
  captions: { total: number; shown: number };
  onAddShot: () => void;
  onAddText: () => void;
  onSubtitles: (shown: boolean) => void;
}) {
  const subtitlesOn = captions.total > 0 && captions.shown === captions.total;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToolButton onClick={onAddShot} title="Add a shot from the archive after the selected one">
        <ImagePlus className="w-3.5 h-3.5" /> Add shot from archive
      </ToolButton>
      <ToolButton onClick={onAddText} title="Add your own text at the playhead">
        <Plus className="w-3.5 h-3.5" /> Add text
      </ToolButton>
      <ToolButton
        onClick={() => onSubtitles(!subtitlesOn)}
        disabled={captions.total === 0}
        title={captions.total === 0 ? "This video has no subtitles planned" : "Show or hide all subtitles"}
      >
        <Captions className="w-3.5 h-3.5" />
        {subtitlesOn ? "Hide subtitles" : `Show subtitles${captions.total ? ` (${captions.total})` : ""}`}
      </ToolButton>
      <span className="text-[10px] text-slate-500">
        Changes save automatically. Render to see them in the video.
      </span>
    </div>
  );
}

/**
 * VIDEO 619 — every asset in every archive, to add as a shot.
 *
 * Nothing is hidden: stills, clips with text in the picture and short clips are all offered, and
 * the card says which it is. Previews stream through this app's own endpoint.
 */
function ArchiveBrowser({
  videoId, onClose, onChoose,
}: {
  videoId: number;
  onClose: () => void;
  onChoose: (archiveAssetId: number) => void | Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [committed, setCommitted] = useState("");
  const [mediaType, setMediaType] = useState<"all" | "video" | "image">("all");
  const [page, setPage] = useState(0);
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [choosing, setChoosing] = useState<number | null>(null);
  const PAGE = 24;
  const query = trpc.timeline.archiveBrowse.useQuery({
    videoId,
    limit: PAGE,
    offset: page * PAGE,
    ...(committed ? { search: committed } : {}),
    ...(mediaType !== "all" ? { mediaType } : {}),
  });
  const total = query.data?.total ?? 0;
  return (
    <div className="rounded-xl border border-cyan-400/25 bg-cyan-400/5 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-white">Add a shot from the archive</h4>
        <button type="button" onClick={onClose} className="text-[11px] text-white/50 hover:text-white/80">Close</button>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); setPage(0); setCommitted(search.trim()); }}
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or tag, then press Enter"
          className="flex-1 rounded-md bg-black/30 border border-white/10 px-2.5 py-1.5 text-[11px] text-white placeholder:text-white/30 focus:outline-none focus:border-cyan-400/50"
        />
        <select
          value={mediaType}
          onChange={(e) => { setPage(0); setMediaType(e.target.value as "all" | "video" | "image"); }}
          className="rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-[11px] text-white"
        >
          <option value="all" className="bg-slate-900">Video &amp; images</option>
          <option value="video" className="bg-slate-900">Video only</option>
          <option value="image" className="bg-slate-900">Images only</option>
        </select>
      </form>
      {query.isLoading && <p className="text-[11px] text-white/50">Loading the archive…</p>}
      {query.error && <p className="text-[11px] text-red-300">{query.error.message}</p>}
      {query.data && query.data.items.length === 0 && (
        <p className="text-[11px] text-white/60">Nothing in the archive matches.</p>
      )}
      {query.data && query.data.items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-80 overflow-y-auto pr-1">
          {query.data.items.map((a) => (
            <div key={a.archiveAssetId} className="rounded-md border border-white/10 bg-black/25 overflow-hidden flex flex-col">
              {previewing === a.archiveAssetId ? (
                a.mediaType === "video" ? (
                  <video src={a.previewUrl} className="w-full aspect-video object-cover bg-black" autoPlay muted loop playsInline />
                ) : (
                  <img src={a.previewUrl} alt="" className="w-full aspect-video object-cover bg-black" />
                )
              ) : (
                <button
                  type="button"
                  onClick={() => setPreviewing(a.archiveAssetId)}
                  className="relative w-full aspect-video bg-black/50 flex items-center justify-center group"
                >
                  {a.mediaType === "image" ? (
                    <img src={a.previewUrl} alt="" className="w-full h-full object-cover opacity-80" />
                  ) : null}
                  <Play className="absolute w-6 h-6 text-white/70 group-hover:text-white transition" />
                </button>
              )}
              <div className="p-2 space-y-1 flex-1 flex flex-col">
                <p className="text-[11px] text-white font-medium leading-tight line-clamp-2">{a.title || "Untitled"}</p>
                <p className="text-[10px] text-white/45">
                  {a.archive}
                  {a.durationSec != null && a.mediaType === "video" && ` · ${a.durationSec.toFixed(1)}s`}
                  {a.mediaType === "image" && " · still"}
                  {a.hasTextInPicture && " · text in picture"}
                </p>
                {a.tags.length > 0 && <p className="text-[10px] text-white/35 leading-tight flex-1">{a.tags.join(", ")}</p>}
                <button
                  type="button"
                  disabled={choosing !== null}
                  onClick={async () => { setChoosing(a.archiveAssetId); try { await onChoose(a.archiveAssetId); } finally { setChoosing(null); } }}
                  className="w-full rounded bg-cyan-500/80 hover:bg-cyan-400 disabled:opacity-40 px-2 py-1 text-[11px] font-semibold text-black transition"
                >
                  {choosing === a.archiveAssetId ? "Adding…" : "Add this shot"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {total > PAGE && (
        <div className="flex items-center justify-between text-[11px] text-white/60">
          <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-30">← Previous</button>
          <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
          <button type="button" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-30">Next →</button>
        </div>
      )}
    </div>
  );
}

/** The kept versions of this timeline, newest first, each restorable. */
function VersionHistory({
  videoId,
  currentVersion,
  onRestore,
}: {
  videoId: number;
  currentVersion: number;
  onRestore: (snapshotId: number) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const versions = trpc.timeline.versions.useQuery({ videoId }, { enabled: open });
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Earlier versions"
        aria-label="Version history"
        className="flex items-center gap-1.5 text-xs px-2.5 py-2 rounded-lg bg-white/5 border border-white/15 text-white hover:bg-white/10 transition-colors"
      >
        <HistoryIcon className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-30 w-72 max-h-80 overflow-y-auto rounded-xl border border-white/15 bg-slate-950/95 p-2 shadow-xl">
          <p className="px-1.5 pb-1.5 text-[10px] uppercase tracking-wide text-slate-500">Versions</p>
          {versions.isLoading && <p className="px-1.5 text-[11px] text-slate-400">Loading…</p>}
          {versions.data?.versions.length === 0 && (
            <p className="px-1.5 text-[11px] text-slate-400">No saved versions yet — they appear as you edit.</p>
          )}
          {versions.data?.versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between gap-2 rounded-lg px-1.5 py-1 hover:bg-white/5">
              <div className="min-w-0">
                <p className="text-[11px] text-white">
                  v{v.timelineVersion}
                  {v.timelineVersion === currentVersion && <span className="text-emerald-400"> · current</span>}
                </p>
                <p className="text-[10px] text-slate-500 truncate">
                  {v.label ?? "save"} · {new Date(v.createdAt).toLocaleString()}
                </p>
              </div>
              {v.timelineVersion !== currentVersion && (
                <button
                  type="button"
                  onClick={() => { setOpen(false); void onRestore(v.id); }}
                  className="shrink-0 text-[11px] text-cyan-300 hover:text-cyan-200"
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tell the editor what to change, in words. The answer is applied as ordinary, undoable edits. */
function AiCommandBar({ busy, onRun }: { busy: boolean; onRun: (instruction: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex items-center gap-2 rounded-xl border border-purple-400/25 bg-purple-500/5 px-2.5 py-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const instruction = text.trim();
        if (instruction.length < 2 || busy) return;
        if (await onRun(instruction)) setText("");
      }}
    >
      <Sparkles className="w-4 h-4 text-purple-300 shrink-0" />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='Tell the editor what to change — "make the intro faster", "replace this shot", "smaller subtitles"'
        className="flex-1 bg-transparent text-xs text-white placeholder:text-white/35 focus:outline-none"
        disabled={busy}
      />
      <button
        type="submit"
        disabled={busy || text.trim().length < 2}
        className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg bg-purple-600/80 border border-purple-400/40 text-white hover:bg-purple-600 disabled:opacity-40 transition-colors"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
        Apply
      </button>
    </form>
  );
}
