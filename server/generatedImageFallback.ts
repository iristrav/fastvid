/**
 * GENERATED_IMAGE_FALLBACK — a still image generated for a sentence nothing else could illustrate.
 *
 * ── Where it sits ───────────────────────────────────────────────────────────────────────────────
 *
 * Last of the picture routes, and asked only once every one before it has had its turn:
 *
 *   1  REAL / ARCHIVE / OPEN / STOCK   YouTube, own archive, open sources, stock, photos — the beat's
 *                                      sourcing ladder and the main-subject rescue (unchanged)
 *   2  DATA / MAP GRAPHIC              a graphic from the sentence as its picture (never pre-empted)
 *   3  AI GENERATED IMAGE              this module — logged GENERATED_IMAGE_FALLBACK
 *   4  CHAPTER CARD                    Remotion's drawn card — logged CHAPTER_CARD_FALLBACK
 *
 * The generated file then takes exactly the route an article screenshot takes: a still clip,
 * `adoptClip` (the technical gate and the picture editor against this sentence), the archive, the
 * timeline. Nothing downstream knows it was generated except the provider name it carries.
 *
 * ── What it may show ─────────────────────────────────────────────────────────────────────────────
 *
 * The prompt is the sentence itself plus its VisualIntent (the director's description and search
 * query). It asks for an editorial illustration, never a photograph, and never a real person's
 * likeness: a sentence that names a person is not generated at all, nor one whose plan forbids AI
 * imagery. A sentence with too little to show (fewer than two subject words) gets nothing.
 */
import fs from "node:fs";

import { classifyProviderFailure, formatProviderCooldown } from "./providerFailureClass";
import { subjectWords } from "./youtubeNonFootage";

export const GENERATED_IMAGE_FALLBACK = "GENERATED_IMAGE_FALLBACK";

/** The provider name a generated image carries through the lineage, the archive and the timeline. */
export const GENERATED_IMAGE_PROVIDER = "stability";

/** At most this many generated pictures in one film: a last resort, not a source. */
export const GENERATED_IMAGES_PER_FILM = 3;

/**
 * The last word of a capitalised name that makes it a plan, war, treaty or institution rather than
 * a person ("Marshall Plan", "Cold War", "Treaty of Versailles"). English nouns, no topic.
 */
const THING_NOUN =
  /^(plan|war|wars|treaty|act|accord|accords|agreement|pact|doctrine|deal|revolution|battle|crisis|depression|conference|summit|convention|movement|era|program|programme|project|mission|cup|games|olympics|election|union|republic|empire|kingdom|bank|fund|organization|organisation|council|committee|agency|court|wall|canal|bridge|airlift|blockade|offensive|campaign|invasion|landings|rebellion|uprising|reform|reforms|law|bill|charter|declaration|protocol|initiative|system|exchange|market|index|institute|university|corporation|company|foundation)$/i;

/** "The Marshall Plan" reads like a person's name but names a thing: only a real person blocks. */
export function namesAThingNotAPerson(name: string): boolean {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  if (/^(treaty|battle|siege|congress|council|republic|kingdom|empire|bank|university)$/i.test(words[0]!) && words[1]?.toLowerCase() === "of") return true;
  return THING_NOUN.test(words[words.length - 1]!);
}

export type GeneratedImageDecision = { generate: true } | { generate: false; reason: string };

/**
 * Whether a sentence with no picture may have one generated. Every "no" names its reason, so the
 * log says why a sentence stayed without a picture.
 */
export function generatedImageDecision(input: {
  /** The sentence already has an approved picture. */
  hasPicture: boolean;
  /** A data graphic or a map from the sentence can be its picture (step 3 wins). */
  graphicCanStandIn: boolean;
  /** The people the sentence names — never generated as a likeness. */
  people: readonly string[];
  /** The plan's forbidden content for this sentence. */
  forbidden?: readonly string[];
  /** Generated pictures still allowed in this film. */
  budgetLeft: number;
}): GeneratedImageDecision {
  if (input.hasPicture) return { generate: false, reason: "has_picture" };
  if (input.graphicCanStandIn) return { generate: false, reason: "graphic_stands_in" };
  if (input.people.some((p) => !namesAThingNotAPerson(p))) return { generate: false, reason: "names_a_person" };
  if ((input.forbidden ?? []).some((f) => /\bai\b|generated/i.test(f))) return { generate: false, reason: "plan_forbids_ai" };
  if (input.budgetLeft <= 0) return { generate: false, reason: "film_budget_spent" };
  return { generate: true };
}

/**
 * The prompt: what the director planned to show, and the sentence it must support, as an
 * illustration. Null when the two together name fewer than two things to show.
 */
export function generatedImagePrompt(input: {
  sentence: string;
  visualDescription?: string | null;
  searchQuery?: string | null;
}): string | null {
  const sentence = input.sentence.replace(/\s+/g, " ").trim();
  const planned = [input.visualDescription, input.searchQuery]
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter((s) => s && s.toLowerCase() !== "documentary broll scene")
    .join(". ");
  if (subjectWords(`${sentence} ${planned}`).length < 2) return null;
  return (
    `Editorial documentary illustration, not a photograph. ` +
    (planned ? `It shows: ${planned}. ` : "") +
    `It illustrates this narration: "${sentence}". ` +
    `No text, no letters, no captions, no logos, no recognisable real person. Wide 16:9 composition, natural light.`
  );
}

/** Writes a PNG for the prompt to `outPng`; true when the file is there. */
export type StillImageGenerator = (prompt: string, outPng: string) => Promise<boolean>;

let generatorOverride: StillImageGenerator | null = null;
export function setStillImageGeneratorForTests(g: StillImageGenerator | null): void {
  generatorOverride = g;
}

/**
 * VIDEO 630 — an answer about the ACCOUNT, not about one picture.
 *
 *     [GENERATED_IMAGE_FALLBACK] the image service answered HTTP 402      (×9, one per sentence)
 *
 * 401, 402 and 403 say the key, the credits or the permission is missing: the next sentence's
 * prompt cannot change that. After one such answer the service is not asked again for 30 minutes,
 * and every sentence goes straight on to the fallbacks after this one. Any other refusal (a
 * prompt the service would not draw, a 5xx, a timeout) stays per picture, exactly as before.
 *
 * The same process-wide "cooldown until" timestamp the Wikimedia stand-down uses
 * (`wikimediaCooldownUntilMs`), the same failure classification and the same log line. Only ever
 * moved later (`Math.max`), so parallel beats and renders can never shorten it.
 */
const ACCOUNT_REFUSAL_STATUSES = new Set([401, 402, 403]);
export const ACCOUNT_REFUSAL_COOLDOWN_MS = 30 * 60_000;
let imageServiceRefusedUntil = 0;

/** True while the image service has refused this account (see above); no request is sent then. */
export function imageServiceStandingDown(now = Date.now()): boolean {
  return now < imageServiceRefusedUntil;
}

export function resetImageServiceStandDownForTests(): void {
  imageServiceRefusedUntil = 0;
}

/**
 * The production generator: Stability's image endpoint with the key the worker already has
 * (`STABILITY_AI_API_KEY`) — the same endpoint and request `probeStabilityAI` (the existing
 * /api/health/stability-probe) already sends. No key, a refusal, a timeout or an empty file: false, and the sentence
 * keeps the fallbacks after this one.
 */
const stabilityGenerator: StillImageGenerator = async (prompt, outPng) => {
  const key = process.env.STABILITY_AI_API_KEY?.trim();
  if (!key) return false;
  if (imageServiceStandingDown()) return false;
  const form = new FormData();
  form.set("prompt", prompt.slice(0, 2000));
  form.set("aspect_ratio", "16:9");
  form.set("output_format", "png");
  form.set("negative_prompt", "text, letters, caption, watermark, logo");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const resp = await fetch("https://api.stability.ai/v2beta/stable-image/generate/core", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "image/*" },
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`[${GENERATED_IMAGE_FALLBACK}] the image service answered HTTP ${resp.status}`);
      if (ACCOUNT_REFUSAL_STATUSES.has(resp.status)) {
        imageServiceRefusedUntil = Math.max(imageServiceRefusedUntil, Date.now() + ACCOUNT_REFUSAL_COOLDOWN_MS);
        console.warn(
          formatProviderCooldown(GENERATED_IMAGE_PROVIDER, classifyProviderFailure({ status: resp.status }), ACCOUNT_REFUSAL_COOLDOWN_MS)
        );
      }
      return false;
    }
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length < 1_000) return false;
    fs.writeFileSync(outPng, bytes);
    return true;
  } catch (err) {
    console.warn(`[${GENERATED_IMAGE_FALLBACK}] the image service failed: ${(err as Error).message?.slice(0, 120)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export function stillImageGenerator(): StillImageGenerator {
  return generatorOverride ?? stabilityGenerator;
}

/** The sentences of a scene that have no picture of their own: those no clip was pushed for. */
export function beatsWithoutPicture<T extends { index: number }>(beats: readonly T[], clipBeatIndices: readonly number[]): T[] {
  const pictured = new Set(clipBeatIndices);
  return beats.filter((b) => !pictured.has(b.index));
}

/**
 * How long the still is made: the sentence's whole spoken window (or its planned hold, whichever is
 * longer) plus a second, so it covers its own sentence and the edit never needs another shot in it.
 */
export function generatedStillSec(beat: { holdSec?: number; voiceStartSec?: number; voiceEndSec?: number }): number {
  const spoken = beat.voiceStartSec != null && beat.voiceEndSec != null ? beat.voiceEndSec - beat.voiceStartSec : 0;
  return Math.round((Math.max(beat.holdSec ?? 5, spoken, 1) + 1) * 1000) / 1000;
}

/** A generated still belongs to its own sentence only: it is never lent to another one as a fill. */
export function isGeneratedImageClip(clip: { source?: { provider?: string | null } | null }): boolean {
  return clip.source?.provider === GENERATED_IMAGE_PROVIDER;
}
