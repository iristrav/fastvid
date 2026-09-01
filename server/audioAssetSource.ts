/**
 * RONDE 154 §16/§17 — where music, sound effects and ambience come from.
 *
 * ── What the audit found, and what follows from it ──────────────────────────────────────────
 *
 * §16 says: integrate the existing music library, and if there is none, build an interface rather
 * than a fictional one. So the first job was to look.
 *
 *   SOUND EFFECTS AND AMBIENCE — there IS a real library. `cinematicAudio/catalog.ts` holds
 *   curated Freesound ids per category, CC0/CC-BY, with labels. Those ids are REAL ASSET
 *   IDENTITIES: `freesound:401178` names a specific recording that can be fetched again tomorrow.
 *   So this module bridges that catalog onto the timeline rather than inventing a second one.
 *
 *   MUSIC — there is NOT one. `generateBackgroundMusic` synthesises a bed from sine waves
 *   (A2/E3/A3/G3 with a slow amplitude pulse). That is a real, working, honest thing, and it is
 *   not a library: it has no catalogue, no moods, and nothing to choose between. So `MusicSource`
 *   below is the interface §16 asks for, with the existing generator as its one implementation,
 *   labelled as what it is.
 *
 * ── The rule that shapes every function here ────────────────────────────────────────────────
 *
 * NO FAKE FILENAMES. §17 is explicit, and it is easy to violate by accident: it is very tempting
 * to write `{ provider: "sfx", providerAssetId: "whoosh_01" }` for a whoosh nobody has. Every
 * identity this module returns names an asset that exists in a catalog; when the catalog has
 * nothing for a request, the answer is `null` and the caller reports `asset_unavailable`.
 */
import { SOUND_CATALOG } from "./cinematicAudio/catalog";
import type { SoundCategoryId } from "./cinematicAudio/types";
import type { AssetSourceIdentity } from "./projectTimeline";
import type { SoundEffectType } from "./cinematicEditingEngine/types";

/* ═══════════════════════ the semantic vocabulary ═══════════════════════ */

/**
 * The sound effects a planner may ask for. §154's own list.
 *
 * These are SEMANTIC names — what the sound means in the edit — and they are deliberately not the
 * catalog's category ids. A planner reasons about "an impact here"; the catalog reasons about
 * which field recording that is. `SFX_TO_CATEGORY` is the mapping, and it is explicit so that a
 * request with no recording behind it is visible as a missing row rather than as a silent gap.
 */
export type SfxRole =
  | "whoosh" | "impact" | "hit" | "riser" | "click"
  | "camera" | "shutter" | "foley" | "crowd" | "explosion" | "ambience";

export type AmbientRole =
  | "room" | "city" | "street" | "nature" | "wind" | "rain"
  | "crowd" | "battlefield" | "archive" | "office";

/**
 * Semantic role → the catalog category that actually holds a recording for it.
 *
 * A `null` means the vocabulary has the word and the catalog has no sound: the request is
 * ANSWERABLE ("we know what you mean") but not FULFILLABLE ("we have nothing to play"). Those are
 * different failures and the report says which one happened.
 */
export const SFX_TO_CATEGORY: Readonly<Record<SfxRole, SoundCategoryId | null>> = {
  impact: "metal_clang",
  hit: "metal_clang",
  crowd: "crowd",
  camera: "camera_shutter",
  shutter: "camera_shutter",
  ambience: "city",
  /**
   * No recording in the catalog. A whoosh and a riser are synthesised transitions rather than
   * field recordings, and the catalog is a field-recording library — so these are honestly
   * unavailable rather than approximated with something that is not them.
   */
  whoosh: null,
  riser: null,
  click: null,
  foley: null,
  explosion: null,
};

export const AMBIENT_TO_CATEGORY: Readonly<Record<AmbientRole, SoundCategoryId | null>> = {
  city: "city",
  street: "traffic",
  nature: "forest",
  wind: "wind",
  rain: "rain",
  crowd: "crowd",
  office: "factory",
  room: null,
  battlefield: null,
  archive: null,
};

/* ═══════════════════════ resolving a role to a real asset ═══════════════════════ */

export type AudioAssetLookup =
  | { ok: true; identity: AssetSourceIdentity; label: string }
  | { ok: false; reason: string };

/**
 * The identity of a catalog sound, or a reason there is none.
 *
 * ── Why the FIRST variant and not a random one ──────────────────────────────────────────────
 *
 * The catalog holds two or three variants per category so a render can vary. Choosing randomly
 * here would make the same timeline produce a different mix on every render, which breaks §32's
 * determinism. The variant is therefore chosen by INDEX, and the caller supplies the index — from
 * the beat number, the scene, or anything else stable. Same input, same sound, every time.
 */
export function resolveCatalogSound(
  category: SoundCategoryId | null,
  variantIndex = 0
): AudioAssetLookup {
  if (!category) {
    return { ok: false, reason: "no catalog category maps to this role" };
  }
  const variants = SOUND_CATALOG[category];
  if (!variants || variants.length === 0) {
    return { ok: false, reason: `the catalog has no recording for category "${category}"` };
  }
  const variant = variants[Math.abs(variantIndex) % variants.length]!;
  return {
    ok: true,
    label: variant.label,
    identity: {
      /**
       * A REAL provider and a REAL id. `freesound:401178` names one specific CC-licensed recording
       * that the fetcher can retrieve again — which is the whole difference between this and the
       * fake filename §17 forbids.
       */
      provider: "freesound",
      providerAssetId: String(variant.freesoundId),
      sourcePageUrl: `https://freesound.org/s/${variant.freesoundId}/`,
      title: variant.label,
    },
  };
}

/**
 * ENABLE CINEMATIC PRODUCTION + SFX — the PLANNER'S vocabulary, mapped onto the catalog.
 *
 * ── The seam this closes ────────────────────────────────────────────────────────────────────
 *
 * `SfxRole` above is this module's own semantic vocabulary. The Phase 4 sound planner has a
 * DIFFERENT one — `SoundEffectType`, seventeen names reasoned from the beat's content — and
 * `edlToTimeline` wrote those names straight onto the timeline as
 * `{ provider: "cinematic_audio", providerAssetId: "explosion" }`.
 *
 * Nothing in the repository resolves `cinematic_audio`. Not the render worker, not the rehydrator,
 * not the renderer. So every sound effect the planner reasoned out reached the timeline, failed to
 * resolve, and was dropped as "could not be recovered": semantically correct SFX, planned on real
 * content, that have never made a sound.
 *
 * This is the missing row. It maps the planner's word to a catalog category, so the timeline can
 * carry a REAL Freesound identity — the same identity shape the AMBIENT track has used since
 * R166, resolved by the same `resolveCatalogSound`, fetched by the same fetcher.
 *
 * ── The nulls are the honest half ───────────────────────────────────────────────────────────
 *
 * A whoosh, a riser, a heartbeat, a notification, a cash register and a UI click are not field
 * recordings, and this catalog is a field-recording library. Mapping them to "something close"
 * would be exactly the fake effect the brief forbids: a `null` here makes the request answerable
 * ("we know what you mean") and unfulfillable ("we have nothing to play"), and the caller reports
 * SFX_NOT_AVAILABLE rather than playing a metal clang where a heartbeat belongs.
 */
export const SOUND_EFFECT_TO_CATEGORY: Readonly<Record<SoundEffectType, SoundCategoryId | null>> = {
  camera_click: "camera_shutter",
  hit: "metal_clang",
  impact: "metal_clang",
  typing: "typewriter",
  keyboard: "keyboard",
  crowd: "crowd",
  applause: "applause",
  wind: "wind",
  rain: "rain",
  fire: "fire",
  explosion: "explosion",
  page_turn: "paper_turn",
  /** No recording behind any of these — see the note above on why they are not approximated. */
  whoosh: null,
  cash_register: null,
  notification: null,
  heartbeat: null,
  ui_click: null,
};

/**
 * A planned sound effect's real recording, or the reason there is none.
 *
 * `variantIndex` is supplied by the caller and must be stable — the beat's index, not a random
 * number — for the determinism reason `resolveCatalogSound` documents.
 */
export function resolveSoundEffect(
  soundType: SoundEffectType,
  variantIndex = 0
): AudioAssetLookup {
  const category = SOUND_EFFECT_TO_CATEGORY[soundType];
  const found = resolveCatalogSound(category ?? null, variantIndex);
  if (found.ok) return found;
  return { ok: false, reason: `SFX_NOT_AVAILABLE "${soundType}": ${found.reason}` };
}

export function resolveSfx(role: SfxRole, variantIndex = 0): AudioAssetLookup {
  const category = SFX_TO_CATEGORY[role];
  const found = resolveCatalogSound(category ?? null, variantIndex);
  if (found.ok) return found;
  return { ok: false, reason: `asset_unavailable sfx "${role}": ${found.reason}` };
}

export function resolveAmbient(role: AmbientRole, variantIndex = 0): AudioAssetLookup {
  const category = AMBIENT_TO_CATEGORY[role];
  const found = resolveCatalogSound(category ?? null, variantIndex);
  if (found.ok) return found;
  return { ok: false, reason: `asset_unavailable ambient "${role}": ${found.reason}` };
}

/* ═══════════════════════ §16 — music ═══════════════════════ */

export type MusicMood =
  | "tense" | "sad" | "inspiring" | "epic" | "calm" | "urgent" | "neutral";
export type MusicEnergy = "low" | "medium" | "high";

export type MusicRequest = {
  mood: MusicMood;
  energy: MusicEnergy;
  durationSec: number;
};

/**
 * A source of background music.
 *
 * ── Why this is an interface and not an implementation ──────────────────────────────────────
 *
 * §16: "Als die niet bestaat: bouw geen fictieve bibliotheek. Maak in plaats daarvan een nette
 * MusicAssetSource interface." FastVid has no music library. It has a sine-wave generator, which
 * is a perfectly good bed and is not a library — it cannot answer "give me something tense".
 *
 * So this is the shape a real library will implement, and `ProceduralMusicSource` is the honest
 * present-day answer: it produces a bed, it says it ignored the mood, and the caller reports that
 * rather than pretending the mood was honoured.
 */
export interface MusicSource {
  /** A name for the render log. */
  readonly id: string;
  /** Does this source have anything for the request? */
  supports(request: MusicRequest): boolean;
  /**
   * The identity of a track for this request, or a reason there is none.
   *
   * Returns an IDENTITY, not a file: fetching is the rehydrator's job, exactly as it is for video.
   */
  resolve(request: MusicRequest): AudioAssetLookup;
}

/**
 * The music FastVid actually has today: a synthesised bed.
 *
 * It answers every request and honours none of them, and it says so. `mood` and `energy` are
 * carried into the identity's title so a render log shows what was ASKED for next to what was
 * delivered — which is the information somebody needs to decide whether a real library is worth
 * buying.
 */
export class ProceduralMusicSource implements MusicSource {
  readonly id = "procedural_sine_bed";

  supports(): boolean {
    return true;
  }

  resolve(request: MusicRequest): AudioAssetLookup {
    return {
      ok: true,
      label: `synthesised bed (mood "${request.mood}" and energy "${request.energy}" not honoured)`,
      identity: {
        /**
         * `provider: "procedural"` is deliberate and important. It is not a real provider, and it
         * must never be mistaken for one — a rehydrator that saw a provider name it recognised
         * would go looking for a file that was never downloaded. It says: this audio is generated
         * at render time from parameters, and re-generating it is how it comes back.
         */
        provider: "procedural",
        providerAssetId: `sine_bed_${request.durationSec.toFixed(0)}s`,
        title: "Generated background bed",
      },
    };
  }
}

/**
 * What the render log should say about the music it used.
 *
 * §20's rule applied to audio: a bed that ignored the requested mood is a downgrade, and a
 * downgrade is never silent.
 */
export function formatMusicChoice(source: MusicSource, request: MusicRequest, found: AudioAssetLookup): string {
  if (!found.ok) {
    return `[Audio] music asset_unavailable mood=${request.mood} energy=${request.energy} — ${found.reason}`;
  }
  const honoured = source.id !== "procedural_sine_bed";
  return (
    `[Audio] music source=${source.id} mood=${request.mood} energy=${request.energy} ` +
    `provider=${found.identity.provider} moodHonoured=${honoured}`
  );
}
