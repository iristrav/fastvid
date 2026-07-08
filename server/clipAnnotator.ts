/**
 * Clip Annotator — één keer per clip, bij ingestie.
 *
 * Analyseert een archief-asset en produceert een volledig redactioneel profiel
 * (ClipAnnotation). Het resultaat wordt opgeslagen in media_archive_assets.annotationJson
 * en mag daarna nooit opnieuw worden berekend, tenzij annotationVersion stijgt.
 *
 * De annotator gebruikt:
 *  1. Metadata uit de DB (title, tags, sourceNote) — altijd beschikbaar.
 *  2. Een thumbnail/frame-URL voor vision-analyse indien beschikbaar.
 *  3. invokeLLM voor de LLM-aanroep (provider-agnostisch).
 *
 * Feature flag: CLIP_ANNOTATOR_ENABLED (default: "true")
 * Versie: wijzig ANNOTATION_VERSION als de prompt significant verandert → backfill opnieuw.
 */

import { invokeLLM } from "./_core/llm";
import type { ClipAnnotation } from "../drizzle/annotationTypes";
import type { MediaArchiveAsset } from "../drizzle/schema";

export const ANNOTATION_VERSION = "v1";

// ─── Feature flag ─────────────────────────────────────────────────────────────

export function clipAnnotatorEnabled(): boolean {
  return process.env.CLIP_ANNOTATOR_ENABLED !== "false";
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildAnnotationPrompt(asset: MediaArchiveAsset): string {
  const meta = [
    asset.title ? `Title: "${asset.title}"` : "",
    asset.tags?.length ? `Tags: ${asset.tags.join(", ")}` : "",
    asset.sourceNote ? `Source: ${asset.sourceNote}` : "",
    `Type: ${asset.mediaType}`,
    asset.durationSec ? `Duration: ${asset.durationSec}s` : "",
    asset.width && asset.height ? `Resolution: ${asset.width}×${asset.height}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `You are a professional documentary archive editor. Analyze this media clip based on the metadata provided${asset.storageUrl ? " and the thumbnail image" : ""}.

${meta}

Return ONLY this JSON object — all fields required, use empty string/array if unknown:

{
  "version": "${ANNOTATION_VERSION}",
  "persons": {
    "named": [],
    "categories": []
  },
  "objects": [],
  "actions": [],
  "environment": {
    "setting": "",
    "isInterior": false,
    "lighting": ""
  },
  "historicalContext": {
    "event": "",
    "period": "",
    "year": "",
    "decade": "",
    "century": ""
  },
  "location": {
    "continent": "",
    "country": "",
    "region": "",
    "city": "",
    "confidence": "low"
  },
  "cinematography": {
    "shotType": "medium",
    "cameraMovement": "static",
    "composition": "asymmetrical",
    "visualStyle": "archival"
  },
  "emotion": "neutral",
  "motionLevel": 50,
  "quality": {
    "overall": 60,
    "sharpness": 60,
    "exposure": 60,
    "stability": 60,
    "compression": 60
  },
  "editorialScore": {
    "total": 0,
    "historicalUsability": 0,
    "cinematicQuality": 0,
    "storytellingPotential": 0,
    "emotionalValue": 0,
    "movementQuality": 0,
    "originality": 0
  },
  "usageHints": {
    "bestUsedAs": "cutaway",
    "topicAffinity": [],
    "avoid": []
  }
}

Scoring guidance for editorialScore sub-scores (0-100):
- historicalUsability: how well does this illustrate a historical moment?
- cinematicQuality: composition, lighting, framing quality
- storytellingPotential: could this open, develop, or close a documentary scene?
- emotionalValue: strength and clarity of emotional impact
- movementQuality: smooth, purposeful camera movement scores high; static or shaky scores lower
- originality: rare/unique footage scores high; generic B-roll scores lower
- total = average of all six sub-scores

motionLevel 0-100: 0=completely static image, 100=maximum movement
quality scores 0-100: estimate from resolution, source era, visual clarity`;
}

// ─── Editorial score calculator ───────────────────────────────────────────────

function computeEditorialTotal(scores: ClipAnnotation["editorialScore"]): number {
  const values = [
    scores.historicalUsability,
    scores.cinematicQuality,
    scores.storytellingPotential,
    scores.emotionalValue,
    scores.movementQuality,
    scores.originality,
  ];
  const sum = values.reduce((a, b) => a + b, 0);
  return Math.round(sum / values.length);
}

// ─── Fallback annotation ──────────────────────────────────────────────────────

function buildFallback(asset: MediaArchiveAsset): ClipAnnotation {
  const tags = asset.tags ?? [];
  return {
    version: ANNOTATION_VERSION,
    persons: { named: [], categories: [] },
    objects: tags.slice(0, 10),
    actions: [],
    environment: { setting: "outdoors", isInterior: false, lighting: "daylight" },
    historicalContext: { event: "", period: "", year: "", decade: "", century: "" },
    location: { continent: "", country: "", region: "", city: "", confidence: "low" },
    cinematography: {
      shotType: "medium",
      cameraMovement: "static",
      composition: "asymmetrical",
      visualStyle: asset.mixKind === "real_video" ? "documentary" : "archival",
    },
    emotion: "neutral",
    motionLevel: 50,
    quality: { overall: 50, sharpness: 50, exposure: 50, stability: 50, compression: 50 },
    editorialScore: {
      total: 50,
      historicalUsability: 50,
      cinematicQuality: 50,
      storytellingPotential: 50,
      emotionalValue: 50,
      movementQuality: 50,
      originality: 50,
    },
    usageHints: {
      bestUsedAs: "cutaway",
      topicAffinity: tags.slice(0, 5),
      avoid: [],
    },
  };
}

// ─── Main annotate function ───────────────────────────────────────────────────

/**
 * Analyse één clip en retourneer een ClipAnnotation.
 * Gooit nooit — geeft fallback terug bij elke fout.
 */
export async function annotateAsset(asset: MediaArchiveAsset): Promise<ClipAnnotation> {
  if (!clipAnnotatorEnabled()) return buildFallback(asset);

  try {
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: buildAnnotationPrompt(asset) },
    ];

    // Voeg thumbnail toe indien beschikbaar (vision-analyse)
    const thumbnailUrl = asset.storageUrl;
    if (thumbnailUrl && (thumbnailUrl.startsWith("http://") || thumbnailUrl.startsWith("https://"))) {
      userContent.push({ type: "image_url", image_url: { url: thumbnailUrl } });
    }

    const result = await invokeLLM({
      messages: [
        {
          role: "system",
          content:
            "You are a professional documentary archive editor. Analyze media clips and return structured JSON annotations. Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: userContent as never,
        },
      ],
      preferProvider: "groq",
      maxTokens: 1000,
      responseFormat: { type: "json_object" },
    });

    const raw =
      typeof result.choices[0]?.message.content === "string"
        ? result.choices[0].message.content
        : "{}";

    const parsed = JSON.parse(raw) as Partial<ClipAnnotation>;

    // Merge met fallback voor ontbrekende velden
    const fb = buildFallback(asset);
    const annotation: ClipAnnotation = {
      version: ANNOTATION_VERSION,
      persons: {
        named: Array.isArray(parsed.persons?.named) ? parsed.persons.named : fb.persons.named,
        categories: Array.isArray(parsed.persons?.categories)
          ? parsed.persons.categories
          : fb.persons.categories,
      },
      objects: Array.isArray(parsed.objects) ? parsed.objects : fb.objects,
      actions: Array.isArray(parsed.actions) ? parsed.actions : fb.actions,
      environment: {
        setting: parsed.environment?.setting || fb.environment.setting,
        isInterior: parsed.environment?.isInterior ?? fb.environment.isInterior,
        lighting: parsed.environment?.lighting || fb.environment.lighting,
      },
      historicalContext: {
        event: parsed.historicalContext?.event || "",
        period: parsed.historicalContext?.period || "",
        year: parsed.historicalContext?.year || "",
        decade: parsed.historicalContext?.decade || "",
        century: parsed.historicalContext?.century || "",
      },
      location: {
        continent: parsed.location?.continent || "",
        country: parsed.location?.country || "",
        region: parsed.location?.region || "",
        city: parsed.location?.city || "",
        confidence: parsed.location?.confidence || "low",
      },
      cinematography: {
        shotType: parsed.cinematography?.shotType || "medium",
        cameraMovement: parsed.cinematography?.cameraMovement || "static",
        composition: parsed.cinematography?.composition || "asymmetrical",
        visualStyle: parsed.cinematography?.visualStyle || "archival",
      },
      emotion: parsed.emotion || "neutral",
      motionLevel:
        typeof parsed.motionLevel === "number"
          ? Math.min(100, Math.max(0, Math.round(parsed.motionLevel)))
          : 50,
      quality: {
        overall: clamp(parsed.quality?.overall ?? 60),
        sharpness: clamp(parsed.quality?.sharpness ?? 60),
        exposure: clamp(parsed.quality?.exposure ?? 60),
        stability: clamp(parsed.quality?.stability ?? 60),
        compression: clamp(parsed.quality?.compression ?? 60),
      },
      editorialScore: {
        historicalUsability: clamp(parsed.editorialScore?.historicalUsability ?? 50),
        cinematicQuality: clamp(parsed.editorialScore?.cinematicQuality ?? 50),
        storytellingPotential: clamp(parsed.editorialScore?.storytellingPotential ?? 50),
        emotionalValue: clamp(parsed.editorialScore?.emotionalValue ?? 50),
        movementQuality: clamp(parsed.editorialScore?.movementQuality ?? 50),
        originality: clamp(parsed.editorialScore?.originality ?? 50),
        total: 0, // computed below
      },
      usageHints: {
        bestUsedAs: parsed.usageHints?.bestUsedAs || "cutaway",
        topicAffinity: Array.isArray(parsed.usageHints?.topicAffinity)
          ? parsed.usageHints.topicAffinity.slice(0, 10)
          : [],
        avoid: Array.isArray(parsed.usageHints?.avoid) ? parsed.usageHints.avoid.slice(0, 5) : [],
      },
    };

    annotation.editorialScore.total = computeEditorialTotal(annotation.editorialScore);

    return annotation;
  } catch (err) {
    console.warn(
      `[ClipAnnotator] Asset ${asset.id} annotation failed — using fallback:`,
      (err as Error).message?.slice(0, 80)
    );
    return buildFallback(asset);
  }
}

function clamp(v: unknown): number {
  const n = typeof v === "number" ? v : 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ─── Semantic document uitbreiding ───────────────────────────────────────────

/**
 * Bouw een rijker semantisch document voor embedding uit annotatie + bestaande metadata.
 * Ter vervanging van de eenvoudige versie in semanticDocumentBuilder.ts.
 */
export function buildEnrichedSemanticDocument(
  asset: MediaArchiveAsset,
  annotation: ClipAnnotation | null
): string {
  const parts: string[] = [];

  if (asset.title) parts.push(asset.title);
  if (asset.tags?.length) parts.push(asset.tags.join(", "));
  if (asset.sourceNote) parts.push(asset.sourceNote);
  parts.push(asset.mediaType === "video" ? "video footage" : "photo image");
  if (asset.mixKind) parts.push(asset.mixKind.replace(/_/g, " "));

  if (annotation) {
    if (annotation.persons.named.length) parts.push(annotation.persons.named.join(", "));
    if (annotation.persons.categories.length) parts.push(annotation.persons.categories.join(", "));
    if (annotation.objects.length) parts.push(annotation.objects.join(", "));
    if (annotation.actions.length) parts.push(annotation.actions.join(", "));
    if (annotation.environment.setting) parts.push(annotation.environment.setting);
    if (annotation.historicalContext.period) parts.push(annotation.historicalContext.period);
    if (annotation.historicalContext.event) parts.push(annotation.historicalContext.event);
    if (annotation.historicalContext.year) parts.push(annotation.historicalContext.year);
    if (annotation.location.country) parts.push(annotation.location.country);
    if (annotation.location.city) parts.push(annotation.location.city);
    if (annotation.cinematography.shotType) parts.push(annotation.cinematography.shotType);
    if (annotation.cinematography.visualStyle) parts.push(annotation.cinematography.visualStyle);
    if (annotation.emotion && annotation.emotion !== "neutral") parts.push(annotation.emotion);
    if (annotation.usageHints.topicAffinity.length)
      parts.push(annotation.usageHints.topicAffinity.join(", "));
  }

  return parts.filter(Boolean).join(". ");
}
