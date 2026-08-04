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
import type {
  ClipAnnotation,
  ClipQualityFlags,
  AnnotationConfidence,
  ExtendedEditorialScores,
  ClipSegment,
  ObjectTrack,
  FaceTrack,
  ShotImportance,
  ClipDescriptions,
  VisualUniqueness,
  OcrEntry,
  StorytellingLabels,
  StorytellingFunction,
  PersonDetail,
  RetrievalPriorityEntry,
} from "../drizzle/annotationTypes";
import type { MediaArchiveAsset } from "../drizzle/schema";

export const ANNOTATION_VERSION = "v5";

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

  return `You are a senior documentary archive editor at a major broadcaster (BBC, PBS, Al Jazeera level). Your task is to create a complete, professional editorial profile of this media clip. This profile will be used by an AI video editor to select the best clips for documentaries.

${meta}

${asset.storageUrl ? "A thumbnail/frame image is attached — use it as your primary analysis input." : "Analyze from the metadata provided."}

Return ONLY this JSON object — all fields required. Use empty string/array/0 if truly unknown, but make your best editorial judgment.

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
  },
  "searchAliases": [],
  "knowledgeGraphEntities": [],
  "editorialDescription": "",
  "qualityFlags": {
    "isBlack": false,
    "isBlurry": false,
    "hasWatermark": false,
    "isIntroOrOutro": false,
    "isCreditSequence": false,
    "hasTitleCard": false,
    "isTestPattern": false
  },
  "confidence": {
    "persons": 0.5,
    "location": 0.5,
    "historicalContext": 0.5,
    "objects": 0.7,
    "emotion": 0.6
  },
  "extendedEditorialScore": {
    "newsValue": 0,
    "documentaryValue": 0,
    "sourceQualityScore": 0,
    "reusabilityScore": 0
  },
  "timeline": [],
  "objectTracks": [],
  "faceTracks": [],
  "ocrText": [],
  "ocrTimeline": [],
  "cinematicTags": [],
  "shotImportance": {"score": 0, "label": "generic", "reason": ""},
  "visualUniqueness": {"score": 0, "reason": ""},
  "descriptions": {"short": "", "normal": "", "extended": ""},
  "storytellingLabels": {"primary": "context", "secondary": []},
  "primarySubject": "",
  "secondarySubjects": [],
  "personDetails": [],
  "emotions": [],
  "searchIntentTags": [],
  "negativeTags": [],
  "retrievalPriority": [],
  "retrievalSummary": ""
}

FIELD GUIDANCE:

persons.named: Full names of specific historical/public figures visible (e.g. "Winston Churchill", "Adolf Hitler", "John F. Kennedy"). Only include if clearly identifiable.
persons.categories: Generic categories of people visible (e.g. "soldiers", "civilians", "politicians", "crowd", "protesters", "military officers", "workers", "children").
objects: All significant visible objects. Be specific: "Spitfire aircraft", "German Panzerkampfwagen IV", "Big Ben", "Union Jack flag", "microphone on podium", "barbed wire fence".
actions: Precise verbs describing what is happening: "marching in formation", "delivering speech", "bombing run", "signing treaty", "surrendering", "celebrating in street".
environment.setting: One of: city | village | forest | desert | beach | sea | sky | indoors | outdoors | office | factory | battlefield | trench | harbour | parliament | stadium
environment.lighting: One of: daylight | night | golden hour | artificial | low key | silhouette | overcast
historicalContext.event: Specific named event (e.g. "D-Day landings Normandy", "Fall of Berlin", "Cuban Missile Crisis", "Moon landing Apollo 11").
historicalContext.period: Named historical era (e.g. "World War II", "Cold War", "French Revolution", "Roman Empire", "Space Race").
historicalContext.year: Best estimate as 4-digit year (e.g. "1944") or decade (e.g. "1940s") or century (e.g. "20th century").
location.confidence: "high" (GPS/text on screen/very distinctive landmark), "medium" (recognizable but not certain), "low" (guessed from context), "unknown".
cinematography.shotType: One of: establishing | extreme wide | wide | medium | medium close-up | close-up | extreme close-up
cinematography.cameraMovement: One of: static | handheld | pan | tilt | zoom | dolly | crane | tracking | drone | orbit
cinematography.visualStyle: One of: archival | modern | black and white | sepia | drone | illustration | map | animation | newsreel | documentary
emotion: One of: tension | calm | grief | triumph | defeat | fear | chaos | mystery | hope | pride | awe | neutral

editorialScore (0-100 each):
- historicalUsability: Does this illustrate a key historical moment? 90+ = irreplaceable primary source, 70+ = useful illustration, 50 = generic context, <40 = limited historical value
- cinematicQuality: Composition, lighting, framing. 90+ = broadcast quality, 70+ = good, 50 = acceptable, <40 = poor
- storytellingPotential: Could this open, develop, or close a documentary scene? 90+ = perfect narrative anchor, 70+ = strong support, <40 = weak
- emotionalValue: Does it carry a clear strong emotion? 90+ = visceral impact, 70+ = clear mood, <40 = neutral/flat
- movementQuality: Camera motion purposefulness. 90+ = professional tracking/crane, 70+ = steady purposeful movement, <40 = shaky/static
- originality: How rare/unique is this footage? 90+ = never-before-seen primary source, 70+ = uncommon, 50 = B-roll, <30 = generic stock
- total: weighted average of all six

motionLevel 0-100: 0 = completely static frame/still, 50 = normal movement, 100 = maximum kinetic energy
quality 0-100: estimate from what you can see/infer from metadata. Low-res, grainy, compressed footage scores lower.

searchAliases: Generate 15-25 alternative search phrases an editor might type to find this clip. Include:
- Person names + context (e.g. "Churchill parliament speech")
- Event names (e.g. "Battle of Britain RAF pilots")
- Location + era (e.g. "London 1940 wartime")
- Emotional context (e.g. "wartime courage defiance")
- Visual description (e.g. "aerial bombing footage WWII")
- Generic alternatives (e.g. "British wartime leader", "Prime Minister speech")

knowledgeGraphEntities: All entities this clip connects to in a knowledge graph. Start with the main subject and expand to related: people → organizations → locations → events → eras → objects. Example for Churchill: ["Churchill", "Winston Churchill", "Prime Minister", "United Kingdom", "London", "World War II", "WWII", "Battle of Britain", "RAF", "House of Commons", "Parliament", "1940", "1940s", "The Blitz", "Downing Street", "Allied Forces"]

editorialDescription: Write a professional 150-200 word description for an AI video editor. Describe exactly: what is visible in the frame, who is present and what they are doing, where this appears to be filmed, when it was filmed and the historical context, why this footage is significant, and how an editor would best use this clip. Be precise and editorial, not generic.

qualityFlags: Based on the title, tags, and image (if available), set these flags:
- isBlack: true if the clip appears to be a black frame or severely underexposed
- isBlurry: true if the image is clearly out of focus or motion-blurred beyond use
- hasWatermark: true if a visible watermark, broadcast logo, or timecode is present
- isIntroOrOutro: true if this appears to be a show intro/title sequence or outro
- isCreditSequence: true if this shows rolling end credits or closing titles
- hasTitleCard: true if the frame is dominated by text overlays or a title slate
- isTestPattern: true if this is colour bars, test pattern, or technical leader

confidence: Your certainty per field on a 0-1 scale. 1.0 = absolutely certain (name on screen / GPS tag), 0.5 = reasonable inference, 0.3 = guess, 0.1 = highly uncertain.

extendedEditorialScore (0-100 each):
- newsValue: Relevance for news/current affairs documentaries
- documentaryValue: Suitability for long-form historical documentary
- sourceQualityScore: Trust in provenance: 90=major broadcaster archive, 70=national archive/museum, 50=Wikimedia, 30=unknown source
- reusabilityScore: How broadly reusable across different productions/topics

timeline: Divide the clip into 2–8 temporal segments using THREE granularity levels:
- level: "scene" (major visual cut — new place/time), "shot" (angle/lens change), "micro_event" (notable action within a shot)
- startSec / endSec: estimate based on total duration
- shotType: wide | medium | close-up | establishing | extreme close-up
- description: 1 sentence of what visually happens in this segment
- persons: named persons visible (copy from persons.named if present)
- objects: key objects in this segment
- emotion: dominant emotion in this segment
- cameraMovement: static | pan | tilt | zoom | dolly | crane | handheld
- ocrText: any text visible in this segment (street signs, dates, subtitles)
- microEventType (only when level="micro_event"): "speech_start" | "explosion" | "flag_appears" | "vehicle_enters" | "aircraft_takeoff" | "handshake" | "applause" | "door_opens" | "person_turns" | "crowd_reaction" | "title_card_appears" | "map_appears" | "document_shown" | "shot_fired" | "fire_appears" | "smoke_appears" | "crowd_disperses" | "other"
If duration unknown, create 1 segment covering the whole clip.

objectTracks: For each significant moving object, describe:
- object: specific object name
- startPosition: "left" | "center" | "right" | "top" | "bottom" | "offscreen"
- endPosition: where it ends up
- direction: e.g. "left→right", "towards camera", "stationary", "top→bottom"
- movement: e.g. "enters frame left", "exits frame right", "approaches camera", "crosses frame"
- startSec: approximate time (seconds) when object first appears
- endSec: approximate time (seconds) when object exits or was last visible
- confidence: 0–1 detection confidence (1.0=very clear, 0.5=likely, 0.3=guess)
Only include objects with notable movement. Omit static background elements.

faceTracks: For each visible person (named or unnamed):
- name: full name or "unknown person"
- firstAppearsSec: estimated time of first appearance
- lastAppearsSec: estimated time of disappearance
- dominanceFraction: 0–1, fraction of clip duration this face is visible
- closeUpDurationSec: estimated seconds where face fills >50% of frame height
- isPrimarySubject: true if this is the main subject of the clip
- confidence: 0–1 identification confidence (1.0=name on screen/unmistakable, 0.7=very likely, 0.5=probable, 0.3=uncertain)

ocrTimeline: List all text visible on screen WITH timestamps:
Each entry: { "text": "string", "startSec": N, "endSec": N, "type": "subtitle|title|map_label|document|sign|date_overlay|other" }
Include: date overlays, subtitles, caption cards, street signs, newspaper headlines, map labels, building names.
This is MORE detailed than ocrText — include all distinct text appearances with when they appear.

ocrText: List all text strings you can read or infer are likely visible in the clip:
- Street signs, place names, year/date overlays, subtitles, banners, posters
- Names on buildings, newspapers, maps with labels, document titles
- Include text inferred from context (e.g. "1944" overlay on WWII footage)

cinematicTags: Apply all relevant tags from this list (use exact strings):
"leading lines" | "symmetry" | "silhouette" | "crowd shot" | "aerial view" | "skyline"
| "smoke" | "fire" | "destruction" | "celebration" | "interview" | "archive footage"
| "establishing shot" | "insert shot" | "reaction shot" | "cutaway" | "b-roll"
| "portrait" | "propaganda" | "newsreel" | "action" | "aftermath" | "procession"
| "ceremony" | "ruins" | "landscape" | "battle" | "documentary"
Add custom tags if relevant and not in this list.

shotImportance:
- score 0–100: How important/iconic is this specific shot in the context of history and documentary filmmaking?
  100 = Moon landing, D-Day landing (once-in-history). 85–99 = major historical event, primary source.
  70–84 = important but not unique. 50–69 = useful contextual footage. 35–49 = generic B-roll. <35 = stock filler.
- label: "iconic" (score≥90) | "unique" (score≥70) | "rare" (score≥50) | "generic" (score<50)
- reason: 1 sentence explaining this score

visualUniqueness:
- score 0–100: How unusual is this visual composition/content relative to all known archive footage?
  100 = one-of-a-kind (Moon landing). 80+ = extremely rare. 60–79 = uncommon. 40–59 = seen before. <40 = very common.
- reason: 1 sentence. E.g. "Rare aerial view of evacuation" or "Standard wide shot of city, many similar exist."

descriptions:
- short: Exactly 1 sentence (15–25 words). Who does what, where, when.
- normal: 1 paragraph of 3–5 sentences. Who, what, where, when, why it matters.
- extended: 150–300 words for an AI documentary editor. Include: visual detail, historical context, editorial usage guidance, emotional impact, cinematographic notes.

storytellingLabels:
- primary: The single most fitting editorial function. One of: "establishing" | "context" | "action" | "transition" | "reaction" | "emotion" | "detail" | "reveal" | "climax" | "ending"
  establishing = sets the scene (wide establishing shot of location)
  context = provides background information, explains what's happening
  action = shows the main event happening (battle, speech, march)
  transition = bridges two scenes or moments visually
  reaction = captures a human response to an event
  emotion = conveys a feeling without narrative function (close-up of grief, celebration)
  detail = insert shot of important object or text (map, document, symbol)
  reveal = dramatic disclosure of something (body, crowd, result)
  climax = the narrative peak (decisive moment, turning point)
  ending = closes a sequence (aftermath, departure, silence)
- secondary: Up to 3 additional functions this clip could serve (use same values as primary)

primarySubject: The single most important subject of this clip. Exactly one. The most specific identifiable entity: a named person ("Winston Churchill") > a specific event ("D-Day landings") > a specific place ("Omaha Beach") > a general category ("World War II"). If a named person is clearly the subject, use their name. If a specific event, use the event name.

secondarySubjects: Up to 10 secondary subjects also clearly present or highly relevant. Be specific: not "soldier" but "British infantryman"; not "airplane" but "Spitfire fighter". Max 10.

personDetails: Rich record for each named person in persons.named:
- name: full name (same as in persons.named)
- role: their specific title/role at the time (e.g. "Prime Minister", "Commanding General", "President")
- function: domain category ("politician", "military officer", "scientist", "journalist", "monarch")
- nationality: country of nationality (e.g. "United Kingdom", "United States", "France")
- confidence: 0–1 identification confidence

emotions: All significant emotions conveyed in this clip, ordered by prominence (strongest first). Up to 5. Use: "triumph" | "grief" | "fear" | "hope" | "pride" | "tension" | "calm" | "chaos" | "awe" | "defeat" | "anger" | "relief" | "joy" | "neutral"

searchIntentTags: Generate 50–100 alternative search terms covering EVERY way a documentary editor might search for this clip. Think in layers:
1. Direct: person name + action ("Churchill delivering speech", "Churchill at podium")
2. Context: event + place + era ("London 1940 wartime", "Houses of Parliament WWII")
3. Role: function + action ("British Prime Minister speaking", "wartime leader address")
4. Emotional: feeling + context ("defiance in wartime", "courage under Blitz")
5. Visual: shot type + subject ("close-up statesman", "medium shot politician")
6. Generic: category ("political speech", "wartime address", "leader speaking")
7. Synonyms: all alternative names/terms ("PM speech", "10 Downing Street", "Churchill radio")
8. Related events: ("Battle of Britain", "The Blitz", "RAF", "Operation Sea Lion")
9. Conceptual: ("democracy in wartime", "Western resistance", "Allied leadership")
10. Negative-space: what an editor is REALLY looking for when they need this clip
Generate at minimum 50. More is better. Every tag = one more retrieval path.

negativeTags: 5–15 explicit NOT-terms. What is this clip definitively NOT?
- People NOT present: "NOT Hitler", "NOT Stalin", "NOT Roosevelt"
- Places NOT shown: "NOT Berlin", "NOT Moscow"
- Periods NOT depicted: "NOT Cold War", "NOT post-war", "NOT modern"
- Topics NOT covered: "NOT Soviet Union", "NOT Nazi Germany", "NOT civilian"
These prevent false-positive matches and make retrieval more precise.

retrievalPriority: Rank the top 5–8 documentary topics this clip serves, 0–100:
100 = perfect fit (clip was literally made for this topic)
80–99 = excellent, highly relevant
60–79 = good, clearly useful
40–59 = partial, usable with care
< 40 = weak, probably wrong clip
Examples: {"topic": "Churchill biography", "score": 100}, {"topic": "WWII documentary", "score": 95}, {"topic": "British wartime history", "score": 90}, {"topic": "Cold War", "score": 20}

retrievalSummary: Write exactly 80–120 words. NOT for users — for the AI retrieval engine.
Explain: (1) what is literally happening in this clip, (2) who is present and their significance, (3) the historical/editorial context, (4) WHY an editor would choose THIS clip specifically over alternatives, (5) what documentary topics it best serves.
Example: "Churchill delivers a wartime address from the House of Commons chamber, 1940. The close-medium framing captures the Prime Minister at full authority — microphone prominent, uniform precise. This is primary source footage from the height of the Battle of Britain. An editor should choose this clip when they need Churchill himself on screen, particularly for biography productions, WWII narratives, or any sequence about British wartime leadership. The formal setting and deliberate speech delivery make it ideal as an action clip (speech delivery) or context clip (wartime governance). Pairs perfectly with RAF footage, Blitz sequences, or civilian morale material."`;
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
    searchAliases: tags.slice(0, 8),
    knowledgeGraphEntities: tags.slice(0, 5),
    editorialDescription: asset.title ?? "",
    qualityFlags: {},
    confidence: { persons: 0.3, location: 0.3, historicalContext: 0.3, objects: 0.5, emotion: 0.3 },
    extendedEditorialScore: { newsValue: 40, documentaryValue: 40, sourceQualityScore: 40, reusabilityScore: 50 },
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
            "You are a senior documentary archive editor. Analyze media clips and return structured JSON annotations with complete editorial detail. Return ONLY valid JSON.",
        },
        {
          role: "user",
          content: userContent as never,
        },
      ],
      maxTokens: 6000,
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

    // ── v2 fields ──────────────────────────────────────────────────────────────
    annotation.searchAliases = Array.isArray(parsed.searchAliases) && parsed.searchAliases.length > 0
      ? (parsed.searchAliases as string[]).slice(0, 30)
      : fb.searchAliases;

    annotation.knowledgeGraphEntities = Array.isArray(parsed.knowledgeGraphEntities)
      ? (parsed.knowledgeGraphEntities as string[]).slice(0, 50)
      : fb.knowledgeGraphEntities;

    annotation.editorialDescription =
      typeof parsed.editorialDescription === "string" && parsed.editorialDescription.length > 20
        ? parsed.editorialDescription.slice(0, 800)
        : fb.editorialDescription;

    const rawQf = parsed.qualityFlags as Partial<ClipQualityFlags> | undefined;
    annotation.qualityFlags = {
      isBlack:          rawQf?.isBlack         ?? false,
      isBlurry:         rawQf?.isBlurry        ?? false,
      hasWatermark:     rawQf?.hasWatermark     ?? false,
      isIntroOrOutro:   rawQf?.isIntroOrOutro   ?? false,
      isCreditSequence: rawQf?.isCreditSequence ?? false,
      hasTitleCard:     rawQf?.hasTitleCard     ?? false,
      isTestPattern:    rawQf?.isTestPattern    ?? false,
    };

    const rawConf = parsed.confidence as Partial<AnnotationConfidence> | undefined;
    annotation.confidence = {
      persons:          clamp01(rawConf?.persons          ?? 0.5),
      location:         clamp01(rawConf?.location         ?? 0.5),
      historicalContext: clamp01(rawConf?.historicalContext ?? 0.5),
      objects:          clamp01(rawConf?.objects          ?? 0.7),
      emotion:          clamp01(rawConf?.emotion          ?? 0.6),
    };

    const rawExt = parsed.extendedEditorialScore as Partial<ExtendedEditorialScores> | undefined;
    annotation.extendedEditorialScore = {
      newsValue:          clamp(rawExt?.newsValue          ?? 40),
      documentaryValue:   clamp(rawExt?.documentaryValue   ?? 40),
      sourceQualityScore: clamp(rawExt?.sourceQualityScore ?? 40),
      reusabilityScore:   clamp(rawExt?.reusabilityScore   ?? 50),
    };

    // ── v3 fields ──────────────────────────────────────────────────────────────

    const VALID_SEGMENT_LEVELS = new Set(["scene", "shot", "micro_event"]);
    const VALID_MICRO_EVENT_TYPES = new Set([
      "speech_start", "explosion", "flag_appears", "vehicle_enters",
      "aircraft_takeoff", "handshake", "applause", "door_opens", "person_turns",
      "crowd_reaction", "title_card_appears", "map_appears", "document_shown",
      "shot_fired", "fire_appears", "smoke_appears", "crowd_disperses", "other",
    ]);

    if (Array.isArray(parsed.timeline) && parsed.timeline.length > 0) {
      annotation.timeline = (parsed.timeline as ClipSegment[]).map((seg) => {
        const out: ClipSegment = {
          startSec:       typeof seg.startSec === "number" ? seg.startSec : 0,
          endSec:         typeof seg.endSec === "number" ? seg.endSec : 0,
          shotType:       typeof seg.shotType === "string" ? seg.shotType : "medium",
          description:    typeof seg.description === "string" ? seg.description.slice(0, 300) : "",
          persons:        Array.isArray(seg.persons) ? seg.persons : undefined,
          objects:        Array.isArray(seg.objects) ? seg.objects : undefined,
          emotion:        typeof seg.emotion === "string" ? seg.emotion : undefined,
          cameraMovement: typeof seg.cameraMovement === "string" ? seg.cameraMovement : undefined,
          ocrText:        typeof seg.ocrText === "string" ? seg.ocrText : undefined,
        };
        if (typeof seg.level === "string" && VALID_SEGMENT_LEVELS.has(seg.level)) {
          out.level = seg.level as ClipSegment["level"];
        }
        if (typeof seg.microEventType === "string" && VALID_MICRO_EVENT_TYPES.has(seg.microEventType)) {
          out.microEventType = seg.microEventType as ClipSegment["microEventType"];
        }
        return out;
      });
    }

    if (Array.isArray(parsed.objectTracks) && parsed.objectTracks.length > 0) {
      annotation.objectTracks = (parsed.objectTracks as ObjectTrack[]).map((t) => {
        const out: ObjectTrack = {
          object:        typeof t.object === "string" ? t.object : "",
          startPosition: typeof t.startPosition === "string" ? t.startPosition : "center",
          endPosition:   typeof t.endPosition === "string" ? t.endPosition : "center",
          direction:     typeof t.direction === "string" ? t.direction : "stationary",
          movement:      typeof t.movement === "string" ? t.movement : "",
        };
        if (typeof t.startSec === "number")   out.startSec   = Math.max(0, t.startSec);
        if (typeof t.endSec === "number")     out.endSec     = Math.max(0, t.endSec);
        if (typeof t.confidence === "number") out.confidence = clamp01(t.confidence);
        return out;
      }).filter((t) => t.object.length > 0);
    }

    if (Array.isArray(parsed.faceTracks) && parsed.faceTracks.length > 0) {
      annotation.faceTracks = (parsed.faceTracks as FaceTrack[]).map((f) => {
        const out: FaceTrack = {
          name:               typeof f.name === "string" ? f.name : "unknown person",
          firstAppearsSec:    typeof f.firstAppearsSec === "number" ? f.firstAppearsSec : 0,
          lastAppearsSec:     typeof f.lastAppearsSec === "number" ? f.lastAppearsSec : 0,
          dominanceFraction:  clamp01(f.dominanceFraction),
          closeUpDurationSec: typeof f.closeUpDurationSec === "number" ? Math.max(0, f.closeUpDurationSec) : 0,
          isPrimarySubject:   f.isPrimarySubject === true,
        };
        if (typeof f.confidence === "number") out.confidence = clamp01(f.confidence);
        return out;
      });
    }

    if (Array.isArray(parsed.ocrText) && parsed.ocrText.length > 0) {
      annotation.ocrText = (parsed.ocrText as string[])
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .slice(0, 30);
    }

    if (Array.isArray(parsed.cinematicTags) && parsed.cinematicTags.length > 0) {
      annotation.cinematicTags = (parsed.cinematicTags as string[])
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .slice(0, 20);
    }

    const rawSI = parsed.shotImportance as Partial<ShotImportance> | undefined;
    if (rawSI && typeof rawSI.score === "number") {
      const score = clamp(rawSI.score);
      const validLabels: Array<ShotImportance["label"]> = ["iconic", "unique", "rare", "generic"];
      const label: ShotImportance["label"] =
        validLabels.includes(rawSI.label as ShotImportance["label"])
          ? (rawSI.label as ShotImportance["label"])
          : score >= 90 ? "iconic" : score >= 70 ? "unique" : score >= 50 ? "rare" : "generic";
      annotation.shotImportance = {
        score,
        label,
        reason: typeof rawSI.reason === "string" ? rawSI.reason.slice(0, 200) : "",
      };
    }

    const rawVU = parsed.visualUniqueness as Partial<VisualUniqueness> | undefined;
    if (rawVU && typeof rawVU.score === "number") {
      annotation.visualUniqueness = {
        score:  clamp(rawVU.score),
        reason: typeof rawVU.reason === "string" ? rawVU.reason.slice(0, 200) : "",
      };
    }

    const rawDesc = parsed.descriptions as Partial<ClipDescriptions> | undefined;
    if (rawDesc && (rawDesc.short || rawDesc.normal || rawDesc.extended)) {
      annotation.descriptions = {
        short:    typeof rawDesc.short === "string" ? rawDesc.short.slice(0, 200) : "",
        normal:   typeof rawDesc.normal === "string" ? rawDesc.normal.slice(0, 600) : "",
        extended: typeof rawDesc.extended === "string" ? rawDesc.extended.slice(0, 1200) : "",
      };
    }

    // ── v4 fields ──────────────────────────────────────────────────────────────

    const rawOcrTimeline = (parsed as Partial<ClipAnnotation>).ocrTimeline;
    if (Array.isArray(rawOcrTimeline) && rawOcrTimeline.length > 0) {
      const VALID_OCR_TYPES = new Set(["subtitle","title","map_label","document","sign","date_overlay","other"]);
      annotation.ocrTimeline = (rawOcrTimeline as OcrEntry[])
        .filter((e) => typeof e.text === "string" && e.text.trim().length > 0)
        .map((e) => ({
          text:     e.text.trim().slice(0, 300),
          startSec: typeof e.startSec === "number" ? Math.max(0, e.startSec) : 0,
          endSec:   typeof e.endSec === "number" ? Math.max(0, e.endSec) : 0,
          type:     typeof e.type === "string" && VALID_OCR_TYPES.has(e.type)
            ? (e.type as OcrEntry["type"])
            : "other",
        }))
        .slice(0, 40);
    }

    const rawStory = (parsed as Partial<ClipAnnotation>).storytellingLabels as Partial<StorytellingLabels> | undefined;
    if (rawStory && typeof rawStory.primary === "string") {
      const VALID_FUNCTIONS: StorytellingFunction[] = [
        "establishing","context","action","transition","reaction",
        "emotion","detail","reveal","climax","ending",
      ];
      const primary = VALID_FUNCTIONS.includes(rawStory.primary as StorytellingFunction)
        ? (rawStory.primary as StorytellingFunction)
        : "context";
      const secondary = Array.isArray(rawStory.secondary)
        ? (rawStory.secondary as string[]).filter((s) => VALID_FUNCTIONS.includes(s as StorytellingFunction)).slice(0, 3) as StorytellingFunction[]
        : undefined;
      annotation.storytellingLabels = { primary, secondary: secondary?.length ? secondary : undefined };
    }

    // ── v5 fields ──────────────────────────────────────────────────────────────

    const rawV5 = parsed as Partial<ClipAnnotation>;

    if (typeof rawV5.primarySubject === "string" && rawV5.primarySubject.trim().length > 0) {
      annotation.primarySubject = rawV5.primarySubject.trim().slice(0, 200);
    }

    if (Array.isArray(rawV5.secondarySubjects) && rawV5.secondarySubjects.length > 0) {
      annotation.secondarySubjects = (rawV5.secondarySubjects as string[])
        .filter((s) => typeof s === "string" && s.trim().length > 0)
        .slice(0, 10);
    }

    if (Array.isArray(rawV5.personDetails) && rawV5.personDetails.length > 0) {
      annotation.personDetails = (rawV5.personDetails as PersonDetail[])
        .filter((p) => typeof p.name === "string" && p.name.trim().length > 0)
        .map((p) => ({
          name:        p.name.trim().slice(0, 100),
          role:        typeof p.role === "string" ? p.role.trim().slice(0, 100) : undefined,
          function:    typeof p.function === "string" ? p.function.trim().slice(0, 100) : undefined,
          nationality: typeof p.nationality === "string" ? p.nationality.trim().slice(0, 100) : undefined,
          confidence:  clamp01(p.confidence ?? 0.5),
        }))
        .slice(0, 20);
    }

    if (Array.isArray(rawV5.emotions) && rawV5.emotions.length > 0) {
      annotation.emotions = (rawV5.emotions as string[])
        .filter((e) => typeof e === "string" && e.trim().length > 0)
        .slice(0, 5);
    }

    if (Array.isArray(rawV5.searchIntentTags) && rawV5.searchIntentTags.length > 0) {
      annotation.searchIntentTags = (rawV5.searchIntentTags as string[])
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, 120);
    }

    if (Array.isArray(rawV5.negativeTags) && rawV5.negativeTags.length > 0) {
      annotation.negativeTags = (rawV5.negativeTags as string[])
        .filter((t) => typeof t === "string" && t.trim().length > 0)
        .map((t) => t.trim())
        .slice(0, 20);
    }

    if (Array.isArray(rawV5.retrievalPriority) && rawV5.retrievalPriority.length > 0) {
      annotation.retrievalPriority = (rawV5.retrievalPriority as RetrievalPriorityEntry[])
        .filter((e) => typeof e.topic === "string" && typeof e.score === "number")
        .map((e) => ({ topic: e.topic.trim().slice(0, 100), score: clamp(e.score) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    }

    if (typeof rawV5.retrievalSummary === "string" && rawV5.retrievalSummary.trim().length > 20) {
      annotation.retrievalSummary = rawV5.retrievalSummary.trim().slice(0, 600);
    }

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

function clamp01(v: unknown): number {
  const n = typeof v === "number" ? v : 0;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
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
