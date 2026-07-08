/**
 * Master Documentary Director — global pre-retrieval visual strategy planner.
 *
 * Runs ONCE after script parse, before any retrieval.
 * Produces a VideoBlueprint: a complete visual strategy for the entire video.
 *
 * What it plans (LLM-based, one call):
 *  - Narrative arc: how the video opens, builds, climaxes, and closes
 *  - Visual budget: per-type allocation (archive%, photo%, map%, animation%, live%)
 *  - Visual callbacks: recurring motifs that create coherence
 *  - Visual type per beat: which clip type each beat should use
 *  - Sound design cues: where sfx should fire based on visual type
 *  - Text overlay plan: names, dates, stats, quote positions
 *  - Animation injection points: where map-zoom, timeline, counter, etc. add value
 *
 * What it enforces (deterministic, no LLM):
 *  - Visual repetition prevention: no same type 3+ consecutive
 *  - Budget tracking during retrieval (via VisualDedupState)
 *  - Existing modules (Editorial Sequence Planner, Shot Sequence Optimizer,
 *    Visual Rhythm Engine, Global Documentary Director) remain authoritative
 *    for their own domains — Blueprint is guidance, not override.
 *
 * Feature flag: MASTER_DOCUMENTARY_DIRECTOR_ENABLED (default: "true")
 */

import { invokeLLM } from "./_core/llm";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function masterDocumentaryDirectorEnabled(): boolean {
  return process.env.MASTER_DOCUMENTARY_DIRECTOR_ENABLED !== "false";
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type VisualType =
  | "archive_video"    // own archive video clip
  | "archive_photo"    // historical photograph / still
  | "map"              // map or geographic infographic
  | "animation"        // motion graphic / data animation
  | "live_footage"     // stock / pexels / pixabay
  | "aerial"           // drone / overhead shot
  | "close_up"         // face / detail close-up
  | "infographic"      // chart, timeline, counter
  | "text_overlay"     // pure text card / lower-third
  | "transition";      // crossfade / fade to black

export type NarrativeAct = "intro" | "setup" | "conflict" | "climax" | "resolution";

export type SoundDesignCue = {
  beatIndex: number;
  sceneIndex: number;
  sfxType: string;   // e.g. "camera_shutter", "whoosh", "explosion", "paper_rustle"
  trigger: string;   // what visual triggers it
};

export type TextOverlayPlan = {
  beatIndex: number;
  sceneIndex: number;
  content: string;        // e.g. "Winston Churchill, 1940"
  style: "lower_third" | "centered_title" | "subtitle" | "quote" | "stat" | "date_stamp";
  animation: "fade" | "slide" | "typewriter" | "none";
};

export type AnimationCue = {
  beatIndex: number;
  sceneIndex: number;
  animationType: "map_zoom" | "route_draw" | "timeline" | "counter" | "highlight_box" | "label" | "arrow" | "underline";
  description: string;    // what the animation should show
};

export type VisualCallback = {
  motif: string;           // e.g. "world map", "Churchill portrait", "burning city"
  sceneIndices: number[];  // which scenes this motif should appear in
  purpose: string;         // why this callback strengthens the narrative
};

export type BeatVisualDirective = {
  sceneIndex: number;
  beatIndex: number;
  visualType: VisualType;
  narrativeAct: NarrativeAct;
  /** Suggested search hint on top of what the beat text already provides */
  visualHint?: string;
  /** Whether this beat is a good place for an overlay or animation */
  overlayPriority: "none" | "low" | "high";
};

export type VisualBudget = {
  archive_video: number;   // target fraction 0–1
  archive_photo: number;
  map: number;
  animation: number;
  live_footage: number;
  aerial: number;
  close_up: number;
  infographic: number;
};

export type VideoBlueprint = {
  videoId: string;
  videoTitle: string;
  /** Top-level narrative description of the visual strategy */
  narrativeSummary: string;
  /** Per-act visual style guidance */
  actDirections: Record<NarrativeAct, string>;
  /** Target allocation by visual type */
  visualBudget: VisualBudget;
  /** Per-beat directives (indexed by `${sceneIndex}_${beatIndex}`) */
  beatDirectives: Map<string, BeatVisualDirective>;
  /** Recurring motifs to be woven through the video */
  visualCallbacks: VisualCallback[];
  /** Where sound design cues should fire */
  soundDesign: SoundDesignCue[];
  /** Where text overlays should appear */
  textOverlays: TextOverlayPlan[];
  /** Where animations should be injected */
  animations: AnimationCue[];
  /** ISO timestamp */
  createdAt: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getBlueprintDirective(
  blueprint: VideoBlueprint | null | undefined,
  sceneIndex: number,
  beatIndex: number
): BeatVisualDirective | null {
  if (!blueprint) return null;
  return blueprint.beatDirectives.get(`${sceneIndex}_${beatIndex}`) ?? null;
}

export function getBlueprintSoundCues(
  blueprint: VideoBlueprint | null | undefined,
  sceneIndex: number,
  beatIndex: number
): SoundDesignCue[] {
  if (!blueprint) return [];
  return blueprint.soundDesign.filter(
    (c) => c.sceneIndex === sceneIndex && c.beatIndex === beatIndex
  );
}

export function getBlueprintTextOverlays(
  blueprint: VideoBlueprint | null | undefined,
  sceneIndex: number,
  beatIndex: number
): TextOverlayPlan[] {
  if (!blueprint) return [];
  return blueprint.textOverlays.filter(
    (t) => t.sceneIndex === sceneIndex && t.beatIndex === beatIndex
  );
}

export function getBlueprintAnimations(
  blueprint: VideoBlueprint | null | undefined,
  sceneIndex: number,
  beatIndex: number
): AnimationCue[] {
  if (!blueprint) return [];
  return blueprint.animations.filter(
    (a) => a.sceneIndex === sceneIndex && a.beatIndex === beatIndex
  );
}

// ─── Visual repetition prevention ─────────────────────────────────────────────

/**
 * Enforces no more than `maxRun` consecutive beats of the same visual type.
 * Mutates the beatDirectives map (post-LLM correction pass).
 */
const FALLBACK_SEQUENCE: VisualType[] = [
  "live_footage", "archive_photo", "archive_video", "close_up",
];
const MAX_RUN_DEFAULT = 2;

function enforceVisualVariety(
  directives: BeatVisualDirective[],
  maxRun = MAX_RUN_DEFAULT
): void {
  let runType: VisualType | null = null;
  let runLength = 0;
  const fallbackIdx = { idx: 0 };

  for (const d of directives) {
    if (d.visualType === runType) {
      runLength++;
      if (runLength > maxRun) {
        // Break the run with a fallback type that differs
        let fallback = FALLBACK_SEQUENCE[fallbackIdx.idx % FALLBACK_SEQUENCE.length];
        while (fallback === runType) {
          fallbackIdx.idx++;
          fallback = FALLBACK_SEQUENCE[fallbackIdx.idx % FALLBACK_SEQUENCE.length];
        }
        d.visualType = fallback;
        fallbackIdx.idx++;
        runLength = 1;
        runType = fallback;
      }
    } else {
      runType = d.visualType;
      runLength = 1;
    }
  }
}

// ─── LLM prompt ───────────────────────────────────────────────────────────────

type SceneInput = { index: number; text: string; beatCount: number };

function buildBlueprintPrompt(
  videoTitle: string,
  videoLengthMin: number,
  scenes: SceneInput[]
): string {
  const sceneLines = scenes.map((s, i) => {
    const act: NarrativeAct =
      i === 0 ? "intro"
      : i === scenes.length - 1 ? "resolution"
      : i < scenes.length * 0.2 ? "setup"
      : i < scenes.length * 0.65 ? "conflict"
      : "climax";
    return `Scene ${s.index} [${act}, ${s.beatCount} beats]: "${s.text.slice(0, 100)}"`;
  }).join("\n");

  return `You are the Master Documentary Director for a ${videoLengthMin}-minute documentary titled "${videoTitle}".

SCENES:
${sceneLines}

Your task: Create a comprehensive visual blueprint as valid JSON.

Respond with ONLY this JSON object (no markdown, no explanation):
{
  "narrativeSummary": "2-3 sentences describing the overall visual strategy",
  "actDirections": {
    "intro": "visual style for opening",
    "setup": "visual style for setup section",
    "conflict": "visual style for conflict/tension",
    "climax": "visual style for climax",
    "resolution": "visual style for resolution/close"
  },
  "visualBudget": {
    "archive_video": 0.25,
    "archive_photo": 0.20,
    "map": 0.10,
    "animation": 0.08,
    "live_footage": 0.20,
    "aerial": 0.05,
    "close_up": 0.07,
    "infographic": 0.05
  },
  "beatDirectives": [
    {
      "sceneIndex": 0,
      "beatIndex": 0,
      "visualType": "aerial",
      "narrativeAct": "intro",
      "visualHint": "sweeping establishing shot of location",
      "overlayPriority": "high"
    }
  ],
  "visualCallbacks": [
    {
      "motif": "world map",
      "sceneIndices": [0, 3, 7],
      "purpose": "anchor geography throughout"
    }
  ],
  "soundDesign": [
    {
      "beatIndex": 0,
      "sceneIndex": 0,
      "sfxType": "whoosh",
      "trigger": "map appears"
    }
  ],
  "textOverlays": [
    {
      "beatIndex": 1,
      "sceneIndex": 0,
      "content": "Location name or date",
      "style": "lower_third",
      "animation": "fade"
    }
  ],
  "animations": [
    {
      "beatIndex": 2,
      "sceneIndex": 1,
      "animationType": "map_zoom",
      "description": "zoom into specific region"
    }
  ]
}

Rules:
- beatDirectives must cover ALL beats across ALL scenes
- visualBudget fractions must sum to 1.0
- Avoid same visualType 3+ times in a row within a scene
- soundDesign: only where it genuinely reinforces the image (max 1 per 3 beats)
- textOverlays: names, dates, statistics, quotes — max 1 per 2 beats
- animations: only where they clarify something the narration alone cannot (max 1 per scene)
- visualCallbacks: 2–4 recurring motifs that create visual coherence`;
}

// ─── LLM raw response parser ──────────────────────────────────────────────────

type RawBlueprint = {
  narrativeSummary?: string;
  actDirections?: Partial<Record<NarrativeAct, string>>;
  visualBudget?: Partial<VisualBudget>;
  beatDirectives?: Array<{
    sceneIndex: number;
    beatIndex: number;
    visualType?: string;
    narrativeAct?: string;
    visualHint?: string;
    overlayPriority?: string;
  }>;
  visualCallbacks?: Array<{ motif?: string; sceneIndices?: number[]; purpose?: string }>;
  soundDesign?: Array<{ beatIndex?: number; sceneIndex?: number; sfxType?: string; trigger?: string }>;
  textOverlays?: Array<{ beatIndex?: number; sceneIndex?: number; content?: string; style?: string; animation?: string }>;
  animations?: Array<{ beatIndex?: number; sceneIndex?: number; animationType?: string; description?: string }>;
};

const VALID_VISUAL_TYPES = new Set<string>([
  "archive_video", "archive_photo", "map", "animation", "live_footage",
  "aerial", "close_up", "infographic", "text_overlay", "transition",
]);
const VALID_ACTS = new Set<string>(["intro", "setup", "conflict", "climax", "resolution"]);

function parseRawBlueprint(
  raw: RawBlueprint,
  videoId: string,
  videoTitle: string,
  scenes: SceneInput[]
): VideoBlueprint {
  // ── Beat directives ──
  const beatDirectives = new Map<string, BeatVisualDirective>();
  const sortedDirectives: BeatVisualDirective[] = [];

  // Build from LLM output
  for (const d of raw.beatDirectives ?? []) {
    const vt = (VALID_VISUAL_TYPES.has(d.visualType ?? "") ? d.visualType : "live_footage") as VisualType;
    const act = (VALID_ACTS.has(d.narrativeAct ?? "") ? d.narrativeAct : "conflict") as NarrativeAct;
    const dir: BeatVisualDirective = {
      sceneIndex: d.sceneIndex ?? 0,
      beatIndex: d.beatIndex ?? 0,
      visualType: vt,
      narrativeAct: act,
      visualHint: d.visualHint ?? undefined,
      overlayPriority: (["none", "low", "high"].includes(d.overlayPriority ?? "") ? d.overlayPriority : "none") as "none" | "low" | "high",
    };
    beatDirectives.set(`${dir.sceneIndex}_${dir.beatIndex}`, dir);
    sortedDirectives.push(dir);
  }

  // Fill gaps: any beat not covered by LLM gets a default
  for (const scene of scenes) {
    for (let bi = 0; bi < scene.beatCount; bi++) {
      const key = `${scene.index}_${bi}`;
      if (!beatDirectives.has(key)) {
        const actIdx = scenes.indexOf(scene);
        const act: NarrativeAct =
          actIdx === 0 ? "intro"
          : actIdx === scenes.length - 1 ? "resolution"
          : "conflict";
        const dir: BeatVisualDirective = {
          sceneIndex: scene.index,
          beatIndex: bi,
          visualType: "live_footage",
          narrativeAct: act,
          overlayPriority: "none",
        };
        beatDirectives.set(key, dir);
        sortedDirectives.push(dir);
      }
    }
  }

  // Enforce visual variety (no 3+ consecutive same type within each scene)
  for (const scene of scenes) {
    const sceneDirectives = sortedDirectives
      .filter((d) => d.sceneIndex === scene.index)
      .sort((a, b) => a.beatIndex - b.beatIndex);
    enforceVisualVariety(sceneDirectives);
  }

  // ── Visual budget (normalize to sum=1) ──
  const rawBudget = raw.visualBudget ?? {};
  const budget: VisualBudget = {
    archive_video: rawBudget.archive_video ?? 0.25,
    archive_photo: rawBudget.archive_photo ?? 0.20,
    map: rawBudget.map ?? 0.10,
    animation: rawBudget.animation ?? 0.08,
    live_footage: rawBudget.live_footage ?? 0.20,
    aerial: rawBudget.aerial ?? 0.05,
    close_up: rawBudget.close_up ?? 0.07,
    infographic: rawBudget.infographic ?? 0.05,
  };
  const budgetSum = Object.values(budget).reduce((a, b) => a + b, 0);
  if (budgetSum > 0 && Math.abs(budgetSum - 1) > 0.05) {
    const scale = 1 / budgetSum;
    (Object.keys(budget) as (keyof VisualBudget)[]).forEach((k) => { budget[k] = Math.round(budget[k] * scale * 100) / 100; });
  }

  // ── Act directions ──
  const defaultAct = (a: NarrativeAct) => `Use appropriate visuals for the ${a} section`;
  const actDirections: Record<NarrativeAct, string> = {
    intro: raw.actDirections?.intro ?? defaultAct("intro"),
    setup: raw.actDirections?.setup ?? defaultAct("setup"),
    conflict: raw.actDirections?.conflict ?? defaultAct("conflict"),
    climax: raw.actDirections?.climax ?? defaultAct("climax"),
    resolution: raw.actDirections?.resolution ?? defaultAct("resolution"),
  };

  // ── Visual callbacks ──
  const visualCallbacks: VisualCallback[] = (raw.visualCallbacks ?? []).map((vc) => ({
    motif: vc.motif ?? "visual motif",
    sceneIndices: Array.isArray(vc.sceneIndices) ? vc.sceneIndices : [],
    purpose: vc.purpose ?? "",
  }));

  // ── Sound design ──
  const soundDesign: SoundDesignCue[] = (raw.soundDesign ?? []).map((s) => ({
    beatIndex: s.beatIndex ?? 0,
    sceneIndex: s.sceneIndex ?? 0,
    sfxType: s.sfxType ?? "whoosh",
    trigger: s.trigger ?? "",
  }));

  // ── Text overlays ──
  const VALID_TEXT_STYLES = new Set(["lower_third", "centered_title", "subtitle", "quote", "stat", "date_stamp"]);
  const VALID_ANIM = new Set(["fade", "slide", "typewriter", "none"]);
  const textOverlays: TextOverlayPlan[] = (raw.textOverlays ?? []).map((t) => ({
    beatIndex: t.beatIndex ?? 0,
    sceneIndex: t.sceneIndex ?? 0,
    content: t.content ?? "",
    style: (VALID_TEXT_STYLES.has(t.style ?? "") ? t.style : "lower_third") as TextOverlayPlan["style"],
    animation: (VALID_ANIM.has(t.animation ?? "") ? t.animation : "fade") as TextOverlayPlan["animation"],
  }));

  // ── Animations ──
  const VALID_ANIMS = new Set(["map_zoom", "route_draw", "timeline", "counter", "highlight_box", "label", "arrow", "underline"]);
  const animations: AnimationCue[] = (raw.animations ?? []).map((a) => ({
    beatIndex: a.beatIndex ?? 0,
    sceneIndex: a.sceneIndex ?? 0,
    animationType: (VALID_ANIMS.has(a.animationType ?? "") ? a.animationType : "label") as AnimationCue["animationType"],
    description: a.description ?? "",
  }));

  return {
    videoId,
    videoTitle,
    narrativeSummary: raw.narrativeSummary ?? "Documentary visual plan.",
    actDirections,
    visualBudget: budget,
    beatDirectives,
    visualCallbacks,
    soundDesign,
    textOverlays,
    animations,
    createdAt: new Date().toISOString(),
  };
}

// ─── Deterministic fallback (no LLM) ─────────────────────────────────────────

function buildFallbackBlueprint(
  videoId: string,
  videoTitle: string,
  scenes: SceneInput[]
): VideoBlueprint {
  const totalScenes = scenes.length;
  const beatDirectives = new Map<string, BeatVisualDirective>();
  const sortedDirectives: BeatVisualDirective[] = [];

  for (const scene of scenes) {
    const sceneIdx = scene.index;
    const relPos = sceneIdx / Math.max(1, totalScenes - 1);
    const act: NarrativeAct =
      relPos < 0.1 ? "intro"
      : relPos < 0.3 ? "setup"
      : relPos < 0.65 ? "conflict"
      : relPos < 0.85 ? "climax"
      : "resolution";

    // Cycle through visual types with variety
    const typePool: VisualType[] = act === "intro"
      ? ["aerial", "archive_photo", "map", "live_footage"]
      : act === "climax"
      ? ["archive_video", "close_up", "live_footage", "archive_photo"]
      : act === "resolution"
      ? ["archive_photo", "live_footage", "text_overlay"]
      : ["live_footage", "archive_video", "archive_photo", "close_up", "map"];

    for (let bi = 0; bi < scene.beatCount; bi++) {
      const vt = typePool[bi % typePool.length]!;
      const dir: BeatVisualDirective = {
        sceneIndex: sceneIdx,
        beatIndex: bi,
        visualType: vt,
        narrativeAct: act,
        overlayPriority: bi === 0 && (act === "intro" || act === "climax") ? "high" : "none",
      };
      beatDirectives.set(`${sceneIdx}_${bi}`, dir);
      sortedDirectives.push(dir);
    }
  }

  return {
    videoId,
    videoTitle,
    narrativeSummary: "Visual plan generated from deterministic rules (LLM unavailable).",
    actDirections: {
      intro: "Open with wide / aerial establishing shots. Set the stage.",
      setup: "Archive photos and video. Build context.",
      conflict: "Mix live footage with archive. Faster rhythm.",
      climax: "High-motion archive video and close-ups. Peak energy.",
      resolution: "Slow down. Wide shots, stills, fade to close.",
    },
    visualBudget: {
      archive_video: 0.25, archive_photo: 0.20, map: 0.10,
      animation: 0.08, live_footage: 0.22, aerial: 0.05,
      close_up: 0.07, infographic: 0.03,
    },
    beatDirectives,
    visualCallbacks: [],
    soundDesign: [],
    textOverlays: [],
    animations: [],
    createdAt: new Date().toISOString(),
  };
}

// ─── Budget tracker ───────────────────────────────────────────────────────────

export type VisualBudgetTracker = {
  blueprint: VideoBlueprint;
  used: Record<string, number>;
  total: number;
};

export function createBudgetTracker(blueprint: VideoBlueprint): VisualBudgetTracker {
  return { blueprint, used: {}, total: 0 };
}

export function recordBudgetUsage(tracker: VisualBudgetTracker, visualType: VisualType): void {
  tracker.used[visualType] = (tracker.used[visualType] ?? 0) + 1;
  tracker.total++;
}

/** Returns true when a visual type has already exceeded its budget by >50% relative overage */
export function isBudgetExceeded(tracker: VisualBudgetTracker, visualType: VisualType): boolean {
  const target = tracker.blueprint.visualBudget[visualType as keyof VisualBudget] ?? 0;
  if (target === 0 || tracker.total < 5) return false;
  const actual = (tracker.used[visualType] ?? 0) / tracker.total;
  return actual > target * 1.5;
}

export function printBudgetSummary(tracker: VisualBudgetTracker): void {
  const lines = ["[MasterDirector] Visual budget usage:"];
  const types = Object.keys(tracker.blueprint.visualBudget) as (keyof VisualBudget)[];
  for (const t of types) {
    const target = tracker.blueprint.visualBudget[t];
    const actual = tracker.total > 0 ? ((tracker.used[t] ?? 0) / tracker.total) : 0;
    const pct = (actual * 100).toFixed(0);
    const tgt = (target * 100).toFixed(0);
    const flag = actual > target * 1.5 ? " ⚠ over budget" : "";
    lines.push(`  ${t.padEnd(16)} actual=${pct}%  target=${tgt}%${flag}`);
  }
  console.log(lines.join("\n"));
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Generates the global visual blueprint for the full video.
 * Never throws. Falls back to deterministic plan if LLM fails.
 */
export async function createVideoBlueprint(
  videoId: string,
  videoTitle: string,
  videoLengthMin: number,
  scenes: Array<{ index: number; text: string; beats?: Array<{ index: number; text: string }> }>
): Promise<VideoBlueprint> {
  if (!masterDocumentaryDirectorEnabled()) {
    return buildFallbackBlueprint(videoId, videoTitle,
      scenes.map((s) => ({ index: s.index, text: s.text, beatCount: s.beats?.length ?? 3 })));
  }

  const sceneInputs: SceneInput[] = scenes.map((s) => ({
    index: s.index,
    text: s.text,
    beatCount: s.beats?.length ?? 3,
  }));

  try {
    const prompt = buildBlueprintPrompt(videoTitle, videoLengthMin, sceneInputs);
    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a master documentary director and visual storyteller. Output only valid JSON. No markdown fences.",
        },
        { role: "user", content: prompt },
      ],
      maxTokens: 2400,
    });

    const rawContent = result?.choices?.[0]?.message?.content;
    const text = typeof rawContent === "string" ? rawContent : null;
    if (!text) throw new Error("empty LLM response");

    // Strip markdown fences if present
    const jsonText = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/, "");
    const raw: RawBlueprint = JSON.parse(jsonText);
    const blueprint = parseRawBlueprint(raw, videoId, videoTitle, sceneInputs);

    // Log summary
    console.log(
      `[MasterDirector] Blueprint created for "${videoTitle}" — ` +
      `${scenes.length} scenes, ${blueprint.beatDirectives.size} beats planned, ` +
      `${blueprint.visualCallbacks.length} callbacks, ` +
      `${blueprint.soundDesign.length} sfx cues, ` +
      `${blueprint.textOverlays.length} overlays, ` +
      `${blueprint.animations.length} animations`
    );
    console.log(`[MasterDirector] Narrative: ${blueprint.narrativeSummary}`);
    const budgetLine = (Object.keys(blueprint.visualBudget) as (keyof VisualBudget)[])
      .map((k) => `${k}=${(blueprint.visualBudget[k] * 100).toFixed(0)}%`)
      .join(" ");
    console.log(`[MasterDirector] Budget: ${budgetLine}`);

    return blueprint;
  } catch (err) {
    console.warn(
      "[MasterDirector] LLM blueprint failed, using deterministic fallback:",
      (err as Error).message?.slice(0, 80)
    );
    return buildFallbackBlueprint(videoId, videoTitle, sceneInputs);
  }
}
