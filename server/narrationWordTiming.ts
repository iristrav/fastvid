/**
 * RONDE 653 — WORD TIMING THAT DOES NOT DISAPPEAR WHEN ELEVENLABS DOES.
 *
 * Renders 606 and 607: ElevenLabs answered 401 payment_required, Fish Audio spoke the narration,
 * and the timeline was planned with `words=0`. Only ElevenLabs' timestamped endpoint ever produced
 * word boundaries, so every fallback voice silently took them away: captions and karaoke lines had
 * nothing to follow, and nothing said so beyond a zero in one log line.
 *
 * One method plus one technical fallback, and the render names the one it stood on:
 *
 *   elevenlabs  measured by the TTS itself — exact.
 *   estimated   the script's words spread over the narration's measured length, weighted by their
 *               length and the pauses punctuation implies. Close enough for a caption to appear
 *               with its sentence; not close enough to cut picture on, which is why it is never
 *               written back to the alignment file the scene split reads.
 *
 * `none` only when there is no narration to time at all.
 */
import fs from "fs";
import path from "path";
import type { TtsWordTiming } from "./voiceTtsAlignment";

export type WordTimingSource = "elevenlabs" | "estimated" | "none";

export type NarrationWordTiming = {
  words: TtsWordTiming[];
  source: WordTimingSource;
  /** Why this rung, in one line for the log. */
  note: string;
};

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Relative weight of a token: its letters, plus the pause its punctuation asks for. */
function tokenWeight(token: string): { speak: number; pauseAfter: number } {
  const letters = token.replace(/[^\p{L}\p{N}]/gu, "").length;
  const speak = Math.max(1, letters) + 1;
  const pauseAfter = /[.!?…]["')\]]*$/.test(token) ? 6 : /[,;:—–-]["')\]]*$/.test(token) ? 3 : 0;
  return { speak, pauseAfter };
}

/**
 * The script's words over the narration's measured length. Deterministic, and every word gets a
 * span inside `[leadSec, durationSec - tailSec]`, in order, without overlap.
 */
export function estimateWordTimings(
  text: string,
  durationSec: number,
  opts: { leadSec?: number; tailSec?: number } = {}
): TtsWordTiming[] {
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0 || !(durationSec > 0)) return [];
  const lead = Math.min(opts.leadSec ?? 0.1, durationSec * 0.1);
  const tail = Math.min(opts.tailSec ?? 0.25, durationSec * 0.1);
  const span = Math.max(0.1, durationSec - lead - tail);
  const weights = tokens.map(tokenWeight);
  const total = weights.reduce((s, w, i) => s + w.speak + (i < weights.length - 1 ? w.pauseAfter : 0), 0);
  const perUnit = span / total;
  const words: TtsWordTiming[] = [];
  let at = lead;
  tokens.forEach((token, i) => {
    const w = weights[i]!;
    const start = at;
    const end = start + w.speak * perUnit;
    words.push({ word: token.replace(/^["'(\[]+|["')\].,;:!?…]+$/g, "") || token, startSec: round(start), endSec: round(end) });
    at = end + (i < tokens.length - 1 ? w.pauseAfter * perUnit : 0);
  });
  return words;
}

/** Walk the ladder. Never throws; always says which rung it stood on and why. */
export async function narrationWordTiming(params: {
  measured: TtsWordTiming[] | null | undefined;
  audioPath: string | null;
  text: string;
  durationSec: number | null;
}): Promise<NarrationWordTiming> {
  if (params.measured && params.measured.length > 0) {
    return { words: params.measured, source: "elevenlabs", note: "measured by the TTS" };
  }
  const dur = params.durationSec ?? 0;
  if (!(dur > 0)) return { words: [], source: "none", note: "no narration length to time" };
  const words = estimateWordTimings(params.text, dur);
  return {
    words,
    source: words.length ? "estimated" : "none",
    note: `TTS gave no timestamps; spread the script over ${dur.toFixed(2)}s`,
  };
}

/* ═══════════════════════ what the TTS actually did ═══════════════════════ */

export type NarrationMeta = { text: string; providers: string[] };

const META_FILE = "narration_meta.json";

export function saveNarrationMeta(workDir: string, meta: NarrationMeta): void {
  try {
    fs.writeFileSync(path.join(workDir, META_FILE), JSON.stringify(meta));
  } catch (err) {
    console.warn(`[Voice] could not record narration meta: ${(err as Error).message?.slice(0, 120)}`);
  }
}

export function loadNarrationMeta(workDir: string): NarrationMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workDir, META_FILE), "utf8")) as Partial<NarrationMeta>;
    if (typeof raw.text !== "string" || !Array.isArray(raw.providers)) return null;
    return { text: raw.text, providers: raw.providers.map(String) };
  } catch {
    return null;
  }
}

/** "fish-audio×2, elevenlabs-timestamped×1" — counted, in order of first appearance. */
export function summarizeProviders(providers: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const p of providers) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts].map(([p, n]) => `${p}×${n}`).join(", ") || "none";
}

/** The one provider that spoke all of it, or "mixed:…" — what the metadata records. */
export function narrationProviderLabel(providers: readonly string[]): string | null {
  const unique = [...new Set(providers.map((p) => (p === "elevenlabs-timestamped" ? "elevenlabs" : p)))];
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0]! : `mixed:${unique.join("+")}`;
}
