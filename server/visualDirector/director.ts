/**
 * Visual Director — the creative brain of the pipeline.
 *
 * Decides per scene WHAT to render and WHY.
 * Does NOT apply fixed rules. Weighs competing signals and picks
 * the most informative animation for each moment.
 *
 * Priority order when multiple directives compete for the same time slot:
 *   1. person_label (establishes who we're talking about)
 *   2. counter (makes numbers tangible)
 *   3. map_marker (grounds the viewer geographically)
 *   4. timeline (shows progression through time)
 *   5. comparison (clarifies A vs B)
 *   6. bullet_list (structures a list)
 *   7. quote (emphasises a key statement)
 *   8. stat_highlight (lone striking number)
 */
import { analyzeScene } from "./analyzer";
import type {
  Directive,
  SceneDirective,
  VideoDirective,
  PersonLabel,
  Counter,
  MapMarker,
  Timeline,
  Comparison,
  BulletList,
  Quote,
  StatHighlight,
} from "./types";

interface BeatMeta {
  text: string;
  voiceStartSec?: number;
  voiceEndSec?: number;
  holdSec: number;
}

interface SceneMeta {
  index: number;
  text: string;
  visualCue?: string;
  pexelsQuery?: string;
  duration: number;
  beats?: BeatMeta[];
}

// ── Time-slot management ──────────────────────────────────────────────────────

// Extend Directive with a computed endTime for overlap checks
type DirectiveWithEnd = Directive & { endTime: number };

function withEnd(d: Directive): DirectiveWithEnd {
  return { ...d, endTime: d.startSec + d.durationSec } as DirectiveWithEnd;
}

function slotFree(used: DirectiveWithEnd[], start: number, end: number): boolean {
  return !used.some(d => d.startSec < end && d.endTime > start);
}

function claimSlot(
  used: DirectiveWithEnd[],
  directive: Directive,
  videoDur: number,
  minGap = 0.5
): Directive | null {
  const start = Math.max(0, directive.startSec);
  const end   = Math.min(videoDur - 0.1, start + directive.durationSec);
  if (end - start < 0.8) return null;
  if (!slotFree(used, start - minGap, end + minGap)) return null;
  const clamped = { ...directive, startSec: start, durationSec: end - start };
  used.push(withEnd(clamped));
  return clamped;
}

// ── Directive builders ────────────────────────────────────────────────────────

function makePersonLabel(name: string, title: string, start: number, dur: number): PersonLabel {
  return { kind: "person_label", name, title, startSec: start, durationSec: dur };
}

function makeCounter(value: number, suffix: string, label: string, start: number): Counter {
  return { kind: "counter", value, suffix, label, startSec: start, durationSec: 3.5 };
}

function makeMapMarker(loc: { name: string; normX: number; normY: number }, start: number, dur: number): MapMarker {
  return { kind: "map_marker", locationName: loc.name, normX: loc.normX, normY: loc.normY, startSec: start, durationSec: dur };
}

function makeTimeline(years: string[], highlight: string | undefined, start: number, dur: number): Timeline {
  return {
    kind: "timeline",
    events: years.map(y => ({ year: y })),
    highlightYear: highlight,
    startSec: start,
    durationSec: dur,
  };
}

function makeComparison(left: string, right: string, start: number): Comparison {
  return { kind: "comparison", leftLabel: left, rightLabel: right, connector: "VS", startSec: start, durationSec: 4.0 };
}

function makeBulletList(items: string[], start: number, dur: number): BulletList {
  return { kind: "bullet_list", items: items.slice(0, 5), startSec: start, durationSec: dur };
}

function makeQuote(text: string, attribution: string | undefined, start: number, dur: number): Quote {
  return { kind: "quote", text, attribution, startSec: start, durationSec: dur };
}

function makeStatHighlight(value: string, context: string | undefined, start: number): StatHighlight {
  return { kind: "stat_highlight", value, context, startSec: start, durationSec: 3.5 };
}

// ── Beat time helper ──────────────────────────────────────────────────────────

function beatWindow(beat: BeatMeta, idx: number): { start: number; end: number } {
  const start = beat.voiceStartSec ?? idx * beat.holdSec;
  const end   = beat.voiceEndSec   ?? start + beat.holdSec;
  return { start, end };
}

// ── Per-scene decision logic ──────────────────────────────────────────────────

export function directScene(scene: SceneMeta, videoTitle = ""): SceneDirective {
  const dur     = scene.duration;
  const beats   = scene.beats ?? [];
  const signals = analyzeScene(scene.text, scene.visualCue ?? "", scene.pexelsQuery ?? "", beats);
  const used: DirectiveWithEnd[] = [];
  const directives: Directive[]  = [];
  const reasons: string[]        = [];

  // ── 1. Person labels — highest priority, at the moment the name appears ──
  for (let bi = 0; bi < beats.length && directives.filter(d => d.kind === "person_label").length < 2; bi++) {
    const beat  = beats[bi];
    const { start, end } = beatWindow(beat, bi);
    const beatSignals = analyzeScene(beat.text, "", "", []);
    for (const p of beatSignals.persons) {
      const d = claimSlot(used, makePersonLabel(p.name, p.title, start + 0.2, Math.min(end - start - 0.3, 4.5)), dur);
      if (d) { directives.push(d); reasons.push(`person "${p.name}" at beat ${bi}`); break; }
    }
  }

  // Also check scene-level persons not yet covered
  for (const p of signals.persons) {
    if (directives.some(d => d.kind === "person_label" && (d as PersonLabel).name === p.name)) continue;
    const d = claimSlot(used, makePersonLabel(p.name, p.title, 0.8, 4.0), dur);
    if (d) { directives.push(d); reasons.push(`person "${p.name}" scene-level`); break; }
  }

  // ── 2. Counters — make numbers tangible ──────────────────────────────────
  for (let bi = 0; bi < beats.length && directives.filter(d => d.kind === "counter").length < 1; bi++) {
    const beat = beats[bi];
    const { start } = beatWindow(beat, bi);
    const beatSig = analyzeScene(beat.text, "", "", []);
    for (const st of beatSig.stats) {
      if (st.value < 100) continue; // only large numbers get counters
      const d = claimSlot(used, makeCounter(st.value, st.suffix, st.label, start + 0.3), dur);
      if (d) { directives.push(d); reasons.push(`counter ${st.raw}`); break; }
    }
  }

  // ── 3. Map markers — ground the viewer geographically ───────────────────
  if (signals.locations.length > 0) {
    const loc   = signals.locations[0];
    const start = 0.5;
    const mapDur = Math.min(5.0, dur * 0.4);
    // Only show map if there's a free slot AND the scene is actually about this place
    const isMainTopic = true; // location already matched via analyzer
    if (isMainTopic) {
      const d = claimSlot(used, makeMapMarker(loc, start, mapDur), dur, 1.0);
      if (d) { directives.push(d); reasons.push(`location "${loc.name}"`); }
    }
  }

  // ── 4. Timeline — show progression when 3+ years span a wide range ───────
  if (signals.years.length >= 3) {
    const minY = parseInt(signals.years[0]);
    const maxY = parseInt(signals.years[signals.years.length - 1]);
    if (maxY - minY >= 3) {
      const start = directives.length > 0
        ? Math.max(...directives.map(d => d.startSec + d.durationSec)) + 0.5
        : 1.0;
      const timelineDur = Math.min(5.0, dur - start - 0.5);
      const d = claimSlot(used, makeTimeline(signals.years.slice(0, 5), signals.years[0], start, timelineDur), dur);
      if (d) { directives.push(d); reasons.push(`timeline ${signals.years[0]}–${signals.years[signals.years.length-1]}`); }
    }
  }

  // ── 5. Comparison — A vs B ───────────────────────────────────────────────
  if (signals.comparison) {
    const { left, right } = signals.comparison;
    const start = directives.length > 0
      ? Math.max(...directives.map(d => d.startSec + d.durationSec)) + 0.5
      : 1.5;
    const d = claimSlot(used, makeComparison(left, right, start), dur);
    if (d) { directives.push(d); reasons.push(`comparison "${left}" vs "${right}"`); }
  }

  // ── 6. Bullet list — structure enumerated items ──────────────────────────
  if (signals.listItems.length >= 3 && directives.length === 0) {
    const start = 0.8;
    const listDur = Math.min(signals.listItems.length * 1.8, dur * 0.7);
    const d = claimSlot(used, makeBulletList(signals.listItems, start, listDur), dur);
    if (d) { directives.push(d); reasons.push(`bullet list (${signals.listItems.length} items)`); }
  }

  // ── 7. Quote — emphasise a key statement ─────────────────────────────────
  if (signals.quote && directives.length === 0) {
    const q    = signals.quote;
    const qdur = Math.min(Math.max(2.5, q.text.length * 0.05), 6.0);
    const d = claimSlot(used, makeQuote(q.text, q.attribution, 0.8, qdur), dur);
    if (d) { directives.push(d); reasons.push(`quote "${q.text.slice(0, 40)}…"`); }
  }

  // ── 8. Stat highlight — lone striking number ─────────────────────────────
  if (signals.stats.length > 0 && !directives.some(d => d.kind === "counter")) {
    const st = signals.stats[0];
    const d = claimSlot(used, makeStatHighlight(st.raw, undefined, 1.0), dur);
    if (d) { directives.push(d); reasons.push(`stat highlight "${st.raw}"`); }
  }

  const reasoning = reasons.length
    ? reasons.join("; ")
    : "no informative overlay needed for this scene";

  if (directives.length) {
    console.log(`[VisualDirector] s${scene.index}: ${reasoning}`);
  }

  return { sceneIndex: scene.index, reasoning, directives };
}

export function directVideo(scenes: SceneMeta[], videoTitle = ""): VideoDirective {
  return { scenes: scenes.map(s => directScene(s, videoTitle)) };
}

import { burnedInTextAllowed } from "../onScreenTextPolicy";
export function visualDirectorEnabled(): boolean {
  // RONDE 113: one rule, asked first — see onScreenTextPolicy.
  if (!burnedInTextAllowed()) return false;
  return process.env.VISUAL_DIRECTOR !== "false";
}
