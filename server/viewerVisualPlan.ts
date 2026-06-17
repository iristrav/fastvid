/**
 * Per-beat literal viewer visual — what the camera shows (subject + action + setting),
 * resolved BEFORE any archive or stock search. Abstract concepts ("AI automation") are
 * translated into filmable shots ("person working on laptop").
 *
 * Workflow: answer the documentary-editor question → one concrete scene → search on that
 * scene only (never on voice-over words).
 */
import { DOCUMENTARY_EDITOR_VIEWER_QUESTION } from "./documentaryVisualPolicy";
import type { ScriptVisualIntentEntry } from "./scriptVisualKeywords";
import {
  fallbackVisualIntent,
  hasDirectorPlan,
  resolveBeatVisualIntent,
  sanitizeVisualIntentText,
  sanitizeVisualKeyword,
} from "./scriptVisualKeywords";
import { extractVisualSearchTags } from "./visualBeatTags";

export type ArchiveMatchTier = "exact" | "semantic" | "related";

export { DOCUMENTARY_EDITOR_VIEWER_QUESTION } from "./documentaryVisualPolicy";

export type LiteralViewerVisual = {
  /** Concrete English: what the viewer literally sees on screen. */
  description: string;
  /** 3–6 word archive/stock search phrase derived from description only. */
  searchQuery: string;
  subject: string;
  action: string;
};

const ABSTRACT_VISUAL_RE =
  /\b(success|growth|groei|strategy|strategie|company|bedrijf|business|concept|idea|innovation|innovatie|future|toekomst|impact|value|vision|mission|goal|doel|solution|opportunity|challenge|important|significant|powerful|amazing|incredible|remarkable|transformation|digitalization|digitalisering|automatisering|automation|efficiency|productivity|progress|development|ontwikkeling)\b/i;

const VISIBLE_SUBJECT_RE =
  /\b(person|people|man|woman|worker|workers|cyclist|cyclists|driver|crowd|child|children|family|office|desk|laptop|computer|street|highway|train|tram|bus|car|cars|bicycle|bike|building|skyline|map|factory|hospital|kitchen|farmer|soldier|president|mayor|parliament|canal|windmill|port|ship|rocket|launchpad|audience|classroom|market|shop|restaurant|highway|intersection|bridge|park|forest|ocean|beach|field|stadium|protest|march|sign|document|newspaper|phone|smartphone|screen|monitor|warehouse|construction|crane|airport|plane|subway|metro|platform|station)\b/i;

const ACTION_RE =
  /\b(work(?:ing|s|ed)?|sit(?:ting|s)?|walk(?:ing|s|ed)?|rid(?:ing|es|e)?|driv(?:ing|es|e)?|run(?:ning|s)?|type(?:s|ing|d)?|read(?:ing|s)?|talk(?:ing|s)?|meet(?:ing|s)?|build(?:ing|s)?|construct(?:ing|s|ed)?|protest(?:ing|s|ed)?|commut(?:ing|e|es)|cycle(?:s|d|ing)?|travel(?:ing|s|led)?|wait(?:ing|s|ed)?|cross(?:ing|es|ed)?|enter(?:ing|s|ed)?|leave(?:s|d|ing)?|operate(?:s|d|ing)?|repair(?:s|ed|ing)?|load(?:ing|s|ed)?|unload(?:ing|s|ed)?|plant(?:ing|s|ed)?|harvest(?:ing|s|ed)?|cook(?:ing|s|ed)?|eat(?:ing|s)?|play(?:ing|s|ed)?|train(?:ing|s|ed)?|study(?:ing|s|ied)?|present(?:ing|s|ed)?|vote(?:s|d|ing)?|sign(?:ing|s|ed)?|paint(?:ing|s|ed)?|film(?:ing|s|ed)?|launch(?:es|ed|ing)?|land(?:s|ed|ing)?|fly(?:ing|s|flew)?|sail(?:ing|s|ed)?|swim(?:ming|s)?|climb(?:ing|s|ed)?|push(?:ing|es|ed)?|pull(?:ing|s|ed)?|carry(?:ing|ies|ied)?|deliver(?:ing|s|ed)?|stack(?:ing|s|ed)?|sort(?:ing|s|ed)?|pack(?:ing|s|ed)?|move(?:s|d|ing)?|stand(?:ing|s)?|look(?:ing|s|ed)?|point(?:ing|s|ed)?|write(?:s|ing|ten)?|code(?:s|d|ing)?)\b/i;

/** Topic-agnostic rules: narration meaning → literal on-screen shot. */
const LITERAL_VISUAL_RULES: Array<{
  pattern: RegExp;
  description: string;
  searchQuery: string;
  subject: string;
  action: string;
}> = [
  {
    pattern: /\b(ai|artificial intelligence|machine learning|chatgpt|automatisering|automation)\b/i,
    description: "A person working on a laptop at a desk in a modern office.",
    searchQuery: "person laptop office desk",
    subject: "person",
    action: "working",
  },
  {
    pattern: /\b(fiets|fietsen|fietser|cyclist|cyclists|cycling|bicycle|bike lane|fietspad)\b/i,
    description: "People riding bicycles on a city street with bike lanes.",
    searchQuery: "people cycling city street",
    subject: "cyclists",
    action: "riding",
  },
  {
    pattern: /\b(auto|auto'?s|car|cars|driving|traffic jam|snelweg|highway|opstopping)\b/i,
    description: "Cars driving on a busy highway with traffic.",
    searchQuery: "cars highway traffic driving",
    subject: "cars",
    action: "driving",
  },
  {
    pattern: /\b(urban planning|stedenbouw|city planning|zoning|master plan)\b/i,
    description: "An urban planning map with streets and districts marked on a table.",
    searchQuery: "urban planning map table",
    subject: "planning map",
    action: "marked",
  },
  {
    pattern: /\b(government|overheid|parliament|congress|capitol|gemeente|city hall)\b/i,
    description: "Government building exterior with flags and steps.",
    searchQuery: "government building exterior flags",
    subject: "government building",
    action: "standing",
  },
  {
    pattern: /\b(protest|demonstration|betoging|march|rally)\b/i,
    description: "A crowd of protesters marching with signs on a city street.",
    searchQuery: "protest march crowd signs",
    subject: "protesters",
    action: "marching",
  },
  {
    pattern: /\b(netherlands|nederland|dutch|amsterdam|holland|gracht|canal)\b/i,
    description: "Amsterdam canal with bicycles and historic buildings.",
    searchQuery: "amsterdam canal bicycles",
    subject: "canal",
    action: "flowing",
  },
  {
    pattern: /\b(america|american|usa|united states|suburb|suburbs)\b/i,
    description: "American suburban streets with cars and detached houses.",
    searchQuery: "american suburb street cars",
    subject: "suburb",
    action: "sprawling",
  },
  {
    pattern: /\b(train|rail|metro|subway|transit|public transport|ov)\b/i,
    description: "Passengers boarding a modern train at a station platform.",
    searchQuery: "train station passengers platform",
    subject: "train",
    action: "boarding",
  },
  {
    pattern: /\b(hospital|doctor|nurse|medical|ziekenhuis|healthcare)\b/i,
    description: "Medical staff working in a busy hospital corridor.",
    searchQuery: "hospital corridor medical staff",
    subject: "medical staff",
    action: "working",
  },
  {
    pattern: /\b(factory|warehouse|manufacturing|fabriek|production line)\b/i,
    description: "Workers operating machinery on a factory production line.",
    searchQuery: "factory workers production line",
    subject: "workers",
    action: "operating",
  },
  {
    pattern: /\b(school|university|student|classroom|campus|education)\b/i,
    description: "Students sitting in a classroom listening to a teacher.",
    searchQuery: "students classroom listening",
    subject: "students",
    action: "listening",
  },
  {
    pattern: /\b(money|euro|dollar|salary|wage|income|profit|revenue|investment)\b/i,
    description: "Close-up of hands counting money on a desk with a calculator.",
    searchQuery: "hands counting money desk",
    subject: "hands",
    action: "counting",
  },
  {
    pattern: /\b(war|battle|soldier|military|army|tank|invasion|oorlog)\b/i,
    description: "Soldiers and military vehicles moving through a war-torn landscape.",
    searchQuery: "soldiers military vehicles war",
    subject: "soldiers",
    action: "advancing",
  },
  {
    pattern: /\b(rocket|spacex|starship|launch|satellite|nasa|space)\b/i,
    description: "A rocket launching from a pad with fire and smoke at liftoff.",
    searchQuery: "rocket launch liftoff smoke",
    subject: "rocket",
    action: "launching",
  },
  {
    pattern: /\b(supply chain|logistics|freight|shipping port|container ship|cargo ship|port terminal)\b/i,
    description: "Shipping containers being loaded at a busy freight port with cranes.",
    searchQuery: "shipping port containers cranes",
    subject: "port",
    action: "loading",
  },
  {
    pattern: /\b(railroad|rail yard|train yard|freight train|rail hub|intermodal)\b/i,
    description: "Freight trains moving through a large rail yard with cargo cars.",
    searchQuery: "freight train rail yard",
    subject: "freight train",
    action: "moving",
  },
  {
    pattern: /\b(gridlock|congestion|bottleneck|chokepoint|shut down|shutdown)\b/i,
    description: "Aerial view of congested highway interchange with stopped traffic.",
    searchQuery: "highway traffic congestion aerial",
    subject: "highway",
    action: "congested",
  },
  {
    pattern: /\b(warehouse|distribution center|fulfillment|delivery truck|semi truck)\b/i,
    description: "Workers and forklifts moving boxes inside a large warehouse.",
    searchQuery: "warehouse workers forklifts boxes",
    subject: "warehouse",
    action: "moving",
  },
  {
    pattern: /\b(city skyline|downtown|metropolis|urban sprawl|one city)\b/i,
    description: "Aerial view of a dense downtown city skyline at daytime.",
    searchQuery: "aerial downtown city skyline",
    subject: "city skyline",
    action: "sprawling",
  },
  {
    pattern: /\b(power grid|electric grid|infrastructure|blackout|power plant)\b/i,
    description: "High-voltage power lines and electrical substation infrastructure.",
    searchQuery: "power lines electrical substation",
    subject: "power lines",
    action: "standing",
  },
];

export function isAbstractVisualText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && ABSTRACT_VISUAL_RE.test(t)) return true;
  if (/^(ai|automation|innovation|business|technology|strategy|growth)$/i.test(t)) return true;
  return false;
}

export function isConcreteViewerVisual(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 12) return false;
  if (isAbstractVisualText(t)) return false;
  return VISIBLE_SUBJECT_RE.test(t) && (ACTION_RE.test(t) || t.split(/\s+/).length >= 6);
}

function buildFromRule(beatText: string): LiteralViewerVisual | null {
  for (const rule of LITERAL_VISUAL_RULES) {
    if (rule.pattern.test(beatText)) {
      return {
        description: rule.description,
        searchQuery: rule.searchQuery,
        subject: rule.subject,
        action: rule.action,
      };
    }
  }
  return null;
}

function buildFromIntent(intent: ScriptVisualIntentEntry): LiteralViewerVisual | null {
  const desc =
    sanitizeVisualIntentText(intent.visual_description ?? "") ||
    sanitizeVisualIntentText(intent.visual_intent ?? "");
  const query =
    sanitizeVisualKeyword(intent.search_query ?? "") ||
    sanitizeVisualKeyword(intent.primary_keyword ?? "");
  if (!desc || !query || !isConcreteViewerVisual(desc)) return null;
  const subject = intent.priority_subject?.trim() || query.split(/\s+/)[0] || "scene";
  const actionMatch = desc.match(ACTION_RE);
  const action = actionMatch?.[0]?.toLowerCase() ?? "visible";
  return { description: desc, searchQuery: query, subject, action };
}

function searchQueryFromDescription(description: string, intent?: ScriptVisualIntentEntry): string {
  const fromIntent =
    sanitizeVisualKeyword(intent?.search_query ?? "") ||
    sanitizeVisualKeyword(intent?.primary_keyword ?? "");
  if (fromIntent && !isAbstractVisualText(fromIntent)) return fromIntent;
  const fromDesc = sanitizeVisualKeyword(description.replace(/^a\s+/i, "").slice(0, 72));
  if (fromDesc && !isAbstractVisualText(fromDesc)) return fromDesc;
  const tags = extractVisualSearchTags(description).slice(0, 4);
  if (tags.length >= 2) return sanitizeVisualKeyword(tags.slice(0, 4).join(" ")) || tags.join(" ");
  return "documentary broll scene";
}

/** Resolve literal on-screen visual for any beat / topic. */
export function inferLiteralViewerVisual(
  beatText: string,
  videoTitle?: string,
  storedIntent?: ScriptVisualIntentEntry
): LiteralViewerVisual {
  // 1. Visual Director / stored plan — concrete scene before any rule or narration tokens.
  if (storedIntent) {
    const fromIntent = buildFromIntent(storedIntent);
    if (fromIntent) return fromIntent;
  }

  // 2. Topic rules translate abstract narration → filmable shot (when no director plan).
  if (!hasDirectorPlan(storedIntent)) {
    const fromRule = buildFromRule(beatText);
    if (fromRule) return fromRule;
  }

  const intent = storedIntent ?? fallbackVisualIntent(beatText);
  const descCandidate =
    sanitizeVisualIntentText(intent.visual_description ?? "") ||
    sanitizeVisualIntentText(intent.visual_intent ?? "");
  if (isConcreteViewerVisual(descCandidate)) {
    const built = buildFromIntent(intent);
    if (built) return built;
  }

  const subject = intent.priority_subject || "person";
  const scene = intent.scene_type && intent.scene_type !== "other" ? intent.scene_type : "documentary";
  const description = `A ${subject} visible in a ${scene} setting, shown as documentary B-roll.`;
  const searchQuery = searchQueryFromDescription(description, intent);

  return {
    description,
    searchQuery,
    subject,
    action: "visible",
  };
}

export function literalVisualSearchTags(literal: LiteralViewerVisual): string[] {
  const tags = new Set<string>();
  for (const t of extractVisualSearchTags(literal.description)) tags.add(t);
  for (const t of extractVisualSearchTags(literal.searchQuery)) tags.add(t);
  for (const w of [literal.subject, literal.action]) {
    const s = w.trim().toLowerCase();
    if (s.length >= 3) tags.add(s);
  }
  return [...tags];
}

export type BeatWithLiteralVisual = {
  text: string;
  searchQuery: string;
  powerWord: string;
  visualDescription?: string;
  visualIntent?: ScriptVisualIntentEntry;
};

/** Set beat.visualDescription + searchQuery from literal viewer visual (call before archive search). */
export function applyLiteralViewerVisualToBeat(
  beat: BeatWithLiteralVisual,
  videoTitle?: string,
  intentMap?: Map<string, ScriptVisualIntentEntry>
): LiteralViewerVisual {
  const stored = resolveBeatVisualIntent(beat.text, intentMap);
  const literal = inferLiteralViewerVisual(beat.text, videoTitle, stored);
  beat.visualDescription = literal.description;
  beat.searchQuery = literal.searchQuery;
  beat.powerWord = literal.subject.split(/\s+/)[0] ?? beat.powerWord;
  beat.visualIntent = {
    ...stored,
    visual_intent: literal.description,
    visual_description: literal.description,
    search_query: literal.searchQuery,
    primary_keyword: literal.searchQuery,
    priority_subject: literal.subject,
  };
  console.log(
    `[ViewerVisual] ${DOCUMENTARY_EDITOR_VIEWER_QUESTION} → "${literal.description.slice(0, 80)}" ` +
      `(zoek: ${literal.searchQuery})`
  );
  return literal;
}

export const ARCHIVE_MATCH_TIER_ORDER: ArchiveMatchTier[] = ["exact", "semantic", "related"];

export function archiveTierLabel(tier: ArchiveMatchTier): string {
  if (tier === "exact") return "exact archive match";
  if (tier === "semantic") return "semantic archive match";
  return "related archive match";
}
